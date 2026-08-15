import { isCallableSymbolKind, type SymbolRecord, type SymbolRegistry } from '../../symbols';
import type {
    CallResolutionContribution,
    CallResolutionEngine,
    CallResolutionEngineInput,
} from './contracts';
import {
    dependencyKeyForCall,
    type ResolutionClaim,
    resolutionAuthorityForProof,
    type ResolutionProofStep,
} from '../resolution';
import type { SemanticProjectEvidence } from '../../semantic/contracts';
import { defaultSemanticLanguageRegistry, type SemanticLanguageDescriptor, type SemanticLanguageRegistry } from '../../semantic/descriptor';
import { admitAuthoritativeProofBackedCalls } from '../admission';

function findEnclosingCaller(
    fileSymbols: readonly SymbolRecord[] | undefined,
    callSpan: { startByte?: number; endByte?: number; startLine: number; endLine: number },
): SymbolRecord | undefined {
    if (!fileSymbols || fileSymbols.length === 0) return undefined;

    let bestCandidate: SymbolRecord | undefined;
    let smallestSpan = Infinity;

    const hasByteCoords = callSpan.startByte !== undefined && callSpan.endByte !== undefined;

    for (const sym of fileSymbols) {
        if (!sym.span) continue;
        if (!isCallableSymbolKind(sym.kind)) continue;

        let contains = false;
        if (hasByteCoords) {
            if (sym.span.startByte !== undefined && sym.span.endByte !== undefined) {
                contains = callSpan.startByte! >= sym.span.startByte && callSpan.endByte! <= sym.span.endByte;
            }
        } else {
            contains = callSpan.startLine >= sym.span.startLine && callSpan.endLine <= sym.span.endLine;
        }

        if (contains) {
            const symSpan = (sym.span.endByte !== undefined && sym.span.startByte !== undefined)
                ? sym.span.endByte - sym.span.startByte
                : (sym.span.endLine - sym.span.startLine);
            if (symSpan < smallestSpan) {
                smallestSpan = symSpan;
                bestCandidate = sym;
            }
        }
    }

    // Fail closed: if no containing callable symbol matched the span, abstain (return undefined).
    // NEVER fall back to arbitrary file symbols.
    return bestCandidate;
}

function findExactSpanTarget(
    registry: SymbolRegistry,
    targetFile: string,
    targetName: string,
    targetSpan?: { startByte?: number; endByte?: number },
    ownerName?: string,
): SymbolRecord[] {
    const fileSymbols = registry.symbolsByFile.get(targetFile);
    if (!fileSymbols || fileSymbols.length === 0) return [];

    // Exact target binding requires exact byte span coordinates from native provenance
    if (targetSpan?.startByte === undefined || targetSpan?.endByte === undefined) {
        return [];
    }

    return fileSymbols.filter((sym: SymbolRecord) => {
        if (sym.kind === 'file') return false;

        // 1. Exact byte span match is the primary binding authority
        if (sym.span?.startByte !== targetSpan.startByte || sym.span?.endByte !== targetSpan.endByte) {
            return false;
        }

        // 2. Name validation as sanity check
        if (sym.name !== targetName && !sym.qualifiedName.endsWith(`.${targetName}`)) {
            return false;
        }

        // 3. Owner validation if provided
        if (ownerName) {
            return (
                sym.parentQualifiedNamePath.includes(ownerName) ||
                sym.qualifiedName.includes(ownerName)
            );
        }
        return true;
    });
}

export interface CbmResolutionInput extends CallResolutionEngineInput {
    readonly semanticEvidence?: SemanticProjectEvidence;
    readonly semanticEvidenceByLanguage?: ReadonlyMap<string, SemanticProjectEvidence> | Record<string, SemanticProjectEvidence>;
}

export class CbmSemanticContributionEngine implements CallResolutionEngine {
    private readonly descriptor: SemanticLanguageDescriptor;

    constructor(
        readonly language: string,
        descriptor?: SemanticLanguageDescriptor,
        registry: SemanticLanguageRegistry = defaultSemanticLanguageRegistry,
    ) {
        const desc = descriptor ?? registry.getDescriptor(language);
        if (!desc) {
            throw new Error(`Unregistered semantic language: '${language}'. A valid SemanticLanguageDescriptor must be registered in the registry.`);
        }
        this.descriptor = desc;
    }

    resolveCalls(input: CbmResolutionInput): CallResolutionContribution {
        const claimsByFile = new Map<string, ResolutionClaim[]>();
        const allClaims: ResolutionClaim[] = [];

        let semanticEvidence = input.semanticEvidence;
        if (!semanticEvidence && input.semanticEvidenceByLanguage) {
            semanticEvidence = input.semanticEvidenceByLanguage instanceof Map
                ? input.semanticEvidenceByLanguage.get(this.language)
                : (input.semanticEvidenceByLanguage as Record<string, SemanticProjectEvidence>)[this.language];
        }

        if (!semanticEvidence || semanticEvidence.language !== this.language) {
            return { records: [], claimsByFile: new Map() };
        }

        const providerId = this.descriptor.providerId;
        const providerVersion = this.descriptor.providerVersion;
        const environmentConfigId = this.descriptor.environmentConfigId;

        const sourceFilter = input.sourceFiles;

        for (const [filePath, occurrences] of semanticEvidence.occurrencesByFile) {
            if (sourceFilter && !sourceFilter.has(filePath)) {
                continue;
            }

            const fileSymbols = input.registry.symbolsByFile.get(filePath);
            const fileClaims: ResolutionClaim[] = [];

            for (const occ of occurrences) {
                const caller = findEnclosingCaller(fileSymbols, occ.callSpan);
                if (!caller) continue;

                const proofSteps: ResolutionProofStep[] = [
                    {
                        kind: 'call_site',
                        subject: occ.targetProvenance?.name ?? 'unknown',
                        span: occ.callSpan,
                    },
                    {
                        kind: 'containing_caller',
                        subject: caller.qualifiedName,
                        span: caller.span && caller.span.startByte !== undefined && caller.span.endByte !== undefined ? {
                            startLine: caller.span.startLine,
                            endLine: caller.span.endLine,
                            startByte: caller.span.startByte,
                            endByte: caller.span.endByte,
                            startColumn: caller.span.startColumn ?? 0,
                            endColumn: caller.span.endColumn ?? 0,
                        } : undefined,
                    },
                ];

                if (occ.proof.packageBinding) {
                    proofSteps.push({
                        kind: 'package_binding',
                        subject: occ.proof.packageBinding.importPath,
                        detail: occ.proof.packageBinding.packageIdentity,
                        span: occ.proof.packageBinding.span,
                    });
                }

                if (occ.proof.receiverBinding) {
                    proofSteps.push({
                        kind: 'receiver_type_binding',
                        subject: occ.proof.receiverBinding.receiverType,
                        detail: occ.proof.receiverBinding.kind,
                        span: occ.proof.receiverBinding.span,
                    });
                }

                if (occ.targetProvenance) {
                    proofSteps.push({
                        kind: 'exact_target_definition',
                        subject: occ.targetProvenance.name,
                        detail: occ.targetProvenance.file,
                        span: occ.targetProvenance.span,
                    });
                }

                let targetSymbol: SymbolRecord | undefined;
                let decision = occ.decision;

                if (decision === 'resolved' && !occ.targetProvenance) {
                    decision = 'unresolved';
                    proofSteps.push({
                        kind: 'unresolved_dependency',
                        subject: 'unknown',
                        detail: 'Resolved occurrence lacks target provenance',
                    });
                } else if (occ.targetProvenance && decision === 'resolved') {
                    const matches = findExactSpanTarget(
                        input.registry,
                        occ.targetProvenance.file,
                        occ.targetProvenance.name,
                        occ.targetProvenance.span,
                        occ.targetProvenance.ownerName,
                    );

                    if (matches.length === 1) {
                        targetSymbol = matches[0];
                    } else if (matches.length > 1) {
                        decision = 'ambiguous';
                        proofSteps.push({
                            kind: 'ambiguity',
                            subject: occ.targetProvenance.name,
                            detail: `Found ${matches.length} matching symbols at target span in ${occ.targetProvenance.file}`,
                        });
                    } else {
                        decision = 'unresolved';
                        proofSteps.push({
                            kind: 'unresolved_dependency',
                            subject: occ.targetProvenance.name,
                            detail: `No matching symbol record found at exact span in target file ${occ.targetProvenance.file}`,
                        });
                    }
                }

                if (decision === 'resolved' && !targetSymbol) {
                    decision = 'unresolved';
                }

                const depKey = dependencyKeyForCall({
                    file: filePath,
                    span: occ.callSpan,
                    receiverText: occ.targetProvenance?.ownerName,
                    calleeName: occ.targetProvenance?.name ?? '',
                });

                const claim: ResolutionClaim = {
                    providerId,
                    providerVersion,
                    environmentConfigId,
                    sourceFile: filePath,
                    sourceInstanceId: caller.symbolInstanceId,
                    ...(targetSymbol ? {
                        targetInstanceId: targetSymbol.symbolInstanceId,
                        targetSymbol: targetSymbol.qualifiedName,
                    } : {}),
                    callSpan: { ...occ.callSpan },
                    decision,
                    relationshipType: decision === 'resolved' ? 'CALLS' : 'REFERENCES',
                    resolutionAuthority: resolutionAuthorityForProof({
                        decision,
                        proofSteps,
                        flowHops: 0,
                    }),
                    proofSteps,
                    dependencyKeys: decision === 'resolved' ? [] : [depKey],
                    flowHops: 0,
                };

                fileClaims.push(claim);
                allClaims.push(claim);
            }

            claimsByFile.set(filePath, fileClaims);
        }

        // Central Satori admission: CBM proposes claims, Satori centrally admits them
        const records = admitAuthoritativeProofBackedCalls({
            registry: input.registry,
            claims: allClaims,
        });

        return {
            records,
            claimsByFile,
        };
    }
}
