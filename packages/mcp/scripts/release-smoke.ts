import { runPublishedPackageReleaseSmoke } from "../src/cli/package-installability.js";

try {
    runPublishedPackageReleaseSmoke();
    console.log("[release:smoke] MCP package graph is published and the packed tarball starts via npx.");
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[release:smoke] ${message}`);
    process.exit(1);
}
