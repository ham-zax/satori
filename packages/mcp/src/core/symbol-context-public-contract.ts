import { z } from "zod";
import type {
    ComposedSymbolContext,
    SymbolContextBudgets,
    SymbolContextContinuationRequest,
    SymbolContextInclude,
} from "./symbol-context-composer.js";

export const SYMBOL_CONTEXT_FORMAT_VERSION = 2 as const;
export const SYMBOL_CONTEXT_KIND = "symbol_context" as const;

export const SYMBOL_CONTEXT_LIMITS = Object.freeze({
    defaultSourceBytes: 12_288,
    maxSourceBytes: 16_384,
    defaultSourceLines: 200,
    maxSourceLines: 250,
    defaultExcerpts: 5,
    maxExcerpts: 6,
    maxExcerptBytes: 8_192,
    defaultSiblings: 12,
    maxSiblings: 20,
    defaultEdgesPerDirection: 20,
    maxEdgesPerDirection: 20,
    defaultTotalResponseBytes: 24_576,
    hardResponseLimitBytes: 32_768,
    maxInspectableSourceBytes: 4_194_304,
    emergencyErrorLimitBytes: 1_024,
    acceptedErrorLimitBytes: 4_096,
});

const boundedFingerprintSchema = z.string().trim().min(1).max(128);
const boundedCursorSchema = z.string().trim().min(1).max(1_024);

const sourceContinuationSchema = z.object({
    kind: z.literal("source_range"),
    fingerprint: boundedFingerprintSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
}).strict().superRefine((value, context) => {
    if (value.endLine < value.startLine) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["endLine"],
            message: "endLine must not precede startLine.",
        });
    }
});

const relationshipContinuationSchema = z.object({
    kind: z.enum(["caller_page", "callee_page"]),
    fingerprint: boundedFingerprintSchema,
    cursor: boundedCursorSchema,
    pageSize: z.number().int().positive().optional(),
}).strict();

const unsupportedContinuationSchema = z.object({
    kind: z.string().trim().min(1).max(64).refine(
        (kind) => !["source_range", "caller_page", "callee_page"].includes(kind),
    ),
}).strict();

export const symbolContextContinuationSchema = z.union([
    sourceContinuationSchema,
    relationshipContinuationSchema,
    unsupportedContinuationSchema,
]);

const contextIncludeSchema = z.object({
    source: z.boolean().optional(),
    lexicalContext: z.boolean().optional(),
    callers: z.boolean().optional(),
    callees: z.boolean().optional(),
}).strict();

const contextBudgetsSchema = z.object({
    sourceBytes: z.number().int().positive().optional(),
    sourceLines: z.number().int().positive().optional(),
    excerpts: z.number().int().positive().optional(),
    siblings: z.number().int().nonnegative().optional(),
    edgesPerDirection: z.number().int().positive().optional(),
    totalResponseBytes: z.number().int()
        .min(SYMBOL_CONTEXT_LIMITS.emergencyErrorLimitBytes)
        .optional(),
}).strict();

export const symbolContextRequestSchema = z.object({
    preset: z.enum(["definition", "implementation", "call_context"]),
    query: z.string().trim().min(1).max(512).optional(),
    include: contextIncludeSchema.optional(),
    budgets: contextBudgetsSchema.optional(),
}).strict();

export const exactSymbolOpenRequestSchema = z.object({
    contractVersion: z.literal(SYMBOL_CONTEXT_FORMAT_VERSION),
    symbolId: z.string().trim().min(1).max(512).optional(),
    symbolLabel: z.string().trim().min(1).max(512).optional(),
    context: symbolContextRequestSchema.optional(),
    continuation: symbolContextContinuationSchema.optional(),
}).strict().superRefine((value, context) => {
    if (Number(Boolean(value.symbolId)) + Number(Boolean(value.symbolLabel)) !== 1) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["symbolId"],
            message: "exactly one of symbolId or symbolLabel is required.",
        });
    }
    if (Number(Boolean(value.context)) + Number(Boolean(value.continuation)) !== 1) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["context"],
            message: "exactly one of context or continuation is required.",
        });
    }
});

export const directSpanOpenRequestSchema = z.object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
}).strict().superRefine((value, context) => {
    if (value.endLine < value.startLine) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["endLine"],
            message: "endLine must not precede startLine.",
        });
    }
});

const symbolIdentityFieldSchema = z.string().trim().min(1).max(512);

export function hasExactSymbolMarker(value: unknown): boolean {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return record.contractVersion !== undefined
        || record.symbolId !== undefined
        || record.symbolLabel !== undefined
        || record.context !== undefined
        || record.continuation !== undefined;
}

function flattenZodIssues(issues: readonly z.ZodIssue[]): z.ZodIssue[] {
    const flattened: z.ZodIssue[] = [];
    for (const issue of issues) {
        const unionErrors = (issue as { unionErrors?: readonly z.ZodError[] }).unionErrors;
        if (issue.code === z.ZodIssueCode.invalid_union && unionErrors && unionErrors.length > 0) {
            for (const unionError of unionErrors) {
                flattened.push(...flattenZodIssues(unionError.issues));
            }
        } else {
            flattened.push(issue);
        }
    }
    return flattened;
}

/**
 * `open_symbol` is validated as one unit. Any exact-symbol marker
 * (`contractVersion`, `symbolId`, `symbolLabel`, `context`, `continuation`)
 * commits the whole object to exact-symbol validation; every actionable
 * violation — unsupported version, conflicting identity or operations,
 * inner shape errors — is reported at a stable field path in one response.
 * Omitted version and operation default to v2 definition context.
 * Objects without any exact-symbol marker are direct spans and remain
 * exempt from the exact-symbol contract.
 */
export const openSymbolRequestSchema = z.object({
    contractVersion: z.unknown().optional(),
    symbolId: z.unknown().optional(),
    symbolLabel: z.unknown().optional(),
    context: z.unknown().optional(),
    continuation: z.unknown().optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
}).strict().superRefine((value, ctx) => {
    if (hasExactSymbolMarker(value)) {
        if (value.contractVersion !== undefined && value.contractVersion !== SYMBOL_CONTEXT_FORMAT_VERSION) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["contractVersion"],
                message: `contractVersion ${SYMBOL_CONTEXT_FORMAT_VERSION} is required for exact-symbol requests.`,
            });
        }
        if (Number(Boolean(value.symbolId)) + Number(Boolean(value.symbolLabel)) !== 1) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["symbolId"],
                message: "exactly one of symbolId or symbolLabel is required.",
            });
        }
        if (value.context !== undefined && value.continuation !== undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["context"],
                message: "exactly one of context or continuation is required.",
            });
        }
        if (value.startLine !== undefined || value.endLine !== undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["startLine"],
                message: "direct span fields cannot be combined with an exact-symbol request.",
            });
        }
        if (value.symbolId !== undefined) {
            const identity = symbolIdentityFieldSchema.safeParse(value.symbolId);
            if (!identity.success) {
                for (const issue of flattenZodIssues(identity.error.issues)) {
                    ctx.addIssue({ ...issue, path: ["symbolId", ...issue.path] });
                }
            }
        }
        if (value.symbolLabel !== undefined) {
            const identity = symbolIdentityFieldSchema.safeParse(value.symbolLabel);
            if (!identity.success) {
                for (const issue of flattenZodIssues(identity.error.issues)) {
                    ctx.addIssue({ ...issue, path: ["symbolLabel", ...issue.path] });
                }
            }
        }
        if (value.context !== undefined) {
            const inner = symbolContextRequestSchema.safeParse(value.context);
            if (!inner.success) {
                for (const issue of flattenZodIssues(inner.error.issues)) {
                    ctx.addIssue({ ...issue, path: ["context", ...issue.path] });
                }
            }
        }
        if (value.continuation !== undefined) {
            const inner = symbolContextContinuationSchema.safeParse(value.continuation);
            if (!inner.success) {
                for (const issue of flattenZodIssues(inner.error.issues)) {
                    ctx.addIssue({ ...issue, path: ["continuation", ...issue.path] });
                }
            }
        }
        return;
    }
    if (value.startLine === undefined) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["startLine"],
            message: "startLine is required for direct-span requests.",
        });
    }
    if (value.endLine === undefined) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["endLine"],
            message: "endLine is required for direct-span requests.",
        });
    }
    if (
        value.startLine !== undefined
        && value.endLine !== undefined
        && value.endLine < value.startLine
    ) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["endLine"],
            message: "endLine must not precede startLine.",
        });
    }
}).transform(value => hasExactSymbolMarker(value) ? {
    ...value,
    contractVersion: value.contractVersion ?? SYMBOL_CONTEXT_FORMAT_VERSION,
    ...(value.context === undefined && value.continuation === undefined
        ? { context: { preset: "definition" as const } } : {}),
} : value);

export type ExactSymbolOpenRequest = z.infer<typeof exactSymbolOpenRequestSchema>;
export type SymbolContextPreset = z.infer<typeof symbolContextRequestSchema>["preset"];

export interface EffectiveSymbolContextRequest {
    requestedMode: "plain" | "annotated";
    preset: SymbolContextPreset;
    include: SymbolContextInclude & { lexicalContext: boolean };
    budgets: {
        sourceBytes: number;
        sourceLines: number;
        excerpts: number;
        siblings: number;
        edgesPerDirection: number;
        totalResponseBytes: number;
    };
}

export type EffectiveSymbolContextContinuationRequest = EffectiveSymbolContextRequest & {
    continuation: {
        kind: SymbolContextContinuationRequest["kind"];
    };
};

export type ResolvedSymbolContextOperation = {
    kind: "context";
    effectiveRequest: EffectiveSymbolContextRequest;
    include: SymbolContextInclude;
    budgets: SymbolContextBudgets;
    query?: string;
} | {
    kind: "continuation";
    effectiveRequest: EffectiveSymbolContextContinuationRequest;
    include: SymbolContextInclude;
    budgets: SymbolContextBudgets;
    continuation: SymbolContextContinuationRequest;
};

const PRESET_DEFAULTS: Record<SymbolContextPreset, SymbolContextInclude & {
    lexicalContext: boolean;
}> = {
    definition: {
        source: true,
        siblings: false,
        callers: false,
        callees: false,
        lexicalContext: false,
    },
    implementation: {
        source: true,
        siblings: true,
        callers: false,
        callees: false,
        lexicalContext: true,
    },
    call_context: {
        source: true,
        siblings: true,
        callers: true,
        callees: true,
        lexicalContext: true,
    },
};

function clamp(value: number | undefined, fallback: number, maximum: number): number {
    return Math.min(value ?? fallback, maximum);
}

function resolveBudgets(
    requested: z.infer<typeof contextBudgetsSchema> | undefined,
): EffectiveSymbolContextRequest["budgets"] {
    return {
        sourceBytes: clamp(
            requested?.sourceBytes,
            SYMBOL_CONTEXT_LIMITS.defaultSourceBytes,
            SYMBOL_CONTEXT_LIMITS.maxSourceBytes,
        ),
        sourceLines: clamp(
            requested?.sourceLines,
            SYMBOL_CONTEXT_LIMITS.defaultSourceLines,
            SYMBOL_CONTEXT_LIMITS.maxSourceLines,
        ),
        excerpts: clamp(
            requested?.excerpts,
            SYMBOL_CONTEXT_LIMITS.defaultExcerpts,
            SYMBOL_CONTEXT_LIMITS.maxExcerpts,
        ),
        siblings: clamp(
            requested?.siblings,
            SYMBOL_CONTEXT_LIMITS.defaultSiblings,
            SYMBOL_CONTEXT_LIMITS.maxSiblings,
        ),
        edgesPerDirection: clamp(
            requested?.edgesPerDirection,
            SYMBOL_CONTEXT_LIMITS.defaultEdgesPerDirection,
            SYMBOL_CONTEXT_LIMITS.maxEdgesPerDirection,
        ),
        totalResponseBytes: clamp(
            requested?.totalResponseBytes,
            SYMBOL_CONTEXT_LIMITS.defaultTotalResponseBytes,
            SYMBOL_CONTEXT_LIMITS.hardResponseLimitBytes,
        ),
    };
}

function composerBudgets(
    effective: EffectiveSymbolContextRequest,
    maxSerializedResponseBytes: number,
): SymbolContextBudgets {
    return {
        source: {
            maxSourceBytes: effective.budgets.sourceBytes,
            maxSourceLines: effective.budgets.sourceLines,
            maxExcerpts: effective.budgets.excerpts,
            maxExcerptBytes: Math.min(
                effective.budgets.sourceBytes,
                SYMBOL_CONTEXT_LIMITS.maxExcerptBytes,
            ),
            maxExcerptLines: effective.budgets.sourceLines,
            contextLines: 2,
            maxSerializedSourceBytes: maxSerializedResponseBytes,
        },
        maxInspectableBytes: SYMBOL_CONTEXT_LIMITS.maxInspectableSourceBytes,
        maxSiblings: effective.budgets.siblings,
        maxEdgesPerDirection: effective.budgets.edgesPerDirection,
        maxSerializedResponseBytes,
    };
}

function responsePrefixBytes(effectiveRequest: EffectiveSymbolContextRequest | (
    EffectiveSymbolContextContinuationRequest
)): number {
    const prefix = {
        formatVersion: SYMBOL_CONTEXT_FORMAT_VERSION,
        kind: SYMBOL_CONTEXT_KIND,
        effectiveRequest,
    };
    return Buffer.byteLength(JSON.stringify(prefix), "utf8") - 1;
}

function effectiveContextRequest(
    mode: "plain" | "annotated",
    request: NonNullable<ExactSymbolOpenRequest["context"]>,
): EffectiveSymbolContextRequest {
    const defaults = PRESET_DEFAULTS[request.preset];
    const include = {
        source: request.include?.source ?? defaults.source,
        siblings: defaults.siblings,
        callers: request.include?.callers ?? defaults.callers,
        callees: request.include?.callees ?? defaults.callees,
        lexicalContext: request.include?.lexicalContext ?? defaults.lexicalContext,
    };
    return {
        requestedMode: mode,
        preset: request.preset,
        include,
        budgets: resolveBudgets(request.budgets),
    };
}

function continuationInclude(
    continuation: SymbolContextContinuationRequest,
): SymbolContextInclude {
    return {
        source: continuation.kind === "source_range",
        siblings: false,
        callers: continuation.kind === "caller_page",
        callees: continuation.kind === "callee_page",
    };
}

export function resolveSymbolContextOperation(input: {
    mode: "plain" | "annotated";
    request: ExactSymbolOpenRequest;
}): ResolvedSymbolContextOperation | { kind: "unsupported_continuation" } {
    if (input.request.context) {
        const effectiveRequest = effectiveContextRequest(input.mode, input.request.context);
        const innerLimit = effectiveRequest.budgets.totalResponseBytes
            - responsePrefixBytes(effectiveRequest);
        if (innerLimit < 1) {
            throw new RangeError("The effective symbol-context response budget is too small.");
        }
        return {
            kind: "context",
            effectiveRequest,
            include: {
                source: effectiveRequest.include.source,
                siblings: effectiveRequest.include.siblings,
                callers: effectiveRequest.include.callers,
                callees: effectiveRequest.include.callees,
            },
            budgets: composerBudgets(effectiveRequest, innerLimit),
            ...(effectiveRequest.include.lexicalContext && input.request.context.query
                ? { query: input.request.context.query }
                : {}),
        };
    }

    const requested = input.request.continuation;
    if (!requested) {
        return { kind: "unsupported_continuation" };
    }
    let continuation: SymbolContextContinuationRequest;
    if ("startLine" in requested) {
        continuation = requested;
    } else if ("cursor" in requested) {
        continuation = {
            ...requested,
            pageSize: clamp(
                requested.pageSize,
                SYMBOL_CONTEXT_LIMITS.defaultEdgesPerDirection,
                SYMBOL_CONTEXT_LIMITS.maxEdgesPerDirection,
            ),
        };
    } else {
        return { kind: "unsupported_continuation" };
    }
    const include = continuationInclude(continuation);
    const effectiveBase: EffectiveSymbolContextRequest = {
        requestedMode: input.mode,
        preset: "implementation",
        include: { ...include, lexicalContext: false },
        budgets: resolveBudgets(undefined),
    };
    const effectiveRequest = {
        ...effectiveBase,
        continuation: { kind: continuation.kind },
    };
    const innerLimit = effectiveBase.budgets.totalResponseBytes
        - responsePrefixBytes(effectiveRequest);
    if (innerLimit < 1) {
        throw new RangeError("The effective symbol-context response budget is too small.");
    }
    return {
        kind: "continuation",
        effectiveRequest,
        include,
        budgets: composerBudgets(effectiveBase, innerLimit),
        continuation,
    };
}

export function composePublicSymbolContextEnvelope(input: {
    effectiveRequest: EffectiveSymbolContextRequest | EffectiveSymbolContextContinuationRequest;
    context: ComposedSymbolContext;
}) {
    return {
        formatVersion: SYMBOL_CONTEXT_FORMAT_VERSION,
        kind: SYMBOL_CONTEXT_KIND,
        effectiveRequest: input.effectiveRequest,
        status: input.context.status,
        symbol: input.context.symbol,
        outline: input.context.outline,
        source: input.context.source,
        relationships: input.context.relationships,
        authority: input.context.authority,
        continuations: input.context.continuations,
        limitations: input.context.limitations,
    };
}
