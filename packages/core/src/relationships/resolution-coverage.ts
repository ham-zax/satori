import type { SourceSpan } from '../language-analysis';
import type { RelationshipRecord } from '../symbols';
import {
    RESOLUTION_CALL_CONSTRUCTS,
    isProofBackedAuthoritativeCall,
    type ResolutionCallConstruct,
    type ResolutionClaim,
} from './resolution';

export type ResolutionConstructCoverageStatus = 'ready' | 'partial' | 'unsupported';

export interface ResolutionConstructCoverageGap {
    readonly file: string;
    readonly span: SourceSpan;
    readonly decision: ResolutionClaim['decision'];
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
    /** Provider-resolved observations withheld by publication admission. */
    readonly withheldResolvedCount?: number;
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
    const repositoryRelevantCount = input.observedCount - input.unsupportedCount;
    if (input.observedCount > 0 && repositoryRelevantCount === 0) return 'unsupported';
    if (repositoryRelevantCount > 0 && input.resolvedCount === repositoryRelevantCount) return 'ready';
    return 'partial';
}

function exactCallSiteKey(input: {
    file: string;
    sourceInstanceId?: string;
    span?: {
        startByte?: number;
        endByte?: number;
    };
}): string | undefined {
    if (
        !input.sourceInstanceId
        || input.span?.startByte === undefined
        || input.span?.endByte === undefined
    ) {
        return undefined;
    }
    return [input.file, input.sourceInstanceId, input.span.startByte, input.span.endByte].join('\0');
}

function authoritativeResolvedCallTargets(
    relationships: readonly RelationshipRecord[],
): ReadonlyMap<string, ReadonlySet<string>> {
    const resolved = new Map<string, Set<string>>();
    for (const relationship of relationships) {
        if (!isProofBackedAuthoritativeCall(relationship) || !relationship.targetInstanceId) continue;
        const key = exactCallSiteKey({
            file: relationship.file,
            sourceInstanceId: relationship.sourceInstanceId,
            span: relationship.span,
        });
        if (!key) continue;
        const targets = resolved.get(key) ?? new Set<string>();
        targets.add(relationship.targetInstanceId);
        resolved.set(key, targets);
    }
    return resolved;
}

/**
 * Summarize the semantic evidence that was actually observed in one validated
 * relationship Publication. This is deliberately evidence-derived: it does
 * not infer support from a static language capability table.
 */
export function summarizeResolutionConstructCoverage(
    claims: readonly ResolutionClaim[],
    options?: {
        readonly gapLimit?: number;
        readonly relationships?: readonly RelationshipRecord[];
    },
): ResolutionConstructCoverage[] {
    const gapLimit = Math.max(0, Math.floor(options?.gapLimit ?? 20));
    const resolvedCallTargets = authoritativeResolvedCallTargets(options?.relationships ?? []);
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
            const isResolvedForCoverage = (claim: ResolutionClaim): boolean => {
                const key = exactCallSiteKey({
                    file: claim.sourceFile,
                    sourceInstanceId: claim.sourceInstanceId,
                    span: claim.callSpan,
                });
                const publishedTargets = key ? resolvedCallTargets.get(key) : undefined;
                if (publishedTargets) {
                    // Non-resolved observations describe the same site that publication
                    // successfully resolved through another provider. A provider-resolved
                    // observation counts only when it names the target actually published.
                    if (claim.decision !== 'resolved') return true;
                    return Boolean(
                        claim.targetInstanceId
                        && publishedTargets.has(claim.targetInstanceId)
                    );
                }
                // Publication-backed callers must report what central admission actually
                // published, not a shadow provider's resolved opinion. Standalone callers
                // without relationship context retain the claim-local fallback.
                if (options?.relationships !== undefined) return false;
                return claim.decision === 'resolved';
            };
            const resolvedCount = sorted.filter(isResolvedForCoverage).length;
            const ambiguousCount = sorted.filter((claim) => (
                !isResolvedForCoverage(claim) && claim.decision === 'ambiguous'
            )).length;
            const unsupportedCount = sorted.filter((claim) => (
                !isResolvedForCoverage(claim) && claim.resolutionAuthority === 'unsupported'
            )).length;
            const unresolvedCount = sorted.filter((claim) => (
                !isResolvedForCoverage(claim)
                && claim.decision === 'unresolved'
                && claim.resolutionAuthority !== 'unsupported'
            )).length;
            const withheldResolvedCount = sorted.filter((claim) => (
                !isResolvedForCoverage(claim) && claim.decision === 'resolved'
            )).length;
            const gaps = sorted.filter((claim) => (
                !isResolvedForCoverage(claim) && claim.resolutionAuthority !== 'unsupported'
            ));
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
                ...(withheldResolvedCount > 0 ? { withheldResolvedCount } : {}),
                unsupportedCount,
                providers,
                gapCount: gaps.length,
                gapSpans: gaps.slice(0, gapLimit).map((claim) => ({
                    file: claim.sourceFile,
                    span: { ...claim.callSpan },
                    decision: claim.decision,
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
