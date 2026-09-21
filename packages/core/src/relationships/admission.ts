import { isCallableSymbolKind, type RelationshipRecord, type SymbolRegistry } from '../symbols';
import type { ResolutionClaim } from './resolution';
import { isCanonicalResolutionClaim } from './resolution-claim-validation';

/**
 * Centrally admits resolved call claims proposed by language providers,
 * verifying that the decision is resolved, authority is approved, both
 * source and target symbol instances exist in the current registry,
 * both symbols are callable kinds, and
 * provenance boundaries (source file match, span containment) hold.
 */
export function admitAuthoritativeProofBackedCalls(input: {
    registry: SymbolRegistry;
    claims: readonly ResolutionClaim[];
}): RelationshipRecord[] {
    const symbolsByInstanceId = new Map(
        input.registry.symbols.map((symbol) => [symbol.symbolInstanceId, symbol]),
    );
    const admitted: RelationshipRecord[] = [];

    for (const claim of input.claims) {
        if (!isCanonicalResolutionClaim(claim) || claim.decision !== 'resolved') continue;
        if (!claim.sourceInstanceId || !claim.targetInstanceId || !claim.targetSymbol) continue;

        const { sourceInstanceId, targetInstanceId } = claim;

        const source = symbolsByInstanceId.get(sourceInstanceId);
        const target = symbolsByInstanceId.get(targetInstanceId);
        if (!source || !target) continue;
        if (claim.targetSymbol !== target.qualifiedName) continue;

        // Invariant: both source (caller) and target (callee) must be callable symbol kinds
        if (!isCallableSymbolKind(source.kind) || !isCallableSymbolKind(target.kind)) continue;

        // Invariant: claim sourceFile must match source symbol file
        if (claim.sourceFile !== source.file) continue;

        // Invariant: call span must fall within source symbol line boundaries if span is defined
        if (source.span) {
            const hasByteCoords =
                claim.callSpan.startByte !== undefined &&
                claim.callSpan.endByte !== undefined &&
                source.span.startByte !== undefined &&
                source.span.endByte !== undefined;

            if (hasByteCoords) {
                const withinByte =
                    claim.callSpan.startByte! >= source.span.startByte! &&
                    claim.callSpan.endByte! <= source.span.endByte!;
                if (!withinByte) {
                    continue;
                }
            } else {
                const withinLine =
                    claim.callSpan.startLine >= source.span.startLine &&
                    claim.callSpan.endLine <= source.span.endLine;
                if (!withinLine) {
                    continue;
                }
            }
        }

        const record: RelationshipRecord = {
            sourceKey: source.symbolKey,
            sourceInstanceId: source.symbolInstanceId,
            targetKey: target.symbolKey,
            targetInstanceId: target.symbolInstanceId,
            type: 'CALLS',
            file: source.file,
            span: claim.callSpan,
            confidence: target.file === source.file ? 'high' : 'low',
            resolutionAuthority: claim.resolutionAuthority,
        };
        admitted.push(record);
    }

    return admitted;
}

export const admitResolvedCallClaims = admitAuthoritativeProofBackedCalls;
