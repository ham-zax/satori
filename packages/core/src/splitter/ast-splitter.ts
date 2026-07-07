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

type TextSymbolCandidate = {
    startLine: number;
    endLine: number;
    label: string;
    breadcrumbs?: string[];
    indent?: number;
    definitionLine?: number;
};

interface RecursiveFallbackSplitter {
    split(code: string, language: string, filePath?: string): Promise<CodeChunk[]>;
    setChunkSize(chunkSize: number): void;
    setChunkOverlap(chunkOverlap: number): void;
}

type LanguageConfig = {
    parser: unknown;
    nodeTypes: string[];
};

export class AstCodeSplitter implements Splitter {
    private chunkSize: number = 2500;
    private chunkOverlap: number = 300;
    private parser: Parser;
    private langchainFallback: RecursiveFallbackSplitter; // Compatibility-named recursive fallback splitter

    constructor(chunkSize?: number, chunkOverlap?: number) {
        if (chunkSize) this.chunkSize = chunkSize;
        if (chunkOverlap) this.chunkOverlap = chunkOverlap;
        this.parser = new Parser();

        // Initialize fallback splitter
        const { LangChainCodeSplitter } = require('./langchain-splitter');
        this.langchainFallback = new LangChainCodeSplitter(chunkSize, chunkOverlap) as RecursiveFallbackSplitter;
    }

    async split(code: string, language: string, filePath?: string): Promise<CodeChunk[]> {
        const normalizedLanguage = normalizeLanguageId(language);
        // Check if language is supported by AST splitter
        const langConfig = this.getLanguageConfig(normalizedLanguage);
        if (!langConfig) {
            console.log(`📝 Language ${language} not supported by AST, using recursive fallback splitter for: ${filePath || 'unknown'}`);
            return await this.langchainFallback.split(code, language, filePath);
        }

        try {
            console.log(`🌳 Using AST splitter for ${normalizedLanguage} file: ${filePath || 'unknown'}`);

            this.parser.setLanguage(langConfig.parser);
            const tree = this.parser.parse(code);

            if (!tree.rootNode) {
                console.warn(`[ASTSplitter] ⚠️  Failed to parse AST for ${normalizedLanguage}, falling back to recursive splitter: ${filePath || 'unknown'}`);
                return await this.langchainFallback.split(code, language, filePath);
            }

            // Extract chunks based on AST nodes
            const chunks = this.extractChunks(tree.rootNode, code, langConfig.nodeTypes, normalizedLanguage, filePath);

            // If chunks are too large, split them further
            const refinedChunks = await this.refineChunks(chunks, code);

            return refinedChunks;
        } catch (error) {
            const textSymbolChunks = this.extractTextSymbolChunks(code, normalizedLanguage, filePath);
            if (textSymbolChunks.length > 0) {
                console.warn(`[ASTSplitter] ⚠️  AST splitter failed for ${normalizedLanguage}, using text-symbol fallback: ${error}`);
                return await this.refineChunks(textSymbolChunks, code);
            }

            console.warn(`[ASTSplitter] ⚠️  AST splitter failed for ${normalizedLanguage}, falling back to recursive splitter: ${error}`);
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

    private getLanguageConfig(language: string): LanguageConfig | null {
        const langMap: Record<string, LanguageConfig> = {
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
                            startByte: currentNode.startIndex,
                            endByte: currentNode.endIndex,
                            startColumn: currentNode.startPosition.column,
                            endColumn: currentNode.endPosition.column,
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

    private splitLargeChunk(chunk: CodeChunk, _originalCode: string): CodeChunk[] {
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
            if (i > 0 && this.chunkOverlap > 0 && this.shouldApplyOverlap(chunks[i - 1], chunks[i])) {
                const prevChunk = chunks[i - 1];
                const overlapText = this.takeSafeSuffix(prevChunk.content, this.chunkOverlap);
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

    private shouldApplyOverlap(previousChunk: CodeChunk, currentChunk: CodeChunk): boolean {
        const previousHasSymbol = Boolean(previousChunk.metadata.symbolId || previousChunk.metadata.symbolLabel);
        const currentHasSymbol = Boolean(currentChunk.metadata.symbolId || currentChunk.metadata.symbolLabel);
        if (!previousHasSymbol || !currentHasSymbol) {
            return true;
        }
        if (previousChunk.metadata.symbolId && currentChunk.metadata.symbolId) {
            return previousChunk.metadata.symbolId === currentChunk.metadata.symbolId;
        }
        if (previousChunk.metadata.symbolLabel && currentChunk.metadata.symbolLabel) {
            return previousChunk.metadata.symbolLabel === currentChunk.metadata.symbolLabel;
        }
        return false;
    }

    private takeSafeSuffix(text: string, codeUnits: number): string {
        let start = Math.max(0, text.length - codeUnits);
        if (
            start > 0
            && start < text.length
            && this.isLowSurrogate(text.charCodeAt(start))
            && this.isHighSurrogate(text.charCodeAt(start - 1))
        ) {
            start -= 1;
        }
        return text.slice(start);
    }

    private isHighSurrogate(code: number): boolean {
        return code >= 0xd800 && code <= 0xdbff;
    }

    private isLowSurrogate(code: number): boolean {
        return code >= 0xdc00 && code <= 0xdfff;
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
        const lines = raw.split('\n');
        const header = this.collectPythonHeader(lines, 0, this.countPythonIndent(lines[0] || ''), 32);
        if (header) {
            const label = this.matchPythonDefinitionLabel(header);
            if (label) {
                return label;
            }
        }
        const firstLine = raw.split('\n')[0]?.trim() || '';
        const fallbackHeader = (firstLine.endsWith(':') ? firstLine.slice(0, -1) : firstLine).replace(/\s+/g, ' ').trim();
        if (!fallbackHeader) {
            return `${kind} <anonymous>`;
        }
        if (kind === 'class') {
            return fallbackHeader.startsWith('class ') ? fallbackHeader : `class ${fallbackHeader}`;
        }
        if (kind === 'async function') {
            if (fallbackHeader.startsWith('async def ')) {
                return `async function ${fallbackHeader.replace(/^async def\s+/, '')}`;
            }
            if (fallbackHeader.startsWith('def ')) {
                return `async function ${fallbackHeader.replace(/^def\s+/, '')}`;
            }
            return `async function ${fallbackHeader}`;
        }
        if (fallbackHeader.startsWith('async def ')) {
            return `async function ${fallbackHeader.replace(/^async def\s+/, '')}`;
        }
        if (fallbackHeader.startsWith('def ')) {
            return `function ${fallbackHeader.replace(/^def\s+/, '')}`;
        }
        return `function ${fallbackHeader}`;
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

    private extractTextSymbolChunks(code: string, language: string, filePath?: string): CodeChunk[] {
        if (language !== 'javascript' && language !== 'typescript' && language !== 'python') {
            return [];
        }

        const lines = code.split('\n');
        const candidates = language === 'python'
            ? this.extractPythonTextSymbols(lines)
            : this.extractJavaScriptTextSymbols(lines);
        return candidates.map((candidate) => {
            const content = lines.slice(candidate.startLine - 1, candidate.endLine).join('\n');
            const symbolMetadata = this.buildSymbolMetadata(
                filePath,
                candidate.startLine,
                candidate.endLine,
                candidate.label
            );

            return {
                content,
                metadata: {
                    startLine: candidate.startLine,
                    endLine: candidate.endLine,
                    language,
                    filePath,
                    breadcrumbs: candidate.breadcrumbs,
                    ...symbolMetadata,
                }
            };
        });
    }

    private extractPythonTextSymbols(lines: string[]): TextSymbolCandidate[] {
        const candidates: TextSymbolCandidate[] = [];
        const consumedDefinitionLines = new Set<number>();

        for (let index = 0; index < lines.length; index++) {
            if (consumedDefinitionLines.has(index)) {
                continue;
            }

            const definition = this.collectPythonDefinition(lines, index);
            if (!definition) {
                continue;
            }
            if (consumedDefinitionLines.has(definition.definitionIndex)) {
                continue;
            }

            consumedDefinitionLines.add(definition.definitionIndex);
            candidates.push({
                startLine: definition.startIndex + 1,
                endLine: this.findPythonBlockEnd(lines, definition.definitionIndex, definition.indent),
                label: definition.label,
                indent: definition.indent,
                definitionLine: definition.definitionIndex + 1,
            });
        }

        const sorted = candidates.sort((a, b) => {
            if (a.startLine !== b.startLine) return a.startLine - b.startLine;
            if (a.endLine !== b.endLine) return a.endLine - b.endLine;
            return a.label.localeCompare(b.label);
        });

        return sorted.map((candidate) => {
            const ancestors = sorted
                .filter((ancestor) => (
                    ancestor !== candidate
                    && (ancestor.definitionLine || ancestor.startLine) < (candidate.definitionLine || candidate.startLine)
                    && ancestor.endLine >= candidate.endLine
                    && (ancestor.indent || 0) < (candidate.indent || 0)
                ))
                .sort((a, b) => {
                    if ((a.indent || 0) !== (b.indent || 0)) return (a.indent || 0) - (b.indent || 0);
                    return a.startLine - b.startLine;
                });
            const breadcrumbLabels = [
                ...ancestors.map((ancestor) => ancestor.label),
                candidate.label,
            ];
            return {
                startLine: candidate.startLine,
                endLine: candidate.endLine,
                label: candidate.label,
                breadcrumbs: this.buildBreadcrumbs(breadcrumbLabels),
            };
        });
    }

    private collectPythonDefinition(
        lines: string[],
        startIndex: number,
        maxLines = 32
    ): { startIndex: number; definitionIndex: number; indent: number; label: string } | null {
        const firstLine = lines[startIndex] || '';
        const firstTrimmed = firstLine.trim();
        if (firstTrimmed.length === 0 || firstTrimmed.startsWith('#')) {
            return null;
        }

        const indent = this.countPythonIndent(firstLine);
        let definitionIndex = startIndex;
        if (firstTrimmed.startsWith('@')) {
            definitionIndex = this.findPythonDecoratedDefinitionLine(lines, startIndex, indent, maxLines);
            if (definitionIndex < 0) {
                return null;
            }
        }

        const definitionIndent = this.countPythonIndent(lines[definitionIndex] || '');
        const header = this.collectPythonHeader(lines, definitionIndex, definitionIndent, maxLines);
        if (!header) {
            return null;
        }

        const label = this.matchPythonDefinitionLabel(header);
        if (!label) {
            return null;
        }

        return {
            startIndex,
            definitionIndex,
            indent: definitionIndent,
            label,
        };
    }

    private findPythonDecoratedDefinitionLine(
        lines: string[],
        startIndex: number,
        indent: number,
        maxLines: number
    ): number {
        for (let index = startIndex; index < Math.min(lines.length, startIndex + maxLines); index++) {
            const line = lines[index] || '';
            const trimmed = line.trim();
            if (trimmed.length === 0) {
                continue;
            }
            if (this.countPythonIndent(line) !== indent) {
                return -1;
            }
            if (trimmed.startsWith('@')) {
                continue;
            }
            return this.isPythonDefinitionStart(trimmed) ? index : -1;
        }
        return -1;
    }

    private collectPythonHeader(
        lines: string[],
        definitionIndex: number,
        indent: number,
        maxLines: number
    ): string | null {
        const parts: string[] = [];
        for (let index = definitionIndex; index < Math.min(lines.length, definitionIndex + maxLines); index++) {
            const line = lines[index] || '';
            const trimmed = line.trim();
            if (trimmed.length === 0) {
                break;
            }
            if (index > definitionIndex && this.countPythonIndent(line) <= indent && this.isPythonDefinitionStart(trimmed)) {
                break;
            }
            parts.push(trimmed);
            if (this.isPythonHeaderTerminated(trimmed)) {
                return parts.join(' ').replace(/\s+/g, ' ').trim();
            }
        }
        return null;
    }

    private isPythonDefinitionStart(trimmedLine: string): boolean {
        return /^(?:async\s+def|def|class)\s+[A-Za-z_][\w]*/.test(trimmedLine);
    }

    private isPythonHeaderTerminated(trimmedLine: string): boolean {
        return /:\s*(?:#.*)?$/.test(trimmedLine);
    }

    private matchPythonDefinitionLabel(header: string): string | null {
        const normalized = header.replace(/:\s*(?:#.*)?$/, '').replace(/\s+/g, ' ').trim();
        const classMatch = normalized.match(/^class\s+(.+)$/);
        if (classMatch) {
            return `class ${classMatch[1]}`;
        }
        const asyncFunctionMatch = normalized.match(/^async\s+def\s+(.+)$/);
        if (asyncFunctionMatch) {
            return `async function ${asyncFunctionMatch[1]}`;
        }
        const functionMatch = normalized.match(/^def\s+(.+)$/);
        if (functionMatch) {
            return `function ${functionMatch[1]}`;
        }
        return null;
    }

    private findPythonBlockEnd(lines: string[], definitionIndex: number, indent: number): number {
        let lastContentLine = definitionIndex + 1;
        let headerComplete = this.isPythonHeaderTerminated((lines[definitionIndex] || '').trim());
        for (let index = definitionIndex + 1; index < lines.length; index++) {
            const line = lines[index] || '';
            const trimmed = line.trim();
            if (!headerComplete) {
                lastContentLine = index + 1;
                if (this.isPythonHeaderTerminated(trimmed)) {
                    headerComplete = true;
                }
                continue;
            }
            if (trimmed.length === 0 || trimmed.startsWith('#')) {
                continue;
            }
            if (this.countPythonIndent(line) <= indent) {
                return lastContentLine;
            }
            lastContentLine = index + 1;
        }
        return lastContentLine;
    }

    private countPythonIndent(line: string): number {
        let indent = 0;
        for (const char of line) {
            if (char === ' ') {
                indent++;
            } else if (char === '\t') {
                indent += 4;
            } else {
                break;
            }
        }
        return indent;
    }

    private extractJavaScriptTextSymbols(lines: string[]): TextSymbolCandidate[] {
        const candidates: TextSymbolCandidate[] = [];
        const classCandidates: TextSymbolCandidate[] = [];

        for (let index = 0; index < lines.length; index++) {
            const header = this.collectJavaScriptHeader(lines, index);
            if (!header) {
                continue;
            }

            const className = this.matchJavaScriptNamedDeclaration(header.text, 'class');
            if (className) {
                const label = `class ${className}`;
                const candidate = {
                    startLine: index + 1,
                    endLine: this.findJavaScriptBlockEnd(lines, index),
                    label,
                    breadcrumbs: this.buildBreadcrumbs([label]),
                };
                candidates.push(candidate);
                classCandidates.push(candidate);
                continue;
            }

            const interfaceName = this.matchJavaScriptNamedDeclaration(header.text, 'interface');
            if (interfaceName) {
                const label = `interface ${interfaceName}`;
                candidates.push({
                    startLine: index + 1,
                    endLine: this.findJavaScriptStatementEnd(lines, index),
                    label,
                    breadcrumbs: this.buildBreadcrumbs([label]),
                });
                continue;
            }

            const typeName = this.matchJavaScriptNamedDeclaration(header.text, 'type');
            if (typeName) {
                const label = `type ${typeName}`;
                candidates.push({
                    startLine: index + 1,
                    endLine: this.findJavaScriptStatementEnd(lines, index),
                    label,
                    breadcrumbs: this.buildBreadcrumbs([label]),
                });
                continue;
            }

            const functionLabel = this.matchJavaScriptFunctionLabel(header.text);
            if (functionLabel) {
                candidates.push({
                    startLine: index + 1,
                    endLine: this.findJavaScriptBlockEnd(lines, index),
                    label: functionLabel,
                    breadcrumbs: this.buildBreadcrumbs([functionLabel]),
                });
                continue;
            }

            const arrowLabel = this.matchJavaScriptArrowFunctionLabel(header.text);
            if (arrowLabel) {
                candidates.push({
                    startLine: index + 1,
                    endLine: header.hasBlock
                        ? this.findJavaScriptBlockEnd(lines, index)
                        : this.findJavaScriptStatementEnd(lines, index),
                    label: arrowLabel,
                    breadcrumbs: this.buildBreadcrumbs([arrowLabel]),
                });
            }
        }

        for (const classCandidate of classCandidates) {
            candidates.push(...this.extractJavaScriptClassMethodSymbols(lines, classCandidate));
        }

        const byKey = new Map<string, TextSymbolCandidate>();
        for (const candidate of candidates) {
            byKey.set(`${candidate.startLine}:${candidate.endLine}:${candidate.label}`, candidate);
        }

        return Array.from(byKey.values()).sort((a, b) => {
            if (a.startLine !== b.startLine) return a.startLine - b.startLine;
            if (a.endLine !== b.endLine) return a.endLine - b.endLine;
            return a.label.localeCompare(b.label);
        });
    }

    private extractJavaScriptClassMethodSymbols(
        lines: string[],
        classCandidate: TextSymbolCandidate
    ): TextSymbolCandidate[] {
        const candidates: TextSymbolCandidate[] = [];
        let depth = 0;

        for (let index = classCandidate.startLine - 1; index < classCandidate.endLine; index++) {
            const trimmed = lines[index]?.trim() || '';
            if (index > classCandidate.startLine - 1 && depth === 1) {
                const header = this.collectJavaScriptHeader(lines, index);
                if (header) {
                    const methodLabel = this.matchJavaScriptMethodLabel(header.text);
                    if (methodLabel) {
                        candidates.push({
                            startLine: index + 1,
                            endLine: this.findJavaScriptBlockEnd(lines, index),
                            label: methodLabel,
                            breadcrumbs: this.buildBreadcrumbs([classCandidate.label, methodLabel]),
                        });
                    }

                    const propertyArrowLabel = this.matchJavaScriptPropertyArrowLabel(header.text);
                    if (propertyArrowLabel) {
                        candidates.push({
                            startLine: index + 1,
                            endLine: header.hasBlock
                                ? this.findJavaScriptBlockEnd(lines, index)
                                : this.findJavaScriptStatementEnd(lines, index),
                            label: propertyArrowLabel,
                            breadcrumbs: this.buildBreadcrumbs([classCandidate.label, propertyArrowLabel]),
                        });
                    }
                }
            }

            if (trimmed.length > 0) {
                depth = Math.max(0, depth + this.getJavaScriptBraceDelta(lines[index] || ''));
            }
        }

        return candidates;
    }

    private collectJavaScriptHeader(
        lines: string[],
        startIndex: number,
        maxLines = 24
    ): { text: string; hasBlock: boolean } | null {
        const parts: string[] = [];
        for (let index = startIndex; index < Math.min(lines.length, startIndex + maxLines); index++) {
            const trimmed = (lines[index] || '').trim();
            if (trimmed.length === 0) {
                if (parts.length === 0) {
                    return null;
                }
                break;
            }
            parts.push(trimmed);
            if (/[{;]|\b=>\b/.test(trimmed)) {
                const text = parts.join(' ').replace(/\s+/g, ' ').trim();
                return { text, hasBlock: text.includes('{') };
            }
        }

        if (parts.length === 0) {
            return null;
        }

        const text = parts.join(' ').replace(/\s+/g, ' ').trim();
        return { text, hasBlock: text.includes('{') };
    }

    private matchJavaScriptNamedDeclaration(header: string, kind: 'class' | 'interface' | 'type'): string | null {
        const pattern = new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?${kind}\\s+([A-Za-z_$][\\w$]*)\\b`);
        const match = header.match(pattern);
        return match?.[1] || null;
    }

    private matchJavaScriptFunctionLabel(header: string): string | null {
        const match = header.match(/^(?:export\s+)?(?:default\s+)?(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(\([^)]*\))/);
        if (!match) {
            return null;
        }
        const asyncPrefix = match[1] ? 'async ' : '';
        return `${asyncPrefix}function ${match[2]}${this.normalizeHeaderParameters(match[3])}`;
    }

    private matchJavaScriptArrowFunctionLabel(header: string): string | null {
        const match = header.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s+)?(?:function\b\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)?\s*=>?/);
        if (!match || !(header.includes('=>') || /\bfunction\b/.test(header))) {
            return null;
        }
        const asyncPrefix = match[2] ? 'async ' : '';
        return `${asyncPrefix}function ${match[1]}${this.normalizeHeaderParameters(match[3] || '(...)')}`;
    }

    private matchJavaScriptMethodLabel(header: string): string | null {
        const match = header.match(/^(?:(?:public|private|protected|static|readonly|abstract|override|declare)\s+)*(async\s+)?([A-Za-z_$][\w$]*|constructor)\s*(?:<[^>{}]*>)?\s*(\([^)]*\))/);
        if (!match || !header.includes('{')) {
            return null;
        }
        if (this.isJavaScriptControlKeyword(match[2])) {
            return null;
        }
        const asyncPrefix = match[1] ? 'async ' : '';
        return `${asyncPrefix}method ${match[2]}${this.normalizeHeaderParameters(match[3])}`;
    }

    private matchJavaScriptPropertyArrowLabel(header: string): string | null {
        const match = header.match(/^(?:(?:public|private|protected|static|readonly|abstract|override|declare)\s+)*([A-Za-z_$][\w$]*)\s*=\s*(async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/);
        if (!match) {
            return null;
        }
        return `${match[2] ? 'async ' : ''}function ${match[1]}(...)`;
    }

    private normalizeHeaderParameters(parameters: string): string {
        const normalized = parameters.replace(/\s+/g, ' ').trim();
        return normalized.length > 0 ? normalized : '(...)';
    }

    private isJavaScriptControlKeyword(value: string): boolean {
        return [
            'catch',
            'do',
            'for',
            'function',
            'if',
            'switch',
            'while',
            'with',
        ].includes(value);
    }

    private findJavaScriptStatementEnd(lines: string[], startIndex: number): number {
        for (let index = startIndex; index < lines.length; index++) {
            if (/[;}]\s*$/.test(lines[index] || '')) {
                return index + 1;
            }
        }
        return startIndex + 1;
    }

    private findJavaScriptBlockEnd(lines: string[], startIndex: number): number {
        let depth = 0;
        let seenOpen = false;
        for (let index = startIndex; index < lines.length; index++) {
            const line = lines[index] || '';
            for (const char of this.stripJavaScriptLineForBraces(line)) {
                if (char === '{') {
                    depth++;
                    seenOpen = true;
                    continue;
                }
                if (char === '}' && seenOpen) {
                    depth--;
                    if (depth <= 0) {
                        return index + 1;
                    }
                }
            }
        }
        return startIndex + 1;
    }

    private getJavaScriptBraceDelta(line: string): number {
        let delta = 0;
        for (const char of this.stripJavaScriptLineForBraces(line)) {
            if (char === '{') {
                delta++;
            } else if (char === '}') {
                delta--;
            }
        }
        return delta;
    }

    private stripJavaScriptLineForBraces(line: string): string {
        return line
            .replace(/\/\/.*$/, '')
            .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '');
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
