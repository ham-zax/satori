import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSearchQualityEvaluation } from './search-quality-evaluation.js';

function readOutputPath(argv: string[], workspaceRoot: string): string | null {
    const outputIndex = argv.indexOf('--output');
    if (outputIndex < 0) {
        return null;
    }
    const value = argv[outputIndex + 1];
    if (!value) {
        throw new Error('--output requires a file path');
    }
    return path.resolve(workspaceRoot, value);
}

async function main(): Promise<void> {
    const scriptPath = fileURLToPath(import.meta.url);
    const workspaceRoot = path.resolve(path.dirname(scriptPath), '../..');
    const outputPath = readOutputPath(process.argv.slice(2), workspaceRoot);
    const rawOutputRelativePath = outputPath ? path.relative(workspaceRoot, outputPath) : null;
    const outputRelativePath = rawOutputRelativePath
        && !path.isAbsolute(rawOutputRelativePath)
        && rawOutputRelativePath !== '..'
        && !rawOutputRelativePath.startsWith(`..${path.sep}`)
        ? rawOutputRelativePath.split(path.sep).join('/')
        : null;
    const artifact = await runSearchQualityEvaluation(workspaceRoot, {
        excludeRepositoryPaths: outputRelativePath ? [outputRelativePath] : [],
    });
    const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
    if (outputPath) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, serialized, 'utf8');
    }
    process.stdout.write(serialized);
}

void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
});
