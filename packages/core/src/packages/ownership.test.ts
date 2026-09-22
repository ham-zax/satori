import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildPublicationPackageOwnership,
    discoverPackageOwnership,
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
        assert.equal(owners.get('README.md'), null);
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

test('Satori pnpm workspace discovers core, mcp, and cli while repository-level files stay unowned', () => {
    const repositoryRoot = path.resolve(__dirname, '../../../..');
    const discovered = discoverPackageOwnership(repositoryRoot);

    assert.equal(discovered.workspace?.kind, 'pnpm');
    assert.equal(discovered.workspace?.root, '');
    assert.equal(discovered.workspace?.manifestPath, 'pnpm-workspace.yaml');

    const packageNamesByRoot = new Map(
        discovered.packages.map((entry) => [entry.root, entry.name]),
    );
    assert.equal(packageNamesByRoot.get('packages/core'), '@zokizuan/satori-core');
    assert.equal(packageNamesByRoot.get('packages/mcp'), '@zokizuan/satori-mcp');
    assert.equal(packageNamesByRoot.get('packages/cli'), '@zokizuan/satori-cli');
    assert.equal(packageNamesByRoot.has('satori-landing'), false);

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
    assert.equal(owners.get('README.md'), null);
});
