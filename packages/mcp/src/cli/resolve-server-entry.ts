import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveServerEntryPath(): string {
    const currentFile = fileURLToPath(import.meta.url);
    const currentDir = path.dirname(currentFile);
    const jsEntry = path.resolve(currentDir, "..", "index.js");
    if (fs.existsSync(jsEntry)) {
        return jsEntry;
    }
    const tsEntry = path.resolve(currentDir, "..", "index.ts");
    if (fs.existsSync(tsEntry)) {
        return tsEntry;
    }
    return jsEntry;
}
