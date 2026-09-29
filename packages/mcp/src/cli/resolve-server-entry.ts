import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeArtifactMissingError } from "@satori-code/core";

/** Server entry next to this file's own extension: dist `.js`, or `.ts` when the CLI itself runs from source. */
export function resolveServerEntryPath(): string {
    const currentFile = fileURLToPath(import.meta.url);
    const entry = path.resolve(path.dirname(currentFile), "..", `index${path.extname(currentFile)}`);
    if (!fs.existsSync(entry)) throw new RuntimeArtifactMissingError(entry);
    return entry;
}
