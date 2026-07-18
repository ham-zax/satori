import { JsonNavigationStore } from './store';
import type {
    NavigationCompatibilityInput,
    NavigationCompatibilityState,
    NavigationOwnerForSpanInput,
    NavigationOwnerForSpanResult,
    NavigationRegistryState,
    NavigationRelationshipsQueryInput,
    NavigationRelationshipsState,
    NavigationStore,
    NavigationStoreInput,
    NavigationSymbolByInstanceIdInput,
    NavigationSymbolByInstanceIdResult,
    NavigationSymbolCandidatesByKeyInput,
    NavigationSymbolCandidatesByKeyResult,
    NavigationSymbolsByFileInput,
    NavigationSymbolsByFileResult,
} from './store';
import { SQLiteNavigationStore, validateNavigationStoreParity } from './sqlite';

export type NavigationDualReadValidationMode = 'off' | 'warn';
export type NavigationServingBackend = 'json' | 'sqlite';

type NavigationStoreResultWithStatus = {
    status: string;
    reason?: string;
};

type NavigationFallbackDecision = {
    shouldFallback: boolean;
    reason: string;
};

type SQLiteServingGateDecision =
    | { canServeSQLite: true }
    | { canServeSQLite: false; reason: string };

export interface RuntimeNavigationStoreOptions {
    servingStore?: NavigationStore;
    candidateStore?: NavigationStore;
    /** @deprecated Compatibility alias for `servingStore`. */
    primaryStore?: NavigationStore;
    /** @deprecated Compatibility alias for `candidateStore`. This is not a serving fallback. */
    fallbackStore?: NavigationStore;
    servingBackend?: NavigationServingBackend;
    dualReadValidation?: NavigationDualReadValidationMode;
    logger?: Pick<Console, 'warn'>;
    parityValidator?: typeof validateNavigationStoreParity;
}

function normalizeTruthiness(value: string | undefined): boolean {
    if (!value) {
        return false;
    }
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on' || normalized === 'warn';
}

function parityKey(input: NavigationStoreInput): string {
    return `${input.stateRoot || ''}\0${input.normalizedRootPath}\0${input.generationId || ''}`;
}

function hasExplicitRuntimeNavigationStoreOptions(options: RuntimeNavigationStoreOptions): boolean {
    return Boolean(
        options.servingStore
        || options.candidateStore
        || options.primaryStore
        || options.fallbackStore
        || options.servingBackend
        || options.dualReadValidation
        || options.logger
        || options.parityValidator
    );
}

function resolveDualReadValidationMode(mode: NavigationDualReadValidationMode | undefined): NavigationDualReadValidationMode {
    return mode || (normalizeTruthiness(process.env.SATORI_NAVIGATION_DUAL_READ) ? 'warn' : 'off');
}

function resolveServingBackend(backend: NavigationServingBackend | undefined): NavigationServingBackend {
    const normalized = (backend || process.env.SATORI_NAVIGATION_BACKEND || '').trim().toLowerCase();
    return normalized === 'sqlite' ? 'sqlite' : 'json';
}

function isFallbackEligibleResult(result: NavigationStoreResultWithStatus): boolean {
    return result.status === 'missing' || result.status === 'incompatible';
}

function evaluateStatusResultFallback(result: NavigationStoreResultWithStatus): NavigationFallbackDecision | null {
    if (!isFallbackEligibleResult(result)) {
        return null;
    }
    return {
        shouldFallback: true,
        reason: result.reason || result.status,
    };
}

function evaluateCompatibilityFallback(result: NavigationCompatibilityState): NavigationFallbackDecision | null {
    if (result.registry.status === 'missing' || result.registry.status === 'incompatible') {
        return {
            shouldFallback: true,
            reason: result.registry.reason,
        };
    }
    if (
        result.relationships.status === 'missing'
        || result.relationships.status === 'incompatible'
    ) {
        return {
            shouldFallback: true,
            reason: result.relationships.reason,
        };
    }
    return null;
}

let sharedRuntimeNavigationStore: RuntimeNavigationStore | null = null;

/** @internal Test helper for resetting the shared default runtime navigation store. */
export function resetSharedRuntimeNavigationStoreForTests(): void {
    sharedRuntimeNavigationStore = null;
}

export class RuntimeNavigationStore implements NavigationStore {
    private readonly jsonStore: NavigationStore;
    private readonly sqliteStore: NavigationStore;
    private readonly servingStore: NavigationStore;
    private readonly servingFallbackStore: NavigationStore | null;
    private readonly servingBackend: NavigationServingBackend;
    private readonly dualReadValidation: NavigationDualReadValidationMode;
    private readonly logger: Pick<Console, 'warn'>;
    private readonly parityValidator: typeof validateNavigationStoreParity;
    private readonly parityValidationByRoot = new Map<string, Promise<void>>();
    private readonly fallbackWarningByRoot = new Set<string>();
    private readonly sqliteServingParityCache = new Set<string>();

    constructor(options: RuntimeNavigationStoreOptions = {}) {
        this.jsonStore = options.servingStore || options.primaryStore || new JsonNavigationStore();
        this.sqliteStore = options.candidateStore || options.fallbackStore || new SQLiteNavigationStore();
        this.servingBackend = options.servingBackend || 'json';
        this.servingStore = this.servingBackend === 'sqlite' ? this.sqliteStore : this.jsonStore;
        this.servingFallbackStore = this.servingBackend === 'sqlite' ? this.jsonStore : null;
        this.dualReadValidation = options.dualReadValidation || 'off';
        this.logger = options.logger || console;
        this.parityValidator = options.parityValidator || validateNavigationStoreParity;
    }

    private scheduleParityValidation(input: NavigationStoreInput): void {
        if (this.dualReadValidation !== 'warn') {
            return;
        }

        const key = parityKey(input);
        let validation = this.parityValidationByRoot.get(key);
        if (!validation) {
            validation = (async () => {
                try {
                    const parity = await this.parityValidator({
                        normalizedRootPath: input.normalizedRootPath,
                        stateRoot: input.stateRoot,
                        generationId: input.generationId,
                        referenceStore: this.jsonStore,
                        candidateStore: this.sqliteStore,
                    });
                    if (!parity.ok) {
                        this.logger.warn(
                            `[NavigationStore] SQLite/JSON parity mismatch for '${input.normalizedRootPath}': ${parity.mismatches.join(', ')}`
                        );
                    }
                } catch (error) {
                    this.logger.warn(
                        `[NavigationStore] SQLite/JSON parity validation failed for '${input.normalizedRootPath}': ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            })().finally(() => {
                if (this.parityValidationByRoot.get(key) === validation) {
                    this.parityValidationByRoot.delete(key);
                }
            });
            this.parityValidationByRoot.set(key, validation);
        }
    }

    private warnServingFallback(input: NavigationStoreInput, reason: string): void {
        const key = parityKey(input);
        if (this.fallbackWarningByRoot.has(key)) {
            return;
        }
        this.fallbackWarningByRoot.add(key);
        this.logger.warn(
            `[NavigationStore] SQLite backend fallback to JSON for '${input.normalizedRootPath}': ${reason}`
        );
    }

    private sqliteServingParityCacheKey(input: NavigationStoreInput, parts: {
        jsonRegistryManifestHash: string;
        sqliteRegistryManifestHash: string;
        jsonRelationshipManifest: string;
        sqliteRelationshipManifest: string;
    }): string {
        return [
            parityKey(input),
            parts.jsonRegistryManifestHash,
            parts.sqliteRegistryManifestHash,
            parts.jsonRelationshipManifest,
            parts.sqliteRelationshipManifest,
        ].join('\0');
    }

    private async evaluateSQLiteServingGate(input: NavigationStoreInput): Promise<SQLiteServingGateDecision> {
        let jsonRegistry: Awaited<ReturnType<NavigationStore['getManifest']>>;
        try {
            jsonRegistry = await this.jsonStore.getManifest(input);
        } catch (error) {
            return {
                canServeSQLite: false,
                reason: `canonical JSON registry check failed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }

        if (jsonRegistry.status !== 'ok') {
            return {
                canServeSQLite: false,
                reason: `canonical JSON registry is unavailable: ${jsonRegistry.reason}`,
            };
        }

        let jsonCompatibility: Awaited<ReturnType<NavigationStore['getCompatibilityState']>>;
        try {
            jsonCompatibility = await this.jsonStore.getCompatibilityState({
                ...input,
                expectedSymbolRegistryManifestHash: jsonRegistry.manifestHash,
            });
        } catch (error) {
            return {
                canServeSQLite: false,
                reason: `canonical JSON compatibility check failed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
        if (jsonCompatibility.registry.status !== 'ok') {
            return {
                canServeSQLite: false,
                reason: `canonical JSON registry is unavailable: ${jsonCompatibility.registry.reason}`,
            };
        }
        if (jsonCompatibility.relationships.status !== 'ok') {
            return {
                canServeSQLite: false,
                reason: `canonical JSON relationships are unavailable: ${jsonCompatibility.relationships.reason}`,
            };
        }

        let sqliteRegistry: Awaited<ReturnType<NavigationStore['getManifest']>>;
        try {
            sqliteRegistry = await this.sqliteStore.getManifest(input);
        } catch (error) {
            return {
                canServeSQLite: false,
                reason: `SQLite registry check failed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }

        if (sqliteRegistry.status !== 'ok') {
            return {
                canServeSQLite: false,
                reason: `SQLite registry is unavailable: ${sqliteRegistry.reason}`,
            };
        }
        if (sqliteRegistry.manifestHash !== jsonRegistry.manifestHash) {
            return {
                canServeSQLite: false,
                reason: 'SQLite registry manifest hash does not match canonical JSON',
            };
        }

        let sqliteCompatibility: Awaited<ReturnType<NavigationStore['getCompatibilityState']>>;
        try {
            sqliteCompatibility = await this.sqliteStore.getCompatibilityState({
                ...input,
                expectedSymbolRegistryManifestHash: jsonRegistry.manifestHash,
            });
        } catch (error) {
            return {
                canServeSQLite: false,
                reason: `SQLite compatibility check failed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
        if (sqliteCompatibility.registry.status !== 'ok') {
            return {
                canServeSQLite: false,
                reason: `SQLite registry is unavailable: ${sqliteCompatibility.registry.reason}`,
            };
        }
        if (sqliteCompatibility.relationships.status !== 'ok') {
            return {
                canServeSQLite: false,
                reason: `SQLite relationships are unavailable: ${sqliteCompatibility.relationships.reason}`,
            };
        }

        const jsonRelationshipManifest = JSON.stringify(jsonCompatibility.relationships.manifest);
        const sqliteRelationshipManifest = JSON.stringify(sqliteCompatibility.relationships.manifest);
        if (jsonRelationshipManifest !== sqliteRelationshipManifest) {
            return {
                canServeSQLite: false,
                reason: 'SQLite relationship manifest does not match canonical JSON',
            };
        }

        const cacheKey = this.sqliteServingParityCacheKey(input, {
            jsonRegistryManifestHash: jsonRegistry.manifestHash,
            sqliteRegistryManifestHash: sqliteRegistry.manifestHash,
            jsonRelationshipManifest,
            sqliteRelationshipManifest,
        });
        if (this.sqliteServingParityCache.has(cacheKey)) {
            return { canServeSQLite: true };
        }

        try {
            const parity = await this.parityValidator({
                normalizedRootPath: input.normalizedRootPath,
                stateRoot: input.stateRoot,
                referenceStore: this.jsonStore,
                candidateStore: this.sqliteStore,
            });
            if (!parity.ok) {
                return {
                    canServeSQLite: false,
                    reason: `SQLite parity mismatch: ${parity.mismatches.join(', ')}`,
                };
            }
        } catch (error) {
            return {
                canServeSQLite: false,
                reason: `SQLite parity validation failed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }

        this.sqliteServingParityCache.add(cacheKey);
        return { canServeSQLite: true };
    }

    private async serve<T>(
        input: NavigationStoreInput,
        read: (store: NavigationStore) => Promise<T>,
        evaluateFallback: (result: T) => NavigationFallbackDecision | null,
    ): Promise<T> {
        if (this.servingBackend === 'sqlite' && this.servingFallbackStore) {
            const gate = await this.evaluateSQLiteServingGate(input);
            if (!gate.canServeSQLite) {
                this.warnServingFallback(input, gate.reason);
                return read(this.servingFallbackStore);
            }
        }

        let result: T;
        try {
            result = await read(this.servingStore);
        } catch (error) {
            if (!this.servingFallbackStore) {
                throw error;
            }
            this.warnServingFallback(
                input,
                error instanceof Error ? error.message : String(error),
            );
            result = await read(this.servingFallbackStore);
            return result;
        }

        const fallback = evaluateFallback(result);
        if (this.servingFallbackStore && fallback?.shouldFallback) {
            this.warnServingFallback(input, fallback.reason);
            result = await read(this.servingFallbackStore);
            return result;
        }

        this.scheduleParityValidation(input);
        return result;
    }

    public async getManifest(input: NavigationStoreInput): Promise<NavigationRegistryState> {
        return this.serve(
            input,
            (store) => store.getManifest(input),
            evaluateStatusResultFallback,
        );
    }

    public async getSymbolsByFile(input: NavigationSymbolsByFileInput): Promise<NavigationSymbolsByFileResult> {
        return this.serve(
            input,
            (store) => store.getSymbolsByFile(input),
            evaluateStatusResultFallback,
        );
    }

    public async getSymbolByInstanceId(input: NavigationSymbolByInstanceIdInput): Promise<NavigationSymbolByInstanceIdResult> {
        return this.serve(
            input,
            (store) => store.getSymbolByInstanceId(input),
            evaluateStatusResultFallback,
        );
    }

    public async getSymbolCandidatesByKey(input: NavigationSymbolCandidatesByKeyInput): Promise<NavigationSymbolCandidatesByKeyResult> {
        return this.serve(
            input,
            (store) => store.getSymbolCandidatesByKey(input),
            evaluateStatusResultFallback,
        );
    }

    public async findOwnerForSpan(input: NavigationOwnerForSpanInput): Promise<NavigationOwnerForSpanResult> {
        return this.serve(
            input,
            (store) => store.findOwnerForSpan(input),
            evaluateStatusResultFallback,
        );
    }

    public async getRelationships(input: NavigationRelationshipsQueryInput): Promise<NavigationRelationshipsState> {
        return this.serve(
            input,
            (store) => store.getRelationships(input),
            evaluateStatusResultFallback,
        );
    }

    public async getCompatibilityState(input: NavigationCompatibilityInput): Promise<NavigationCompatibilityState> {
        return this.serve(
            input,
            (store) => store.getCompatibilityState(input),
            evaluateCompatibilityFallback,
        );
    }
}

export function createRuntimeNavigationStore(options: RuntimeNavigationStoreOptions = {}): RuntimeNavigationStore {
    const resolvedOptions: RuntimeNavigationStoreOptions = {
        ...options,
        servingBackend: resolveServingBackend(options.servingBackend),
        dualReadValidation: resolveDualReadValidationMode(options.dualReadValidation),
    };
    if (hasExplicitRuntimeNavigationStoreOptions(options)) {
        return new RuntimeNavigationStore(resolvedOptions);
    }
    if (!sharedRuntimeNavigationStore) {
        sharedRuntimeNavigationStore = new RuntimeNavigationStore(resolvedOptions);
    }
    return sharedRuntimeNavigationStore;
}
