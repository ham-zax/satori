import { getLanguageCapabilityDeclarations } from '../languages/capabilities';

export type IndexProfile = 'default' | 'minimal' | 'all-text';

export const INDEX_PROFILES: readonly IndexProfile[] = ['default', 'minimal', 'all-text'] as const;
export const ALL_TEXT_INDEX_MARKER = '<all-text>';

export const SOURCE_SUPPORTED_EXTENSIONS = [
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.cpp', '.c', '.h', '.hpp',
    '.cs', '.go', '.rs', '.php', '.rb', '.swift', '.kt', '.scala', '.m', '.mm',
] as const;

export const DOC_SUPPORTED_EXTENSIONS = [
    '.md', '.markdown', '.mdx', '.rst', '.txt', '.adoc', '.ipynb',
] as const;

export const CONFIG_SUPPORTED_EXTENSIONS = [
    '.toml', '.yaml', '.yml', '.json', '.jsonc', '.ini', '.cfg', '.conf', '.properties', '.xml',
] as const;

export const SCRIPT_SUPPORTED_EXTENSIONS = [
    '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
] as const;

export const INFRA_QUERY_SUPPORTED_EXTENSIONS = [
    '.sql', '.graphql', '.gql', '.tf', '.tfvars',
] as const;

// Recognized by the language registry but not indexed by default: bulk data,
// transient patches, graphics, translation catalogs, and secret-bearing env
// files add noise (or risk) to semantic search. The `all-text` profile still
// admits the non-secret ones; env files also stay in DEFAULT_IGNORE_PATTERNS.
const NOT_DEFAULT_INDEXED_EXTENSIONS: ReadonlySet<string> = new Set([
    '.csv', '.diff', '.patch', '.svg', '.po', '.pot', '.env',
]);
const NOT_DEFAULT_INDEXED_FILENAMES: ReadonlySet<string> = new Set(['.env', '.env.local']);

const SEARCHABLE_DECLARATIONS = getLanguageCapabilityDeclarations()
    .filter((declaration) => declaration.searchEligibility !== 'none');

// The language registry is the single source of truth for which files are
// recognized; admission derives from it, as codebase-memory-mcp derives
// discovery from its language table.
const REGISTRY_SEARCH_EXTENSIONS = SEARCHABLE_DECLARATIONS
    .flatMap((declaration) => declaration.extensions)
    .filter((extension) => !NOT_DEFAULT_INDEXED_EXTENSIONS.has(extension));

const REGISTRY_SYMBOL_EXTENSIONS = SEARCHABLE_DECLARATIONS
    .filter((declaration) => declaration.symbolExtractionCapability === 'production_ready')
    .flatMap((declaration) => declaration.extensions);

export const INDEXABLE_EXTENSIONLESS_FILENAMES = [
    'Dockerfile',
    'Makefile',
    'Justfile',
    'Taskfile',
    'Procfile',
    'Jenkinsfile',
    '.dockerignore',
] as const;

export const INDEXABLE_EXACT_FILENAMES: readonly string[] = [...new Set([
    ...INDEXABLE_EXTENSIONLESS_FILENAMES,
    ...SEARCHABLE_DECLARATIONS
        .flatMap((declaration) => declaration.filenames ?? [])
        .filter((filename) => !NOT_DEFAULT_INDEXED_FILENAMES.has(filename)),
])];

/**
 * Catalog filenames (go.mod, CMakeLists.txt, kustomization.yaml, ...) belong to
 * the registry search tier, so an extension set admits them only when it
 * carries that whole tier (default, all-text); `minimal` keeps the legacy
 * extensionless names only.
 */
export function getIndexableExactFilenames(supportedExtensions: ReadonlySet<string>): readonly string[] {
    return REGISTRY_SEARCH_EXTENSIONS.every((extension) => supportedExtensions.has(extension.toLowerCase()))
        ? INDEXABLE_EXACT_FILENAMES
        : INDEXABLE_EXTENSIONLESS_FILENAMES;
}

export const MINIMAL_SUPPORTED_EXTENSIONS: readonly string[] = [...new Set([
    ...SOURCE_SUPPORTED_EXTENSIONS,
    ...REGISTRY_SYMBOL_EXTENSIONS,
    ...DOC_SUPPORTED_EXTENSIONS,
])];

export const DEFAULT_SUPPORTED_EXTENSIONS: string[] = [...new Set([
    ...MINIMAL_SUPPORTED_EXTENSIONS,
    ...CONFIG_SUPPORTED_EXTENSIONS,
    ...SCRIPT_SUPPORTED_EXTENSIONS,
    ...INFRA_QUERY_SUPPORTED_EXTENSIONS,
    ...REGISTRY_SEARCH_EXTENSIONS,
])];

export const ALL_TEXT_SUPPORTED_EXTENSIONS = [
    ...DEFAULT_SUPPORTED_EXTENSIONS,
    ALL_TEXT_INDEX_MARKER,
];

export function normalizeIndexProfile(value: unknown): IndexProfile | null {
    if (value === 'default' || value === 'minimal' || value === 'all-text') {
        return value;
    }
    return null;
}

export function getSupportedExtensionsForIndexProfile(profile: IndexProfile = 'default'): string[] {
    if (profile === 'minimal') {
        return [...MINIMAL_SUPPORTED_EXTENSIONS];
    }
    if (profile === 'all-text') {
        return [...ALL_TEXT_SUPPORTED_EXTENSIONS];
    }
    return [...DEFAULT_SUPPORTED_EXTENSIONS];
}

export const DEFAULT_IGNORE_PATTERNS = [
    // Common build output and dependency directories
    'node_modules/**',
    'dist/**',
    'build/**',
    'out/**',
    'target/**',
    'coverage/**',
    '.nyc_output/**',

    // IDE and editor files
    '.vscode/**',
    '.idea/**',
    '*.swp',
    '*.swo',

    // Version control
    '.git/**',
    '.svn/**',
    '.hg/**',

    // Cache directories
    '.cache/**',
    '__pycache__/**',
    '.pytest_cache/**',

    // Logs and temporary files
    'logs/**',
    'tmp/**',
    'temp/**',
    '*.log',

    // Environment and config files
    '.env',
    '.env.*',
    '*.local',

    // Lockfiles
    'package-lock.json',
    'npm-shrinkwrap.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lockb',
    'Cargo.lock',
    'Gemfile.lock',
    'composer.lock',
    'poetry.lock',
    'Pipfile.lock',
    'uv.lock',

    // Private keys, certs, and local credential material
    '*.pem',
    '*.key',
    '*.crt',
    '*.cer',
    '*.p12',
    '*.pfx',

    // Minified and bundled files
    '*.min.js',
    '*.min.css',
    '*.min.map',
    '*.bundle.js',
    '*.bundle.css',
    '*.chunk.js',
    '*.vendor.js',
    '*.polyfills.js',
    '*.runtime.js',
    '*.map',

    // Database dumps and generated snapshots
    '*.sqlite',
    '*.sqlite3',
    '*.db',
    '*.dump',
    '*.bak',
    '*.snap',
    '__snapshots__/**',

    'node_modules', '.git', '.svn', '.hg', 'build', 'dist', 'out',
    'target', '.vscode', '.idea', '__pycache__', '.pytest_cache',
    'coverage', '.nyc_output', 'logs', 'tmp', 'temp'
];
