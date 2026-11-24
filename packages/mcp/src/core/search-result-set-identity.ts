import crypto from "node:crypto";
import type { Reranker } from "@satori-code/core";
import { serializeCanonicalJson } from "./canonical-json.js";
import { resolveSearchRerankDocumentProjectionIdentity } from "./search-rerank-document.js";
import { SEARCH_RERANK_QUERY_RAW_IDENTITY } from "./search-rerank-query.js";
import type {
    SearchGroupedResultV2,
    SearchRecommendedNextAction,
} from "./search-types.js";

export const SEARCH_NATIVE_RETRIEVAL_ORDER_POLICY_ID = "search_native_retrieval_order_v2";
export const SEARCH_NATIVE_RERANKER_ORDER_POLICY_ID = "search_native_reranker_order_v2";
export const SEARCH_DEFINITION_DISCOVERY_ORDER_POLICY_ID = "search_definition_discovery_order_v2";

export type SearchOrderAuthority = "retrieval_order" | "reranker_order" | "definition_fusion_order";

export function resolveSearchRankingPolicyIdentity(input: {
    orderAuthority: SearchOrderAuthority;
}): string {
    if (input.orderAuthority === "definition_fusion_order") return SEARCH_DEFINITION_DISCOVERY_ORDER_POLICY_ID;
    return input.orderAuthority === "reranker_order"
        ? SEARCH_NATIVE_RERANKER_ORDER_POLICY_ID
        : SEARCH_NATIVE_RETRIEVAL_ORDER_POLICY_ID;
}

export interface SearchRerankRequestIdentityV1 {
    provider: string;
    model: string;
    profile: string;
    queryProjectionIdentity: string;
    documentProjectionIdentity: string;
}

export function resolveSearchRerankRequestIdentity(reranker: Reranker): SearchRerankRequestIdentityV1 {
    const identity = reranker.getIdentity();
    const queryProjectionIdentity = reranker.getQueryProjectionVersion?.()?.trim();
    const documentProjectionIdentity = reranker.getDocumentProjectionVersion?.()?.trim();
    return {
        provider: identity.provider,
        model: identity.model,
        profile: identity.profile,
        queryProjectionIdentity: queryProjectionIdentity || SEARCH_RERANK_QUERY_RAW_IDENTITY,
        documentProjectionIdentity: resolveSearchRerankDocumentProjectionIdentity(
            documentProjectionIdentity,
        ),
    };
}

export const SEARCH_RANKED_SET_BINDING_VERSION =
    "search_ranked_set_binding_v1" as const;

type JsonScalar = string | number | boolean | null;
type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export type SearchRerankerBindingIdentity =
    | Readonly<{
        kind: "deterministic_baseline";
        policy: "B";
    }>
    | Readonly<{
        kind: "provider";
        provider: string;
        model: string;
        profile: string;
    }>;

export type SearchPublicationBindingIdentity = Readonly<{
    publicationId: string;
    collectionName: string;
    policyHash: string;
    navigation:
        | Readonly<{ status: "not_bound" }>
        | Readonly<{ status: "bound" }>;
}>;

export type SearchRankedSetBindingInput = Readonly<{
    queryPolicyDigest: string;
    rankingPolicyIdentity: string;
    disclosurePolicyVersion: string;
    publicationIdentity: SearchPublicationBindingIdentity;
    rerankerIdentity: SearchRerankerBindingIdentity;
    rerankerProjectionIdentity: string;
    rerankerRequestIdentity: SearchRerankRequestIdentityV1 | null;
    orderedResults: readonly SearchGroupedResultV2[];
    recommendedActions: readonly (SearchRecommendedNextAction | null)[];
}>;

export type SearchRankedSetBinding = Readonly<{
    version: typeof SEARCH_RANKED_SET_BINDING_VERSION;
    queryPolicyDigest: string;
    rankingPolicyIdentity: string;
    disclosurePolicyVersion: string;
    publicationIdentity: JsonValue;
    rerankerIdentity: SearchRerankerBindingIdentity;
    rerankerProjectionIdentity: string;
    rerankerRequestIdentity: SearchRerankRequestIdentityV1 | null;
    orderedGroups: readonly Readonly<{
        groupIdentity: string;
        pageableProjectionDigest: string;
    }>[];
    rankedSetDigest: string;
}>;

function normalizeJson(value: unknown, context: "object" | "array" = "object"): JsonValue {
    if (
        value === null
        || typeof value === "string"
        || typeof value === "boolean"
    ) {
        return value;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new TypeError("Ranked-set identity does not accept non-finite numbers.");
        }
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((entry) => {
            if (entry === undefined) {
                throw new TypeError("Ranked-set identity does not accept undefined array entries.");
            }
            return normalizeJson(entry, "array");
        });
    }
    if (typeof value === "object") {
        const normalized: Record<string, JsonValue> = {};
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            if (entry === undefined) continue;
            normalized[key] = normalizeJson(entry, "object");
        }
        return normalized;
    }
    throw new TypeError(
        `Ranked-set identity does not accept ${typeof value} ${context} values.`,
    );
}

function digest(value: unknown): string {
    return crypto.createHash("sha256")
        .update(serializeCanonicalJson(normalizeJson(value)), "utf8")
        .digest("hex");
}

function requireIdentityText(value: string, label: string): void {
    if (!value.trim()) {
        throw new Error(`Ranked-set ${label} identity must be non-empty.`);
    }
}

export function buildSearchRankedSetBinding(
    input: SearchRankedSetBindingInput,
): SearchRankedSetBinding {
    if (input.orderedResults.length !== input.recommendedActions.length) {
        throw new Error("Ranked-set results and recommended actions must remain paired.");
    }
    if (
        !input.publicationIdentity.publicationId.trim()
        || !input.publicationIdentity.collectionName.trim()
        || !input.publicationIdentity.policyHash.trim()
    ) {
        throw new Error("Ranked-set publication identity must be complete.");
    }
    requireIdentityText(input.queryPolicyDigest, "query policy");
    requireIdentityText(input.rankingPolicyIdentity, "ranking policy");
    requireIdentityText(input.disclosurePolicyVersion, "disclosure policy");
    requireIdentityText(input.rerankerProjectionIdentity, "reranker projection");
    if (input.rerankerIdentity.kind === "provider") {
        requireIdentityText(input.rerankerIdentity.provider, "reranker provider");
        requireIdentityText(input.rerankerIdentity.model, "reranker model");
        requireIdentityText(input.rerankerIdentity.profile, "reranker profile");
        if (!input.rerankerRequestIdentity) {
            throw new Error("Applied search reranking requires a complete rerank request identity.");
        }
        requireIdentityText(input.rerankerRequestIdentity.provider, "rerank request provider");
        requireIdentityText(input.rerankerRequestIdentity.model, "rerank request model");
        requireIdentityText(input.rerankerRequestIdentity.profile, "rerank request profile");
        requireIdentityText(
            input.rerankerRequestIdentity.queryProjectionIdentity,
            "rerank request query projection",
        );
        requireIdentityText(
            input.rerankerRequestIdentity.documentProjectionIdentity,
            "rerank request document projection",
        );
        if (input.rerankerRequestIdentity.provider !== input.rerankerIdentity.provider) {
            throw new Error("Ranked-set rerank request provider must match the applied reranker provider.");
        }
        if (input.rerankerRequestIdentity.model !== input.rerankerIdentity.model) {
            throw new Error("Ranked-set rerank request model must match the applied reranker model.");
        }
        if (input.rerankerRequestIdentity.profile !== input.rerankerIdentity.profile) {
            throw new Error("Ranked-set rerank request profile must match the applied reranker profile.");
        }
        if (input.rerankerRequestIdentity.documentProjectionIdentity !== input.rerankerProjectionIdentity) {
            throw new Error("Ranked-set rerank request document projection must match the applied reranker projection.");
        }
    } else if (input.rerankerRequestIdentity !== null) {
        throw new Error("Deterministic baseline ranked sets must not carry a rerank request identity.");
    }

    const orderedGroups = input.orderedResults.map((result, index) => ({
        groupIdentity: digest(result.target),
        pageableProjectionDigest: digest({
            result,
            recommendedAction: input.recommendedActions[index] ?? null,
        }),
    }));
    const identity = {
        version: SEARCH_RANKED_SET_BINDING_VERSION,
        queryPolicyDigest: input.queryPolicyDigest,
        rankingPolicyIdentity: input.rankingPolicyIdentity,
        disclosurePolicyVersion: input.disclosurePolicyVersion,
        publicationIdentity: normalizeJson(input.publicationIdentity),
        rerankerIdentity: input.rerankerIdentity,
        rerankerProjectionIdentity: input.rerankerProjectionIdentity,
        rerankerRequestIdentity: input.rerankerRequestIdentity,
        orderedGroups,
    };
    return {
        ...identity,
        rankedSetDigest: digest(identity),
    };
}

export function verifySearchRankedSetBinding(
    binding: SearchRankedSetBinding,
    input: SearchRankedSetBindingInput,
): boolean {
    try {
        return serializeCanonicalJson(normalizeJson(buildSearchRankedSetBinding(input)))
            === serializeCanonicalJson(normalizeJson(binding));
    } catch {
        return false;
    }
}
