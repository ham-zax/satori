import type { ExtractedSymbol, ExtractedSymbolKind } from '../languages/types';
import { cbmExtractorHost, type CbmDefinitionRecord } from './cbm-extractor-host';
import { Utf8SourceMap } from './source-map';
import type { LanguageAnalysisInput } from './types';

// CBM definition labels with a Satori symbol kind. The per-file Module node,
// File, Variable, Field, Constant, Object, and the SQL-only labels (Table,
// View, Trigger, Index, Storage, Section, XData) have no Satori kind in v1 and
// are dropped, not approximated.
const KIND_BY_CBM_LABEL: Readonly<Record<string, ExtractedSymbolKind>> = {
    Function: 'function',
    Method: 'method',
    Class: 'class',
    Interface: 'interface',
    Struct: 'struct',
    Enum: 'enum',
    Trait: 'trait',
    Type: 'type',
    Macro: 'macro',
};

export function supportsCbmDefinitions(language: string, assetRoot?: string): boolean {
    return cbmExtractorHost(assetRoot).supports(language);
}

function parentPath(record: CbmDefinitionRecord): string[] {
    const suffix = `.${record.name}`;
    if (!record.qualifiedName.endsWith(suffix)) return [];
    return record.qualifiedName.slice(0, -suffix.length).split('.').filter(Boolean);
}

export function symbolsFromCbmDefinitions(
    records: readonly CbmDefinitionRecord[],
    source: string,
): ExtractedSymbol[] {
    const sourceMap = new Utf8SourceMap(source);
    const symbols: ExtractedSymbol[] = [];
    for (const record of records) {
        const kind = KIND_BY_CBM_LABEL[record.label];
        if (!kind || !record.name) continue;
        const parents = parentPath(record);
        symbols.push({
            kind,
            name: record.name,
            label: `${kind} ${record.name}`,
            qualifiedName: [...parents, record.name].join('.'),
            parentQualifiedNamePath: parents,
            span: sourceMap.span(record.startByte, record.endByte),
        });
    }
    return symbols;
}

export async function analyzeWithCbmDefinitions(
    input: LanguageAnalysisInput,
    assetRoot?: string,
): Promise<ExtractedSymbol[]> {
    const records = await cbmExtractorHost(assetRoot).extract(input.language, input.relativePath, input.content);
    return symbolsFromCbmDefinitions(records, input.content);
}
