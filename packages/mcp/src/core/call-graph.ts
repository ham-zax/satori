import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import crypto from 'node:crypto';
import ignore from 'ignore';
import {
    createLanguageAnalysisService,
    getLanguageIdFromExtension,
    getSupportedExtensionsForCapability,
    getSupportedLanguageIdsForCapability,
    type LanguageAnalysisPort,
    type LanguageAnalysisResult,
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

export interface CallGraphTestReference {
    file: string;
    symbolId: string;
    symbolLabel?: string;
    span: CallGraphSpan;
    site: {
        file: string;
        startLine: number;
        endLine?: number;
    };
    targetSymbolId: string;
    kind: CallGraphEdgeKind;
    confidence: number;
}

export interface CallGraphNote {
    type: 'unresolved_edge' | 'dynamic_edge' | 'missing_symbol_metadata' | 'suppressed_edge';
    file: string;
    startLine: number;
    symbolId?: string;
    symbolLabel?: string;
    confidence?: number;
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
    warnings?: string[];
    testReferences?: CallGraphTestReference[];
    notesTruncated: boolean;
    totalNoteCount: number;
    returnedNoteCount: number;
    sidecar: {
        builtAt: string;
        nodeCount: number;
        edgeCount: number;
    };
    /** Executable recovery steps when graph evidence is incomplete (e.g. notes-only inbound). */
    hints?: Record<string, unknown>;
}

export type CallGraphQueryResponse = CallGraphResponseSupported | CallGraphResponseUnsupported;

export interface CallGraphDeltaPolicy {
    shouldRebuild(changedFiles: string[]): boolean;
}

const SUPPORTED_SOURCE_EXTENSIONS = new Set(getSupportedExtensionsForCapability('callGraphBuild'));
const QUERY_SUPPORTED_EXTENSIONS = new Set(getSupportedExtensionsForCapability('callGraphQuery'));
const QUERY_SUPPORTED_LANGUAGE_IDS = getSupportedLanguageIdsForCapability('callGraphQuery');
const DEFAULT_IGNORE_PATTERNS = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/.next/**'];
const DEFAULT_CALL_GRAPH_NOTE_LIMIT = 200;
const DEFAULT_CALL_GRAPH_TEST_REFERENCE_LIMIT = 50;
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
    private readonly languageAnalyzer: LanguageAnalysisPort;
    private readonly now: () => number;
    private readonly deltaPolicy: CallGraphDeltaPolicy;
    private readonly noteLimit: number;

    constructor(
        runtimeFingerprint: IndexFingerprint,
        options?: {
            now?: () => number;
            deltaPolicy?: CallGraphDeltaPolicy;
            noteLimit?: number;
        }
    ) {
        this.runtimeFingerprint = runtimeFingerprint;
        this.languageAnalyzer = createLanguageAnalysisService();
        this.now = options?.now || (() => Date.now());
        this.deltaPolicy = options?.deltaPolicy || new SupportedSourceDeltaPolicy();
        this.noteLimit = Number.isFinite(options?.noteLimit)
            ? Math.max(1, Math.min(1000, Number(options?.noteLimit)))
            : DEFAULT_CALL_GRAPH_NOTE_LIMIT;
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

    public async rebuildForCodebase(
        codebasePath: string,
        ignorePatterns: string[] = [],
        assertMutationCurrent?: () => void,
    ): Promise<CallGraphSidecarInfo> {
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
        assertMutationCurrent?.();
        await fs.promises.mkdir(sidecarDir, { recursive: true });
        assertMutationCurrent?.();
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

    public async rebuildIfSupportedDelta(
        codebasePath: string,
        changedFiles: string[],
        ignorePatterns: string[] = [],
        assertMutationCurrent?: () => void,
    ): Promise<CallGraphSidecarInfo | null> {
        if (!this.shouldRebuildForDelta(changedFiles)) {
            return null;
        }
        return this.rebuildForCodebase(codebasePath, ignorePatterns, assertMutationCurrent);
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
        const visitedFiles = new Set<string>();
        for (const node of nodes) {
            visitedFiles.add(node.file);
        }
        for (const edge of edges) {
            visitedFiles.add(edge.site.file);
        }

        const relevantNotes = this.sortNotes(
            sidecar.notes.filter((note) => {
                if (!visitedFiles.has(note.file)) {
                    return false;
                }
                if (note.symbolId && !visited.has(note.symbolId)) {
                    return false;
                }
                return true;
            })
        );
        const totalNoteCount = relevantNotes.length;
        const notes = relevantNotes.slice(0, this.noteLimit);
        const notesTruncated = totalNoteCount > notes.length;
        const warnings = notesTruncated ? ['CALL_GRAPH_NOTES_TRUNCATED'] : undefined;
        const testReferences = this.buildTestReferences(sidecar, nodeById, visited).slice(0, DEFAULT_CALL_GRAPH_TEST_REFERENCE_LIMIT);

        return {
            supported: true,
            direction: options.direction,
            depth: maxDepth,
            limit: maxEdges,
            nodes,
            edges,
            notes,
            warnings,
            ...(testReferences.length > 0 ? { testReferences } : {}),
            notesTruncated,
            totalNoteCount,
            returnedNoteCount: notes.length,
            sidecar: {
                builtAt: sidecar.builtAt,
                nodeCount: sidecar.nodes.length,
                edgeCount: sidecar.edges.length,
            },
        };
    }

    private buildTestReferences(
        sidecar: CallGraphSidecar,
        nodeById: Map<string, CallGraphNode>,
        targetSymbolIds: Set<string>
    ): CallGraphTestReference[] {
        const referencesByKey = new Map<string, CallGraphTestReference>();

        for (const edge of sidecar.edges) {
            if (!targetSymbolIds.has(edge.dstSymbolId)) {
                continue;
            }

            const source = nodeById.get(edge.srcSymbolId);
            if (!source || !this.isTestPath(source.file)) {
                continue;
            }

            const reference: CallGraphTestReference = {
                file: source.file,
                symbolId: source.symbolId,
                symbolLabel: source.symbolLabel,
                span: {
                    startLine: source.span.startLine,
                    endLine: source.span.endLine,
                },
                site: {
                    file: edge.site.file,
                    startLine: edge.site.startLine,
                    ...(Number.isFinite(edge.site.endLine) ? { endLine: edge.site.endLine } : {}),
                },
                targetSymbolId: edge.dstSymbolId,
                kind: edge.kind,
                confidence: edge.confidence,
            };
            referencesByKey.set(this.getTestReferenceKey(reference), reference);
        }

        return this.sortTestReferences(Array.from(referencesByKey.values()));
    }

    private async buildGraph(codebaseRoot: string, files: string[]): Promise<{ nodes: CallGraphNode[]; edges: CallGraphEdge[]; notes: CallGraphNote[] }> {
        const nodeById = new Map<string, MutableNode>();
        const sourceSpanByNodeId = new Map<string, { startByte?: number; endByte?: number }>();
        const analysisByFile = new Map<string, LanguageAnalysisResult>();
        const noteByKey = new Map<string, CallGraphNote>();

        for (const absoluteFile of files) {
            const relativeFile = this.toRelativePath(codebaseRoot, absoluteFile);
            const language = this.getSplitLanguage(relativeFile);
            if (language === 'unknown') {
                continue;
            }

            const content = await fs.promises.readFile(absoluteFile, 'utf8');
            const analysis = await this.languageAnalyzer.analyze({ content, language, relativePath: relativeFile });
            analysisByFile.set(relativeFile, analysis);

            for (const symbol of analysis.symbols) {
                const symbolLabel = symbol.label;
                const startLine = symbol.span.startLine;
                const endLine = symbol.span.endLine;
                const startByte = symbol.span.startByte;
                const endByte = symbol.span.endByte;
                const symbolId = crypto.createHash('sha256')
                    .update(`${relativeFile}:${startLine}:${endLine}:${startByte ?? ''}:${endByte ?? ''}:${symbolLabel}`, 'utf8')
                    .digest('hex')
                    .slice(0, 16);
                sourceSpanByNodeId.set(symbolId, { startByte, endByte });
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

        for (const [relativeFile, analysis] of analysisByFile) {
            const fileNodes = nodes.filter((node) => node.file === relativeFile && this.shouldScanNodeAsSource(node.symbolLabel));
            for (const callSite of analysis.callSites) {
                if (CALL_KEYWORDS.has(callSite.calleeName.toLowerCase())) continue;
                const lineOwners = fileNodes
                    .filter((node) => (
                        node.span.startLine <= callSite.span.startLine
                        && node.span.endLine >= callSite.span.endLine
                    ));
                const byteOwners = lineOwners.filter((node) => {
                    const span = sourceSpanByNodeId.get(node.symbolId);
                    return span?.startByte !== undefined
                        && span.endByte !== undefined
                        && span.startByte <= callSite.span.startByte
                        && span.endByte >= callSite.span.endByte;
                });
                const owners = (byteOwners.length > 0
                    ? byteOwners
                    : lineOwners.filter((node) => {
                        const span = sourceSpanByNodeId.get(node.symbolId);
                        return span?.startByte === undefined || span.endByte === undefined;
                    }))
                    .sort((left, right) => (
                        this.compareSourceSpanSize(left, right, sourceSpanByNodeId)
                        || (left.symbolId < right.symbolId ? -1 : left.symbolId > right.symbolId ? 1 : 0)
                    ));
                const node = owners[0];
                if (!node) continue;
                const target = this.resolveTargetNode(
                    symbolIndex,
                    node,
                    callSite.calleeName,
                    callSite.span.startLine,
                );
                    if (!target) {
                        const note: CallGraphNote = {
                            type: 'unresolved_edge',
                            file: node.file,
                            startLine: callSite.span.startLine,
                            symbolId: node.symbolId,
                            detail: `Could not resolve '${callSite.calleeName}()' from ${node.symbolId}`,
                        };
                        noteByKey.set(`${note.type}:${note.file}:${note.startLine}:${note.symbolId}:${callSite.calleeName}`, note);
                        continue;
                    }

                    const edge: CallGraphEdge = {
                        srcSymbolId: node.symbolId,
                        dstSymbolId: target.symbolId,
                        kind: 'call',
                        site: {
                            file: node.file,
                            startLine: callSite.span.startLine,
                            endLine: callSite.span.endLine,
                        },
                        confidence: this.resolveConfidence('call', node, target),
                    };
                    edgeByKey.set(this.getEdgeKey(edge), edge);
            }
        }

        const edges = this.sortEdges(Array.from(edgeByKey.values()));
        const notes = this.sortNotes(Array.from(noteByKey.values()));

        return { nodes, edges, notes };
    }

    private compareSourceSpanSize(
        left: CallGraphNode,
        right: CallGraphNode,
        sourceSpanByNodeId: ReadonlyMap<string, { startByte?: number; endByte?: number }>,
    ): number {
        const leftSpan = sourceSpanByNodeId.get(left.symbolId);
        const rightSpan = sourceSpanByNodeId.get(right.symbolId);
        if (
            leftSpan?.startByte !== undefined
            && leftSpan.endByte !== undefined
            && rightSpan?.startByte !== undefined
            && rightSpan.endByte !== undefined
        ) {
            const byteSize = (leftSpan.endByte - leftSpan.startByte)
                - (rightSpan.endByte - rightSpan.startByte);
            if (byteSize !== 0) return byteSize;
        }
        return (left.span.endLine - left.span.startLine)
            - (right.span.endLine - right.span.startLine);
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

        const methodMatch = normalized.match(/^(?:async\s+)?method\s+([A-Za-z_$][\w$]*)(?:\s*\(|$)/i);
        if (methodMatch?.[1]) {
            names.push(methodMatch[1].toLowerCase());
        }

        const functionMatch = normalized.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)(?:\s*\(|$)/i);
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
                supportedExtensions: Array.from(QUERY_SUPPORTED_EXTENSIONS as Set<string>).sort((a, b) => a.localeCompare(b)),
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

    private getTestReferenceKey(reference: CallGraphTestReference): string {
        return `${reference.symbolId}:${reference.targetSymbolId}:${reference.kind}:${reference.site.file}:${reference.site.startLine}`;
    }

    private isTestPath(relativePath: string): boolean {
        const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
        return this.hasPathSegment(normalizedPath, 'test')
            || this.hasPathSegment(normalizedPath, 'tests')
            || this.hasPathSegment(normalizedPath, '__tests__')
            || /\.test\.[^/]+$/.test(normalizedPath)
            || /\.spec\.[^/]+$/.test(normalizedPath);
    }

    private hasPathSegment(normalizedPath: string, segment: string): boolean {
        return normalizedPath === segment
            || normalizedPath.startsWith(`${segment}/`)
            || normalizedPath.includes(`/${segment}/`);
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

    private sortTestReferences(references: CallGraphTestReference[]): CallGraphTestReference[] {
        return references.sort((a, b) => {
            const fileCmp = this.compareNullableStringsAsc(a.file, b.file);
            if (fileCmp !== 0) return fileCmp;
            const startCmp = this.compareNullableNumbersAsc(a.span?.startLine, b.span?.startLine);
            if (startCmp !== 0) return startCmp;
            const labelCmp = this.compareNullableStringsAsc(a.symbolLabel, b.symbolLabel);
            if (labelCmp !== 0) return labelCmp;
            const symbolCmp = this.compareNullableStringsAsc(a.symbolId, b.symbolId);
            if (symbolCmp !== 0) return symbolCmp;
            const targetCmp = this.compareNullableStringsAsc(a.targetSymbolId, b.targetSymbolId);
            if (targetCmp !== 0) return targetCmp;
            const siteFileCmp = this.compareNullableStringsAsc(a.site?.file, b.site?.file);
            if (siteFileCmp !== 0) return siteFileCmp;
            return this.compareNullableNumbersAsc(a.site?.startLine, b.site?.startLine);
        });
    }

    private sortNotes(notes: CallGraphNote[]): CallGraphNote[] {
        return notes.sort((a, b) => {
            const fileCmp = this.compareNullableStringsAsc(a.file, b.file);
            if (fileCmp !== 0) return fileCmp;
            const typeCmp = this.compareNullableStringsAsc(a.type, b.type);
            if (typeCmp !== 0) return typeCmp;
            const symbolCmp = this.compareNullableStringsAsc(a.symbolId, b.symbolId);
            if (symbolCmp !== 0) return symbolCmp;
            const startCmp = this.compareNullableNumbersAsc(a.startLine, b.startLine);
            if (startCmp !== 0) return startCmp;
            const aHash = crypto.createHash('sha1').update(a.detail || '').digest('hex');
            const bHash = crypto.createHash('sha1').update(b.detail || '').digest('hex');
            return this.compareNullableStringsAsc(aHash, bHash);
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
