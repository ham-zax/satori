import { CBM_LANGUAGE_MAP_COMMIT } from '../languages/cbm-language-map';
import { NATIVE_PYTHON_PROVIDER_VERSION } from '../relationships/python-provider-identity';
import { TYPESCRIPT_COMPILER_PROVIDER_VERSION } from '../semantic/typescript-provider-identity';
import { cbmExtendedPackIdentity } from './cbm-extractor-host';
import { installedPackageRootVersion, installedPackageVersion } from './installed-package-version';

const SCALA_PARSER_IDENTITY = 'scala-0.24.0-sha256-b7ec2bb29c19827abcefd18ed5cb5a43596009f96a5d53c5b9d1f9676d7521c3';
// The extractor manifest pins its modules to the same CBM commit as the language map.
const CBM_EXTRACTOR_IDENTITY = `cbm-extractor-${CBM_LANGUAGE_MAP_COMMIT.slice(0, 12)}-emscripten-3.1.64`;

export interface LanguageParserVersions {
    readonly oxc: string;
    readonly webTreeSitter: string;
    readonly vscodeGrammars: string;
    readonly typescript: string;
}

export interface RelationshipProviderVersions {
    readonly pythonProviderVersion: string;
    readonly typescriptProviderVersion: string;
}

/**
 * Installed parser versions are identity, so they are read from the packages
 * that provide the parsers. Do not copy version literals here: an upgrade must
 * change parser and extractor identity without a matching source edit.
 */
function readInstalledParserVersions(): LanguageParserVersions {
    return {
        oxc: installedPackageVersion('oxc-parser'),
        webTreeSitter: installedPackageRootVersion('web-tree-sitter'),
        vscodeGrammars: installedPackageVersion('@vscode/tree-sitter-wasm'),
        typescript: installedPackageVersion('typescript'),
    };
}

export function composeLanguageParserVersion(versions: LanguageParserVersions): string {
    return [
        `oxc-${versions.oxc}`,
        `web-tree-sitter-${versions.webTreeSitter}`,
        `vscode-grammars-${versions.vscodeGrammars}`,
        `typescript-${versions.typescript}`,
        SCALA_PARSER_IDENTITY,
        CBM_EXTRACTOR_IDENTITY,
    ].join('+');
}

// Read once during module initialization so every request observes one identity.
export const LANGUAGE_PARSER_VERSION = `${composeLanguageParserVersion(readInstalledParserVersions())}+${cbmExtendedPackIdentity()}`;
// Flow recovery, JSX/assigned-function/callback extraction, Python module and class lambda bindings,
// Module-level bound object caller extraction, Python TYPE_CHECKING import flags, C/C++ macro-wrapped definition names,
// recovered C++ namespace children, and definitionStatus change persisted symbols.
export const SYMBOL_EXTRACTOR_VERSION = `language-analysis-v23+${LANGUAGE_PARSER_VERSION}`;

/**
 * Provider revisions are owned by the providers. The aggregate references
 * those identities instead of copying their text, so a provider revision
 * cannot silently leave stale relationship identity behind.
 */
export function composeRelationshipBuilderVersion(
    providers: RelationshipProviderVersions,
): string {
    return [
        'relationship-v20',
        'cbm-multilang-v1',
        'python-cross-module-constructors',
        providers.pythonProviderVersion,
        'scala-syntactic-calls-v1',
        'js-this-member-calls-v1',
        providers.typescriptProviderVersion,
        'relationship-evidence-v1',
        'provider-coverage-v1',
        'resource-budgets-v1',
        'cbm-gated-unresolved-claims-v1',
        'python-reexports-exact-mro-v1',
    ].join('+');
}

export const RELATIONSHIP_BUILDER_VERSION = composeRelationshipBuilderVersion({
    pythonProviderVersion: NATIVE_PYTHON_PROVIDER_VERSION,
    typescriptProviderVersion: TYPESCRIPT_COMPILER_PROVIDER_VERSION,
});
