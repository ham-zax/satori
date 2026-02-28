export const WARNING_CODES = {
    REINDEX_UNNECESSARY_IGNORE_ONLY: 'REINDEX_UNNECESSARY_IGNORE_ONLY',
    REINDEX_PREFLIGHT_UNKNOWN: 'REINDEX_PREFLIGHT_UNKNOWN',
    IGNORE_POLICY_PROBE_FAILED: 'IGNORE_POLICY_PROBE_FAILED',
    FILTER_MUST_UNSATISFIED: 'FILTER_MUST_UNSATISFIED',
    RERANKER_FAILED: 'RERANKER_FAILED',
} as const;

export type WarningCode = typeof WARNING_CODES[keyof typeof WARNING_CODES];

export const WARNING_CODE_SET: ReadonlySet<WarningCode> = new Set<WarningCode>(Object.values(WARNING_CODES));

export function isWarningCode(value: unknown): value is WarningCode {
    return typeof value === 'string' && WARNING_CODE_SET.has(value as WarningCode);
}
