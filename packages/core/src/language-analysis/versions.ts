export const LANGUAGE_PARSER_VERSION = [
    'oxc-0.139.0',
    'web-tree-sitter-0.26.10',
    'vscode-grammars-0.3.1',
    'scala-0.24.0-sha256-b7ec2bb29c19827abcefd18ed5cb5a43596009f96a5d53c5b9d1f9676d7521c3',
].join('+');
export const SYMBOL_EXTRACTOR_VERSION = `language-analysis-v2+${LANGUAGE_PARSER_VERSION}`;
export const RELATIONSHIP_BUILDER_VERSION = 'relationship-v2+normalized-language-analysis';
