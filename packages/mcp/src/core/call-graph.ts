import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import crypto from 'node:crypto';
import ignore from 'ignore';
import {
    AstCodeSplitter,
    getLanguageIdFromExtension,
    getSupportedExtensionsForCapability,
    getSupportedLanguageIdsForCapability,
} from '@zokizuan/satori-core';
import { CallGraphSidecarInfo, IndexFingerprint } from '../config.js';

export type CallGraphDirection = 'callers' | 'callees' | 'both';
export type CallGraphEdgeKind = 'call' | 'import' | 'dynamic';

export interface CallGraphSpan {
    startLine: number;
    endLine: number;
}

export interface CallGraphSymbolRef {
    file: string;
    symbolId: string;
    symbolLabel?: string;
    span?: CallGraphSpan;
}

export interface CallGraphNode {
    symbolId: string;
    symbolLabel?: string;
    file: string;
    language: string;
    span: CallGraphSpan;
}

export interface CallGraphEdge {
    srcSymbolId: string;
    dstSymbolId: string;
    kind: CallGraphEdgeKind;
    site: {
        file: string;
        startLine: number;
        endLine?: number;
    };
    confidence: number;
}

export interface CallGraphNote {
    type: 'unresolved_edge' | 'dynamic_edge' | 'missing_symbol_metadata';
    file: string;
    startLine: number;
    symbolId?: string;
    detail: string;
}

interface CallGraphSidecar {
    formatVersion: 'v3';
    codebasePath: string;
    builtAt: string;
    fingerprint: IndexFingerprint;
    nodes: CallGraphNode[];
    edges: CallGraphEdge[];
    notes: CallGraphNote[];
}

export interface CallGraphResponseUnsupported {
    supported: false;
    reason: string;
    hints?: Record<string, unknown>;
}

export interface CallGraphResponseSupported {
    supported: true;
    direction: CallGraphDirection;
    depth: number;
    limit: number;
    nodes: CallGraphNode[];
    edges: CallGraphEdge[];
    notes: CallGraphNote[];
    sidecar: {
        builtAt: string;
        nodeCount: number;
        edgeCount: number;
    };
}

export type CallGraphQueryResponse = CallGraphResponseSupported | CallGraphResponseUnsupported;

export interface CallGraphDeltaPolicy {
    shouldRebuild(changedFiles: string[]): boolean;
}

const SUPPORTED_SOURCE_EXTENSIONS = new Set(getSupportedExtensionsForCapability('callGraphBuild'));
const QUERY_SUPPORTED_EXTENSIONS = new Set(getSupportedExtensionsForCapability('callGraphQuery'));
const QUERY_SUPPORTED_LANGUAGE_IDS = getSupportedLanguageIdsForCapability('callGraphQuery');
const DEFAULT_IGNORE_PATTERNS = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/.next/**'];
const CALL_KEYWORDS = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'typeof', 'function', 'class', 'def', 'await', 'with', 'from', 'import',
]);

export class SupportedSourceDeltaPolicy implements CallGraphDeltaPolicy {
    shouldRebuild(changedFiles: string[]): boolean {
        for (const file of changedFiles) {
            const extension = path.extname(file).toLowerCase();
            if (SUPPORTED_SOURCE_EXTENSIONS.has(extension)) {
                return true;
            }
        }
        return false;
    }
}

type MutableNode = {
    symbolId: string;
    symbolLabel?: string;
    file: string;
    language: string;
    span: CallGraphSpan;
};

export class CallGraphSidecarManager {
    private readonly runtimeFingerprint: IndexFingerprint;
    private readonly splitter: AstCodeSplitter;
    private readonly now: () => number;
    private readonly deltaPolicy: CallGraphDeltaPolicy;

    constructor(
        runtimeFingerprint: IndexFingerprint,
        options?: {
            now?: () => number;
            deltaPolicy?: CallGraphDeltaPolicy;
        }
    ) {
        this.runtimeFingerprint = runtimeFingerprint;
        this.splitter = new AstCodeSplitter();
        this.now = options?.now || (() => Date.now());
        this.deltaPolicy = options?.deltaPolicy || new SupportedSourceDeltaPolicy();
    }

    public shouldRebuildForDelta(changedFiles: string[]): boolean {
        return this.deltaPolicy.shouldRebuild(changedFiles);
    }

    public loadSidecar(codebasePath: string): CallGraphSidecar | null {
        const sidecarPath = this.getSidecarPath(codebasePath);
        if (!fs.existsSync(sidecarPath)) {
            return null;
        }

        try {
            const raw = fs.readFileSync(sidecarPath, 'utf8');
            const parsed = JSON.parse(raw) as Partial<CallGraphSidecar>;
            if (parsed.formatVersion !== 'v3') {
                return null;
            }

            if (!parsed.fingerprint || parsed.fingerprint.schemaVersion !== this.runtimeFingerprint.schemaVersion) {
                return null;
            }

            const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
            const edges = Array.isArray(parsed.edges) ? parsed.edges : [];
            const notes = Array.isArray(parsed.notes) ? parsed.notes : [];

            return {
                formatVersion: 'v3',
                codebasePath: path.resolve(codebasePath),
                builtAt: typeof parsed.builtAt === 'string' ? parsed.builtAt : new Date(this.now()).toISOString(),
                fingerprint: parsed.fingerprint,
                nodes,
                edges,
                notes,
            };
        } catch {
            return null;
        }
    }

    public async rebuildForCodebase(codebasePath: string, ignorePatterns: string[] = []): Promise<CallGraphSidecarInfo> {
        const absoluteRoot = path.resolve(codebasePath);
        const files = await this.collectSourceFiles(absoluteRoot, ignorePatterns);
        const graph = await this.buildGraph(absoluteRoot, files);

        const sidecar: CallGraphSidecar = {
            formatVersion: 'v3',
            codebasePath: absoluteRoot,
            builtAt: new Date(this.now()).toISOString(),
            fingerprint: this.runtimeFingerprint,
            nodes: graph.nodes,
            edges: graph.edges,
            notes: graph.notes,
        };

        const sidecarPath = this.getSidecarPath(absoluteRoot);
        const sidecarDir = path.dirname(sidecarPath);
        await fs.promises.mkdir(sidecarDir, { recursive: true });
        await fs.promises.writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf8');

        return {
            version: 'v3',
            sidecarPath,
            builtAt: sidecar.builtAt,
            nodeCount: sidecar.nodes.length,
            edgeCount: sidecar.edges.length,
            noteCount: sidecar.notes.length,
            fingerprint: this.runtimeFingerprint,
        };
    }

    public async rebuildIfSupportedDelta(codebasePath: string, changedFiles: string[], ignorePatterns: string[] = []): Promise<CallGraphSidecarInfo | null> {
        if (!this.shouldRebuildForDelta(changedFiles)) {
            return null;
        }
        return this.rebuildForCodebase(codebasePath, ignorePatterns);
    }

    public queryGraph(
        codebasePath: string,
        symbolRef: CallGraphSymbolRef,
        options: {
            direction: CallGraphDirection;
            depth: number;
            limit: number;
        }
    ): CallGraphQueryResponse {
        const languageSupport = this.isSupportedQueryLanguage(symbolRef.file);
        if (!languageSupport.supported) {
            return languageSupport;
        }

        const sidecar = this.loadSidecar(codebasePath);
        if (!sidecar) {
            return {
                supported: false,
                reason: 'missing_sidecar',
                hints: {
                    reindex: {
                        tool: 'manage_index',
                        args: {
                            action: 'reindex',
                            path: path.resolve(codebasePath),
                        },
                    },
                },
            };
        }

        const nodeById = new Map<string, CallGraphNode>(sidecar.nodes.map((node) => [node.symbolId, node]));
        if (!nodeById.has(symbolRef.symbolId)) {
            return {
                supported: false,
                reason: 'missing_symbol',
                hints: {
                    message: 'Symbol ID was not found in the call-graph sidecar. Use grouped search results to refresh callGraphHint.',
                },
            };
        }

        const maxDepth = Math.max(1, Math.min(3, options.depth));
        const maxEdges = Math.max(1, options.limit);
        const includeCallers = options.direction === 'callers' || options.direction === 'both';
        const includeCallees = options.direction === 'callees' || options.direction === 'both';

        const sortedEdges = this.sortEdges([...sidecar.edges]);
        const outgoing = new Map<string, CallGraphEdge[]>();
        const incoming = new Map<string, CallGraphEdge[]>();

        for (const edge of sortedEdges) {
            if (!outgoing.has(edge.srcSymbolId)) {
                outgoing.set(edge.srcSymbolId, []);
            }
            if (!incoming.has(edge.dstSymbolId)) {
                incoming.set(edge.dstSymbolId, []);
            }
            outgoing.get(edge.srcSymbolId)!.push(edge);
            incoming.get(edge.dstSymbolId)!.push(edge);
        }

        const visited = new Set<string>([symbolRef.symbolId]);
        let frontier = [symbolRef.symbolId];
        const selectedEdges = new Map<string, CallGraphEdge>();

        for (let depth = 1; depth <= maxDepth; depth++) {
            const nextFrontier: string[] = [];

            for (const symbolId of frontier) {
                const edgeList: CallGraphEdge[] = [];
                if (includeCallees) {
                    edgeList.push(...(outgoing.get(symbolId) || []));
                }
                if (includeCallers) {
                    edgeList.push(...(incoming.get(symbolId) || []));
                }

                for (const edge of edgeList) {
                    const edgeKey = this.getEdgeKey(edge);
                    if (!selectedEdges.has(edgeKey)) {
                        if (selectedEdges.size >= maxEdges) {
                            break;
                        }
                        selectedEdges.set(edgeKey, edge);
                    }

                    const peerId = edge.srcSymbolId === symbolId ? edge.dstSymbolId : edge.srcSymbolId;
                    if (!visited.has(peerId)) {
                        visited.add(peerId);
                        nextFrontier.push(peerId);
                    }
                }

                if (selectedEdges.size >= maxEdges) {
                    break;
                }
            }

            frontier = Array.from(new Set(nextFrontier));
            if (frontier.length === 0 || selectedEdges.size >= maxEdges) {
                break;
            }
        }

        const nodes = this.sortNodes(
            Array.from(visited)
                .map((symbolId) => nodeById.get(symbolId))
                .filter((node): node is CallGraphNode => Boolean(node))
        );

        const edges = this.sortEdges(Array.from(selectedEdges.values()));
        const notes = this.sortNotes(
            sidecar.notes.filter((note) => !note.symbolId || visited.has(note.symbolId))
        );

        return {
            supported: true,
            direction: options.direction,
            depth: maxDepth,
            limit: maxEdges,
            nodes,
            edges,
            notes,
            sidecar: {
                builtAt: sidecar.builtAt,
                nodeCount: sidecar.nodes.length,
                edgeCount: sidecar.edges.length,
            },
        };
    }

    private async buildGraph(codebaseRoot: string, files: string[]): Promise<{ nodes: CallGraphNode[]; edges: CallGraphEdge[]; notes: CallGraphNote[] }> {
        const nodeById = new Map<string, MutableNode>();
        const fileCache = new Map<string, { lines: string[]; language: string }>();
        const noteByKey = new Map<string, CallGraphNote>();

        for (const absoluteFile of files) {
            const relativeFile = this.toRelativePath(codebaseRoot, absoluteFile);
            const language = this.getSplitLanguage(relativeFile);
            if (language === 'unknown') {
                continue;
            }

            const content = await fs.promises.readFile(absoluteFile, 'utf8');
            const lines = content.split(/\r?\n/);
            fileCache.set(relativeFile, { lines, language });

            const chunks = await this.splitter.split(content, language, absoluteFile);
            for (const chunk of chunks) {
                const symbolLabel = typeof chunk.metadata.symbolLabel === 'string' ? chunk.metadata.symbolLabel : undefined;
                const startLine = Number.isFinite(chunk.metadata.startLine) ? Math.max(1, Number(chunk.metadata.startLine)) : 1;
                const endLine = Number.isFinite(chunk.metadata.endLine) ? Math.max(startLine, Number(chunk.metadata.endLine)) : startLine;
                const symbolId = typeof chunk.metadata.symbolId === 'string' ? chunk.metadata.symbolId : undefined;
                if (!symbolId) {
                    const note: CallGraphNote = {
                        type: 'missing_symbol_metadata',
                        file: relativeFile,
                        startLine,
                        detail: `Skipped chunk without symbol metadata at ${relativeFile}:${startLine}-${endLine}.`
                    };
                    noteByKey.set(`missing_symbol_metadata:${relativeFile}:${startLine}:${endLine}`, note);
                    continue;
                }
                this.upsertNode(nodeById, {
                    symbolId,
                    symbolLabel,
                    file: relativeFile,
                    language,
                    span: { startLine, endLine },
                });
            }
        }

        const nodes = this.sortNodes(Array.from(nodeById.values()));
        const symbolIndex = this.buildSymbolIndex(nodes);

        const edgeByKey = new Map<string, CallGraphEdge>();

        for (const node of nodes) {
            if (!this.shouldScanNodeAsSource(node.symbolLabel)) {
                continue;
            }

            const fileData = fileCache.get(node.file);
            if (!fileData) {
                continue;
            }

            for (let lineNo = node.span.startLine; lineNo <= Math.min(node.span.endLine, fileData.lines.length); lineNo++) {
                const rawLine = fileData.lines[lineNo - 1] || '';
                const line = this.stripInlineComments(rawLine, fileData.language);
                if (line.trim().length === 0) {
                    continue;
                }

                const importNames = this.extractImportNames(line, fileData.language);
                for (const importName of importNames) {
                    const target = this.resolveTargetNode(symbolIndex, node, importName, lineNo);
                    if (!target) {
                        continue;
                    }

                    const edge: CallGraphEdge = {
                        srcSymbolId: node.symbolId,
                        dstSymbolId: target.symbolId,
                        kind: 'import',
                        site: {
                            file: node.file,
                            startLine: lineNo,
                        },
                        confidence: target.file === node.file ? 0.65 : 0.55,
                    };
                    edgeByKey.set(this.getEdgeKey(edge), edge);
                }

                const callSites = this.extractCallSites(line);
                for (const callSite of callSites) {
                    if (CALL_KEYWORDS.has(callSite.name)) {
                        continue;
                    }
                    if (this.looksLikeDefinition(line, callSite.name)) {
                        continue;
                    }

                    const target = this.resolveTargetNode(symbolIndex, node, callSite.name, lineNo);
                    if (!target) {
                        const note: CallGraphNote = {
                            type: callSite.kind === 'dynamic' ? 'dynamic_edge' : 'unresolved_edge',
                            file: node.file,
                            startLine: lineNo,
                            symbolId: node.symbolId,
                            detail: `Could not resolve '${callSite.name}()' from ${node.symbolId}`,
                        };
                        noteByKey.set(`${note.type}:${note.file}:${note.startLine}:${note.symbolId}:${callSite.name}`, note);
                        continue;
                    }

                    const edge: CallGraphEdge = {
                        srcSymbolId: node.symbolId,
                        dstSymbolId: target.symbolId,
                        kind: callSite.kind,
                        site: {
                            file: node.file,
                            startLine: lineNo,
                        },
                        confidence: this.resolveConfidence(callSite.kind, node, target),
                    };
                    edgeByKey.set(this.getEdgeKey(edge), edge);
                }
            }
        }

        const edges = this.sortEdges(Array.from(edgeByKey.values()));
        const notes = this.sortNotes(Array.from(noteByKey.values()));

        return { nodes, edges, notes };
    }

    private buildSymbolIndex(nodes: CallGraphNode[]): Map<string, CallGraphNode[]> {
        const byName = new Map<string, CallGraphNode[]>();

        for (const node of nodes) {
            const names = this.extractSymbolNames(node.symbolLabel);
            for (const name of names) {
                if (!byName.has(name)) {
                    byName.set(name, []);
                }
                byName.get(name)!.push(node);
            }
        }

        for (const nodeList of byName.values()) {
            nodeList.sort((a, b) => {
                const fileCmp = this.compareNullableStringsAsc(a.file, b.file);
                if (fileCmp !== 0) return fileCmp;
                return this.compareNullableNumbersAsc(a.span.startLine, b.span.startLine);
            });
        }

        return byName;
    }

    private resolveTargetNode(index: Map<string, CallGraphNode[]>, source: CallGraphNode, name: string, callLine: number): CallGraphNode | undefined {
        const candidates = index.get(name.toLowerCase());
        if (!candidates || candidates.length === 0) {
            return undefined;
        }

        const sameFile = candidates.filter((candidate) => candidate.file === source.file);
        const pool = sameFile.length > 0 ? sameFile : candidates;
        const sortedPool = [...pool].sort((a, b) => {
            const aDist = Math.abs(a.span.startLine - callLine);
            const bDist = Math.abs(b.span.startLine - callLine);
            if (aDist !== bDist) return aDist - bDist;
            const fileCmp = this.compareNullableStringsAsc(a.file, b.file);
            if (fileCmp !== 0) return fileCmp;
            const startCmp = this.compareNullableNumbersAsc(a.span.startLine, b.span.startLine);
            if (startCmp !== 0) return startCmp;
            const labelCmp = this.compareNullableStringsAsc(a.symbolLabel, b.symbolLabel);
            if (labelCmp !== 0) return labelCmp;
            return this.compareNullableStringsAsc(a.symbolId, b.symbolId);
        });

        return sortedPool[0];
    }

    private extractImportNames(line: string, language: string): string[] {
        const names = new Set<string>();

        if (language === 'python') {
            const fromMatch = line.match(/^\s*from\s+[^\s]+\s+import\s+(.+)$/);
            if (fromMatch && fromMatch[1]) {
                for (const token of fromMatch[1].split(',')) {
                    const normalized = token.trim().split(/\s+as\s+/i)[0]?.trim();
                    if (normalized) {
                        names.add(normalized.toLowerCase());
                    }
                }
            }
        } else {
            const fromMatch = line.match(/^\s*import\s+(.+)\s+from\s+['"][^'"]+['"]/);
            if (fromMatch && fromMatch[1]) {
                const clause = fromMatch[1]
                    .replace(/[{}]/g, ' ')
                    .replace(/\bas\b/gi, ' ')
                    .replace(/\*/g, ' ');
                for (const token of clause.split(/[\s,]+/)) {
                    const normalized = token.trim();
                    if (normalized.length > 0) {
                        names.add(normalized.toLowerCase());
                    }
                }
            }
        }

        return Array.from(names);
    }

    private extractCallSites(line: string): Array<{ name: string; kind: 'call' | 'dynamic' }> {
        const sites: Array<{ name: string; kind: 'call' | 'dynamic' }> = [];
        const seen = new Set<string>();

        const memberCallRegex = /(?:\b[A-Za-z_$][\w$]*\.)+([A-Za-z_$][\w$]*)\s*\(/g;
        for (const match of line.matchAll(memberCallRegex)) {
            const name = (match[1] || '').toLowerCase();
            if (!name) continue;
            const key = `dynamic:${name}`;
            if (!seen.has(key)) {
                seen.add(key);
                sites.push({ name, kind: 'dynamic' });
            }
        }

        const directCallRegex = /\b([A-Za-z_$][\w$]*)\s*\(/g;
        for (const match of line.matchAll(directCallRegex)) {
            const name = (match[1] || '').toLowerCase();
            if (!name) continue;
            const key = `call:${name}`;
            if (!seen.has(key)) {
                seen.add(key);
                sites.push({ name, kind: 'call' });
            }
        }

        if (/\bgetattr\s*\(/.test(line)) {
            sites.push({ name: 'getattr', kind: 'dynamic' });
        }

        return sites;
    }

    private looksLikeDefinition(line: string, name: string): boolean {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`\\b(function|class|def)\\s+${escaped}\\b`, 'i');
        if (pattern.test(line)) {
            return true;
        }

        const methodPattern = new RegExp(`\\b${escaped}\\s*\\([^)]*\\)\\s*(=>|\\{)`, 'i');
        return methodPattern.test(line);
    }

    private shouldScanNodeAsSource(symbolLabel?: string): boolean {
        if (!symbolLabel) {
            return false;
        }

        const normalized = symbolLabel.toLowerCase();
        return normalized.includes('function ') || normalized.includes('method ') || normalized.startsWith('class ');
    }

    private extractSymbolNames(symbolLabel?: string): string[] {
        if (!symbolLabel) {
            return [];
        }

        const names: string[] = [];
        const normalized = symbolLabel.trim();

        const methodMatch = normalized.match(/^(?:async\s+)?method\s+([A-Za-z_$][\w$]*)\s*\(/i);
        if (methodMatch?.[1]) {
            names.push(methodMatch[1].toLowerCase());
        }

        const functionMatch = normalized.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/i);
        if (functionMatch?.[1]) {
            names.push(functionMatch[1].toLowerCase());
        }

        const classMatch = normalized.match(/^class\s+([A-Za-z_$][\w$]*)/i);
        if (classMatch?.[1]) {
            names.push(classMatch[1].toLowerCase());
        }

        return Array.from(new Set(names));
    }

    private resolveConfidence(kind: 'call' | 'dynamic', source: CallGraphNode, target: CallGraphNode): number {
        if (kind === 'dynamic') {
            return source.file === target.file ? 0.72 : 0.62;
        }
        return source.file === target.file ? 0.92 : 0.78;
    }

    private upsertNode(nodeById: Map<string, MutableNode>, node: MutableNode): void {
        const existing = nodeById.get(node.symbolId);
        if (!existing) {
            nodeById.set(node.symbolId, node);
            return;
        }

        existing.span.startLine = Math.min(existing.span.startLine, node.span.startLine);
        existing.span.endLine = Math.max(existing.span.endLine, node.span.endLine);
        if (!existing.symbolLabel && node.symbolLabel) {
            existing.symbolLabel = node.symbolLabel;
        }
    }

    private stripInlineComments(line: string, language: string): string {
        if (language === 'python') {
            return line.replace(/#.*$/, '');
        }
        return line.replace(/\/\/.*$/, '');
    }

    private getSplitLanguage(relativePath: string): string {
        const ext = path.extname(relativePath).toLowerCase();
        const language = getLanguageIdFromExtension(ext, 'unknown');
        if (language === 'python' || language === 'typescript' || language === 'javascript') {
            return language;
        }
        return 'unknown';
    }

    private isSupportedQueryLanguage(relativePath: string): CallGraphResponseUnsupported | { supported: true } {
        const ext = path.extname(relativePath).toLowerCase();
        if (QUERY_SUPPORTED_EXTENSIONS.has(ext)) {
            return { supported: true };
        }

        return {
            supported: false,
            reason: 'unsupported_language',
            hints: {
                supportedExtensions: Array.from(QUERY_SUPPORTED_EXTENSIONS).sort((a, b) => a.localeCompare(b)),
                supportedLanguages: QUERY_SUPPORTED_LANGUAGE_IDS,
                message: 'call_graph currently supports TypeScript, JavaScript, and Python symbols.',
            },
        };
    }

    private async collectSourceFiles(codebaseRoot: string, ignorePatterns: string[]): Promise<string[]> {
        const files: string[] = [];
        const matcher = ignore();
        matcher.add(DEFAULT_IGNORE_PATTERNS);
        if (ignorePatterns.length > 0) {
            matcher.add(ignorePatterns);
        }

        const walk = async (dir: string): Promise<void> => {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name.startsWith('.')) {
                    continue;
                }

                const absolutePath = path.join(dir, entry.name);
                const relativePath = this.toRelativePath(codebaseRoot, absolutePath);
                if (matcher.ignores(relativePath) || matcher.ignores(`${relativePath}/`)) {
                    continue;
                }

                if (entry.isDirectory()) {
                    await walk(absolutePath);
                    continue;
                }

                if (!entry.isFile()) {
                    continue;
                }

                const extension = path.extname(entry.name).toLowerCase();
                if (SUPPORTED_SOURCE_EXTENSIONS.has(extension)) {
                    files.push(absolutePath);
                }
            }
        };

        await walk(codebaseRoot);
        files.sort((a, b) => this.compareNullableStringsAsc(a, b));
        return files;
    }

    private getSidecarPath(codebasePath: string): string {
        const hash = crypto.createHash('md5').update(path.resolve(codebasePath)).digest('hex');
        return path.join(os.homedir(), '.satori', 'call-graph', `${hash}.json`);
    }

    private toRelativePath(codebaseRoot: string, absolutePath: string): string {
        return path.relative(codebaseRoot, absolutePath).replace(/\\/g, '/');
    }

    private getEdgeKey(edge: CallGraphEdge): string {
        return `${edge.srcSymbolId}:${edge.dstSymbolId}:${edge.kind}:${edge.site.file}:${edge.site.startLine}`;
    }

    private sortNodes(nodes: CallGraphNode[]): CallGraphNode[] {
        return nodes.sort((a, b) => {
            const fileCmp = this.compareNullableStringsAsc(a.file, b.file);
            if (fileCmp !== 0) return fileCmp;
            const startCmp = this.compareNullableNumbersAsc(a.span?.startLine, b.span?.startLine);
            if (startCmp !== 0) return startCmp;
            const labelCmp = this.compareNullableStringsAsc(a.symbolLabel, b.symbolLabel);
            if (labelCmp !== 0) return labelCmp;
            return this.compareNullableStringsAsc(a.symbolId, b.symbolId);
        });
    }

    private sortEdges(edges: CallGraphEdge[]): CallGraphEdge[] {
        return edges.sort((a, b) => {
            const srcCmp = this.compareNullableStringsAsc(a.srcSymbolId, b.srcSymbolId);
            if (srcCmp !== 0) return srcCmp;
            const dstCmp = this.compareNullableStringsAsc(a.dstSymbolId, b.dstSymbolId);
            if (dstCmp !== 0) return dstCmp;
            const kindCmp = this.compareNullableStringsAsc(a.kind, b.kind);
            if (kindCmp !== 0) return kindCmp;
            return this.compareNullableNumbersAsc(a.site?.startLine, b.site?.startLine);
        });
    }

    private sortNotes(notes: CallGraphNote[]): CallGraphNote[] {
        return notes.sort((a, b) => {
            const fileCmp = this.compareNullableStringsAsc(a.file, b.file);
            if (fileCmp !== 0) return fileCmp;
            const startCmp = this.compareNullableNumbersAsc(a.startLine, b.startLine);
            if (startCmp !== 0) return startCmp;
            const typeCmp = this.compareNullableStringsAsc(a.type, b.type);
            if (typeCmp !== 0) return typeCmp;
            const symbolCmp = this.compareNullableStringsAsc(a.symbolId, b.symbolId);
            if (symbolCmp !== 0) return symbolCmp;
            return this.compareNullableStringsAsc(a.detail, b.detail);
        });
    }

    private compareNullableNumbersAsc(a?: number, b?: number): number {
        const av = a === undefined || a === null ? Number.POSITIVE_INFINITY : a;
        const bv = b === undefined || b === null ? Number.POSITIVE_INFINITY : b;
        return av - bv;
    }

    private compareNullableStringsAsc(a?: string, b?: string): number {
        if (!a && !b) return 0;
        if (!a) return 1;
        if (!b) return -1;
        return a.localeCompare(b);
    }
}
