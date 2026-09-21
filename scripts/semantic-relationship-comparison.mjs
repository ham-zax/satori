#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { compareRelationshipQualificationArtifacts } from './semantic-relationship-qualification.mjs';

function usage() {
    return `Usage:
  node scripts/semantic-relationship-comparison.mjs --input <qualification.json> --input <qualification.json> --out <comparison.json>

Options:
  --input <file>   Completed semantic relationship qualification artifact. Repeat for each provider/run.
  --out <file>     Output comparison JSON path. Parent directories are created.
  --help           Show this help.
`;
}

function parseArgs(argv) {
    const options = {
        inputFiles: [],
        outFile: null,
        help: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = () => {
            const value = argv[++index];
            if (!value) throw new Error(`Missing value for ${arg}.`);
            return value;
        };
        if (arg === '--input') options.inputFiles.push(path.resolve(next()));
        else if (arg === '--out') options.outFile = path.resolve(next());
        else if (arg === '--help') options.help = true;
        else throw new Error(`Unknown argument: ${arg}`);
    }
    if (options.help) return options;
    if (options.inputFiles.length === 0) throw new Error('--input is required at least once.');
    if (!options.outFile) throw new Error('--out is required.');
    return options;
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(usage());
        return;
    }

    const artifacts = options.inputFiles.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
    const comparison = compareRelationshipQualificationArtifacts(artifacts);
    const artifact = {
        ...comparison,
        generatedAt: new Date().toISOString(),
        sourceArtifacts: options.inputFiles.map((file) => path.relative(process.cwd(), file)),
    };

    fs.mkdirSync(path.dirname(options.outFile), { recursive: true });
    fs.writeFileSync(options.outFile, `${JSON.stringify(artifact, null, 2)}\n`);

    process.stdout.write('Semantic Relationship Provider Comparison\n=========================================\n');
    for (const row of comparison.lanes.deterministic.providers) {
        const provider = `${row.provider.id}@${row.provider.version}`;
        const semantic = row.semanticExact
            ? `${row.semanticExact.count}/${row.semanticExact.total ?? row.totalCases}`
            : 'n/a';
        const strict = row.strictCaseExact
            ? `${row.strictCaseExact.count}/${row.strictCaseExact.total ?? row.totalCases}`
            : 'n/a';
        process.stdout.write(
            `- ${provider} (${row.language}): semantic=${semantic}, strict=${strict}, `
            + `wrong-targets=${row.wrongTargetCount ?? 'n/a'}, false-resolved=${row.falseResolvedCount ?? 'n/a'}\n`,
        );
    }
}

try {
    main();
} catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}
