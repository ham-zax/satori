import type { SourceSpan } from '../language-analysis';
import { isCallableSymbolKind, type SymbolRecord, type SymbolRegistry } from '../symbols';
import type {
    TypeScriptCallEvidence,
    TypeScriptSemanticTarget,
} from '../semantic/typescript-compiler-provider';
import type {
    ResolutionAuthority,
    ResolutionCallConstruct,
    ResolutionClaim,
    ResolutionDecision,
    ResolutionObservedCandidate,
    ResolutionProofStep,
} from './resolution';

function spanMatches(
    symbol: SymbolRecord,
    target: TypeScriptSemanticTarget,
): boolean {
    return symbol.span.startByte === target.span.startByte
        && symbol.span.endByte === target.span.endByte;
}

function ownerMatches(symbol: SymbolRecord, target: TypeScriptSemanticTarget): boolean {
    if (!target.ownerName) return true;
    return symbol.parentQualifiedNamePath[symbol.parentQualifiedNamePath.length - 1] === target.ownerName
        || symbol.qualifiedName === `${target.ownerName}.${target.name}`;
}

function targetKindMatches(symbol: SymbolRecord, target: TypeScriptSemanticTarget): boolean {
    if (target.kind === 'constructor') return symbol.kind === 'method';
    if (target.kind === 'method') return symbol.kind === 'method';
    return symbol.kind === 'function';
}

function exactTarget(
    registry: SymbolRegistry,
    target: TypeScriptSemanticTarget,
): SymbolRecord | undefined {
    const matches = (registry.symbolsByFile.get(target.file) ?? []).filter((symbol) => (
        symbol.name === target.name
        && targetKindMatches(symbol, target)
        && ownerMatches(symbol, target)
        && spanMatches(symbol, target)
    ));
    return matches.length === 1 ? matches[0] : undefined;
}

function exactCaller(
    registry: SymbolRegistry,
    occurrence: TypeScriptCallEvidence,
): SymbolRecord | undefined {
    const candidates = (registry.symbolsByFile.get(occurrence.sourceFile) ?? [])
        .filter((symbol) => (
            isCallableSymbolKind(symbol.kind)
            && symbol.span.startByte !== undefined
            && symbol.span.endByte !== undefined
            && symbol.span.startByte <= occurrence.callSpan.startByte
            && symbol.span.endByte >= occurrence.callSpan.endByte
        ))
        .sort((left, right) => (
            ((left.span.endByte ?? 0) - (left.span.startByte ?? 0))
            - ((right.span.endByte ?? 0) - (right.span.startByte ?? 0))
        ));
    if (candidates.length === 0) return undefined;
    const width = (candidates[0].span.endByte ?? 0) - (candidates[0].span.startByte ?? 0);
    const narrowest = candidates.filter((candidate) => (
        ((candidate.span.endByte ?? 0) - (candidate.span.startByte ?? 0)) === width
    ));
    return narrowest.length === 1 ? narrowest[0] : undefined;
}

function targetLabel(target: TypeScriptSemanticTarget): string {
    return target.ownerName ? `${target.ownerName}.${target.name}` : target.name;
}

function observedCandidate(
    registry: SymbolRegistry,
    candidate: TypeScriptSemanticTarget,
): ResolutionObservedCandidate {
    const mapped = exactTarget(registry, candidate);
    return {
        file: candidate.file,
        span: { ...candidate.span },
        name: candidate.name,
        qualifiedName: mapped?.qualifiedName ?? targetLabel(candidate),
        ...(mapped ? { symbolInstanceId: mapped.symbolInstanceId } : {}),
    };
}

function callConstruct(occurrence: TypeScriptCallEvidence): ResolutionCallConstruct {
    if (occurrence.callKind === 'constructor') return 'constructor_call';
    if (
        occurrence.reason === 'dynamic_receiver'
        || occurrence.reason === 'dynamic_callee'
        || occurrence.reason === 'generic_receiver'
    ) {
        return 'dynamic_receiver';
    }
    if (occurrence.callKind === 'member' && occurrence.receiverType) return 'typed_member_call';
    if (occurrence.callKind === 'member') return 'member_call';
    return 'direct_call';
}

function receiverTextForCall(occurrence: TypeScriptCallEvidence): string | undefined {
    for (const separator of [`?.${occurrence.calleeName}`, `.${occurrence.calleeName}`]) {
        if (occurrence.calleeText.endsWith(separator)) {
            const receiver = occurrence.calleeText.slice(0, -separator.length).trim();
            if (receiver) return receiver;
        }
    }
    return undefined;
}

function sourceSpanForSymbol(symbol: SymbolRecord): SourceSpan | undefined {
    if (
        symbol.span.startByte === undefined
        || symbol.span.endByte === undefined
        || symbol.span.startColumn === undefined
        || symbol.span.endColumn === undefined
    ) return undefined;
    return {
        startLine: symbol.span.startLine,
        endLine: symbol.span.endLine,
        startByte: symbol.span.startByte,
        endByte: symbol.span.endByte,
        startColumn: symbol.span.startColumn,
        endColumn: symbol.span.endColumn,
    };
}

function dependencyKeys(
    occurrence: TypeScriptCallEvidence,
    environmentConfigId: string,
): string[] {
    const keys = new Set<string>([
        `typescript-project:${environmentConfigId}`,
        `typescript-call:${occurrence.sourceFile}:${occurrence.callSpan.startByte}:${occurrence.callSpan.endByte}:${occurrence.calleeName}`,
    ]);
    for (const candidate of occurrence.candidates ?? []) {
        keys.add(`typescript-target:${candidate.file}:${candidate.span.startByte}:${candidate.span.endByte}`);
    }
    if (occurrence.target) {
        keys.add(`typescript-target:${occurrence.target.file}:${occurrence.target.span.startByte}:${occurrence.target.span.endByte}`);
    }
    return [...keys].sort();
}

function proofSteps(
    occurrence: TypeScriptCallEvidence,
    caller: SymbolRecord | undefined,
    target: SymbolRecord | undefined,
    decision: ResolutionDecision,
    detail?: string,
): ResolutionProofStep[] {
    const proof: ResolutionProofStep[] = [{
        kind: 'call_site',
        subject: occurrence.calleeText,
        span: occurrence.callSpan,
    }];
    if (caller) {
        const callerSpan = sourceSpanForSymbol(caller);
        proof.push({
            kind: 'containing_caller',
            subject: caller.qualifiedName,
            ...(callerSpan ? { span: callerSpan } : {}),
        });
    }
    if (occurrence.receiverType) {
        proof.push({
            kind: 'receiver_type_binding',
            subject: occurrence.receiverType,
            span: occurrence.callSpan,
        });
    }
    if ((occurrence.candidates?.length ?? 0) > 0) {
        proof.push({
            kind: 'candidate_set',
            subject: (occurrence.candidates ?? []).map(targetLabel).sort().join('|'),
        });
    }
    if (target) {
        const targetSpan = sourceSpanForSymbol(target);
        proof.push({
            kind: 'exact_target_definition',
            subject: target.qualifiedName,
            ...(targetSpan ? { span: targetSpan } : {}),
        });
    }
    if (decision === 'ambiguous') {
        proof.push({
            kind: 'ambiguity',
            subject: occurrence.reason,
            detail,
        });
    } else if (decision === 'unresolved') {
        proof.push({
            kind: 'unresolved_dependency',
            subject: occurrence.reason,
            detail,
        });
    }
    return proof;
}

export function buildTypeScriptResolutionClaims(input: {
    readonly registry: SymbolRegistry;
    readonly environmentConfigId: string;
    readonly providerId: string;
    readonly providerVersion: string;
    readonly occurrencesByFile: ReadonlyMap<string, readonly TypeScriptCallEvidence[]>;
    readonly sourceFiles?: ReadonlySet<string>;
}): ReadonlyMap<string, readonly ResolutionClaim[]> {
    const claimsByFile = new Map<string, ResolutionClaim[]>();

    for (const [sourceFile, occurrences] of input.occurrencesByFile) {
        if (input.sourceFiles && !input.sourceFiles.has(sourceFile)) continue;
        const claims: ResolutionClaim[] = [];

        for (const occurrence of occurrences) {
            const caller = exactCaller(input.registry, occurrence);
            const mappedTarget = occurrence.target
                ? exactTarget(input.registry, occurrence.target)
                : undefined;

            let decision: ResolutionDecision;
            let authority: ResolutionAuthority;
            let relationshipType: ResolutionClaim['relationshipType'];
            let target: SymbolRecord | undefined;
            let detail: string | undefined;

            if (occurrence.decision === 'resolved' && mappedTarget) {
                decision = 'resolved';
                authority = 'direct_binding';
                relationshipType = caller ? 'CALLS' : 'REFERENCES';
                target = mappedTarget;
            } else if (occurrence.decision === 'ambiguous') {
                decision = 'ambiguous';
                authority = 'ambiguous';
                relationshipType = 'REFERENCES';
            } else {
                decision = 'unresolved';
                authority = occurrence.decision === 'unsupported' ? 'unsupported' : 'unresolved';
                relationshipType = 'REFERENCES';
                if (occurrence.decision === 'resolved') {
                    detail = 'Compiler target did not map to one canonical Satori target instance.';
                }
            }

            claims.push({
                providerId: input.providerId,
                providerVersion: input.providerVersion,
                environmentConfigId: input.environmentConfigId,
                sourceFile,
                ...(caller ? { sourceInstanceId: caller.symbolInstanceId } : {}),
                ...(target ? {
                    targetInstanceId: target.symbolInstanceId,
                    targetSymbol: target.qualifiedName,
                } : {}),
                callSpan: occurrence.callSpan,
                observation: {
                    kind: 'call',
                    calleeName: occurrence.calleeName,
                    calleeText: occurrence.calleeText,
                    ...(receiverTextForCall(occurrence) ? { receiverText: receiverTextForCall(occurrence) } : {}),
                    ...(occurrence.receiverType ? { receiverType: occurrence.receiverType } : {}),
                    construct: callConstruct(occurrence),
                    candidates: [...(occurrence.candidates ?? [])]
                        .map((candidate) => observedCandidate(input.registry, candidate))
                        .sort((left, right) => (
                            left.file.localeCompare(right.file)
                            || left.span.startByte - right.span.startByte
                            || left.span.endByte - right.span.endByte
                            || left.name.localeCompare(right.name)
                        )),
                },
                decision,
                relationshipType,
                resolutionAuthority: authority,
                proofSteps: proofSteps(occurrence, caller, mappedTarget, decision, detail),
                dependencyKeys: dependencyKeys(occurrence, input.environmentConfigId),
                flowHops: 0,
            });
        }

        claimsByFile.set(sourceFile, claims);
    }

    return claimsByFile;
}
