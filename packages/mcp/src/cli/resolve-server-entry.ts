import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveServerEntryPath(): string {
    const currentFile = fileURLToPath(import.meta.url);
    const currentDir = path.dirname(currentFile);
    return path.resolve(currentDir, "..", "index.js");
}

