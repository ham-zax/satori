import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const LATEON_PROFILE_ID = "lateon_offline_quality_projection_v5_d32_v1";
export const LATEON_ACTIVATION_POLICY = "lateon_context_v5_d32_owner_default_v1";
export const LATEON_REVISION = "07ef20f406c86badca122464808f4cac2f6e4b25";
export const LATEON_FIXTURE_ARTIFACTS = {
    "model.onnx": "model",
    "tokenizer.json": "tokenizer",
} as const;

export function digest(content: string | Buffer): string {
    return crypto.createHash("sha256").update(content).digest("hex");
}

export function writeLateOnAcquisitionFixture(
    mcpRoot: string,
    artifacts: Readonly<Record<string, string>> = LATEON_FIXTURE_ARTIFACTS,
): void {
    const assetsRoot = path.join(mcpRoot, "assets", "lateon");
    fs.mkdirSync(assetsRoot, { recursive: true });
    const profile = {
        schemaVersion: "satori_lateon_runtime_profile_v5",
        profileId: LATEON_PROFILE_ID,
        identity: {
            repository: "lightonai/LateOn-Code-edge",
            revision: LATEON_REVISION,
            license: "Apache-2.0",
        },
        inference: { candidateDepth: 32 },
        artifacts: Object.entries(artifacts).map(([artifactPath, content]) => ({
            path: artifactPath,
            sha256: digest(content),
        })),
    };
    const profileBytes = Buffer.from(JSON.stringify(profile, null, 2), "utf8");
    fs.writeFileSync(path.join(assetsRoot, "runtime-profile-v5-d32.json"), profileBytes);
    const entries = Object.entries(artifacts).map(([artifactPath, content]) => ({
        path: artifactPath,
        sizeBytes: Buffer.byteLength(content, "utf8"),
        sha256: digest(content),
    }));
    fs.writeFileSync(
        path.join(assetsRoot, "runtime-profile-v5-d32.acquisition.json"),
        JSON.stringify({
            schemaVersion: "satori_lateon_acquisition_v1",
            runtimeProfileSha256: digest(profileBytes),
            artifacts: entries,
            totalExpectedArtifactBytes: entries.reduce((total, entry) => total + entry.sizeBytes, 0),
            policy: {
                downloadDeadlineMilliseconds: 10 * 60 * 1000,
                maximumRedirects: 5,
                diskHeadroomFraction: 0.1,
                diskHeadroomFormula:
                    "totalExpectedArtifactBytes + ceil(totalExpectedArtifactBytes * diskHeadroomFraction)",
            },
        }, null, 2),
        "utf8",
    );
}

export function writeLateOnModelDirectory(
    modelDirectory: string,
    artifacts: Readonly<Record<string, string>> = LATEON_FIXTURE_ARTIFACTS,
): void {
    for (const [artifactPath, content] of Object.entries(artifacts)) {
        const filePath = path.join(modelDirectory, artifactPath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, "utf8");
    }
}

export function fixtureLateOnRuntime(homeDir: string): {
    mcpRoot: string;
    runtimeCommand: { command: string; args: string[] };
    fetchImpl: typeof fetch;
} {
    const mcpRoot = path.join(homeDir, "fixture-runtime", "node_modules", "@satori-code", "mcp");
    fs.mkdirSync(path.join(mcpRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(mcpRoot, "package.json"), JSON.stringify({
        name: "@satori-code/mcp",
        version: "0.0.0-test",
        bin: { satori: "dist/index.js" },
    }), "utf8");
    fs.writeFileSync(path.join(mcpRoot, "dist", "index.js"), "", "utf8");
    writeLateOnAcquisitionFixture(mcpRoot);
    return {
        mcpRoot,
        runtimeCommand: {
            command: process.execPath,
            args: [path.join(mcpRoot, "dist", "index.js")],
        },
        fetchImpl: (async (input: string | URL | Request) => {
            const name = String(input).slice(String(input).lastIndexOf("/") + 1);
            return new Response(
                name === "model.onnx" ? LATEON_FIXTURE_ARTIFACTS["model.onnx"] : LATEON_FIXTURE_ARTIFACTS["tokenizer.json"],
                { status: 200 },
            );
        }) as typeof fetch,
    };
}
