import fs from "node:fs";
import path from "node:path";
import { readManagedPackageJson, resolveManagedPackageRoot } from "./managed-package.js";

export function resolveServerEntryPath(): string {
    const packageRoot = resolveManagedPackageRoot();
    const pkg = readManagedPackageJson();
    const jsEntry = path.resolve(packageRoot, typeof pkg.main === "string" ? pkg.main : "dist/index.js");
    if (fs.existsSync(jsEntry)) {
        return jsEntry;
    }
    const tsEntry = path.resolve(packageRoot, "src", "index.ts");
    if (fs.existsSync(tsEntry)) {
        return tsEntry;
    }
    return jsEntry;
}
