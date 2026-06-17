import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    getLanguageCapabilityDeclaration,
    getLanguageCapabilityDeclarations,
    getLanguageCapabilityTierCounts,
} from './capabilities';
import type {
    CapabilityStatus,
    LanguageCapabilityDeclaration,
    PublicLanguageClaim,
} from './types';

const GRANDFATHERED_FULL_NAVIGATION_LANGUAGES = new Set([
    'javascript',
    'python',
    'typescript',
]);

function assertUnique(values: readonly string[], label: string): void {
    const seen = new Map<string, number>();
    for (const value of values) {
        seen.set(value, (seen.get(value) || 0) + 1);
    }
    const duplicates = [...seen.entries()]
        .filter(([, count]) => count > 1)
        .map(([value]) => value);
    assert.deepEqual(duplicates, [], label);
}

function enabled(status: CapabilityStatus): boolean {
    return status !== 'none';
}

function productionReady(status: CapabilityStatus): boolean {
    return status === 'production_ready';
}

function resolveRepoPath(relativePath: string): string {
    const candidates = [
        path.resolve(process.cwd(), relativePath),
        path.resolve(process.cwd(), '../..', relativePath),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return candidates[0];
}

function assertPublicClaimConsistent(declaration: LanguageCapabilityDeclaration): void {
    const checks: Record<PublicLanguageClaim, () => void> = {
        search_only: () => {
            assert.equal(productionReady(declaration.searchEligibility), true, declaration.languageId);
            assert.equal(enabled(declaration.symbolExtractionCapability), false, declaration.languageId);
            assert.equal(enabled(declaration.ownerExtractionCapability), false, declaration.languageId);
            assert.equal(enabled(declaration.importExportCapability), false, declaration.languageId);
            assert.equal(enabled(declaration.callsCapability), false, declaration.languageId);
            assert.equal(enabled(declaration.typeReceiverAwareCapability), false, declaration.languageId);
        },
        symbol_only: () => {
            assert.equal(productionReady(declaration.symbolExtractionCapability), true, declaration.languageId);
            assert.equal(productionReady(declaration.ownerExtractionCapability), true, declaration.languageId);
            assert.equal(enabled(declaration.importExportCapability), false, declaration.languageId);
            assert.equal(enabled(declaration.callsCapability), false, declaration.languageId);
            assert.equal(enabled(declaration.typeReceiverAwareCapability), false, declaration.languageId);
        },
        imports_exports: () => {
            assert.equal(productionReady(declaration.symbolExtractionCapability), true, declaration.languageId);
            assert.equal(productionReady(declaration.ownerExtractionCapability), true, declaration.languageId);
            assert.equal(productionReady(declaration.importExportCapability), true, declaration.languageId);
            assert.equal(enabled(declaration.callsCapability), false, declaration.languageId);
            assert.equal(enabled(declaration.typeReceiverAwareCapability), false, declaration.languageId);
        },
        calls_v0: () => {
            assert.equal(productionReady(declaration.symbolExtractionCapability), true, declaration.languageId);
            assert.equal(productionReady(declaration.ownerExtractionCapability), true, declaration.languageId);
            assert.equal(productionReady(declaration.callsCapability), true, declaration.languageId);
            assert.equal(enabled(declaration.typeReceiverAwareCapability), false, declaration.languageId);
        },
        type_receiver_aware: () => {
            assert.equal(productionReady(declaration.symbolExtractionCapability), true, declaration.languageId);
            assert.equal(productionReady(declaration.ownerExtractionCapability), true, declaration.languageId);
            assert.equal(productionReady(declaration.callsCapability), true, declaration.languageId);
            assert.equal(productionReady(declaration.typeReceiverAwareCapability), true, declaration.languageId);
        },
    };

    checks[declaration.publicClaim]();
}

test('language capability declarations have unique routing keys', () => {
    const declarations = getLanguageCapabilityDeclarations();
    const languageIds = declarations.map((declaration) => declaration.languageId);
    const extensions = declarations.flatMap((declaration) => declaration.extensions.map((extension) => extension.toLowerCase()));

    assertUnique(languageIds, 'language ids must be unique');
    assertUnique(extensions, 'extensions must not be claimed by multiple languages');

    const filenamesByOwner = new Map<string, Set<string>>();
    for (const declaration of declarations) {
        for (const filename of declaration.filenames || []) {
            const key = filename.toLowerCase();
            const owners = filenamesByOwner.get(key) || new Set<string>();
            owners.add(declaration.languageId);
            filenamesByOwner.set(key, owners);
        }
    }
    const duplicateFilenameOwners = [...filenamesByOwner.entries()]
        .filter(([, owners]) => owners.size > 1)
        .map(([filename]) => filename);
    assert.deepEqual(duplicateFilenameOwners, [], 'special filenames must not be claimed by multiple languages');
});

test('language aliases do not collide with canonical ids from other declarations', () => {
    const declarations = getLanguageCapabilityDeclarations();
    const languageIds = new Set(declarations.map((declaration) => declaration.languageId));
    const aliases = declarations.flatMap((declaration) =>
        declaration.aliases.map((alias) => ({
            owner: declaration.languageId,
            alias: alias.toLowerCase(),
        }))
    );

    assertUnique(aliases.map((entry) => entry.alias), 'aliases must be unique');
    for (const entry of aliases) {
        assert.equal(
            languageIds.has(entry.alias) && entry.alias !== entry.owner,
            false,
            `${entry.owner} alias '${entry.alias}' collides with another canonical language id`
        );
    }
});

test('public language claims are consistent with capability statuses', () => {
    for (const declaration of getLanguageCapabilityDeclarations()) {
        assertPublicClaimConsistent(declaration);
    }
});

test('production_ready symbol extraction requires fixture metadata unless explicitly grandfathered', () => {
    for (const declaration of getLanguageCapabilityDeclarations()) {
        if (declaration.symbolExtractionCapability !== 'production_ready') {
            continue;
        }
        if (GRANDFATHERED_FULL_NAVIGATION_LANGUAGES.has(declaration.languageId)) {
            // TS/JS/Python predate the L1 matrix and still use the existing splitter/chunk-symbol path.
            continue;
        }

        assert.ok(declaration.fixtures.navigation?.length, `${declaration.languageId} must list golden navigation fixtures`);
        assert.ok(declaration.fixtures.symbols?.length, `${declaration.languageId} must list extractor fixtures`);
        assert.ok(declaration.fixtures.ownerMetadata?.length, `${declaration.languageId} must list owner metadata tests`);
        assert.ok(declaration.fixtures.fileOutline?.length, `${declaration.languageId} must list file_outline tests`);
        assert.ok(declaration.fixtures.readFileOpenSymbol?.length, `${declaration.languageId} must list read_file(open_symbol) tests`);
    }
});

test('capability fixture evidence paths exist', () => {
    for (const declaration of getLanguageCapabilityDeclarations()) {
        for (const [category, evidencePaths] of Object.entries(declaration.fixtures)) {
            for (const evidencePath of evidencePaths || []) {
                assert.equal(
                    fs.existsSync(resolveRepoPath(evidencePath)),
                    true,
                    `${declaration.languageId} fixture ${category} path does not exist: ${evidencePath}`
                );
            }
        }
    }
});

test('production_ready parser capability requires parser fixtures or symbol-production proof', () => {
    for (const declaration of getLanguageCapabilityDeclarations()) {
        if (declaration.parserCapability !== 'production_ready') {
            continue;
        }
        if (GRANDFATHERED_FULL_NAVIGATION_LANGUAGES.has(declaration.languageId)) {
            // TS/JS/Python predate the L1 fixture metadata split.
            continue;
        }
        if (declaration.symbolExtractionCapability === 'production_ready') {
            // Symbol-production languages already require extractor, owner, file_outline, and read_file proof.
            continue;
        }

        assert.ok(declaration.fixtures.parser?.length, `${declaration.languageId} must list parser no-crash fixtures`);
    }
});

test('production_ready calls require relationship fixtures unless explicitly grandfathered', () => {
    for (const declaration of getLanguageCapabilityDeclarations()) {
        if (declaration.callsCapability !== 'production_ready') {
            continue;
        }
        if (GRANDFATHERED_FULL_NAVIGATION_LANGUAGES.has(declaration.languageId)) {
            // TS/JS/Python are existing full-navigation languages; L1 does not retrofit fixture metadata.
            continue;
        }

        assert.ok(declaration.fixtures.calls?.length, `${declaration.languageId} must list call_graph relationship tests`);
    }
});

test('CMM-derived broad catalog stays tiered instead of becoming symbol or graph support', () => {
    const declarations = getLanguageCapabilityDeclarations();
    const routedLanguages = declarations.filter((declaration) =>
        declaration.extensions.length > 0 || (declaration.filenames?.length || 0) > 0
    );
    const parserCoveredLanguages = declarations.filter((declaration) => declaration.parserCapability !== 'none');
    const symbolOnlyLanguages = declarations
        .filter((declaration) => declaration.publicClaim === 'symbol_only')
        .map((declaration) => declaration.languageId);
    const callGraphLanguages = declarations
        .filter((declaration) => declaration.callsCapability === 'production_ready')
        .map((declaration) => declaration.languageId);

    assert.ok(routedLanguages.length > 140, 'broad catalog should expose recognized/routed languages');
    assert.ok(parserCoveredLanguages.length > 140, 'broad catalog should expose parser-declared languages');
    assert.deepEqual(symbolOnlyLanguages, ['go', 'rust']);
    assert.deepEqual(callGraphLanguages, ['javascript', 'python', 'typescript']);

    for (const language of ['zig', 'solidity', 'gleam', 'kotlin', 'ruby', 'swift']) {
        const declaration = getLanguageCapabilityDeclaration(language);
        assert.equal(declaration?.searchEligibility, 'production_ready', language);
        assert.equal(declaration?.parserCapability, 'declared', language);
        assert.equal(declaration?.symbolExtractionCapability, 'none', language);
        assert.equal(declaration?.ownerExtractionCapability, 'none', language);
        assert.equal(declaration?.callsCapability, 'none', language);
        assert.equal(declaration?.publicClaim, 'search_only', language);
    }
});

test('tiered catalog counts are computed from the Satori matrix', () => {
    const declarations = getLanguageCapabilityDeclarations();
    const counts = getLanguageCapabilityTierCounts();

    assert.equal(counts.totalDeclarations, declarations.length);
    assert.equal(
        counts.recognizedRoutedLanguages,
        declarations.filter((declaration) =>
            declaration.extensions.length > 0 || (declaration.filenames?.length || 0) > 0
        ).length
    );
    assert.equal(
        counts.parserCoveredLanguages,
        declarations.filter((declaration) => declaration.parserCapability !== 'none').length
    );
    assert.equal(
        counts.symbolOnlyLanguages,
        declarations.filter((declaration) => declaration.publicClaim === 'symbol_only').length
    );
    assert.equal(
        counts.callGraphLanguages,
        declarations.filter((declaration) => declaration.callsCapability === 'production_ready').length
    );
    assert.ok(counts.recognizedRoutedLanguages > counts.symbolOnlyLanguages);
    assert.ok(counts.symbolOnlyLanguages > 0);
    assert.ok(counts.callGraphLanguages > 0);
});

test('legacy imports facade remains separate from relationship-sidecar TS/JS import/export extraction', () => {
    const typescript = getLanguageCapabilityDeclaration('typescript');
    const javascript = getLanguageCapabilityDeclaration('javascript');

    assert.equal(typescript?.importExportCapability, 'none');
    assert.equal(javascript?.importExportCapability, 'none');
});
