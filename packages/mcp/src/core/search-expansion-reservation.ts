import { searchCandidateIdentity } from "./search-candidate-survival.js";
import { SEARCH_MAX_CANDIDATES } from "./search-constants.js";
import type { SearchCandidate } from "./search-execution.js";

/**
 * Ceiling on the primary-candidate slots reserved when a caller-supplied
 * expansion is in play.
 *
 * An expansion pass runs as a second retrieval pass fused by RRF, so pure
 * expansion candidates can out-score primary candidates and crowd them out of
 * the candidate budget. The reservation guarantees primary candidates keep slots
 * regardless. The ceiling bounds how many primary slots the reservation may
 * claim, so a very large primary pool cannot consume the entire budget either.
 */
export const SEARCH_EXPANSION_PRIMARY_RESERVATION_CAP = 55;

/**
 * Wider reservation ceiling used only by the `cap64` reservation policy.
 * The frozen 55 cap above is untouched; this is a separate named variant.
 */
export const SEARCH_EXPANSION_PRIMARY_RESERVATION_CAP_WIDE = 64;

/**
 * Primary-slot reservation policy for the caller-expansion pass.
 *
 * - `cap55` reserves up to 55 primary slots: the current default behavior.
 * - `cap64` reserves up to 64 primary slots: the wider named variant.
 * - `off` disables the reservation: the pool keeps fused-score order.
 */
export type ExpansionReservationPolicy = "cap55" | "cap64" | "off";

export const DEFAULT_EXPANSION_RESERVATION_POLICY: ExpansionReservationPolicy = "cap55";

/** Resolve caller input to a policy; unknown or absent input stays on the default. */
export function resolveExpansionReservationPolicy(
    value: unknown,
): ExpansionReservationPolicy {
    return value === "cap64" || value === "off" || value === "cap55"
        ? value
        : DEFAULT_EXPANSION_RESERVATION_POLICY;
}

/** Reservation ceiling for a policy; `off` reserves nothing. */
export function reservationCapForPolicy(policy: ExpansionReservationPolicy): number {
    if (policy === "off") return 0;
    if (policy === "cap64") return SEARCH_EXPANSION_PRIMARY_RESERVATION_CAP_WIDE;
    return SEARCH_EXPANSION_PRIMARY_RESERVATION_CAP;
}

/** A candidate counts as primary if any retrieval pass other than "expanded" found it. */
export function isPrimarySearchCandidate(candidate: SearchCandidate): boolean {
    return candidate.retrievalPasses.some((pass) => pass !== "expanded");
}

/**
 * Reserve primary-candidate slots in a candidate pool.
 *
 * Pure function over the pool: no sorting, no I/O, no shared state. Returns a
 * new array. The caller supplies native retrieval order and re-sorts the
 * admitted set afterwards; diagnostics observe that same set.
 *
 * The caps describe shares of the maximum 80-candidate budget. Smaller
 * requests retain those shares, so reserving primary slots cannot exhaust a
 * 32-slot budget before a high-ranking expansion-only owner is considered.
 * Every reserved primary survives; every policy obeys candidateLimit.
 */
export function reservePrimaryCandidateSlots(
    candidates: readonly SearchCandidate[],
    candidateLimit: number,
    policy: ExpansionReservationPolicy = DEFAULT_EXPANSION_RESERVATION_POLICY,
): SearchCandidate[] {
    if (policy === "off") {
        return candidates.slice(0, candidateLimit);
    }
    const cap = reservationCapForPolicy(policy);
    const primaryCandidates = candidates.filter(isPrimarySearchCandidate);
    const pureExpansionCandidates = candidates.filter((c) => !isPrimarySearchCandidate(c));
    if (pureExpansionCandidates.length === 0 || primaryCandidates.length === 0) {
        return candidates.slice(0, candidateLimit);
    }
    const reservedPrimaryCount = Math.min(
        cap,
        primaryCandidates.length,
        Math.floor(candidateLimit * cap / SEARCH_MAX_CANDIDATES),
    );
    const primaryReserved = primaryCandidates.slice(0, reservedPrimaryCount);
    const primaryReservedIds = new Set(
        primaryReserved.map((c) => searchCandidateIdentity(c.result).candidateId),
    );
    const remainderCandidates = candidates.filter(
        (c) => !primaryReservedIds.has(searchCandidateIdentity(c.result).candidateId),
    );
    const remainderLimit = Math.max(0, candidateLimit - primaryReserved.length);
    const remainderSelected = remainderCandidates.slice(0, remainderLimit);
    return [...primaryReserved, ...remainderSelected];
}
