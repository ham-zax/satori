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

export const DEFAULT_TEXT_WIDTH = 100;

function collapseWhitespace(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function firstSentence(value: string): string {
    const text = collapseWhitespace(value);
    return /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
}

function truncateTo(value: string, width: number): string {
    if (value.length <= width) return value;
    return `${value.slice(0, Math.max(0, width - 1)).trimEnd()}…`;
}

/** Compact text view of an MCP tools/list result: aligned name and first description sentence. */
export function formatToolsListText(result: unknown, width: number = DEFAULT_TEXT_WIDTH): string {
    const tools = (result as { tools?: unknown } | null)?.tools;
    const entries = (Array.isArray(tools) ? tools : [])
        .map((tool) => tool as { name?: unknown; description?: unknown })
        .filter((tool): tool is { name: string; description?: unknown } => typeof tool?.name === "string");
    const nameWidth = Math.max(0, ...entries.map((tool) => tool.name.length));
    const lines = entries.map((tool) => {
        const description = typeof tool.description === "string" ? firstSentence(tool.description) : "";
        const line = description ? `${tool.name.padEnd(nameWidth)}  ${description}` : tool.name;
        return truncateTo(line, Math.max(width, nameWidth + 4));
    });
    return [
        ...lines,
        "",
        "Use --format json for full tool descriptions and input schemas.",
        "",
    ].join("\n");
}

/**
 * Text view of a tool result: the payload's humanText when it has one, else the parsed JSON
 * pretty-printed, else the text as-is. Results without text content fall back to JSON.
 */
export function formatToolResultText(result: unknown): string {
    const text = firstTextContent(result);
    if (text === null) {
        return `${JSON.stringify(result, null, 2)}\n`;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return text.endsWith("\n") ? text : `${text}\n`;
    }
    const humanText = parsed && typeof parsed === "object"
        ? (parsed as { humanText?: unknown }).humanText
        : undefined;
    const rendered = typeof humanText === "string" ? humanText : JSON.stringify(parsed, null, 2);
    return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
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
