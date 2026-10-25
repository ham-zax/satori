import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CBM_LANGUAGE_MAP_COMMIT } from '../languages/cbm-language-map';

import {
    installedPackageRootVersion,
    installedPackageVersion,
    type PackageManifestResolver,
} from './installed-package-version';
import {
    composeLanguageParserVersion,
    composeRelationshipBuilderVersion,
    LANGUAGE_PARSER_VERSION,
    RELATIONSHIP_BUILDER_VERSION,
    SYMBOL_EXTRACTOR_VERSION,
} from './versions';
import {
    NATIVE_PYTHON_PROVIDER_ID,
    NATIVE_PYTHON_PROVIDER_VERSION,
    PYTHON_NATIVE_ENVIRONMENT_CONFIG_ID,
} from '../relationships/python-provider-identity';
import {
    NATIVE_PYTHON_PROVIDER_ID as RESOLUTION_PYTHON_PROVIDER_ID,
    NATIVE_PYTHON_PROVIDER_VERSION as RESOLUTION_PYTHON_PROVIDER_VERSION,
    PYTHON_NATIVE_ENVIRONMENT_CONFIG_ID as RESOLUTION_PYTHON_ENVIRONMENT_CONFIG_ID,
} from '../relationships/resolution';
import {
    TYPESCRIPT_COMPILER_PROVIDER_VERSION,
} from '../semantic/typescript-provider-identity';
import {
    TYPESCRIPT_COMPILER_PROVIDER_ID as COMPILER_PROVIDER_ID,
    TYPESCRIPT_COMPILER_PROVIDER_VERSION as COMPILER_PROVIDER_VERSION,
} from '../semantic/typescript-compiler-provider';

function installedParserVersions() {
    return {
        oxc: installedPackageVersion('oxc-parser'),
        webTreeSitter: installedPackageRootVersion('web-tree-sitter'),
        vscodeGrammars: installedPackageVersion('@vscode/tree-sitter-wasm'),
        typescript: installedPackageVersion('typescript'),
    };
}

function fixtureResolver(entries: Record<string, string | Error>): PackageManifestResolver {
    return {
        resolve(request: string): string {
            const value = entries[request];
            if (typeof value === 'string') return value;
            if (value instanceof Error) throw value;
            throw Object.assign(new Error(`Cannot find module '${request}'`), { code: 'MODULE_NOT_FOUND' });
        },
    };
}

test('provider identity leaves own the revisions and resolution layers re-export them', () => {
    assert.equal(PYTHON_NATIVE_ENVIRONMENT_CONFIG_ID, 'python-native-resolution-v2');
    assert.equal(RESOLUTION_PYTHON_ENVIRONMENT_CONFIG_ID, PYTHON_NATIVE_ENVIRONMENT_CONFIG_ID);
    assert.equal(RESOLUTION_PYTHON_PROVIDER_ID, NATIVE_PYTHON_PROVIDER_ID);
    assert.equal(RESOLUTION_PYTHON_PROVIDER_VERSION, NATIVE_PYTHON_PROVIDER_VERSION);

    assert.equal(COMPILER_PROVIDER_VERSION, TYPESCRIPT_COMPILER_PROVIDER_VERSION);
    assert.ok(COMPILER_PROVIDER_ID.length > 0);
});

test('relationship identity composes the provider-owned revisions', () => {
    assert.equal(
        RELATIONSHIP_BUILDER_VERSION,
        composeRelationshipBuilderVersion({
            pythonProviderVersion: NATIVE_PYTHON_PROVIDER_VERSION,
            typescriptProviderVersion: TYPESCRIPT_COMPILER_PROVIDER_VERSION,
        }),
    );

    const components = RELATIONSHIP_BUILDER_VERSION.split('+');
    assert.deepEqual(components, [
        'relationship-v20',
        'cbm-multilang-v1',
        'python-cross-module-constructors',
        NATIVE_PYTHON_PROVIDER_VERSION,
        'scala-syntactic-calls-v1',
        'js-this-member-calls-v1',
        TYPESCRIPT_COMPILER_PROVIDER_VERSION,
        'relationship-evidence-v1',
        'provider-coverage-v1',
        'resource-budgets-v1',
        'cbm-gated-unresolved-claims-v1',
        'python-reexports-exact-mro-v1',
    ]);
    // Stale copied revision tags must not survive an owner revision bump.
    assert.ok(!components.includes('python-native-resolution-v3'));
    assert.ok(!components.includes('typescript-compiler-resolution-v8'));
});

test('provider revision changes alter only relationship identity', () => {
    const actualComponents = RELATIONSHIP_BUILDER_VERSION.split('+');
    const changedComponents = composeRelationshipBuilderVersion({
        pythonProviderVersion: 'probe-python-provider',
        typescriptProviderVersion: 'probe-typescript-provider',
    }).split('+');

    assert.equal(changedComponents.length, actualComponents.length);
    const changedIndices = actualComponents.flatMap((component, index) => (
        component === changedComponents[index] ? [] : [index]
    ));
    assert.deepEqual(changedIndices, [3, 6]);
    assert.equal(actualComponents[3], NATIVE_PYTHON_PROVIDER_VERSION);
    assert.equal(actualComponents[6], TYPESCRIPT_COMPILER_PROVIDER_VERSION);
});

test('installed parser versions drive parser and extractor identity', () => {
    const installed = installedParserVersions();
    const composedParser = composeLanguageParserVersion(installed);

    assert.ok(LANGUAGE_PARSER_VERSION.startsWith(`${composedParser}+`));
    assert.match(LANGUAGE_PARSER_VERSION, /\+cbm-extended-(present|absent)$/);
    assert.equal(SYMBOL_EXTRACTOR_VERSION, `language-analysis-v23+${LANGUAGE_PARSER_VERSION}`);

    const components = LANGUAGE_PARSER_VERSION.split('+');
    assert.deepEqual(components.slice(0, -1), [
        `oxc-${installed.oxc}`,
        `web-tree-sitter-${installed.webTreeSitter}`,
        `vscode-grammars-${installed.vscodeGrammars}`,
        `typescript-${installed.typescript}`,
        'scala-0.24.0-sha256-b7ec2bb29c19827abcefd18ed5cb5a43596009f96a5d53c5b9d1f9676d7521c3',
        `cbm-extractor-${CBM_LANGUAGE_MAP_COMMIT.slice(0, 12)}-emscripten-3.1.64`,
    ]);
});

test('parser version changes drive parser and extractor identity without touching relationships', () => {
    const installed = installedParserVersions();
    const baselineParser = composeLanguageParserVersion(installed);
    const changedParser = composeLanguageParserVersion({
        oxc: `${installed.oxc}-probe`,
        webTreeSitter: `${installed.webTreeSitter}-probe`,
        vscodeGrammars: `${installed.vscodeGrammars}-probe`,
        typescript: `${installed.typescript}-probe`,
    });

    assert.notEqual(changedParser, baselineParser);
    assert.notEqual(`language-analysis-v23+${changedParser}`, SYMBOL_EXTRACTOR_VERSION);
    assert.equal(
        RELATIONSHIP_BUILDER_VERSION,
        composeRelationshipBuilderVersion({
            pythonProviderVersion: NATIVE_PYTHON_PROVIDER_VERSION,
            typescriptProviderVersion: TYPESCRIPT_COMPILER_PROVIDER_VERSION,
        }),
    );
});

test('provider identity leaves stay free of imports and side effects', () => {
    const leaves = [
        path.resolve(__dirname, '../relationships/python-provider-identity.ts'),
        path.resolve(__dirname, '../semantic/typescript-provider-identity.ts'),
    ];
    for (const leaf of leaves) {
        const source = fs.readFileSync(leaf, 'utf8');
        assert.doesNotMatch(source, /^\s*(import|export\s+\*?\s*from)\b/m);
        assert.doesNotMatch(source, /\brequire\(/);
    }
});

test('installed version lookup rejects missing and malformed manifests', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-installed-version-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const write = (relativePath: string, content: string): string => {
        const fullPath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
        return fullPath;
    };

    const good = write('good/package.json', JSON.stringify({ name: 'fixture-good', version: '1.2.3' }));
    assert.equal(
        installedPackageVersion('fixture-good', fixtureResolver({ 'fixture-good/package.json': good })),
        '1.2.3',
    );

    const wrongName = write('wrong-name/package.json', JSON.stringify({ name: 'other', version: '1.2.3' }));
    assert.throws(
        () => installedPackageVersion('fixture-wrong', fixtureResolver({ 'fixture-wrong/package.json': wrongName })),
        /expected 'fixture-wrong'/,
    );

    const noVersion = write('no-version/package.json', JSON.stringify({ name: 'fixture-no-version' }));
    assert.throws(
        () => installedPackageVersion('fixture-no-version', fixtureResolver({ 'fixture-no-version/package.json': noVersion })),
        /no valid version/,
    );

    const malformed = write('malformed/package.json', '{');
    assert.throws(
        () => installedPackageVersion('fixture-malformed', fixtureResolver({ 'fixture-malformed/package.json': malformed })),
        /not valid JSON/,
    );

    const notObject = write('array/package.json', '[]');
    assert.throws(
        () => installedPackageVersion('fixture-array', fixtureResolver({ 'fixture-array/package.json': notObject })),
        /not a JSON object/,
    );

    assert.throws(
        () => installedPackageVersion('fixture-missing', fixtureResolver({})),
        /Cannot find module/,
    );

    const missingManifest = path.join(root, 'missing/package.json');
    assert.throws(
        () => installedPackageVersion(
            'fixture-missing-file',
            fixtureResolver({ 'fixture-missing-file/package.json': missingManifest }),
        ),
        /Cannot read installed package manifest/,
    );

    write('entry/package.json', JSON.stringify({ name: 'fixture-entry', version: '4.5.6' }));
    write('entry/index.js', 'module.exports = {};');
    assert.equal(
        installedPackageRootVersion(
            'fixture-entry',
            fixtureResolver({ 'fixture-entry': path.join(root, 'entry/index.js') }),
        ),
        '4.5.6',
    );

    write('entry-wrong/package.json', JSON.stringify({ name: 'other', version: '4.5.6' }));
    assert.throws(
        () => installedPackageRootVersion(
            'fixture-entry-wrong',
            fixtureResolver({ 'fixture-entry-wrong': path.join(root, 'entry-wrong/index.js') }),
        ),
        /expected 'fixture-entry-wrong'/,
    );
});
