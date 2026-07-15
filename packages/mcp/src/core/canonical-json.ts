export function serializeCanonicalJson(value: unknown): string {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
        return JSON.stringify(value);
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new TypeError("Canonical JSON does not accept non-finite numbers.");
        }
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((entry) => serializeCanonicalJson(entry)).join(",")}]`;
    }
    if (typeof value === "object") {
        const record = value as Record<string, unknown>;
        const entries = Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${serializeCanonicalJson(record[key])}`);
        return `{${entries.join(",")}}`;
    }
    throw new TypeError(`Canonical JSON does not accept ${typeof value}.`);
}
