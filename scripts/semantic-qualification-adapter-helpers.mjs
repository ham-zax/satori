import { createHash } from 'node:crypto';

const PROOF_EVIDENCE = new Map([
    ['call_site', 'call_site'],
    ['containing_caller', 'caller_identity'],
    ['absolute_import', 'direct_symbol_binding'],
    ['relative_import', 'direct_symbol_binding'],
    ['same_file_definition', 'direct_symbol_binding'],
    ['constructor_origin', 'constructor_origin'],
    ['parameter_annotation', 'receiver_type'],
    ['package_binding', 'direct_symbol_binding'],
    ['receiver_type_binding', 'receiver_type'],
    ['exact_target_definition', 'target_provenance'],
    ['allocation_origin', 'assignment_origin'],
    ['field_origin', 'field_origin'],
    ['callback_origin', 'assignment_origin'],
    ['class_inheritance', 'inheritance'],
    ['flow_hop', 'flow_hop'],
    ['candidate_set', 'candidate_set'],
    ['ambiguity', 'ambiguity'],
    ['unresolved_dependency', 'unresolved_dependency'],
]);

function sameSpan(left, right) {
    return left.startLine === right.startLine
        && left.endLine === right.endLine
        && left.startByte === right.startByte
        && left.endByte === right.endByte
        && left.startColumn === right.startColumn
        && left.endColumn === right.endColumn;
}

function targetLabel(target) {
    return target.ownerName ? `${target.ownerName}.${target.name}` : target.name;
}

function unmappedRef(target) {
    const identity = [
        target.file,
        target.span.startByte,
        target.span.endByte,
        target.ownerName ?? '',
        target.name,
    ].join('\0');
    return `unmapped_${createHash('sha256').update(identity).digest('hex').slice(0, 12)}`;
}

export function mapExactCanonicalTarget(target, canonicalTargets) {
    const matches = canonicalTargets.filter((canonical) => (
        canonical.file === target.file
        && canonical.name === target.name
        && (canonical.ownerName ?? undefined) === (target.ownerName ?? undefined)
        && sameSpan(canonical.span, target.span)
    ));
    const ref = matches.length === 1 ? matches[0].ref : unmappedRef(target);
    return {
        ref,
        label: targetLabel(target),
        file: target.file,
        span: { ...target.span },
    };
}

export function neutralEvidenceFromResolutionClaim(claim, options = {}) {
    const evidence = [];
    const seen = new Set();
    const target = options.target;
    for (const step of claim.proofSteps ?? []) {
        const kind = PROOF_EVIDENCE.get(step.kind);
        if (!kind) continue;
        const file = kind === 'target_provenance' && target
            ? target.file
            : claim.sourceFile;
        const span = kind === 'target_provenance' && target
            ? target.span
            : step.span;
        const key = [kind, step.subject, file, span?.startByte ?? ''].join('\0');
        if (seen.has(key)) continue;
        seen.add(key);
        evidence.push({
            kind,
            subject: step.subject,
            ...(step.detail ? { detail: step.detail } : {}),
            ...(span ? { file, span: { ...span } } : {}),
        });
    }
    return evidence;
}

export function inferResolutionStrategy(claim, provider = {}) {
    const proofKinds = new Set((claim.proofSteps ?? []).map((step) => step.kind));
    const reasonText = [
        provider.reason,
        ...(claim.proofSteps ?? [])
            .filter((step) => step.kind === 'ambiguity' || step.kind === 'unresolved_dependency')
            .map((step) => step.subject),
    ].filter(Boolean).join(' ').toLowerCase();

    if (reasonText.includes('multiple_overload_candidates')) return 'overload_resolution';
    if (
        reasonText.includes('dynamic_callee')
        || reasonText.includes('dynamic_receiver')
        || reasonText.includes('dynamic_dispatch')
        || reasonText.includes('getattr')
    ) {
        return 'dynamic_dispatch';
    }
    if (
        proofKinds.has('receiver_type_binding')
        || proofKinds.has('parameter_annotation')
        || proofKinds.has('constructor_origin')
        || proofKinds.has('allocation_origin')
        || proofKinds.has('field_origin')
        || proofKinds.has('class_inheritance')
    ) {
        return 'type_dispatch';
    }
    if (
        proofKinds.has('absolute_import')
        || proofKinds.has('relative_import')
        || proofKinds.has('same_file_definition')
        || proofKinds.has('package_binding')
        || proofKinds.has('exact_target_definition')
        || proofKinds.has('callback_origin')
    ) {
        return 'direct_call';
    }
    return 'unknown';
}

export function candidateNamesFromResolutionClaim(claim) {
    return (claim.proofSteps ?? [])
        .filter((step) => step.kind === 'candidate_set')
        .flatMap((step) => step.subject.split('|'))
        .map((value) => value.trim())
        .filter(Boolean);
}
