import {
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    type SymbolRecord,
    type SymbolRegistryManifest,
} from '../packages/core/src/symbols/contracts.ts';
import {
    buildSymbolRecordsForFile,
    buildSymbolRegistry,
} from '../packages/core/src/symbols/registry.ts';
import { createLanguageAnalysisService } from '../packages/core/src/language-analysis/service.ts';
import { getLanguageIdFromFilename } from '../packages/core/src/language/registry.ts';
import {
    resolvePythonRelationships,
    type PythonResolutionAnalysisInput,
} from '../packages/core/src/relationships/python-resolution.ts';
import {
    NATIVE_PYTHON_PROVIDER_ID,
    NATIVE_PYTHON_PROVIDER_VERSION,
    type ResolutionClaim,
} from '../packages/core/src/relationships/resolution.ts';

type Expectation =
    | { kind: 'target'; target: string }
    | { kind: 'abstain' }
    | { kind: 'observe' };

interface Fixture {
    readonly id: string;
    readonly pattern: string;
    readonly sources: Readonly<Record<string, string>>;
    readonly callFile: string;
    readonly callLine: number;
    readonly callee: string;
    readonly expectation: Expectation;
    readonly note?: string;
}

interface Observation {
    readonly id: string;
    readonly pattern: string;
    readonly expected: string;
    readonly observedDecision: string;
    readonly observedTarget: string | null;
    readonly authority: string | null;
    readonly proof: readonly string[];
    readonly classification: 'exact' | 'honest_abstention' | 'miss' | 'wrong_target' | 'observe';
    readonly note?: string;
}

async function analyzeFiles(sources: Readonly<Record<string, string>>) {
    const analyzer = createLanguageAnalysisService();
    return new Map(await Promise.all(Object.entries(sources).map(async ([relativePath, content]) => [
        relativePath,
        await analyzer.analyze({
            content,
            language: getLanguageIdFromFilename(relativePath, 'text'),
            relativePath,
        }),
    ] as const)));
}

async function buildRegistry(sources: Readonly<Record<string, string>>) {
    const entries = Object.entries(sources).sort(([left], [right]) => left.localeCompare(right));
    const analysisByFile = await analyzeFiles(Object.fromEntries(entries));
    const symbols: SymbolRecord[] = [];
    const files: SymbolRegistryManifest['files'] = [];

    for (const [relativePath, content] of entries) {
        const analysis = analysisByFile.get(relativePath);
        if (!analysis) throw new Error(`missing analysis for ${relativePath}`);
        const fileHash = `p1-${relativePath}`;
        const fileSymbols = buildSymbolRecordsForFile({
            relativePath,
            language: 'python',
            content,
            fileHash,
            extractorVersion: 'python-p1',
            chunks: [],
            extractedSymbols: analysis.symbols,
        });
        symbols.push(...fileSymbols);
        files.push({
            path: relativePath,
            hash: fileHash,
            language: 'python',
            symbolCount: fileSymbols.length,
            definitionStatus: analysis.structuralStatus === 'complete'
                ? 'definitions_present'
                : 'structural_unavailable',
        });
    }

    return {
        analysisByFile: analysisByFile as Map<string, PythonResolutionAnalysisInput>,
        registry: buildSymbolRegistry({
            manifest: {
                schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
                normalizedRootPath: '/python-p1',
                rootFingerprint: 'python-p1-root',
                indexPolicyHash: 'python-p1-policy',
                languageRouterVersion: 'python-p1-router',
                extractorVersion: 'python-p1',
                relationshipVersion: 'python-p1',
                builtAt: '2026-09-21T00:00:00.000Z',
                files,
            },
            symbols,
        }),
    };
}

function classify(expectation: Expectation, claim: ResolutionClaim | undefined): Observation['classification'] {
    if (expectation.kind === 'observe') return 'observe';
    const target = claim?.targetSymbol ?? null;
    if (expectation.kind === 'abstain') {
        return claim?.decision === 'resolved' ? 'wrong_target' : 'honest_abstention';
    }
    if (claim?.decision !== 'resolved') return 'miss';
    return target === expectation.target ? 'exact' : 'wrong_target';
}

function expectedText(expectation: Expectation): string {
    if (expectation.kind === 'target') return expectation.target;
    return expectation.kind;
}

const fixtures: readonly Fixture[] = [
    {
        id: 'typed-parameter',
        pattern: 'typed parameters',
        sources: {
            'pkg/models.py': 'class Service:\n    def run(self): pass\n',
            'pkg/app.py': 'from .models import Service\n\ndef use(service: Service):\n    service.run()\n',
        },
        callFile: 'pkg/app.py',
        callLine: 4,
        callee: 'run',
        expectation: { kind: 'target', target: 'Service.run' },
    },
    {
        id: 'forward-ref-parameter',
        pattern: 'typed parameters / forward refs',
        sources: {
            'pkg/models.py': 'class Service:\n    def run(self): pass\n',
            'pkg/app.py': 'from .models import Service\n\ndef use(service: "Service"):\n    service.run()\n',
        },
        callFile: 'pkg/app.py',
        callLine: 4,
        callee: 'run',
        expectation: { kind: 'target', target: 'Service.run' },
    },
    {
        id: 'cross-module-constructor',
        pattern: 'cross-module constructors',
        sources: {
            'pkg/models.py': 'class Service:\n    pass\n',
            'pkg/app.py': 'from .models import Service\n\ndef make():\n    return Service()\n',
        },
        callFile: 'pkg/app.py',
        callLine: 4,
        callee: 'Service',
        expectation: { kind: 'target', target: 'Service' },
    },
    {
        id: 'self-field-origin',
        pattern: 'self.field receiver origins',
        sources: {
            'pkg/models.py': 'class Service:\n    def run(self): pass\n',
            'pkg/app.py': [
                'from .models import Service',
                'class Runner:',
                '    def __init__(self):',
                '        self.service = Service()',
                '',
                '    def go(self):',
                '        self.service.run()',
            ].join('\n'),
        },
        callFile: 'pkg/app.py',
        callLine: 7,
        callee: 'run',
        expectation: { kind: 'target', target: 'Service.run' },
    },
    {
        id: 'constructor-assignment',
        pattern: 'constructor assignment',
        sources: {
            'pkg/models.py': 'class Service:\n    def run(self): pass\n',
            'pkg/app.py': 'from .models import Service\n\ndef go():\n    service = Service()\n    service.run()\n',
        },
        callFile: 'pkg/app.py',
        callLine: 5,
        callee: 'run',
        expectation: { kind: 'target', target: 'Service.run' },
    },
    {
        id: 'import-alias-constructor',
        pattern: 'aliases',
        sources: {
            'pkg/models.py': 'class Service:\n    def run(self): pass\n',
            'pkg/app.py': 'from .models import Service as S\n\ndef go():\n    service = S()\n    service.run()\n',
        },
        callFile: 'pkg/app.py',
        callLine: 5,
        callee: 'run',
        expectation: { kind: 'target', target: 'Service.run' },
    },
    {
        id: 'module-alias-direct',
        pattern: 'aliases',
        sources: {
            'pkg/models.py': 'def helper(): pass\n',
            'pkg/app.py': 'import models as m\n\ndef go():\n    m.helper()\n',
        },
        callFile: 'pkg/app.py',
        callLine: 4,
        callee: 'helper',
        expectation: { kind: 'target', target: 'helper' },
    },
    {
        id: 'local-import-positive',
        pattern: 'local imports',
        sources: {
            'pkg/models.py': 'def helper(): pass\n',
            'pkg/app.py': 'def go():\n    from .models import helper\n    helper()\n',
        },
        callFile: 'pkg/app.py',
        callLine: 3,
        callee: 'helper',
        expectation: { kind: 'target', target: 'helper' },
    },
    {
        id: 'local-import-scope-leak',
        pattern: 'local imports',
        sources: {
            'pkg/models.py': 'def helper(): pass\n',
            'pkg/app.py': [
                'def a():',
                '    from .models import helper',
                '    helper()',
                '',
                'def b():',
                '    helper()',
            ].join('\n'),
        },
        callFile: 'pkg/app.py',
        callLine: 6,
        callee: 'helper',
        expectation: { kind: 'abstain' },
        note: 'The import is local to a(); b() has no binding for helper.',
    },
    {
        id: 'competing-local-import-a',
        pattern: 'local imports',
        sources: {
            'pkg/alpha.py': 'def helper(): pass\n',
            'pkg/beta.py': 'def helper(): pass\n',
            'pkg/app.py': [
                'def a():',
                '    from .alpha import helper',
                '    helper()',
                '',
                'def b():',
                '    from .beta import helper',
                '    helper()',
            ].join('\n'),
        },
        callFile: 'pkg/app.py',
        callLine: 3,
        callee: 'helper',
        expectation: { kind: 'target', target: 'helper' },
        note: 'Expected target file is pkg/alpha.py; targetSymbol alone cannot distinguish duplicate qualified names, so file is inspected separately.',
    },
    {
        id: 'callback-direct-keyword',
        pattern: 'callback passing/invocation',
        sources: {
            'pkg/app.py': [
                'def target(): pass',
                '',
                'def invoke(cb):',
                '    cb()',
                '',
                'def entry():',
                '    invoke(cb=target)',
            ].join('\n'),
        },
        callFile: 'pkg/app.py',
        callLine: 4,
        callee: 'cb',
        expectation: { kind: 'target', target: 'target' },
    },
    {
        id: 'service-any-keyword',
        pattern: 'service fields typed Any',
        sources: {
            'pkg/app.py': [
                'from typing import Any',
                '',
                'class Ledger:',
                '    def record(self): pass',
                '',
                'class Engine:',
                '    def __init__(self):',
                '        self.ledger = Ledger()',
                '',
                'class Services:',
                '    def __init__(self, ledger: Any):',
                '        self.ledger = ledger',
                '',
                'def consume(services: Services):',
                '    services.ledger.record()',
                '',
                'def entry():',
                '    engine = Engine()',
                '    services = Services(ledger=engine.ledger)',
                '    consume(services=services)',
            ].join('\n'),
        },
        callFile: 'pkg/app.py',
        callLine: 15,
        callee: 'record',
        expectation: { kind: 'target', target: 'Ledger.record' },
    },
    {
        id: 'service-any-positional',
        pattern: 'service fields typed Any / positional flow',
        sources: {
            'pkg/app.py': [
                'from typing import Any',
                '',
                'class Ledger:',
                '    def record(self): pass',
                '',
                'class Engine:',
                '    def __init__(self):',
                '        self.ledger = Ledger()',
                '',
                'class Services:',
                '    def __init__(self, ledger: Any):',
                '        self.ledger = ledger',
                '',
                'def consume(services: Services):',
                '    services.ledger.record()',
                '',
                'def entry():',
                '    engine = Engine()',
                '    services = Services(engine.ledger)',
                '    consume(services=services)',
            ].join('\n'),
        },
        callFile: 'pkg/app.py',
        callLine: 15,
        callee: 'record',
        expectation: { kind: 'target', target: 'Ledger.record' },
    },
    {
        id: 'inherited-method',
        pattern: 'inheritance',
        sources: {
            'pkg/app.py': [
                'class Base:',
                '    def run(self): pass',
                '',
                'class Child(Base):',
                '    pass',
                '',
                'def go():',
                '    child = Child()',
                '    child.run()',
            ].join('\n'),
        },
        callFile: 'pkg/app.py',
        callLine: 9,
        callee: 'run',
        expectation: { kind: 'target', target: 'Base.run' },
    },
    {
        id: 'override-dispatch',
        pattern: 'inheritance / override dispatch',
        sources: {
            'pkg/app.py': [
                'class Base:',
                '    def run(self): pass',
                '',
                'class Child(Base):',
                '    def run(self): pass',
                '',
                'def go():',
                '    child = Child()',
                '    child.run()',
            ].join('\n'),
        },
        callFile: 'pkg/app.py',
        callLine: 9,
        callee: 'run',
        expectation: { kind: 'target', target: 'Child.run' },
    },
    {
        id: 'straight-reassignment',
        pattern: 'reassignment',
        sources: {
            'pkg/app.py': [
                'class A:',
                '    def run(self): pass',
                'class B:',
                '    def run(self): pass',
                '',
                'def go():',
                '    value = A()',
                '    value = B()',
                '    value.run()',
            ].join('\n'),
        },
        callFile: 'pkg/app.py',
        callLine: 9,
        callee: 'run',
        expectation: { kind: 'target', target: 'B.run' },
    },
    {
        id: 'branch-conflicted-reassignment',
        pattern: 'branch-conflicted origins',
        sources: {
            'pkg/app.py': [
                'class A:',
                '    def run(self): pass',
                'class B:',
                '    def run(self): pass',
                '',
                'def go(flag):',
                '    value = A()',
                '    if flag:',
                '        value = B()',
                '    value.run()',
            ].join('\n'),
        },
        callFile: 'pkg/app.py',
        callLine: 10,
        callee: 'run',
        expectation: { kind: 'abstain' },
        note: 'Both A.run and B.run are reachable at runtime; exact binding is not proven.',
    },
    {
        id: 'typed-parameter-alias',
        pattern: 'aliases / typed-origin propagation',
        sources: {
            'pkg/models.py': 'class Service:\n    def run(self): pass\n',
            'pkg/app.py': 'from .models import Service\n\ndef use(service: Service):\n    alias = service\n    alias.run()\n',
        },
        callFile: 'pkg/app.py',
        callLine: 5,
        callee: 'run',
        expectation: { kind: 'target', target: 'Service.run' },
    },
    {
        id: 'callable-object',
        pattern: 'callable objects',
        sources: {
            'pkg/app.py': [
                'class Handler:',
                '    def __call__(self): pass',
                '',
                'def go():',
                '    handler = Handler()',
                '    handler()',
            ].join('\n'),
        },
        callFile: 'pkg/app.py',
        callLine: 6,
        callee: 'handler',
        expectation: { kind: 'target', target: 'Handler.__call__' },
    },
    {
        id: 'any-parameter-abstention',
        pattern: 'service fields typed as Any / unresolved receiver',
        sources: {
            'pkg/app.py': [
                'from typing import Any',
                'class Service:',
                '    def run(self): pass',
                '',
                'def use(service: Any):',
                '    service.run()',
            ].join('\n'),
        },
        callFile: 'pkg/app.py',
        callLine: 6,
        callee: 'run',
        expectation: { kind: 'abstain' },
    },
    {
        id: 'ambiguous-untyped-receiver',
        pattern: 'unresolved/ambiguous calls',
        sources: {
            'pkg/app.py': [
                'class A:',
                '    def run(self): pass',
                'class B:',
                '    def run(self): pass',
                '',
                'def use(service):',
                '    service.run()',
            ].join('\n'),
        },
        callFile: 'pkg/app.py',
        callLine: 7,
        callee: 'run',
        expectation: { kind: 'abstain' },
    },
    {
        id: 'dynamic-getattr',
        pattern: 'dynamic attributes',
        sources: {
            'pkg/app.py': [
                'class A:',
                '    def run(self): pass',
                '',
                'def use(value):',
                '    getattr(value, "run")()',
            ].join('\n'),
        },
        callFile: 'pkg/app.py',
        callLine: 5,
        callee: 'getattr',
        expectation: { kind: 'abstain' },
        note: 'The dynamic attribute target is not statically proven; abstention is the safe result.',
    },
    {
        id: 'protocol-static-dispatch',
        pattern: 'protocol/interface-like dispatch',
        sources: {
            'pkg/app.py': [
                'from typing import Protocol',
                '',
                'class Runner(Protocol):',
                '    def run(self): ...',
                '',
                'class Impl:',
                '    def run(self): pass',
                '',
                'def use(value: Runner):',
                '    value.run()',
            ].join('\n'),
        },
        callFile: 'pkg/app.py',
        callLine: 10,
        callee: 'run',
        expectation: { kind: 'abstain' },
        note: 'A protocol declaration constrains shape but does not prove one executable runtime implementation, so authoritative CALLS must abstain.',
    },
    {
        id: 'decorator-replacement',
        pattern: 'decorator/wrapper effects',
        sources: {
            'pkg/app.py': [
                'def replacement(): pass',
                '',
                'def replace(fn):',
                '    return replacement',
                '',
                '@replace',
                'def original(): pass',
                '',
                'def go():',
                '    original()',
            ].join('\n'),
        },
        callFile: 'pkg/app.py',
        callLine: 10,
        callee: 'original',
        expectation: { kind: 'abstain' },
        note: 'Decorator execution may rebind the global name to a different runtime callable. Without proof of the post-decoration value, authoritative CALLS must fail closed.',
    },
];

const rows: Observation[] = [];
for (const fixture of fixtures) {
    const { registry, analysisByFile } = await buildRegistry(fixture.sources);
    const result = resolvePythonRelationships({ registry, analysisByFile });
    const claims = result.claimsByFile.get(fixture.callFile) ?? [];
    const claim = claims.find((candidate) => (
        candidate.callSpan.startLine === fixture.callLine
        && candidate.proofSteps[0]?.subject === fixture.callee
    ));
    let classification = classify(fixture.expectation, claim);
    let observedTarget = claim?.targetSymbol ?? null;
    let note = fixture.note;

    if (fixture.id === 'competing-local-import-a' && claim?.targetInstanceId) {
        const target = registry.symbolsByInstanceId.get(claim.targetInstanceId);
        const exactFile = target?.file === 'pkg/alpha.py';
        if (claim.decision === 'resolved' && claim.targetSymbol === 'helper' && exactFile) {
            classification = 'exact';
        } else if (claim.decision === 'resolved') {
            classification = 'wrong_target';
        } else {
            classification = 'miss';
        }
        observedTarget = target ? `${target.file}::${target.qualifiedName}` : observedTarget;
    }

    rows.push({
        id: fixture.id,
        pattern: fixture.pattern,
        expected: expectedText(fixture.expectation),
        observedDecision: claim?.decision ?? 'missing_claim',
        observedTarget,
        authority: claim?.resolutionAuthority ?? null,
        proof: claim?.proofSteps.map((step) => step.kind) ?? [],
        classification,
        ...(note ? { note } : {}),
    });
}

const summary = {
    revision: '30af0973d9bf283776f2e3efeb5096379188443b',
    provider: `${NATIVE_PYTHON_PROVIDER_ID}/${NATIVE_PYTHON_PROVIDER_VERSION}`,
    counts: {
        exact: rows.filter((row) => row.classification === 'exact').length,
        honestAbstention: rows.filter((row) => row.classification === 'honest_abstention').length,
        misses: rows.filter((row) => row.classification === 'miss').length,
        wrongTargets: rows.filter((row) => row.classification === 'wrong_target').length,
        observe: rows.filter((row) => row.classification === 'observe').length,
    },
    rows,
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
