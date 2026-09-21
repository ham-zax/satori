import { isRepositoryRelativePath } from '../paths/repository-path';
import type { PythonFlowFact } from '../language-analysis';
import type { RelationshipAnalysisEvidence } from '../relationships';
import {
    isResolutionAuthority,
    MAX_PYTHON_FLOW_HOPS,
    NATIVE_PYTHON_PROVIDER_ID,
    type ResolutionClaim,
} from '../relationships/resolution';
import {
    isCanonicalResolutionClaim,
} from '../relationships/resolution-claim-validation';
export {
    isResolutionProofStep,
} from '../relationships/resolution-claim-validation';
import {
    isStructuralDefinitionStatus,
    isSymbolKind,
} from './contracts';
import type {
    RelationshipRecord,
    SymbolRecord,
    SymbolRegistryManifestFile,
} from './contracts';

export const SYMBOL_INDEX_SCHEMA_VERSION = 'symbol_index_v3';

export interface SymbolIndexFileEntry {
    path: string;
    hash: string;
    language: string;
    symbolCount: number;
    definitionStatus: SymbolRegistryManifestFile['definitionStatus'];
    shardPath: string;
    shardHash: string;
}

export interface SymbolIndexFile {
    schemaVersion: typeof SYMBOL_INDEX_SCHEMA_VERSION;
    manifestHash: string;
    files: SymbolIndexFileEntry[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
    return Number.isInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
    return Number.isInteger(value) && Number(value) >= 1;
}

function isOptionalNonEmptyString(value: unknown): boolean {
    return value === undefined || isNonEmptyString(value);
}

function isSymbolSpan(value: unknown): boolean {
    if (!isRecord(value)) {
        return false;
    }
    if (!isPositiveInteger(value.startLine) || !isPositiveInteger(value.endLine)) {
        return false;
    }
    if (value.endLine < value.startLine) {
        return false;
    }
    for (const field of ['startByte', 'endByte', 'startColumn', 'endColumn']) {
        if (value[field] !== undefined && !isNonNegativeInteger(value[field])) {
            return false;
        }
    }
    if (
        typeof value.startByte === 'number'
        && typeof value.endByte === 'number'
        && value.endByte < value.startByte
    ) {
        return false;
    }
    if (
        value.startLine === value.endLine
        && typeof value.startColumn === 'number'
        && typeof value.endColumn === 'number'
        && value.endColumn < value.startColumn
    ) {
        return false;
    }
    return true;
}

export function isSymbolIndexFile(value: unknown): value is SymbolIndexFile {
    if (!isRecord(value)) {
        return false;
    }
    return value.schemaVersion === SYMBOL_INDEX_SCHEMA_VERSION
        && isNonEmptyString(value.manifestHash)
        && Array.isArray(value.files)
        && value.files.every((file) => (
            isRecord(file)
            && isRepositoryRelativePath(file.path)
            && isNonEmptyString(file.hash)
            && isNonEmptyString(file.language)
            && isNonNegativeInteger(file.symbolCount)
            && isStructuralDefinitionStatus(file.definitionStatus)
            && isRepositoryRelativePath(file.shardPath)
            && typeof file.shardHash === 'string'
            && /^[a-f0-9]{64}$/.test(file.shardHash)
        ));
}

export function isSymbolRecord(value: unknown): value is SymbolRecord {
    if (!isRecord(value)) {
        return false;
    }
    for (const field of [
        'symbolKey',
        'symbolInstanceId',
        'language',
        'name',
        'qualifiedName',
        'label',
        'file',
        'fileHash',
        'extractorVersion',
    ]) {
        if (!isNonEmptyString(value[field])) {
            return false;
        }
    }
    if (!isSymbolKind(value.kind)) {
        return false;
    }
    if (!isSymbolSpan(value.span)) {
        return false;
    }
    if (!isOptionalNonEmptyString(value.parentKey)) {
        return false;
    }
    if (!Array.isArray(value.parentQualifiedNamePath) || !value.parentQualifiedNamePath.every((item) => typeof item === 'string')) {
        return false;
    }
    if (value.exported !== undefined && typeof value.exported !== 'boolean') {
        return false;
    }
    if (value.ontologyTags !== undefined && (!Array.isArray(value.ontologyTags) || !value.ontologyTags.every(isNonEmptyString))) {
        return false;
    }
    return true;
}

const VALID_RELATIONSHIP_TYPES = new Set([
    'CALLS',
    'IMPORTS',
    'EXPORTS',
    'EXTENDS',
    'IMPLEMENTS',
    'REFERENCES',
    'TESTS',
    'GENERATES',
    'CONFIGURES',
]);

export function isRelationshipRecord(value: unknown): value is RelationshipRecord {
    if (!isRecord(value)) {
        return false;
    }
    const hasTarget = isNonEmptyString(value.targetKey)
        || isNonEmptyString(value.targetInstanceId)
        || isNonEmptyString(value.targetPath);
    return isNonEmptyString(value.sourceKey)
        && hasTarget
        && isNonEmptyString(value.type)
        && VALID_RELATIONSHIP_TYPES.has(value.type)
        && isNonEmptyString(value.file)
        && isOptionalNonEmptyString(value.sourceInstanceId)
        && isOptionalNonEmptyString(value.targetKey)
        && isOptionalNonEmptyString(value.targetInstanceId)
        && isOptionalNonEmptyString(value.targetPath)
        && (value.span === undefined || isSymbolSpan(value.span))
        && (value.confidence === 'high' || value.confidence === 'medium' || value.confidence === 'low')
        && (value.args === undefined || (Array.isArray(value.args) && value.args.every(arg => typeof arg === 'string')))
        && (value.strategy === undefined || value.strategy === 'rule' || value.strategy === 'heuristic')
        && (value.resolutionAuthority === undefined || isResolutionAuthority(value.resolutionAuthority));
}

function isSourceSpan(value: unknown): boolean {
    if (!isSymbolSpan(value) || !isRecord(value)) return false;
    return ['startByte', 'endByte', 'startColumn', 'endColumn']
        .every((field) => isNonNegativeInteger(value[field]));
}

const PYTHON_FLOW_VALUE_KINDS = new Set(['constructor', 'call', 'member', 'identifier', 'unknown']);

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const allowed = new Set(keys);
    return Object.keys(value).every((key) => allowed.has(key));
}

export function isPythonFlowFact(value: unknown): value is PythonFlowFact {
    if (!isRecord(value) || typeof value.kind !== 'string') return false;
    if (value.kind === 'assignment_origin') {
        return hasOnlyKeys(value, [
            'kind',
            'targetText',
            'valueText',
            'valueKind',
            'constructorTypeName',
            'calleeName',
            'span',
            'contextSpan',
        ])
            && isNonEmptyString(value.targetText)
            && isNonEmptyString(value.valueText)
            && typeof value.valueKind === 'string'
            && PYTHON_FLOW_VALUE_KINDS.has(value.valueKind)
            && isOptionalNonEmptyString(value.constructorTypeName)
            && isOptionalNonEmptyString(value.calleeName)
            && isSourceSpan(value.span)
            && isSourceSpan(value.contextSpan);
    }
    if (value.kind === 'call_argument') {
        return hasOnlyKeys(value, [
            'kind',
            'calleeText',
            'argumentName',
            'argumentIndex',
            'valueText',
            'span',
            'contextSpan',
        ])
            && isNonEmptyString(value.calleeText)
            && isOptionalNonEmptyString(value.argumentName)
            && (value.argumentIndex === undefined || isNonNegativeInteger(value.argumentIndex))
            && isNonEmptyString(value.valueText)
            && isSourceSpan(value.span)
            && isSourceSpan(value.contextSpan);
    }
    if (value.kind === 'callable_signature') {
        return hasOnlyKeys(value, [
            'kind',
            'callableName',
            'parameterNames',
            'positionalExact',
            'decorated',
            'span',
            'contextSpan',
        ])
            && isNonEmptyString(value.callableName)
            && Array.isArray(value.parameterNames)
            && value.parameterNames.every(isNonEmptyString)
            && typeof value.positionalExact === 'boolean'
            && typeof value.decorated === 'boolean'
            && isSourceSpan(value.span)
            && isSourceSpan(value.contextSpan);
    }
    if (value.kind !== 'class_bases') return false;
    return hasOnlyKeys(value, ['kind', 'className', 'baseNames', 'span', 'contextSpan'])
        && isNonEmptyString(value.className)
        && Array.isArray(value.baseNames)
        && value.baseNames.every(isNonEmptyString)
        && isSourceSpan(value.span)
        && isSourceSpan(value.contextSpan);
}

export function isResolutionClaim(value: unknown): value is ResolutionClaim {
    return isCanonicalResolutionClaim(value)
        && (value.providerId !== NATIVE_PYTHON_PROVIDER_ID || value.flowHops <= MAX_PYTHON_FLOW_HOPS);
}

export function isRelationshipAnalysisEvidence(value: unknown): value is RelationshipAnalysisEvidence {
    if (
        !isRecord(value)
        || !hasOnlyKeys(value, ['moduleBindings', 'callSites', 'receiverTypeBindings', 'pythonFlowFacts', 'resolutionClaims'])
        || !Array.isArray(value.moduleBindings)
        || !Array.isArray(value.callSites)
        || !Array.isArray(value.receiverTypeBindings)
    ) {
        return false;
    }
    const bindingsValid = value.moduleBindings.every((binding) => {
        if (!isRecord(binding)) return false;
        if (binding.kind !== 'import' && binding.kind !== 'reexport' && binding.kind !== 'export') return false;
        if (typeof binding.typeOnly !== 'boolean' || !isSourceSpan(binding.span)) return false;
        return ['moduleSpecifier', 'importedName', 'localName', 'exportedName']
            .every((field) => isOptionalNonEmptyString(binding[field]));
    });
    const callsValid = value.callSites.every((call) => (
        isRecord(call)
        && (call.args === undefined || (Array.isArray(call.args) && call.args.every(arg => typeof arg === 'string')))
        && isNonEmptyString(call.calleeName)
        && isSourceSpan(call.span)
    ));
    const receiverTypesValid = value.receiverTypeBindings.every((binding) => {
        if (
            !isRecord(binding)
            || !isNonEmptyString(binding.localName)
            || !isNonEmptyString(binding.typeName)
            || !isSourceSpan(binding.span)
        ) {
            return false;
        }
        if (binding.kind === 'local_constructor') {
            return Object.keys(binding).length === 5 && isSourceSpan(binding.statementBlockSpan);
        }
        return Object.keys(binding).length === 4
            && (
                binding.kind === 'parameter_annotation'
                || binding.kind === 'local_annotation'
                || binding.kind === 'self_field_constructor'
            );
    });
    const flowFactsValid = value.pythonFlowFacts === undefined
        || (Array.isArray(value.pythonFlowFacts) && value.pythonFlowFacts.every(isPythonFlowFact));
    const claimsValid = value.resolutionClaims === undefined
        || (Array.isArray(value.resolutionClaims) && value.resolutionClaims.every(isResolutionClaim));
    return bindingsValid && callsValid && receiverTypesValid && flowFactsValid && claimsValid;
}
