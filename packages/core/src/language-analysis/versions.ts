import { CBM_LANGUAGE_MAP_COMMIT } from '../languages/cbm-language-map';
import { cbmExtendedPackIdentity } from './cbm-extractor-host';

export const LANGUAGE_PARSER_VERSION = [
    'oxc-0.139.0',
    'web-tree-sitter-0.26.10',
    'vscode-grammars-0.3.1',
    'scala-0.24.0-sha256-b7ec2bb29c19827abcefd18ed5cb5a43596009f96a5d53c5b9d1f9676d7521c3',
    // The extractor manifest pins its modules to the same CBM commit as the language map.
    `cbm-extractor-${CBM_LANGUAGE_MAP_COMMIT.slice(0, 12)}-emscripten-3.1.64`,
    cbmExtendedPackIdentity(),
].join('+');
export const SYMBOL_EXTRACTOR_VERSION = `language-analysis-v17+${LANGUAGE_PARSER_VERSION}`;
export const RELATIONSHIP_BUILDER_VERSION = 'relationship-v19+cbm-multilang-v1+python-cross-module-constructors+python-native-resolution-v2+scala-syntactic-calls-v1+js-this-member-calls-v1+typescript-compiler-resolution-v8+relationship-evidence-v1+provider-coverage-v1+resource-budgets-v1';
