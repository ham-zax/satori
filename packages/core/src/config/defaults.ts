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

export const INDEXABLE_EXTENSIONLESS_FILENAMES = [
    'Dockerfile',
    'Makefile',
    'Justfile',
    'Taskfile',
    'Procfile',
    'Jenkinsfile',
    '.dockerignore',
] as const;

export const MINIMAL_SUPPORTED_EXTENSIONS = [
    ...SOURCE_SUPPORTED_EXTENSIONS,
    ...DOC_SUPPORTED_EXTENSIONS,
] as const;

export const DEFAULT_SUPPORTED_EXTENSIONS = [
    ...MINIMAL_SUPPORTED_EXTENSIONS,
    ...CONFIG_SUPPORTED_EXTENSIONS,
    ...SCRIPT_SUPPORTED_EXTENSIONS,
    ...INFRA_QUERY_SUPPORTED_EXTENSIONS,
];

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
