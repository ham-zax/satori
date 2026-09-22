/**
 * Generation-domain Publication contracts.
 *
 * Neutral module for immutable Publication descriptors and read leases shared
 * by generation owners and their consumers. Kept free of any import of
 * `core/context.ts` so domain owners never depend on the composition façade.
 *
 * `Context` re-exports the current product-facing Publication contracts.
 */
import type { ResolvedIndexPolicy } from '../policy/index-policy-runtime-service';

export type PublicationId = string;

export interface Publication {
    readonly version: 1;
    readonly id: PublicationId;
    readonly canonicalRoot: string;
    readonly createdAt: string;
    readonly status: 'complete' | 'partial';
    readonly policy: Readonly<{
        profile: ResolvedIndexPolicy['profile'];
        customExtensions: readonly string[];
        customIgnorePatterns: readonly string[];
        fileBasedIgnorePatterns: readonly string[];
        supportedExtensions: readonly string[];
        effectiveIgnorePatterns: readonly string[];
        policyHash: string;
        controlSignature: string;
    }>;
    readonly format: Readonly<{
        indexFormatVersion: string;
        embeddingIdentity: string;
        relationshipVersion: string;
    }>;
    readonly vector: Readonly<{
        collectionName: string;
        indexedFiles: number;
        totalChunks: number;
    }>;
    readonly packageOwnership?: null | Readonly<{
        digest: string;
    }>;
    readonly navigation: null | Readonly<{
        relativeRoot: 'navigation';
    }>;
}

export interface PublicationRef {
    readonly id: PublicationId;
    readonly publication: Publication;
}

export interface PublicationLease extends PublicationRef {
    release(): void;
}

export interface CustomIndexPolicyUpdate {
    customExtensions?: string[];
    customIgnorePatterns?: string[];
}

export interface ObservedResolvedIndexPolicy extends ResolvedIndexPolicy {
    controlSignature: string;
}

export type PublicationNavigationStatus =
    | 'valid'
    | 'not_bound'
    | 'missing'
    | 'incompatible'
    | 'corrupt';

export type IndexBuildPublicationResult = Readonly<{
    id: PublicationId;
    status: 'staged' | 'activated';
}>;

export type IndexCodebaseResult = {
    indexedFiles: number;
    totalChunks: number;
    status: 'completed' | 'limit_reached';
    collectionName: string;
    indexedPaths: readonly string[];
    publication: IndexBuildPublicationResult;
};
