import * as crypto from 'crypto';
import {
    getSupportedExtensionsForIndexProfile,
    type IndexProfile,
} from '../config/defaults';
import {
    INDEX_FILE_ADMISSION_VERSION,
    normalizeSupportedExtensions,
} from '../config/index-policy';
import { IgnoreRuleService } from '../core/ignore-rule-service';
import type { CustomIndexPolicyUpdate, ObservedResolvedIndexPolicy, PublicationRef } from '../generation/contracts';
import { computeIndexPolicyControlSignature, observeIndexPolicyInputs } from '../core/index-policy-input-observer';

/**
 * Runtime-resolved index policy for one canonical codebase root.
 * The selected immutable Publication is the accepted policy authority. Live
 * repository controls are observed separately for admission and reconciliation.
 */
export interface ResolvedIndexPolicy {
    canonicalRoot: string;
    profile: IndexProfile;
    customExtensions: string[];
    customIgnorePatterns: string[];
    fileBasedIgnorePatterns: string[];
    supportedExtensions: string[];
    effectiveIgnorePatterns: string[];
    policyHash: string;
    controlSignature?: string;
}

/** Process-local projection of the selected Publication for transitional callers. */
export interface IndexPolicyRuntimeBinding {
    publicationId: string;
    collectionName: string;
    navigation:
        | { status: 'not_bound' }
        | { status: 'sealed'; publicationId: string };
}

export class IndexPolicyAuthorityError extends Error {
    constructor(message: string, readonly authorityCause: unknown) {
        super(message);
        this.name = 'IndexPolicyAuthorityError';
    }
}

/** Canonical policy hash over the effective runtime inputs frozen in a Publication. */
export function computeIndexPolicyHash(
    profile: IndexProfile,
    supportedExtensions: readonly string[],
    effectiveIgnorePatterns: readonly string[],
): string {
    return crypto.createHash('sha256').update(JSON.stringify({
        profile,
        fileAdmissionVersion: INDEX_FILE_ADMISSION_VERSION,
        extensions: supportedExtensions,
        ignorePatterns: effectiveIgnorePatterns,
    }), 'utf8').digest('hex');
}

export interface IndexPolicyRuntimeServiceConfig {
    /** Static configured extension overlays (config + environment). */
    configuredExtensionOverlays: readonly string[];
    getIgnoreRuleService: () => IgnoreRuleService;
    canonicalizeCodebasePath: (codebasePath: string) => string;
    getCurrentPublication: (canonicalRoot: string) => PublicationRef | null;
    getPublishedResolvedPolicy: (canonicalRoot: string) => ResolvedIndexPolicy | undefined;
    onActivateResolvedIndexPolicy: (
        policy: ResolvedIndexPolicy,
        binding: IndexPolicyRuntimeBinding,
    ) => void;
    onClearPublishedIndexPolicy: (canonicalRoot: string) => void;
}

/**
 * Owns live policy resolution, reconciliation, and the process-local projection
 * of accepted policy. Durable policy and selection remain in PublicationStore.
 */
export class IndexPolicyRuntimeService {
    private readonly configuredExtensionOverlays: string[];
    private readonly getIgnoreRuleService: () => IgnoreRuleService;
    private readonly canonicalizeCodebasePath: (codebasePath: string) => string;
    private readonly getCurrentPublication: (canonicalRoot: string) => PublicationRef | null;
    private readonly getPublishedResolvedPolicy: (canonicalRoot: string) => ResolvedIndexPolicy | undefined;
    private readonly onActivateResolvedIndexPolicy: (
        policy: ResolvedIndexPolicy,
        binding: IndexPolicyRuntimeBinding,
    ) => void;
    private readonly onClearPublishedIndexPolicy: (canonicalRoot: string) => void;

    private readonly runtimeCustomExtensionsByCodebase = new Map<string, string[]>();
    private readonly indexProfilesByCodebase = new Map<string, IndexProfile>();
    private readonly loadedPublicationIdsByCodebase = new Map<string, string>();
    private readonly policyRuntimeCompatibilityByCodebase = new Map<string, boolean>();

    constructor(config: IndexPolicyRuntimeServiceConfig) {
        this.configuredExtensionOverlays = [...config.configuredExtensionOverlays];
        this.getIgnoreRuleService = config.getIgnoreRuleService;
        this.canonicalizeCodebasePath = config.canonicalizeCodebasePath;
        this.getCurrentPublication = config.getCurrentPublication;
        this.getPublishedResolvedPolicy = config.getPublishedResolvedPolicy;
        this.onActivateResolvedIndexPolicy = config.onActivateResolvedIndexPolicy;
        this.onClearPublishedIndexPolicy = config.onClearPublishedIndexPolicy;
    }

    getPolicyRuntimeCompatibilityByCodebase(): ReadonlyMap<string, boolean> {
        return this.policyRuntimeCompatibilityByCodebase;
    }

    async resolveIndexPolicyForReindex(
        codebasePath: string,
        update: CustomIndexPolicyUpdate = {},
    ): Promise<ObservedResolvedIndexPolicy> {
        return this.resolveIndexPolicyFromCurrentInputs(
            this.canonicalizeCodebasePath(codebasePath), update, false, true,
        );
    }

    async observeIndexPolicyForIncrementalReconciliation(codebasePath: string): Promise<ObservedResolvedIndexPolicy> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        this.loadCurrentPublicationPolicy(canonicalRoot);
        return this.resolveIndexPolicyFromCurrentInputs(canonicalRoot, {}, true, false);
    }

    async resolveIndexPolicyFromCurrentInputs(
        canonicalRoot: string,
        update: CustomIndexPolicyUpdate,
        inheritActiveCustomPolicy: boolean,
        activateRuntimeProfile: boolean,
    ): Promise<ObservedResolvedIndexPolicy> {
        const observedInputs = await observeIndexPolicyInputs(canonicalRoot);
        const profile = observedInputs.profileConfig.profile;
        if (activateRuntimeProfile) {
            this.setIndexProfileForCodebase(canonicalRoot, profile);
            this.recomputePolicyRuntimeCompatibility(canonicalRoot, this.getPublishedResolvedPolicy(canonicalRoot));
        }
        const ignoreRules = this.getIgnoreRuleService();
        const customExtensions = update.customExtensions === undefined
            ? inheritActiveCustomPolicy ? this.getRuntimeCustomExtensions(canonicalRoot) : []
            : normalizeSupportedExtensions(update.customExtensions);
        const customIgnorePatterns = update.customIgnorePatterns === undefined
            ? inheritActiveCustomPolicy ? ignoreRules.getRuntimeCustomPatterns(canonicalRoot) : []
            : update.customIgnorePatterns.map((pattern) => pattern.trim()).filter(Boolean);
        const fileBasedPatterns = [...observedInputs.fileBasedIgnorePatterns];
        const supportedExtensions = normalizeSupportedExtensions([
            ...getSupportedExtensionsForIndexProfile(profile),
            ...this.configuredExtensionOverlays,
            ...customExtensions,
        ]);
        const effectiveIgnorePatterns = [
            ...ignoreRules.getBasePatterns(), ...customIgnorePatterns, ...fileBasedPatterns,
        ];
        return {
            canonicalRoot,
            profile,
            customExtensions,
            customIgnorePatterns,
            fileBasedIgnorePatterns: fileBasedPatterns,
            supportedExtensions,
            effectiveIgnorePatterns,
            policyHash: computeIndexPolicyHash(profile, supportedExtensions, effectiveIgnorePatterns),
            controlSignature: observedInputs.controlSignature,
        };
    }

    async isObservedIndexPolicyControlSignatureCurrent(policy: ObservedResolvedIndexPolicy): Promise<boolean> {
        const canonicalRoot = this.canonicalizeCodebasePath(policy.canonicalRoot);
        return canonicalRoot === policy.canonicalRoot
            && await computeIndexPolicyControlSignature(canonicalRoot) === policy.controlSignature;
    }

    activateObservedIndexPolicyForIncrementalReconciliation(policy: ObservedResolvedIndexPolicy): boolean {
        const canonicalRoot = this.canonicalizeCodebasePath(policy.canonicalRoot);
        this.loadCurrentPublicationPolicy(canonicalRoot);
        const publishedPolicy = this.getPublishedResolvedPolicy(canonicalRoot);
        if (!publishedPolicy || publishedPolicy.policyHash !== policy.policyHash
            || publishedPolicy.controlSignature !== policy.controlSignature) {
            return false;
        }
        this.setIndexProfileForCodebase(canonicalRoot, policy.profile);
        this.getIgnoreRuleService().setFileBasedPatterns(canonicalRoot, policy.fileBasedIgnorePatterns);
        this.recomputePolicyRuntimeCompatibility(canonicalRoot, publishedPolicy);
        return true;
    }

    getPolicyRuntimeCompatibility(canonicalRoot: string): boolean | undefined {
        return this.policyRuntimeCompatibilityByCodebase.get(canonicalRoot);
    }

    getConfiguredExtensionOverlays(): string[] {
        return [...this.configuredExtensionOverlays];
    }

    getIndexProfile(canonicalRoot: string): IndexProfile | undefined {
        return this.indexProfilesByCodebase.get(canonicalRoot);
    }

    hasIndexProfile(canonicalRoot: string): boolean {
        return this.indexProfilesByCodebase.has(canonicalRoot);
    }

    setIndexProfileForCodebase(canonicalRoot: string, profile: IndexProfile): void {
        this.indexProfilesByCodebase.set(canonicalRoot, profile);
    }

    deleteIndexProfile(canonicalRoot: string): void {
        this.indexProfilesByCodebase.delete(canonicalRoot);
    }

    getRuntimeCustomExtensions(canonicalRoot: string): string[] {
        return [...(this.runtimeCustomExtensionsByCodebase.get(canonicalRoot) ?? [])];
    }

    buildSupportedExtensions(profile: IndexProfile, canonicalRoot?: string): string[] {
        return normalizeSupportedExtensions([
            ...getSupportedExtensionsForIndexProfile(profile),
            ...this.configuredExtensionOverlays,
            ...(canonicalRoot ? this.runtimeCustomExtensionsByCodebase.get(canonicalRoot) ?? [] : []),
        ]);
    }

    /**
     * Runtime compatibility intentionally excludes the live control signature.
     * The signature is a separate fail-closed new-read admission boundary.
     */
    isPolicyRuntimeCompatible(policy: ResolvedIndexPolicy): boolean {
        const expectedExtensions = normalizeSupportedExtensions([
            ...getSupportedExtensionsForIndexProfile(policy.profile),
            ...this.configuredExtensionOverlays,
            ...policy.customExtensions,
        ]);
        const expectedIgnorePatterns = [
            ...this.getIgnoreRuleService().getBasePatterns(),
            ...policy.customIgnorePatterns,
            ...policy.fileBasedIgnorePatterns,
        ];
        return JSON.stringify(policy.supportedExtensions) === JSON.stringify(expectedExtensions)
            && JSON.stringify(policy.effectiveIgnorePatterns) === JSON.stringify(expectedIgnorePatterns);
    }

    recomputePolicyRuntimeCompatibility(
        canonicalRoot: string,
        policy: ResolvedIndexPolicy | undefined,
    ): void {
        if (!policy) {
            this.policyRuntimeCompatibilityByCodebase.delete(canonicalRoot);
            return;
        }
        this.policyRuntimeCompatibilityByCodebase.set(
            canonicalRoot,
            this.isPolicyRuntimeCompatible(policy),
        );
    }

    /** Hydrate the accepted runtime policy projection from the current Publication. */
    loadCurrentPublicationPolicy(codebasePath: string): void {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        const ref = this.getCurrentPublication(canonicalRoot);
        if (!ref) {
            this.clearResolvedIndexPolicyRuntime(canonicalRoot);
            return;
        }
        if (this.loadedPublicationIdsByCodebase.get(canonicalRoot) === ref.id) return;

        const accepted = ref.publication.policy;
        const expectedPolicyHash = computeIndexPolicyHash(
            accepted.profile,
            accepted.supportedExtensions,
            accepted.effectiveIgnorePatterns,
        );
        if (accepted.policyHash !== expectedPolicyHash) {
            throw new IndexPolicyAuthorityError(
                `Current Publication '${ref.id}' has an invalid policy hash.`,
                new Error('Publication policy hash does not match its effective inputs.'),
            );
        }

        this.activateResolvedIndexPolicy({
            canonicalRoot,
            profile: accepted.profile,
            customExtensions: [...accepted.customExtensions],
            customIgnorePatterns: [...accepted.customIgnorePatterns],
            fileBasedIgnorePatterns: [...accepted.fileBasedIgnorePatterns],
            supportedExtensions: [...accepted.supportedExtensions],
            effectiveIgnorePatterns: [...accepted.effectiveIgnorePatterns],
            policyHash: accepted.policyHash,
            controlSignature: accepted.controlSignature,
        }, {
            publicationId: ref.id,
            collectionName: ref.publication.vector.collectionName,
            navigation: ref.publication.navigation
                ? { status: 'sealed', publicationId: ref.id }
                : { status: 'not_bound' },
        });
    }

    clearResolvedIndexPolicyRuntime(canonicalRoot: string): void {
        this.runtimeCustomExtensionsByCodebase.delete(canonicalRoot);
        this.getIgnoreRuleService().deleteRuntimeCustomPatterns(canonicalRoot);
        this.policyRuntimeCompatibilityByCodebase.delete(canonicalRoot);
        this.loadedPublicationIdsByCodebase.delete(canonicalRoot);
        this.getIgnoreRuleService().setFileBasedPatterns(canonicalRoot, []);
        this.onClearPublishedIndexPolicy(canonicalRoot);
    }

    activateResolvedIndexPolicy(
        policy: ResolvedIndexPolicy,
        binding: IndexPolicyRuntimeBinding,
    ): void {
        const canonicalRoot = this.canonicalizeCodebasePath(policy.canonicalRoot);
        if (canonicalRoot !== policy.canonicalRoot) {
            throw new IndexPolicyAuthorityError(
                `Resolved policy root '${policy.canonicalRoot}' is not canonical.`,
                new Error('Resolved policy root mismatch.'),
            );
        }
        this.runtimeCustomExtensionsByCodebase.set(canonicalRoot, [...policy.customExtensions]);
        this.getIgnoreRuleService().setRuntimeCustomPatterns(canonicalRoot, policy.customIgnorePatterns);
        this.indexProfilesByCodebase.set(canonicalRoot, policy.profile);
        this.loadedPublicationIdsByCodebase.set(canonicalRoot, binding.publicationId);
        this.policyRuntimeCompatibilityByCodebase.set(
            canonicalRoot,
            this.isPolicyRuntimeCompatible(policy),
        );
        this.getIgnoreRuleService().setFileBasedPatterns(canonicalRoot, policy.fileBasedIgnorePatterns);
        this.onActivateResolvedIndexPolicy(policy, binding);
    }
}
