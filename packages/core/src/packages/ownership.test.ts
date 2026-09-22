import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildPublicationPackageOwnership,
    discoverPackageOwnership,
    parsePublicationPackageOwnership,
} from './ownership';

function createRepo(): { root: string; cleanup: () => void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-package-ownership-'));
    return {
        root,
        cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
}

function writeFile(root: string, relativePath: string, contents: string): void {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, contents);
}

function ownerByFile(
    files: readonly { path: string; packageRoot: string | null }[],
): Map<string, string | null> {
    return new Map(files.map((entry) => [entry.path, entry.packageRoot]));
}

test('pnpm workspace ownership uses manifest identity and the nearest nested package root', () => {
    const fixture = createRepo();
    try {
        writeFile(fixture.root, 'package.json', JSON.stringify({ name: 'workspace-root', private: true }));
        writeFile(fixture.root, 'pnpm-workspace.yaml', "packages:\n  - 'packages/**'\n");
        writeFile(fixture.root, 'packages/a/package.json', JSON.stringify({ name: '@fixture/a' }));
        writeFile(
            fixture.root,
            'packages/a/plugins/b/package.json',
            JSON.stringify({ name: '@fixture/b' }),
        );
        writeFile(fixture.root, 'packages/a/src/a.ts', 'export const a = 1;\n');
        writeFile(fixture.root, 'packages/a/plugins/b/src/b.ts', 'export const b = 1;\n');
        writeFile(fixture.root, 'README.md', '# fixture\n');

        const discovered = discoverPackageOwnership(fixture.root);
        assert.deepEqual(discovered.workspace, {
            kind: 'pnpm',
            root: '',
            manifestPath: 'pnpm-workspace.yaml',
            patterns: ['packages/**'],
        });
        assert.deepEqual(
            discovered.packages.map(({ root, name, workspaceMember }) => ({
                root,
                name,
                workspaceMember,
            })),
            [
                { root: '', name: 'workspace-root', workspaceMember: false },
                { root: 'packages/a', name: '@fixture/a', workspaceMember: true },
                { root: 'packages/a/plugins/b', name: '@fixture/b', workspaceMember: true },
            ],
        );

        const ownership = buildPublicationPackageOwnership(
            fixture.root,
            [
                'packages/a/src/a.ts',
                'packages/a/plugins/b/src/b.ts',
                'README.md',
            ],
            new Map(discovered.controlFiles),
        );
        const owners = ownerByFile(ownership.files);
        assert.equal(owners.get('packages/a/src/a.ts'), 'packages/a');
        assert.equal(owners.get('packages/a/plugins/b/src/b.ts'), 'packages/a/plugins/b');
        assert.equal(owners.get('README.md'), '');
    } finally {
        fixture.cleanup();
    }
});

test('manifest-free repositories keep explicit no-owner file semantics', () => {
    const fixture = createRepo();
    try {
        writeFile(fixture.root, 'src/index.ts', 'export const value = 1;\n');

        const discovered = discoverPackageOwnership(fixture.root);
        assert.equal(discovered.workspace, null);
        assert.deepEqual(discovered.packages, []);
        assert.deepEqual(discovered.controlFiles, []);

        const ownership = buildPublicationPackageOwnership(
            fixture.root,
            ['src/index.ts'],
            new Map(),
        );
        assert.deepEqual(ownership.files, [
            { path: 'src/index.ts', packageRoot: null },
        ]);
    } finally {
        fixture.cleanup();
    }
});

test('a root package.json defines a single factual root package without folder-name inference', () => {
    const fixture = createRepo();
    try {
        writeFile(fixture.root, 'package.json', JSON.stringify({ name: '@fixture/root-package' }));
        writeFile(fixture.root, 'src/index.ts', 'export const value = 1;\n');

        const discovered = discoverPackageOwnership(fixture.root);
        assert.equal(discovered.workspace, null);
        assert.deepEqual(discovered.packages, [{
            ecosystem: 'node',
            root: '',
            manifestPath: 'package.json',
            name: '@fixture/root-package',
            workspaceMember: false,
        }]);

        const ownership = buildPublicationPackageOwnership(
            fixture.root,
            ['src/index.ts'],
            new Map(discovered.controlFiles),
        );
        assert.deepEqual(ownership.files, [
            { path: 'src/index.ts', packageRoot: '' },
        ]);
    } finally {
        fixture.cleanup();
    }
});

test('Satori pnpm workspace discovers the root, core, mcp, and cli packages', () => {
    const repositoryRoot = path.resolve(__dirname, '../../../..');
    const discovered = discoverPackageOwnership(repositoryRoot);

    assert.equal(discovered.workspace?.kind, 'pnpm');
    assert.equal(discovered.workspace?.root, '');
    assert.equal(discovered.workspace?.manifestPath, 'pnpm-workspace.yaml');

    const packageNamesByRoot = new Map(
        discovered.packages.map((entry) => [entry.root, entry.name]),
    );
    assert.equal(packageNamesByRoot.get(''), 'satori');
    assert.equal(packageNamesByRoot.get('packages/core'), '@zokizuan/satori-core');
    assert.equal(packageNamesByRoot.get('packages/mcp'), '@zokizuan/satori-mcp');
    assert.equal(packageNamesByRoot.get('packages/cli'), '@zokizuan/satori-cli');
    assert.equal(packageNamesByRoot.has('satori-landing'), false);
    assert.equal(discovered.controlFiles.some(([filePath]) => filePath === 'package.json'), true);

    const ownership = buildPublicationPackageOwnership(
        repositoryRoot,
        [
            'packages/core/src/core/context.ts',
            'packages/mcp/src/index.ts',
            'packages/cli/src/index.ts',
            'README.md',
        ],
        new Map(discovered.controlFiles),
    );
    const owners = ownerByFile(ownership.files);
    assert.equal(owners.get('packages/core/src/core/context.ts'), 'packages/core');
    assert.equal(owners.get('packages/mcp/src/index.ts'), 'packages/mcp');
    assert.equal(owners.get('packages/cli/src/index.ts'), 'packages/cli');
    assert.equal(owners.get('README.md'), '');
});

test('package.json workspaces persist both the root package and child packages', () => {
    const fixture = createRepo();
    try {
        writeFile(fixture.root, 'package.json', JSON.stringify({
            name: 'root-pkg',
            workspaces: ['packages/*'],
        }));
        writeFile(fixture.root, 'packages/a/package.json', JSON.stringify({ name: 'a' }));
        writeFile(fixture.root, 'root.ts', 'export const root = 1;\n');
        writeFile(fixture.root, 'packages/a/a.ts', 'export const a = 1;\n');

        const discovered = discoverPackageOwnership(fixture.root);
        assert.deepEqual(discovered.workspace, {
            kind: 'package_json',
            root: '',
            manifestPath: 'package.json',
            patterns: ['packages/*'],
        });
        assert.deepEqual(
            discovered.packages.map(({ root, name, workspaceMember }) => ({
                root,
                name,
                workspaceMember,
            })),
            [
                { root: '', name: 'root-pkg', workspaceMember: false },
                { root: 'packages/a', name: 'a', workspaceMember: true },
            ],
        );

        const ownership = buildPublicationPackageOwnership(
            fixture.root,
            ['root.ts', 'packages/a/a.ts'],
            new Map(discovered.controlFiles),
        );
        const owners = ownerByFile(ownership.files);
        assert.equal(owners.get('root.ts'), '');
        assert.equal(owners.get('packages/a/a.ts'), 'packages/a');
    } finally {
        fixture.cleanup();
    }
});

test('ownership parser rejects incoherent workspace/package semantics', () => {
    const hash = 'a'.repeat(64);
    const base = {
        schemaVersion: 'package_ownership_v1',
        canonicalRoot: '/repo',
        workspace: {
            kind: 'pnpm',
            root: '',
            manifestPath: 'pnpm-workspace.yaml',
            patterns: ['packages/*'],
        },
        packages: [
            {
                ecosystem: 'node',
                root: '',
                manifestPath: 'package.json',
                name: 'root',
                workspaceMember: false,
            },
            {
                ecosystem: 'node',
                root: 'packages/a',
                manifestPath: 'packages/a/package.json',
                name: 'a',
                workspaceMember: true,
            },
        ],
        files: [
            { path: 'packages/a/src/a.ts', packageRoot: 'packages/a' },
        ],
        controlFiles: [
            ['package.json', hash],
            ['packages/a/package.json', hash],
            ['pnpm-workspace.yaml', hash],
        ],
    };

    assert.doesNotThrow(() => parsePublicationPackageOwnership(JSON.stringify(base), '/repo'));

    const wrongWorkspaceManifest = structuredClone(base);
    wrongWorkspaceManifest.workspace.manifestPath = 'package.json';
    assert.throws(
        () => parsePublicationPackageOwnership(JSON.stringify(wrongWorkspaceManifest), '/repo'),
        /workspace manifest path/,
    );

    const wrongMembership = structuredClone(base);
    wrongMembership.packages[1].workspaceMember = false;
    assert.throws(
        () => parsePublicationPackageOwnership(JSON.stringify(wrongMembership), '/repo'),
        /workspace member/,
    );

    const wrongManifest = structuredClone(base);
    wrongManifest.packages[1].manifestPath = 'packages/other/package.json';
    assert.throws(
        () => parsePublicationPackageOwnership(JSON.stringify(wrongManifest), '/repo'),
        /manifest path/,
    );
});

test('unsafe workspace glob expansion is rejected before filesystem globbing', () => {
    const fixture = createRepo();
    const mutableFs = require('node:fs') as {
        globSync?: (
            pattern: string,
            options: { cwd: string; withFileTypes?: false },
        ) => string[];
    };
    const originalGlobSync = mutableFs.globSync;
    assert.ok(originalGlobSync);
    let globCalls = 0;
    mutableFs.globSync = (pattern, options) => {
        globCalls += 1;
        return originalGlobSync(pattern, options);
    };

    try {
        for (const pattern of [
            '../outside/*',
            '{../outside,packages/*}',
            '@(../outside|packages/*)',
            '[.][.]/outside',
            'packages/**/../outside',
            '/outside/*',
            'C:/outside/*',
        ]) {
            writeFile(
                fixture.root,
                'pnpm-workspace.yaml',
                `packages:\n  - '${pattern}'\n`,
            );
            assert.throws(
                () => discoverPackageOwnership(fixture.root),
                /Invalid workspace package pattern/,
            );
            assert.equal(globCalls, 0);
        }
    } finally {
        mutableFs.globSync = originalGlobSync;
        fixture.cleanup();
    }
});
