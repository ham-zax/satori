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
    '.sql', '.graphql', '.gql', '.tf',
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

/** Always excluded: user ignore files cannot re-include these (see `ignore-matcher.ts`). */
export const HARD_IGNORE_PATTERNS = [
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
    'go.sum',
    'flake.lock',
    'Podfile.lock',
    'pubspec.lock',
    'mix.lock',
    'packages.lock.json',
    'gradle.lockfile',
    'deno.lock',
    '.pnp.cjs',
    '.pnp.loader.mjs',

    // Private keys, certs, and local credential material
    '*.pem',
    '*.key',
    '*.crt',
    '*.cer',
    '*.p12',
    '*.pfx',
    '*.jks',
    '*.keystore',
    'id_rsa*',
    'id_ed25519*',
    '.npmrc',
    '.pypirc',
    '.netrc',
    'credentials.json',
    'service-account*.json',
    '*-key.json',

    // Terraform state and variable files often hold secrets
    '*.tfstate',
    '*.tfstate.*',
    '*.tfvars',

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

/**
 * Excluded by default, but a `!` rule in `.gitignore` or `.satoriignore` can
 * re-include them: some repositories commit `vendor/` or `deps/` on purpose.
 * Bare names match at any depth.
 */
export const OVERRIDABLE_DEFAULT_IGNORE_PATTERNS = [
    // Python environments, caches, and packaging output
    '.venv', 'venv', '.tox', '.nox', '.mypy_cache', '.ruff_cache', '.pytype',
    '.hypothesis', '.ipynb_checkpoints', '.eggs', '*.egg-info', '__pypackages__',
    'site-packages', 'htmlcov',
    // JavaScript framework output, tool caches, and package stores
    '.next', '.nuxt', '.output', '.svelte-kit', '.turbo', '.parcel-cache',
    '.angular', '.docusaurus', '.expo', '.vercel', '.netlify', '.wrangler',
    '.serverless', '.nx', '.yarn', '.pnpm-store', 'bower_components',
    'jspm_packages', 'storybook-static', '*.tsbuildinfo', '.eslintcache',
    // Vendored dependencies
    'vendor', 'deps', '.bundle',
    // JVM, .NET, Apple, Dart, Elixir, Haskell, Zig, CMake, Bazel, Terraform
    '.gradle', '.m2', 'obj', 'Pods', 'DerivedData', '.build', '.swiftpm',
    '.dart_tool', '.pub-cache', '_build', '.stack-work', 'dist-newstyle',
    'zig-cache', '.zig-cache', 'zig-out', 'CMakeFiles', 'cmake-build-*',
    'bazel-*', '.terraform',
    // Other caches and local tool state
    '.cache', '.sass-cache', '.direnv', '.devenv', '.history',
    '.vs', '.fleet', '.godot', '.pio', 'elm-stuff', '.cabal-sandbox',
    '**/.mvn/wrapper', '**/.dvc/cache', '.ccache', '.bsp', '.metals', '.bloop',
    // Coding-agent state and in-repo worktrees: worktrees duplicate the repository
    '.worktrees', '**/.claude/worktrees', '**/.claude/projects', '.codex', '.jj',
    '.aider*', '.cursor', '.continue', '.windsurf',
    // Test, coverage, and CI reports
    'test-results', 'playwright-report', 'blob-report', '**/cypress/videos',
    '**/cypress/screenshots', 'lcov-report', '.coverage', 'coverage.xml',
    'junit*.xml', 'reports',
    // Generated documentation sites
    'site', '_site', '**/.vitepress/cache', 'api-docs', 'typedoc',
    // Protobuf and Dart codegen output. Other generated paths stay indexed:
    // search classifies them as `generated` and ranks them down.
    '*.pb.go', '*_pb2.py', '*_pb2_grpc.py', '*.g.dart', '*.freezed.dart',
    // Bundled third-party source trees
    'third_party', 'third-party', '3rdparty', 'external',
];

/** Base ignore set: hard exclusions first, then the overridable defaults. */
export const DEFAULT_IGNORE_PATTERNS = [...HARD_IGNORE_PATTERNS, ...OVERRIDABLE_DEFAULT_IGNORE_PATTERNS];
