import type { SourceSpan } from '../language-analysis';
import { RESOLUTION_CALL_CONSTRUCTS, type ResolutionCallConstruct, type ResolutionClaim } from './resolution';

export type ResolutionConstructCoverageStatus = 'ready' | 'partial' | 'unsupported';

export interface ResolutionConstructCoverageGap {
    readonly file: string;
    readonly span: SourceSpan;
    readonly decision: 'ambiguous' | 'unresolved';
    readonly resolutionAuthority: ResolutionClaim['resolutionAuthority'];
    readonly providerId: string;
    readonly providerVersion: string;
    readonly calleeName: string;
    readonly calleeText: string;
}

export interface ResolutionConstructCoverage {
    readonly construct: ResolutionCallConstruct;
    readonly status: ResolutionConstructCoverageStatus;
    readonly observedCount: number;
    readonly resolvedCount: number;
    readonly ambiguousCount: number;
    readonly unresolvedCount: number;
    readonly unsupportedCount: number;
    readonly providers: readonly {
        readonly providerId: string;
        readonly providerVersion: string;
    }[];
    readonly gapCount: number;
    readonly gapSpans: readonly ResolutionConstructCoverageGap[];
    readonly gapsTruncated: boolean;
}

function compareStrings(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function statusForCounts(input: {
    observedCount: number;
    resolvedCount: number;
    unsupportedCount: number;
}): ResolutionConstructCoverageStatus {
    if (input.observedCount > 0 && input.resolvedCount === input.observedCount) return 'ready';
    if (input.observedCount > 0 && input.unsupportedCount === input.observedCount) return 'unsupported';
    return 'partial';
}

/**
 * Summarize the semantic evidence that was actually observed in one validated
 * relationship Publication. This is deliberately evidence-derived: it does
 * not infer support from a static language capability table.
 */
export function summarizeResolutionConstructCoverage(
    claims: readonly ResolutionClaim[],
    options?: { readonly gapLimit?: number },
): ResolutionConstructCoverage[] {
    const gapLimit = Math.max(0, Math.floor(options?.gapLimit ?? 20));
    const byConstruct = new Map<ResolutionCallConstruct, ResolutionClaim[]>();
    for (const claim of claims) {
        const group = byConstruct.get(claim.observation.construct) ?? [];
        group.push(claim);
        byConstruct.set(claim.observation.construct, group);
    }

    return RESOLUTION_CALL_CONSTRUCTS
        .flatMap((construct): ResolutionConstructCoverage[] => {
            const observed = byConstruct.get(construct);
            if (!observed || observed.length === 0) return [];

            const sorted = [...observed].sort((left, right) => (
                compareStrings(left.sourceFile, right.sourceFile)
                || left.callSpan.startByte - right.callSpan.startByte
                || left.callSpan.endByte - right.callSpan.endByte
                || compareStrings(left.providerId, right.providerId)
            ));
            const resolvedCount = sorted.filter((claim) => claim.decision === 'resolved').length;
            const ambiguousCount = sorted.filter((claim) => claim.decision === 'ambiguous').length;
            const unsupportedCount = sorted.filter((claim) => claim.resolutionAuthority === 'unsupported').length;
            const unresolvedCount = sorted.filter((claim) => (
                claim.decision === 'unresolved' && claim.resolutionAuthority !== 'unsupported'
            )).length;
            const gaps = sorted.filter((claim) => claim.decision !== 'resolved');
            const providers = [...new Map(sorted.map((claim) => [
                `${claim.providerId}\0${claim.providerVersion}`,
                { providerId: claim.providerId, providerVersion: claim.providerVersion },
            ])).values()].sort((left, right) => (
                compareStrings(left.providerId, right.providerId)
                || compareStrings(left.providerVersion, right.providerVersion)
            ));

            return [{
                construct,
                status: statusForCounts({
                    observedCount: sorted.length,
                    resolvedCount,
                    unsupportedCount,
                }),
                observedCount: sorted.length,
                resolvedCount,
                ambiguousCount,
                unresolvedCount,
                unsupportedCount,
                providers,
                gapCount: gaps.length,
                gapSpans: gaps.slice(0, gapLimit).map((claim) => ({
                    file: claim.sourceFile,
                    span: { ...claim.callSpan },
                    decision: claim.decision as 'ambiguous' | 'unresolved',
                    resolutionAuthority: claim.resolutionAuthority,
                    providerId: claim.providerId,
                    providerVersion: claim.providerVersion,
                    calleeName: claim.observation.calleeName,
                    calleeText: claim.observation.calleeText,
                })),
                gapsTruncated: gaps.length > gapLimit,
            }];
        });
}
