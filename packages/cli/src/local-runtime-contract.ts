import crypto from "node:crypto";
import path from "node:path";

export {
    EMBEDDING_PROJECTION_VERSION,
    LEXICAL_PROJECTION_VERSION,
    POTION_DIMENSION,
    POTION_MODEL_ID,
} from "./runtime-identities.cjs";

export function resolveSatoriStateRoot(input: {
    configured?: string;
    homeDir: string;
}): string {
    if (!input.configured || input.configured.trim() === "") {
        return path.join(input.homeDir, ".satori");
    }
    if (!path.isAbsolute(input.configured)) {
        throw new Error(
            `SATORI_STATE_ROOT must be an absolute path; received "${input.configured}".`,
        );
    }
    return input.configured;
}

export function resolveRuntimeOwnerStateDir(input: {
    stateRoot: string;
    vectorStoreProvider: "LanceDB" | "Milvus";
    milvusEndpoint?: string;
    homeDir: string;
}): string {
    if (input.vectorStoreProvider === "Milvus") {
        if (!input.milvusEndpoint || input.milvusEndpoint.trim() === "") {
            throw new Error(
                "Milvus vector-store requires MILVUS_ADDRESS for the runtime-owner registry.",
            );
        }
        const endpointHash = crypto.createHash("sha256")
            .update(input.milvusEndpoint.trim().toLowerCase())
            .digest("hex");
        return path.join(input.homeDir, ".satori", "runtime-owner", "milvus", endpointHash);
    }
    return path.join(input.stateRoot, "runtime-owner");
}

export function assertLocalOnlyEndpoint(endpoint: string, label: string): void {
    let url: URL;
    try {
        url = new URL(endpoint);
    } catch {
        throw new Error(`${label} must be a valid URL.`);
    }
    const hostname = url.hostname.toLowerCase();
    const isLoopback = hostname === "localhost"
        || hostname === "::1"
        || /^127(?:\.\d{1,3}){3}$/.test(hostname);
    if (!["http:", "https:"].includes(url.protocol) || !isLoopback) {
        throw new Error(`${label} must use a loopback HTTP(S) endpoint in local-only mode.`);
    }
}
