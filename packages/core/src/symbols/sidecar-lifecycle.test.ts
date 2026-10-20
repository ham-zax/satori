import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createLanguageAnalysisService } from '../language-analysis/service';
import { SYMBOL_REGISTRY_SCHEMA_VERSION } from './contracts';
import { buildSymbolRecordsForFile, buildSymbolRegistry } from './registry';
import { stagePublicationNavigation } from './sidecar-lifecycle';

const EXT4 = 0xef53;
const TMPFS = 0x01021994;
const source = 'export function first() { return second(); }\nexport function second() { return 1; }\n';

async function stage(root: string) {
    const analyzer = createLanguageAnalysisService();
    const analysis = await analyzer.analyze({ content: source, relativePath: 'a.ts', language: 'typescript' });
    await analyzer.dispose?.();
    const symbols = buildSymbolRecordsForFile({ relativePath: 'a.ts', content: source, language: 'typescript',
        fileHash: 'hash', extractorVersion: 'fixture', extractedSymbols: analysis.symbols, chunks: [...analysis.chunks] });
    const registry = buildSymbolRegistry({ manifest: {
        schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION, normalizedRootPath: root, rootFingerprint: 'fixture',
        indexPolicyHash: 'policy', languageRouterVersion: 'router', extractorVersion: 'fixture',
        relationshipVersion: 'fixture', builtAt: new Date(0).toISOString(), files: [
            { path: 'a.ts', hash: 'hash', language: 'typescript', symbolCount: symbols.length,
                definitionStatus: 'definitions_present' },
        ],
    }, symbols });
    return stagePublicationNavigation({ publicationId: 'first', navigationRoot: path.join(root, 'first', 'navigation'),
        registry, records: [], analysisByFile: new Map([['a.ts', { moduleBindings: analysis.moduleBindings,
            callSites: analysis.callSites, receiverTypeBindings: analysis.receiverTypeBindings }]]) });
}

interface DurabilityProbe {
    syncfsCalls: string[][];
    /** Paths fsynced through a file handle, relative to the staging parent. */
    fsyncedPaths: string[];
}

/** Fakes the filesystem type and `sync -f` so the test never depends on the host disk. */
async function installDurabilityProbe(
    t: TestContext,
    root: string,
    fault: { filesystemType: number; syncfs: 'ok' | 'fail' | 'missing' },
): Promise<DurabilityProbe> {
    const probe: DurabilityProbe = { syncfsCalls: [], fsyncedPaths: [] };
    const realStatfs = fs.promises.statfs;
    t.mock.method(fs.promises, 'statfs', async (target: fs.PathLike) => {
        const stats = await realStatfs(target);
        return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { type: fault.filesystemType });
    });
    t.mock.method(childProcess, 'execFile', (command: string, args: string[], _options: unknown,
        callback: (error: childProcess.ExecFileException | null) => void) => {
        probe.syncfsCalls.push([command, ...args]);
        const error = fault.syncfs === 'ok' ? null
            : Object.assign(new Error(`injected ${fault.syncfs} syncfs`), { code: fault.syncfs === 'missing' ? 'ENOENT' : 1 });
        queueMicrotask(() => callback(error as childProcess.ExecFileException | null));
    });
    const realOpen = fs.promises.open;
    t.mock.method(fs.promises, 'open', async (target: fs.PathLike, ...rest: unknown[]) => {
        const handle = await (realOpen as (...args: unknown[]) => Promise<fs.promises.FileHandle>)(target, ...rest);
        const realSync = handle.sync.bind(handle);
        handle.sync = async () => {
            probe.fsyncedPaths.push(path.relative(root, String(target)));
            return realSync();
        };
        return handle;
    });
    return probe;
}

function tempRoot(t: TestContext): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-staging-durability-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

/** fsyncs below the staging build directory (the parent-directory fsync after publish is not part of the tree). */
function treeFsyncs(probe: DurabilityProbe): string[] {
    return probe.fsyncedPaths.filter((entry) => entry.startsWith(path.join('first', '.satori-')));
}

test('navigation staging makes the tree durable with one syncfs on a journaling filesystem', async (t) => {
    const root = tempRoot(t);
    const probe = await installDurabilityProbe(t, root, { filesystemType: EXT4, syncfs: 'ok' });
    const staged = await stage(root);

    assert.equal(probe.syncfsCalls.length, 1);
    assert.deepEqual(probe.syncfsCalls[0]?.slice(1, 2), ['-f']);
    assert.deepEqual(treeFsyncs(probe), [], 'no per-file fsync after a successful syncfs');
    assert.ok(staged.physical.writtenFiles > 0);
    assert.ok(fs.existsSync(staged.navigationRoot));
});

test('navigation staging fsyncs every written file and directory when syncfs fails', async (t) => {
    const root = tempRoot(t);
    const probe = await installDurabilityProbe(t, root, { filesystemType: EXT4, syncfs: 'fail' });
    const staged = await stage(root);

    assert.equal(probe.syncfsCalls.length, 1, 'a failed syncfs is not retried with another command');
    const fsynced = treeFsyncs(probe);
    const files = fs.readdirSync(staged.navigationRoot, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile());
    assert.equal(staged.physical.writtenFiles, files.length);
    // Every written file plus every directory of the build tree (root included).
    const directories = fs.readdirSync(staged.navigationRoot, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isDirectory()).length + 1;
    assert.equal(fsynced.length, files.length + directories);
});

test('navigation staging tries the next sync command only when one is missing', async (t) => {
    const root = tempRoot(t);
    const probe = await installDurabilityProbe(t, root, { filesystemType: EXT4, syncfs: 'missing' });
    const staged = await stage(root);

    assert.deepEqual(probe.syncfsCalls.map((call) => call[0]), ['/usr/bin/sync', '/bin/sync']);
    assert.equal(treeFsyncs(probe).length > staged.physical.writtenFiles, true);
});

test('navigation staging keeps per-file fsync on a filesystem without durable syncfs', async (t) => {
    const root = tempRoot(t);
    const probe = await installDurabilityProbe(t, root, { filesystemType: TMPFS, syncfs: 'ok' });
    const staged = await stage(root);

    assert.equal(probe.syncfsCalls.length, 0);
    assert.equal(treeFsyncs(probe).length > staged.physical.writtenFiles, true);
});
