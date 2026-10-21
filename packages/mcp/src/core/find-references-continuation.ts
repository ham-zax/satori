import crypto from "node:crypto";
import { serializeCanonicalJson } from "./canonical-json.js";

// find_references continuations follow the call_graph evidence cursor contract:
// canonical JSON bound to the serving Publication, the target symbol, and the
// requested path scope, so a page never mixes occurrences from two Publications.
const FIND_REFERENCES_CURSOR_FORMAT_VERSION = 1;
export const MAX_FIND_REFERENCES_CURSOR_BYTES = 1_024;

export type FindReferencesCursorIdentity = {
    publicationId: string;
    symbolId: string;
    scopeIdentity: string;
};

type FindReferencesCursor = FindReferencesCursorIdentity & {
    formatVersion: typeof FIND_REFERENCES_CURSOR_FORMAT_VERSION;
    offset: number;
};

export class InvalidFindReferencesContinuationError extends Error {
    constructor() {
        super("The find_references continuation is invalid for the current Publication, symbol, and requested path scope.");
        this.name = "InvalidFindReferencesContinuationError";
    }
}

export function findReferencesScopeIdentity(scope: {
    subtree?: string;
    includePaths?: readonly string[];
    excludePaths?: readonly string[];
}): string {
    return crypto.createHash("sha256")
        .update(serializeCanonicalJson({
            subtree: scope.subtree ?? null,
            includePaths: scope.includePaths ?? [],
            excludePaths: scope.excludePaths ?? [],
        }), "utf8")
        .digest("hex");
}

export function serializeFindReferencesCursor(identity: FindReferencesCursorIdentity, offset: number): string {
    const serialized = serializeCanonicalJson({
        formatVersion: FIND_REFERENCES_CURSOR_FORMAT_VERSION,
        ...identity,
        offset,
    } satisfies FindReferencesCursor);
    if (Buffer.byteLength(serialized, "utf8") > MAX_FIND_REFERENCES_CURSOR_BYTES) {
        throw new InvalidFindReferencesContinuationError();
    }
    return serialized;
}

/** Returns the occurrence offset the cursor continues from. */
export function parseFindReferencesCursor(serialized: string, expected: FindReferencesCursorIdentity): number {
    if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_FIND_REFERENCES_CURSOR_BYTES) {
        throw new InvalidFindReferencesContinuationError();
    }
    let parsed: Partial<FindReferencesCursor>;
    try {
        parsed = JSON.parse(serialized) as Partial<FindReferencesCursor>;
    } catch {
        throw new InvalidFindReferencesContinuationError();
    }
    if (
        parsed === null
        || typeof parsed !== "object"
        || Array.isArray(parsed)
        || Object.keys(parsed).length !== 5
        || parsed.formatVersion !== FIND_REFERENCES_CURSOR_FORMAT_VERSION
        || parsed.publicationId !== expected.publicationId
        || parsed.symbolId !== expected.symbolId
        || parsed.scopeIdentity !== expected.scopeIdentity
        || !Number.isSafeInteger(parsed.offset)
        || Number(parsed.offset) < 1
    ) {
        throw new InvalidFindReferencesContinuationError();
    }
    return Number(parsed.offset);
}
