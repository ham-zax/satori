type ToolTextContent = { type: string; text?: string };

export interface CliWriters {
    writeStdout: (text: string) => void;
    writeStderr: (text: string) => void;
}

export interface StructuredEnvelopeSummary {
    status: string;
    reason?: string;
    hintStatus?: unknown;
}

export type ManageStatusState = "indexing" | "indexed" | "indexfailed" | "requires_reindex" | "not_indexed" | "unknown";

export function emitJson(writers: CliWriters, payload: unknown): void {
    writers.writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
}

export function emitError(writers: CliWriters, token: string, message: string): void {
    writers.writeStderr(`${token} ${message}\n`);
}

function firstTextContent(result: unknown): string | null {
    const content = (result as { content?: ToolTextContent[] } | null)?.content;
    if (!Array.isArray(content)) {
        return null;
    }

    const firstText = content.find((entry) => entry && entry.type === "text" && typeof entry.text === "string");
    if (!firstText || typeof firstText.text !== "string") {
        return null;
    }
    return firstText.text;
}

export function parseStructuredEnvelope(result: unknown): StructuredEnvelopeSummary | null {
    const text = firstTextContent(result);
    if (!text) {
        return null;
    }

    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object") {
            return null;
        }
        const status = (parsed as { status?: unknown }).status;
        if (typeof status !== "string") {
            return null;
        }
        const reason = (parsed as { reason?: unknown }).reason;
        const hints = (parsed as { hints?: unknown }).hints;
        const hintStatus = hints && typeof hints === "object"
            ? (hints as { status?: unknown }).status
            : undefined;
        return {
            status,
            reason: typeof reason === "string" ? reason : undefined,
            hintStatus
        };
    } catch {
        return null;
    }
}

export function inferManageStatusState(result: unknown): ManageStatusState {
    const envelope = parseStructuredEnvelope(result);
    if (envelope) {
        if (envelope.status === "not_ready" && envelope.reason === "indexing") {
            return "indexing";
        }
        if (envelope.status === "not_ready" && envelope.reason === "requires_reindex") {
            return "requires_reindex";
        }
        if (envelope.status === "requires_reindex") {
            return "requires_reindex";
        }
        if (envelope.status === "blocked" && envelope.reason === "requires_reindex") {
            return "requires_reindex";
        }
        if (envelope.status === "not_indexed") {
            return "not_indexed";
        }
        if (envelope.status === "blocked" && envelope.reason === "not_indexed") {
            return "not_indexed";
        }
        if (envelope.status === "ok") {
            return "indexed";
        }
        if (envelope.status === "error" && envelope.reason === "requires_reindex") {
            return "requires_reindex";
        }
        if (envelope.status === "error" && envelope.reason === "not_indexed") {
            return "not_indexed";
        }
    }

    const text = firstTextContent(result);
    if (!text) {
        return "unknown";
    }

    const normalized = text.toLowerCase();
    if (normalized.includes("currently being indexed") || normalized.includes("currently indexing")) {
        return "indexing";
    }
    if (normalized.includes("fully indexed and ready")) {
        return "indexed";
    }
    if (normalized.includes("indexing failed")) {
        return "indexfailed";
    }
    if (normalized.includes("must be rebuilt") || normalized.includes("incompatible with the current runtime")) {
        return "requires_reindex";
    }
    if (normalized.includes("is not indexed")) {
        return "not_indexed";
    }
    return "unknown";
}
