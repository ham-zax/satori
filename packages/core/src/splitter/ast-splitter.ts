import Parser from 'tree-sitter';
import crypto from 'node:crypto';
import { Splitter, CodeChunk } from './index';
import {
    normalizeLanguageId,
    getSupportedLanguageAliasesForCapability,
    getSupportedLanguageIdsForCapability,
    isLanguageCapabilitySupportedForLanguage,
} from '../language';

// Language parsers
const JavaScript = require('tree-sitter-javascript');
const TypeScript = require('tree-sitter-typescript').typescript;
const Python = require('tree-sitter-python');
const Java = require('tree-sitter-java');
const Cpp = require('tree-sitter-cpp');
const Go = require('tree-sitter-go');
const Rust = require('tree-sitter-rust');
const CSharp = require('tree-sitter-c-sharp');
const Scala = require('tree-sitter-scala');

// Node types that represent logical code units
const SPLITTABLE_NODE_TYPES = {
    javascript: ['function_declaration', 'arrow_function', 'class_declaration', 'method_definition', 'export_statement'],
    typescript: ['function_declaration', 'arrow_function', 'class_declaration', 'method_definition', 'export_statement', 'interface_declaration', 'type_alias_declaration'],
    python: ['function_definition', 'class_definition', 'decorated_definition', 'async_function_definition'],
    java: ['method_declaration', 'class_declaration', 'interface_declaration', 'constructor_declaration'],
    cpp: ['function_definition', 'class_specifier', 'namespace_definition', 'declaration'],
    go: ['function_declaration', 'method_declaration', 'type_declaration', 'var_declaration', 'const_declaration'],
    rust: ['function_item', 'impl_item', 'struct_item', 'enum_item', 'trait_item', 'mod_item'],
    csharp: ['method_declaration', 'class_declaration', 'interface_declaration', 'struct_declaration', 'enum_declaration'],
    scala: ['method_declaration', 'class_declaration', 'interface_declaration', 'constructor_declaration']
};

const MAX_BREADCRUMB_DEPTH = 2;
const MAX_BREADCRUMB_LENGTH = 120;

export class AstCodeSplitter implements Splitter {
    private chunkSize: number = 2500;
    private chunkOverlap: number = 300;
    private parser: Parser;
    private langchainFallback: any; // LangChainCodeSplitter for fallback

    constructor(chunkSize?: number, chunkOverlap?: number) {
        if (chunkSize) this.chunkSize = chunkSize;
        if (chunkOverlap) this.chunkOverlap = chunkOverlap;
        this.parser = new Parser();

        // Initialize fallback splitter
        const { LangChainCodeSplitter } = require('./langchain-splitter');
        this.langchainFallback = new LangChainCodeSplitter(chunkSize, chunkOverlap);
    }

    async split(code: string, language: string, filePath?: string): Promise<CodeChunk[]> {
        const normalizedLanguage = normalizeLanguageId(language);
        // Check if language is supported by AST splitter
        const langConfig = this.getLanguageConfig(normalizedLanguage);
        if (!langConfig) {
            console.log(`📝 Language ${language} not supported by AST, using LangChain splitter for: ${filePath || 'unknown'}`);
            return await this.langchainFallback.split(code, language, filePath);
        }

        try {
            console.log(`🌳 Using AST splitter for ${normalizedLanguage} file: ${filePath || 'unknown'}`);

            this.parser.setLanguage(langConfig.parser);
            const tree = this.parser.parse(code);

            if (!tree.rootNode) {
                console.warn(`[ASTSplitter] ⚠️  Failed to parse AST for ${normalizedLanguage}, falling back to LangChain: ${filePath || 'unknown'}`);
                return await this.langchainFallback.split(code, language, filePath);
            }

            // Extract chunks based on AST nodes
            const chunks = this.extractChunks(tree.rootNode, code, langConfig.nodeTypes, normalizedLanguage, filePath);

            // If chunks are too large, split them further
            const refinedChunks = await this.refineChunks(chunks, code);

            return refinedChunks;
        } catch (error) {
            console.warn(`[ASTSplitter] ⚠️  AST splitter failed for ${normalizedLanguage}, falling back to LangChain: ${error}`);
            return await this.langchainFallback.split(code, language, filePath);
        }
    }

    setChunkSize(chunkSize: number): void {
        this.chunkSize = chunkSize;
        this.langchainFallback.setChunkSize(chunkSize);
    }

    setChunkOverlap(chunkOverlap: number): void {
        this.chunkOverlap = chunkOverlap;
        this.langchainFallback.setChunkOverlap(chunkOverlap);
    }

    private getLanguageConfig(language: string): { parser: any; nodeTypes: string[] } | null {
        const langMap: Record<string, { parser: any; nodeTypes: string[] }> = {
            javascript: { parser: JavaScript, nodeTypes: SPLITTABLE_NODE_TYPES.javascript },
            typescript: { parser: TypeScript, nodeTypes: SPLITTABLE_NODE_TYPES.typescript },
            python: { parser: Python, nodeTypes: SPLITTABLE_NODE_TYPES.python },
            java: { parser: Java, nodeTypes: SPLITTABLE_NODE_TYPES.java },
            cpp: { parser: Cpp, nodeTypes: SPLITTABLE_NODE_TYPES.cpp },
            go: { parser: Go, nodeTypes: SPLITTABLE_NODE_TYPES.go },
            rust: { parser: Rust, nodeTypes: SPLITTABLE_NODE_TYPES.rust },
            csharp: { parser: CSharp, nodeTypes: SPLITTABLE_NODE_TYPES.csharp },
            scala: { parser: Scala, nodeTypes: SPLITTABLE_NODE_TYPES.scala }
        };

        return langMap[normalizeLanguageId(language)] || null;
    }

    private extractChunks(
        node: Parser.SyntaxNode,
        code: string,
        splittableTypes: string[],
        language: string,
        filePath?: string
    ): CodeChunk[] {
        const chunks: CodeChunk[] = [];
        const codeLines = code.split('\n');
        const normalizedLanguage = language.toLowerCase();

        const traverse = (currentNode: Parser.SyntaxNode, scopeStack: string[]) => {
            const scopeLabel = this.getScopeLabel(currentNode, code, normalizedLanguage);
            const nextScope = scopeLabel ? [...scopeStack, scopeLabel] : scopeStack;

            // Check if this node type should be split into a chunk
            if (splittableTypes.includes(currentNode.type)) {
                const startLine = currentNode.startPosition.row + 1;
                const endLine = currentNode.endPosition.row + 1;
                const nodeText = code.slice(currentNode.startIndex, currentNode.endIndex);
                const breadcrumbs = this.buildBreadcrumbs(nextScope);
                const symbolMetadata = this.buildSymbolMetadata(filePath, startLine, endLine, scopeLabel || undefined);

                // Only create chunk if it has meaningful content
                if (nodeText.trim().length > 0) {
                    chunks.push({
                        content: nodeText,
                        metadata: {
                            startLine,
                            endLine,
                            language,
                            filePath,
                            breadcrumbs,
                            ...symbolMetadata,
                        }
                    });
                }
            }

            // Continue traversing child nodes
            for (const child of currentNode.children) {
                traverse(child, nextScope);
            }
        };

        traverse(node, []);

        // If no meaningful chunks found, create a single chunk with the entire code
        if (chunks.length === 0) {
            chunks.push({
                content: code,
                metadata: {
                    startLine: 1,
                    endLine: codeLines.length,
                    language,
                    filePath,
                }
            });
        }

        return chunks;
    }

    private async refineChunks(chunks: CodeChunk[], originalCode: string): Promise<CodeChunk[]> {
        const refinedChunks: CodeChunk[] = [];

        for (const chunk of chunks) {
            if (chunk.content.length <= this.chunkSize) {
                refinedChunks.push(chunk);
            } else {
                // Split large chunks using character-based splitting
                const subChunks = this.splitLargeChunk(chunk, originalCode);
                refinedChunks.push(...subChunks);
            }
        }

        return this.addOverlap(refinedChunks);
    }

    private splitLargeChunk(chunk: CodeChunk, originalCode: string): CodeChunk[] {
        const lines = chunk.content.split('\n');
        const subChunks: CodeChunk[] = [];
        let currentChunk = '';
        let currentStartLine = chunk.metadata.startLine;
        let currentLineCount = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineWithNewline = i === lines.length - 1 ? line : line + '\n';

            if (currentChunk.length + lineWithNewline.length > this.chunkSize && currentChunk.length > 0) {
                // Create a sub-chunk
                subChunks.push({
                    content: currentChunk.trim(),
                    metadata: {
                        startLine: currentStartLine,
                        endLine: currentStartLine + currentLineCount - 1,
                        language: chunk.metadata.language,
                        filePath: chunk.metadata.filePath,
                        breadcrumbs: chunk.metadata.breadcrumbs,
                        symbolId: chunk.metadata.symbolId,
                        symbolLabel: chunk.metadata.symbolLabel,
                    }
                });

                currentChunk = lineWithNewline;
                currentStartLine = chunk.metadata.startLine + i;
                currentLineCount = 1;
            } else {
                currentChunk += lineWithNewline;
                currentLineCount++;
            }
        }

        // Add the last sub-chunk
        if (currentChunk.trim().length > 0) {
            subChunks.push({
                content: currentChunk.trim(),
                metadata: {
                    startLine: currentStartLine,
                    endLine: currentStartLine + currentLineCount - 1,
                    language: chunk.metadata.language,
                    filePath: chunk.metadata.filePath,
                    breadcrumbs: chunk.metadata.breadcrumbs,
                    symbolId: chunk.metadata.symbolId,
                    symbolLabel: chunk.metadata.symbolLabel,
                }
            });
        }

        return subChunks;
    }

    private addOverlap(chunks: CodeChunk[]): CodeChunk[] {
        if (chunks.length <= 1 || this.chunkOverlap <= 0) {
            return chunks;
        }

        const overlappedChunks: CodeChunk[] = [];

        for (let i = 0; i < chunks.length; i++) {
            let content = chunks[i].content;
            const metadata = { ...chunks[i].metadata };

            // Add overlap from previous chunk
            if (i > 0 && this.chunkOverlap > 0) {
                const prevChunk = chunks[i - 1];
                const overlapText = prevChunk.content.slice(-this.chunkOverlap);
                content = overlapText + '\n' + content;
                metadata.startLine = Math.max(1, metadata.startLine - this.getLineCount(overlapText));
            }

            overlappedChunks.push({
                content,
                metadata
            });
        }

        return overlappedChunks;
    }

    private getLineCount(text: string): number {
        return text.split('\n').length;
    }

    private buildSymbolMetadata(
        filePath: string | undefined,
        startLine: number,
        endLine: number,
        symbolLabel?: string
    ): { symbolId?: string; symbolLabel?: string } {
        if (!symbolLabel) {
            return {};
        }

        if (!filePath) {
            return { symbolLabel };
        }

        const normalizedPath = filePath.replace(/\\/g, '/');
        const payload = `${normalizedPath}:${startLine}:${endLine}:${symbolLabel}`;
        const digest = crypto.createHash('sha1').update(payload, 'utf8').digest('hex').slice(0, 16);
        return {
            symbolId: `sym_${digest}`,
            symbolLabel,
        };
    }

    private buildBreadcrumbs(scopeStack: string[]): string[] | undefined {
        if (scopeStack.length === 0) {
            return undefined;
        }

        const normalized = scopeStack
            .map((scope) => this.normalizeBreadcrumbText(scope))
            .filter((scope) => scope.length > 0);

        if (normalized.length === 0) {
            return undefined;
        }

        const deduped = normalized.filter((scope, index) => index === 0 || scope !== normalized[index - 1]);
        const sliced = deduped.slice(-MAX_BREADCRUMB_DEPTH);
        return sliced.length > 0 ? sliced : undefined;
    }

    private normalizeBreadcrumbText(value: string): string {
        const compact = value.replace(/\s+/g, ' ').trim();
        if (compact.length <= MAX_BREADCRUMB_LENGTH) {
            return compact;
        }
        return `${compact.slice(0, MAX_BREADCRUMB_LENGTH - 3)}...`;
    }

    private getScopeLabel(currentNode: Parser.SyntaxNode, code: string, language: string): string | null {
        if (language === 'javascript' || language === 'js' || language === 'typescript' || language === 'ts') {
            return this.getJavaScriptScopeLabel(currentNode, code);
        }
        if (language === 'python' || language === 'py') {
            return this.getPythonScopeLabel(currentNode, code);
        }
        return null;
    }

    private getJavaScriptScopeLabel(currentNode: Parser.SyntaxNode, code: string): string | null {
        switch (currentNode.type) {
            case 'class_declaration':
                return `class ${this.getNodeName(currentNode, code) || '<anonymous>'}`;
            case 'function_declaration':
                return this.buildFunctionLabel(currentNode, code, this.getNodeName(currentNode, code) || '<anonymous>');
            case 'method_definition': {
                const methodName = this.getMethodName(currentNode, code) || '<anonymous>';
                const params = this.getFunctionParameters(currentNode, code);
                const asyncPrefix = this.isAsyncNode(currentNode, code) ? 'async ' : '';
                return `${asyncPrefix}method ${methodName}${params}`;
            }
            case 'arrow_function': {
                const functionName = this.getArrowFunctionName(currentNode, code) || '<anonymous>';
                return this.buildFunctionLabel(currentNode, code, functionName);
            }
            case 'interface_declaration':
                return `interface ${this.getNodeName(currentNode, code) || '<anonymous>'}`;
            case 'type_alias_declaration':
                return `type ${this.getNodeName(currentNode, code) || '<anonymous>'}`;
            case 'export_statement': {
                const declaration = currentNode.namedChildren.find((child) =>
                    child.type === 'class_declaration'
                    || child.type === 'function_declaration'
                    || child.type === 'interface_declaration'
                    || child.type === 'type_alias_declaration'
                );
                if (declaration) {
                    return this.getJavaScriptScopeLabel(declaration, code);
                }
                return null;
            }
            default:
                return null;
        }
    }

    private getPythonScopeLabel(currentNode: Parser.SyntaxNode, code: string): string | null {
        switch (currentNode.type) {
            case 'class_definition':
                return this.extractPythonSignature(currentNode, code, 'class');
            case 'function_definition':
                return this.extractPythonSignature(currentNode, code, 'function');
            case 'async_function_definition':
                return this.extractPythonSignature(currentNode, code, 'async function');
            case 'decorated_definition': {
                const decorated = currentNode.namedChildren.find((child) =>
                    child.type === 'class_definition'
                    || child.type === 'function_definition'
                    || child.type === 'async_function_definition'
                );
                if (!decorated) {
                    return null;
                }
                return this.getPythonScopeLabel(decorated, code);
            }
            default:
                return null;
        }
    }

    private buildFunctionLabel(node: Parser.SyntaxNode, code: string, functionName: string): string {
        const asyncPrefix = this.isAsyncNode(node, code) ? 'async ' : '';
        const params = this.getFunctionParameters(node, code);
        return `${asyncPrefix}function ${functionName}${params}`;
    }

    private extractPythonSignature(node: Parser.SyntaxNode, code: string, kind: 'class' | 'function' | 'async function'): string {
        const raw = this.getNodeText(code, node);
        const firstLine = raw.split('\n')[0]?.trim() || '';
        const header = (firstLine.endsWith(':') ? firstLine.slice(0, -1) : firstLine).replace(/\s+/g, ' ').trim();
        if (!header) {
            return `${kind} <anonymous>`;
        }
        if (kind === 'class') {
            return header.startsWith('class ') ? header : `class ${header}`;
        }
        if (kind === 'async function') {
            if (header.startsWith('async def ')) {
                return `async function ${header.replace(/^async def\s+/, '')}`;
            }
            if (header.startsWith('def ')) {
                return `async function ${header.replace(/^def\s+/, '')}`;
            }
            return `async function ${header}`;
        }
        if (header.startsWith('async def ')) {
            return `async function ${header.replace(/^async def\s+/, '')}`;
        }
        if (header.startsWith('def ')) {
            return `function ${header.replace(/^def\s+/, '')}`;
        }
        return `function ${header}`;
    }

    private getFunctionParameters(node: Parser.SyntaxNode, code: string): string {
        const paramsNode = node.childForFieldName('parameters');
        if (!paramsNode) {
            return '(...)';
        }
        const paramsText = this.getNodeText(code, paramsNode).replace(/\s+/g, ' ').trim();
        return paramsText.length > 0 ? paramsText : '(...)';
    }

    private getMethodName(node: Parser.SyntaxNode, code: string): string | null {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) {
            return null;
        }
        return this.getNodeText(code, nameNode).replace(/\s+/g, ' ').trim() || null;
    }

    private getArrowFunctionName(node: Parser.SyntaxNode, code: string): string | null {
        const parent = node.parent;
        if (!parent) {
            return null;
        }

        if (parent.type === 'variable_declarator') {
            const nameNode = parent.childForFieldName('name');
            if (nameNode) {
                return this.getNodeText(code, nameNode).trim() || null;
            }
        }

        if (parent.type === 'assignment_expression') {
            const leftNode = parent.childForFieldName('left');
            if (leftNode) {
                const left = this.getNodeText(code, leftNode).replace(/\s+/g, ' ').trim();
                return left.length > 0 ? left : null;
            }
        }

        if (parent.type === 'pair' || parent.type === 'property_assignment') {
            const keyNode = parent.childForFieldName('key');
            if (keyNode) {
                const key = this.getNodeText(code, keyNode).replace(/\s+/g, ' ').trim();
                return key.length > 0 ? key : null;
            }
        }

        return null;
    }

    private getNodeName(node: Parser.SyntaxNode, code: string): string | null {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) {
            return null;
        }
        const value = this.getNodeText(code, nameNode).replace(/\s+/g, ' ').trim();
        return value.length > 0 ? value : null;
    }

    private isAsyncNode(node: Parser.SyntaxNode, code: string): boolean {
        const preview = this.getNodeText(code, node).slice(0, 30);
        return /^\s*async\b/.test(preview);
    }

    private getNodeText(code: string, node: Parser.SyntaxNode): string {
        return code.slice(node.startIndex, node.endIndex);
    }

    /**
     * Check if AST splitting is supported for the given language
     */
    static isLanguageSupported(language: string): boolean {
        return isLanguageCapabilitySupportedForLanguage(language, 'astSplitter');
    }

    static getSupportedLanguages(): string[] {
        return getSupportedLanguageAliasesForCapability('astSplitter');
    }

    static getSupportedCanonicalLanguages(): string[] {
        return getSupportedLanguageIdsForCapability('astSplitter');
    }
}
