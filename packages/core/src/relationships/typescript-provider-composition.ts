import { createHash } from 'node:crypto';

import type {
    ResolutionClaim,
    ResolutionProjectAnalyzer,
    ResolutionProjectEvidence,
    ResolutionProjectInput,
} from './resolution';

export const TYPESCRIPT_PROVIDER_COMPOSITE_ID = 'satori-typescript-provider-composite';
export const TYPESCRIPT_PROVIDER_COMPOSITE_VERSION = 'typescript-provider-composition-v1';

export type TypeScriptProviderParticipation = 'admission' | 'shadow';

export interface TypeScriptResolutionProviderLane {
    readonly analyzer: ResolutionProjectAnalyzer;
    readonly participation: TypeScriptProviderParticipation;
}

interface LaneEvidence {
    readonly participation: TypeScriptProviderParticipation;
    readonly evidence: ResolutionProjectEvidence;
}

function compareStrings(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function compareClaims(left: ResolutionClaim, right: ResolutionClaim): number {
    return (
        compareStrings(left.sourceFile, right.sourceFile)
        || left.callSpan.startByte - right.callSpan.startByte
        || left.callSpan.endByte - right.callSpan.endByte
        || compareStrings(left.providerId, right.providerId)
        || compareStrings(left.providerVersion, right.providerVersion)
        || compareStrings(left.decision, right.decision)
        || compareStrings(left.sourceInstanceId ?? '', right.sourceInstanceId ?? '')
        || compareStrings(left.targetInstanceId ?? '', right.targetInstanceId ?? '')
    );
}

function callSiteKey(claim: ResolutionClaim): string {
    return [
        claim.sourceFile,
        claim.callSpan.startByte,
        claim.callSpan.endByte,
    ].join('\0');
}

function stableHash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function mergeClaims(
    laneEvidence: readonly LaneEvidence[],
): ReadonlyMap<string, readonly ResolutionClaim[]> {
    const claimsByFile = new Map<string, ResolutionClaim[]>();
    for (const { evidence } of laneEvidence) {
        for (const [file, claims] of evidence.claimsByFile) {
            const merged = claimsByFile.get(file) ?? [];
            merged.push(...claims);
            claimsByFile.set(file, merged);
        }
    }
    return new Map(
        [...claimsByFile.entries()]
            .sort(([left], [right]) => compareStrings(left, right))
            .map(([file, claims]) => [file, claims.sort(compareClaims)]),
    );
}

function hasMaterialConflict(
    claims: readonly ResolutionClaim[],
    resolvedIdentity: string,
): boolean {
    for (const claim of claims) {
        if (claim.decision === 'resolved') {
            if (!claim.sourceInstanceId || !claim.targetInstanceId) return true;
            const identity = `${claim.sourceInstanceId}\0${claim.targetInstanceId}`;
            if (identity !== resolvedIdentity) return true;
            continue;
        }

        // A non-resolved lane with positive candidates is semantically withholding
        // authority, not merely lacking evidence. Provider identity is provenance,
        // not priority, so another lane cannot promote that site through the conflict.
        if (claim.observation.candidates.length > 0) return true;
    }
    return false;
}

function reconcileAdmissionClaims(
    laneEvidence: readonly LaneEvidence[],
): ReadonlyMap<string, readonly ResolutionClaim[]> {
    const admissionClaims = mergeClaims(
        laneEvidence.filter(({ participation }) => participation === 'admission'),
    );
    const reconciledByFile = new Map<string, readonly ResolutionClaim[]>();

    for (const [file, claims] of admissionClaims) {
        const bySite = new Map<string, ResolutionClaim[]>();
        for (const claim of claims) {
            const group = bySite.get(callSiteKey(claim)) ?? [];
            group.push(claim);
            bySite.set(callSiteKey(claim), group);
        }

        const reconciled: ResolutionClaim[] = [];
        for (const siteClaims of bySite.values()) {
            const resolved = siteClaims.filter((claim) => claim.decision === 'resolved');
            if (resolved.length === 0) {
                reconciled.push(...siteClaims);
                continue;
            }

            const first = resolved[0];
            if (!first.sourceInstanceId || !first.targetInstanceId) {
                reconciled.push(...siteClaims.filter((claim) => claim.decision !== 'resolved'));
                continue;
            }

            const identity = `${first.sourceInstanceId}\0${first.targetInstanceId}`;
            if (hasMaterialConflict(siteClaims, identity)) {
                reconciled.push(...siteClaims.filter((claim) => claim.decision !== 'resolved'));
                continue;
            }

            reconciled.push(...siteClaims);
        }

        reconciledByFile.set(file, reconciled.sort(compareClaims));
    }

    return reconciledByFile;
}

function mergeAffectedSourceFiles(
    laneEvidence: readonly LaneEvidence[],
): ReadonlySet<string> | undefined {
    if (laneEvidence.some(({ evidence }) => evidence.affectedSourceFiles === undefined)) {
        return undefined;
    }
    const affected = new Set<string>();
    for (const { evidence } of laneEvidence) {
        for (const file of evidence.affectedSourceFiles ?? []) affected.add(file);
    }
    return affected;
}

function mergeSourceControlFiles(laneEvidence: readonly LaneEvidence[]): readonly string[] {
    return [...new Set(
        laneEvidence.flatMap(({ evidence }) => evidence.sourceControlFiles ?? []),
    )].sort(compareStrings);
}

/**
 * TypeScript-only provider composition above neutral ResolutionClaims.
 *
 * Raw claims from every lane remain observable. Only admission lanes enter
 * reconciliation, and conflicting canonical caller/target evidence is removed
 * from the admission set so central Satori admission fails closed. Shadow lanes
 * therefore cannot change the Publication relationship graph.
 */
export class CompositeTypeScriptResolutionProjectAnalyzer implements ResolutionProjectAnalyzer {
    public constructor(private readonly lanes: readonly TypeScriptResolutionProviderLane[]) {
        if (lanes.length === 0) {
            throw new Error('TypeScript provider composition requires at least one lane.');
        }
    }

    public supportsLanguage(language: string): boolean {
        return (
            language.trim().toLowerCase() === 'typescript'
            && this.lanes.some(({ analyzer }) => analyzer.supportsLanguage(language))
        );
    }

    public async analyze(input: ResolutionProjectInput): Promise<ResolutionProjectEvidence> {
        const activeLanes = this.lanes.filter(({ analyzer }) => analyzer.supportsLanguage(input.language));
        if (activeLanes.length === 0) {
            throw new Error(`No TypeScript resolution provider supports '${input.language}'.`);
        }

        const laneEvidence: LaneEvidence[] = await Promise.all(activeLanes.map(async (lane) => ({
            participation: lane.participation,
            evidence: await lane.analyzer.analyze(input),
        })));
        const claimsByFile = mergeClaims(laneEvidence);
        const admissionClaimsByFile = reconcileAdmissionClaims(laneEvidence);
        const sourceControlFiles = mergeSourceControlFiles(laneEvidence);
        const affectedSourceFiles = mergeAffectedSourceFiles(laneEvidence);
        const environmentConfigId = `typescript-provider-composite:${stableHash(
            laneEvidence
                .map(({ participation, evidence }) => ({
                    participation,
                    providerId: evidence.providerId,
                    providerVersion: evidence.providerVersion,
                    environmentConfigId: evidence.environmentConfigId,
                }))
                .sort((left, right) => (
                    compareStrings(left.providerId, right.providerId)
                    || compareStrings(left.providerVersion, right.providerVersion)
                    || compareStrings(left.participation, right.participation)
                    || compareStrings(left.environmentConfigId, right.environmentConfigId)
                )),
        )}`;

        return {
            language: 'typescript',
            providerId: TYPESCRIPT_PROVIDER_COMPOSITE_ID,
            providerVersion: TYPESCRIPT_PROVIDER_COMPOSITE_VERSION,
            environmentConfigId,
            claimsByFile,
            admissionClaimsByFile,
            ...(affectedSourceFiles ? { affectedSourceFiles } : {}),
            ...(sourceControlFiles.length > 0 ? { sourceControlFiles } : {}),
        };
    }

    public async getSourceControlFiles(input: {
        readonly rootPath: string;
        readonly language: string;
        readonly sourceFiles: readonly string[];
    }): Promise<readonly string[]> {
        const controls = await Promise.all(
            this.lanes
                .filter(({ analyzer }) => analyzer.supportsLanguage(input.language))
                .map(({ analyzer }) => analyzer.getSourceControlFiles?.(input) ?? []),
        );
        return [...new Set(controls.flat())].sort(compareStrings);
    }

    public async dispose(): Promise<void> {
        const analyzers = [...new Set(this.lanes.map(({ analyzer }) => analyzer))];
        await Promise.all(analyzers.map((analyzer) => analyzer.dispose?.()));
    }
}
