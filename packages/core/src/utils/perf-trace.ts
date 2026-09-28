/**
 * Opt-in performance tracing for profiling indexing and sync.
 *
 * Off by default and free when off. Set `SATORI_PERF_TRACE=1` to write one JSON
 * line per span to stderr, prefixed `[perf]`, e.g.
 *   [perf] {"span":"navigation.semantic","language":"go","files":3295,"ms":4102.3}
 * `scripts/perf/` tools collect and summarize these lines.
 */
export function isPerfTraceEnabled(): boolean {
    const value = process.env.SATORI_PERF_TRACE;
    return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

export function perfTrace(span: string, ms: number, fields: Readonly<Record<string, string | number | boolean>> = {}): void {
    if (!isPerfTraceEnabled()) return;
    process.stderr.write(`[perf] ${JSON.stringify({ span, ...fields, ms: Math.round(ms * 10) / 10 })}\n`);
}

/** Times `run` as `span` when tracing is on; otherwise just runs it. */
export async function perfSpan<T>(
    span: string,
    run: () => Promise<T> | T,
    fields: Readonly<Record<string, string | number | boolean>> = {},
): Promise<T> {
    if (!isPerfTraceEnabled()) return run();
    const startedAt = performance.now();
    try {
        return await run();
    } finally {
        perfTrace(span, performance.now() - startedAt, fields);
    }
}
