import type { CapabilityStatus, LanguageCapabilityDeclaration } from './types';

const NONE: CapabilityStatus = 'none';
const DECLARED: CapabilityStatus = 'declared';
const PRODUCTION_READY: CapabilityStatus = 'production_ready';

type DeclarationInput = Omit<LanguageCapabilityDeclaration, 'fixtures'> & {
    readonly fixtures?: LanguageCapabilityDeclaration['fixtures'];
};

function declaration(input: DeclarationInput): LanguageCapabilityDeclaration {
    return {
        ...input,
        fixtures: input.fixtures ?? {},
    };
}

function fullNavigationLanguage(input: {
    readonly languageId: string;
    readonly aliases: readonly string[];
    readonly extensions: readonly string[];
}): LanguageCapabilityDeclaration {
    return declaration({
        ...input,
        searchEligibility: PRODUCTION_READY,
        parserCapability: PRODUCTION_READY,
        symbolExtractionCapability: PRODUCTION_READY,
        ownerExtractionCapability: PRODUCTION_READY,
        importExportCapability: NONE,
        callsCapability: PRODUCTION_READY,
        typeReceiverAwareCapability: NONE,
        testReferenceCapability: PRODUCTION_READY,
        publicClaim: 'calls_v0',
    });
}

function astSearchOnlyLanguage(input: {
    readonly languageId: string;
    readonly aliases: readonly string[];
    readonly extensions: readonly string[];
    readonly fixtures?: Pick<LanguageCapabilityDeclaration['fixtures'], 'parser'>;
}): LanguageCapabilityDeclaration {
    return declaration({
        ...input,
        searchEligibility: PRODUCTION_READY,
        parserCapability: PRODUCTION_READY,
        symbolExtractionCapability: NONE,
        ownerExtractionCapability: NONE,
        importExportCapability: NONE,
        callsCapability: NONE,
        typeReceiverAwareCapability: NONE,
        testReferenceCapability: NONE,
        publicClaim: 'search_only',
    });
}

function parserDeclaredSearchOnlyLanguage(input: {
    readonly languageId: string;
    readonly aliases?: readonly string[];
    readonly extensions: readonly string[];
    readonly filenames?: readonly string[];
}): LanguageCapabilityDeclaration {
    return declaration({
        languageId: input.languageId,
        aliases: input.aliases ?? [],
        extensions: input.extensions,
        ...(input.filenames ? { filenames: input.filenames } : {}),
        searchEligibility: PRODUCTION_READY,
        parserCapability: DECLARED,
        symbolExtractionCapability: NONE,
        ownerExtractionCapability: NONE,
        importExportCapability: NONE,
        callsCapability: NONE,
        typeReceiverAwareCapability: NONE,
        testReferenceCapability: NONE,
        publicClaim: 'search_only',
    });
}

function symbolOnlyLanguage(input: {
    readonly languageId: string;
    readonly aliases: readonly string[];
    readonly extensions: readonly string[];
    readonly fixtures: Required<Pick<LanguageCapabilityDeclaration['fixtures'], 'navigation' | 'symbols' | 'ownerMetadata' | 'fileOutline' | 'readFileOpenSymbol'>>;
}): LanguageCapabilityDeclaration {
    return declaration({
        ...input,
        searchEligibility: PRODUCTION_READY,
        parserCapability: PRODUCTION_READY,
        symbolExtractionCapability: PRODUCTION_READY,
        ownerExtractionCapability: PRODUCTION_READY,
        importExportCapability: NONE,
        callsCapability: NONE,
        typeReceiverAwareCapability: NONE,
        testReferenceCapability: NONE,
        publicClaim: 'symbol_only',
    });
}

function searchOnlyLanguage(input: {
    readonly languageId: string;
    readonly aliases: readonly string[];
    readonly extensions: readonly string[];
    readonly filenames?: readonly string[];
}): LanguageCapabilityDeclaration {
    return declaration({
        ...input,
        searchEligibility: PRODUCTION_READY,
        parserCapability: NONE,
        symbolExtractionCapability: NONE,
        ownerExtractionCapability: NONE,
        importExportCapability: NONE,
        callsCapability: NONE,
        typeReceiverAwareCapability: NONE,
        testReferenceCapability: NONE,
        publicClaim: 'search_only',
    });
}

const CMM_DERIVED_SEARCH_ONLY_DECLARATIONS: readonly LanguageCapabilityDeclaration[] = [
    parserDeclaredSearchOnlyLanguage({ languageId: 'ada', extensions: ['.adb', '.ads'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'agda', extensions: ['.agda'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'apex', extensions: ['.cls', '.trigger'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'assembly', extensions: ['.s'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'astro', extensions: ['.astro'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'awk', extensions: ['.awk'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'bash', aliases: ['sh'], extensions: ['.bash', '.sh'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'beancount', extensions: ['.beancount'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'bibtex', extensions: ['.bib'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'bicep', extensions: ['.bicep'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'bitbake', extensions: ['.bb', '.bbappend', '.bbclass', '.inc'] }),
    // Keep `.c` routed through the existing C/C++ AST splitter until C has Satori-native parser proof.
    parserDeclaredSearchOnlyLanguage({ languageId: 'c', extensions: [] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'cairo', extensions: ['.cairo'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'capnp', extensions: ['.capnp'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'cfml', extensions: ['.cfm'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'cfscript', extensions: ['.cfc'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'clojure', extensions: ['.clj', '.cljc', '.cljs'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'cmake', extensions: ['.cmake'], filenames: ['CMakeLists.txt'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'cobol', extensions: ['.cbl', '.cob'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'commonlisp', aliases: ['common-lisp'], extensions: ['.cl', '.lisp', '.lsp'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'crystal', extensions: ['.cr'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'css', extensions: ['.css'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'csv', extensions: ['.csv'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'cuda', extensions: ['.cu', '.cuh'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'dart', extensions: ['.dart'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'devicetree', extensions: ['.dts', '.dtsi', '.overlay'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'diff', extensions: ['.diff', '.patch'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'dlang', aliases: ['d'], extensions: ['.d'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'dockerfile', extensions: ['.dockerfile'], filenames: ['Dockerfile'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'dotenv', extensions: ['.env'], filenames: ['.env', '.env.local'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'elixir', extensions: ['.ex', '.exs'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'elm', extensions: ['.elm'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'emacslisp', aliases: ['elisp', 'emacs-lisp'], extensions: ['.el'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'erlang', extensions: ['.erl'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'fennel', extensions: ['.fnl'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'fish', extensions: ['.fish'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'form', extensions: ['.frm', '.prc'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'fortran', extensions: ['.f03', '.f08', '.f90', '.f95'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'fsharp', aliases: ['f#'], extensions: ['.fs', '.fsi', '.fsx'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'func', extensions: ['.fc'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'gdscript', extensions: ['.gd'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'gitattributes', extensions: [], filenames: ['.gitattributes'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'gleam', extensions: ['.gleam'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'glsl', extensions: ['.frag', '.glsl', '.vert'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'gn', extensions: ['.gn', '.gni'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'gomod', extensions: [], filenames: ['go.mod'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'gotemplate', extensions: ['.gotmpl', '.tmpl', '.tpl'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'graphql', extensions: ['.gql', '.graphql'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'groovy', extensions: ['.gradle', '.groovy'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'hare', extensions: ['.ha'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'haskell', extensions: ['.hs'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'hcl', extensions: ['.hcl', '.tf'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'hlsl', extensions: ['.fx', '.hlsl', '.hlsli'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'html', extensions: ['.htm', '.html'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'hyprlang', extensions: ['.hl'], filenames: ['hyprland.conf'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'ini', extensions: ['.cfg', '.conf', '.ini'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'ispc', extensions: ['.ispc'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'janet', extensions: ['.janet'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'jinja2', extensions: ['.j2', '.jinja', '.jinja2'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'json', extensions: ['.json'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'json5', extensions: ['.json5'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'jsonnet', extensions: ['.jsonnet', '.libsonnet'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'julia', extensions: ['.jl'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'kconfig', extensions: [], filenames: ['Kconfig'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'kdl', extensions: ['.kdl'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'kotlin', aliases: ['kt'], extensions: ['.kt', '.kts'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'kustomize', extensions: [], filenames: ['kustomization.yaml', 'kustomization.yml'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'lean', extensions: ['.lean'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'linkerscript', aliases: ['linker-script'], extensions: ['.ld', '.lds'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'liquid', extensions: ['.liquid'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'llvm_ir', aliases: ['llvm-ir'], extensions: ['.ll'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'lua', extensions: ['.lua'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'luau', extensions: ['.luau'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'magma', extensions: ['.mag', '.magma'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'makefile', extensions: ['.mk'], filenames: ['GNUmakefile', 'Makefile', 'makefile'] }),
    // CMM disambiguates `.m` by source content; Satori keeps `.m` on Objective-C until it has that detector.
    parserDeclaredSearchOnlyLanguage({ languageId: 'matlab', extensions: ['.matlab', '.mlx'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'mermaid', extensions: ['.mermaid', '.mmd'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'meson', extensions: ['.meson'], filenames: ['meson.build', 'meson.options', 'meson_options.txt'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'move', extensions: ['.move'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'nasm', extensions: ['.nasm'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'nickel', extensions: ['.ncl'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'nix', extensions: ['.nix'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'ocaml', extensions: ['.ml', '.mli'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'odin', extensions: ['.odin'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'pascal', extensions: ['.dpr', '.lpr', '.pas'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'perl', extensions: ['.pl', '.pm'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'php', extensions: ['.php'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'pine', extensions: ['.pine'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'pkl', extensions: ['.pkl'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'po', extensions: ['.po', '.pot'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'pony', extensions: ['.pony'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'powershell', aliases: ['ps'], extensions: ['.ps1', '.psd1', '.psm1'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'prisma', extensions: ['.prisma'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'properties', extensions: ['.properties'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'protobuf', extensions: ['.proto'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'puppet', extensions: ['.pp'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'purescript', extensions: ['.purs'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'qml', extensions: ['.qml'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'r', extensions: ['.r'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'racket', extensions: ['.rkt'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'regex', extensions: ['.re'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'requirements', extensions: [], filenames: ['requirements-dev.txt', 'requirements-test.txt', 'requirements.txt'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'rescript', extensions: ['.res', '.resi'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'ron', extensions: ['.ron'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'rst', aliases: ['restructuredtext'], extensions: ['.rst'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'ruby', aliases: ['rb'], extensions: ['.gemspec', '.rake', '.rb'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'scheme', extensions: ['.scm', '.ss'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'scss', extensions: ['.scss'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'slang', extensions: ['.slang'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'smali', extensions: ['.smali'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'smithy', extensions: ['.smithy'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'solidity', extensions: ['.sol'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'soql', extensions: ['.soql'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'sosl', extensions: ['.sosl'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'sql', extensions: ['.sql'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'squirrel', extensions: ['.nut'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'sshconfig', aliases: ['ssh-config'], extensions: [], filenames: ['ssh_config', 'sshd_config'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'starlark', extensions: ['.bzl', '.star'], filenames: ['BUILD', 'BUILD.bazel', 'WORKSPACE', 'WORKSPACE.bazel'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'svelte', extensions: ['.svelte'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'sway', extensions: ['.sw'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'swift', extensions: ['.swift'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'tablegen', extensions: ['.td'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'tcl', extensions: ['.tcl'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'teal', extensions: ['.tl'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'templ', extensions: ['.templ'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'thrift', extensions: ['.thrift'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'tlaplus', aliases: ['tla+'], extensions: ['.tla'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'toml', extensions: ['.toml'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'typst', extensions: ['.typ'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'verilog', extensions: ['.sv', '.v'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'vhdl', extensions: ['.vhd', '.vhdl'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'vimscript', aliases: ['vim'], extensions: ['.vim', '.vimrc'], filenames: ['.vimrc'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'vue', extensions: ['.vue'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'wgsl', extensions: ['.wgsl'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'wit', extensions: ['.wit'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'wolfram', extensions: ['.wl', '.wls'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'xml', extensions: ['.svg', '.xml', '.xsd', '.xsl'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'yaml', extensions: ['.yaml', '.yml'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'zig', extensions: ['.zig'] }),
    parserDeclaredSearchOnlyLanguage({ languageId: 'zsh', extensions: ['.zsh'], filenames: ['.zprofile', '.zshenv', '.zshrc'] }),
];

const SATORI_DECLARATIONS: readonly LanguageCapabilityDeclaration[] = [
    astSearchOnlyLanguage({
        languageId: 'cpp',
        aliases: ['c++'],
        extensions: ['.cpp', '.c', '.h', '.hpp', '.cc', '.ccm', '.cppm', '.cxx', '.hh', '.hxx', '.ixx'],
        fixtures: {
            parser: ['packages/core/src/splitter/ast-splitter.test.ts'],
        },
    }),
    astSearchOnlyLanguage({
        languageId: 'csharp',
        aliases: ['cs'],
        extensions: ['.cs'],
        fixtures: {
            parser: ['packages/core/src/splitter/ast-splitter.test.ts'],
        },
    }),
    symbolOnlyLanguage({
        languageId: 'go',
        aliases: [],
        extensions: ['.go'],
        fixtures: {
            navigation: [
                'fixtures/navigation/go-basic-symbols/expected_symbols.json',
                'fixtures/navigation/go-basic-symbols/expected_tool_outputs.json',
            ],
            symbols: ['packages/core/src/languages/extractors/go-rust.test.ts'],
            ownerMetadata: ['packages/core/src/languages/extractors/go-rust.test.ts', 'packages/core/src/core/context.test.ts'],
            fileOutline: ['packages/mcp/src/core/handlers.file_outline.test.ts'],
            readFileOpenSymbol: ['packages/mcp/src/tools/read_file.test.ts'],
        },
    }),
    astSearchOnlyLanguage({
        languageId: 'java',
        aliases: [],
        extensions: ['.java'],
        fixtures: {
            parser: ['packages/core/src/splitter/ast-splitter.test.ts'],
        },
    }),
    fullNavigationLanguage({
        languageId: 'javascript',
        aliases: ['js'],
        extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    }),
    searchOnlyLanguage({
        languageId: 'jupyter',
        aliases: ['ipynb'],
        extensions: ['.ipynb'],
    }),
    parserDeclaredSearchOnlyLanguage({
        languageId: 'justfile',
        aliases: ['just'],
        extensions: ['.just', '.justfile'],
        filenames: ['.justfile', 'Justfile', 'justfile'],
    }),
    parserDeclaredSearchOnlyLanguage({
        languageId: 'objective-c',
        aliases: ['objc', 'objectivec'],
        extensions: ['.m', '.mm'],
    }),
    fullNavigationLanguage({
        languageId: 'python',
        aliases: ['py'],
        extensions: ['.py'],
    }),
    symbolOnlyLanguage({
        languageId: 'rust',
        aliases: ['rs'],
        extensions: ['.rs'],
        fixtures: {
            navigation: [
                'fixtures/navigation/rust-basic-symbols/expected_symbols.json',
                'fixtures/navigation/rust-basic-symbols/expected_tool_outputs.json',
            ],
            symbols: ['packages/core/src/languages/extractors/go-rust.test.ts'],
            ownerMetadata: ['packages/core/src/languages/extractors/go-rust.test.ts', 'packages/core/src/core/context.test.ts'],
            fileOutline: ['packages/mcp/src/core/handlers.file_outline.test.ts'],
            readFileOpenSymbol: ['packages/mcp/src/tools/read_file.test.ts'],
        },
    }),
    astSearchOnlyLanguage({
        languageId: 'scala',
        aliases: [],
        extensions: ['.scala'],
        fixtures: {
            parser: ['packages/core/src/splitter/ast-splitter.test.ts'],
        },
    }),
    parserDeclaredSearchOnlyLanguage({
        languageId: 'text',
        aliases: ['md', 'markdown'],
        extensions: ['.md', '.markdown', '.mdx'],
    }),
    fullNavigationLanguage({
        languageId: 'typescript',
        aliases: ['ts', 'tsx'],
        extensions: ['.ts', '.tsx', '.mts', '.cts'],
    }),
];

const DECLARATIONS: readonly LanguageCapabilityDeclaration[] = [
    ...CMM_DERIVED_SEARCH_ONLY_DECLARATIONS,
    ...SATORI_DECLARATIONS,
].sort((a, b) => a.languageId.localeCompare(b.languageId));

const DECLARATION_BY_KEY = new Map<string, LanguageCapabilityDeclaration>();

for (const item of DECLARATIONS) {
    DECLARATION_BY_KEY.set(item.languageId, item);
    for (const alias of item.aliases) {
        DECLARATION_BY_KEY.set(alias.toLowerCase(), item);
    }
}

export function getLanguageCapabilityDeclarations(): readonly LanguageCapabilityDeclaration[] {
    return DECLARATIONS;
}

export function getLanguageCapabilityDeclaration(language: string): LanguageCapabilityDeclaration | undefined {
    const key = String(language || '').trim().toLowerCase();
    if (!key) {
        return undefined;
    }
    return DECLARATION_BY_KEY.get(key);
}

export interface LanguageCapabilityTierCounts {
    readonly totalDeclarations: number;
    readonly recognizedRoutedLanguages: number;
    readonly parserCoveredLanguages: number;
    readonly symbolOnlyLanguages: number;
    readonly callGraphLanguages: number;
}

export function getLanguageCapabilityTierCounts(): LanguageCapabilityTierCounts {
    return {
        totalDeclarations: DECLARATIONS.length,
        recognizedRoutedLanguages: DECLARATIONS.filter((declaration) =>
            declaration.extensions.length > 0 || (declaration.filenames?.length || 0) > 0
        ).length,
        parserCoveredLanguages: DECLARATIONS.filter((declaration) => declaration.parserCapability !== NONE).length,
        symbolOnlyLanguages: DECLARATIONS.filter((declaration) => declaration.publicClaim === 'symbol_only').length,
        callGraphLanguages: DECLARATIONS.filter((declaration) => declaration.callsCapability === PRODUCTION_READY).length,
    };
}
