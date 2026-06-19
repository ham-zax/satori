import test from 'node:test';
import assert from 'node:assert/strict';
import { AstCodeSplitter } from './ast-splitter';

test('AstCodeSplitter preserves symbol metadata for large TypeScript files', async () => {
    const fillerMethods = Array.from({ length: 1200 }, (_, index) => [
        `    public filler${index}(): number {`,
        `        return ${index};`,
        '    }',
    ].join('\n')).join('\n');
    const code = [
        'export class HugeHandlers {',
        fillerMethods,
        '    public async targetOwner(input: string): Promise<string> {',
        '        return input.trim();',
        '    }',
        '}',
    ].join('\n');

    assert.ok(code.length > 40_000);

    const splitter = new AstCodeSplitter();
    const chunks = await splitter.split(code, 'typescript', 'src/huge-handlers.ts');
    const symbolChunks = chunks.filter((chunk) => typeof chunk.metadata.symbolId === 'string');

    assert.ok(symbolChunks.length > 0);
    assert.ok(symbolChunks.some((chunk) => chunk.metadata.symbolLabel === 'class HugeHandlers'));
    assert.ok(symbolChunks.some((chunk) => chunk.metadata.symbolLabel === 'async method targetOwner(input: string)'));
    assert.ok(symbolChunks.every((chunk) => chunk.metadata.startLine <= chunk.metadata.endLine));
});

test('AstCodeSplitter text-symbol fallback identifies class property arrow functions', async () => {
    const filler = Array.from({ length: 1200 }, (_, index) => `export function filler${index}() { return ${index}; }`).join('\n');
    const code = [
        filler,
        'export class Worker {',
        '    private runTask = async (name: string) => {',
        '        return name.toUpperCase();',
        '    };',
        '}',
    ].join('\n');

    const splitter = new AstCodeSplitter();
    const chunks = await splitter.split(code, 'typescript', 'src/worker.ts');

    assert.ok(chunks.some((chunk) => chunk.metadata.symbolLabel === 'async function runTask(...)'));
});

test('AstCodeSplitter preserves symbol metadata for large Python files', async () => {
    const fillerMethods = Array.from({ length: 2500 }, (_, index) => [
        `    def filler_${index}(self):`,
        `        return ${index}`,
        '',
    ].join('\n')).join('\n');
    const code = [
        '@tracked',
        'class HugePython:',
        fillerMethods,
        '    @staticmethod',
        '    async def target_owner(value: str) -> str:',
        '        return value.strip()',
        '',
        'def top_level(value):',
        '    return value',
    ].join('\n');

    assert.ok(code.length > 100_000);

    const splitter = new AstCodeSplitter();
    const chunks = await splitter.split(code, 'python', 'src/huge_python.py');
    const symbolChunks = chunks.filter((chunk) => typeof chunk.metadata.symbolId === 'string');
    const target = symbolChunks.find((chunk) => chunk.metadata.symbolLabel === 'async function target_owner(value: str) -> str');

    assert.ok(symbolChunks.length > 0);
    assert.ok(symbolChunks.some((chunk) => chunk.metadata.symbolLabel === 'class HugePython'));
    assert.ok(target);
    assert.deepEqual(target.metadata.breadcrumbs, [
        'class HugePython',
        'async function target_owner(value: str) -> str',
    ]);
    assert.ok(target.content.includes('@staticmethod'));
    assert.ok(symbolChunks.some((chunk) => chunk.metadata.symbolLabel === 'function top_level(value)'));
});

test('AstCodeSplitter Python text-symbol fallback preserves decorated top-level functions', async () => {
    const filler = Array.from({ length: 2500 }, (_, index) => `def filler_${index}():\n    return ${index}`).join('\n\n');
    const code = [
        filler,
        '@route("/health")',
        '@cached',
        'def health_check(request):',
        '    return request.ok',
    ].join('\n');

    const splitter = new AstCodeSplitter();
    const chunks = await splitter.split(code, 'python', 'src/routes.py');
    const healthCheckChunks = chunks.filter((chunk) => chunk.metadata.symbolLabel === 'function health_check(request)');
    const healthCheck = healthCheckChunks[0];

    assert.equal(healthCheckChunks.length, 1);
    assert.ok(healthCheck);
    assert.ok(healthCheck.content.includes('@route("/health")'));
    assert.ok(healthCheck.content.includes('@cached'));
    assert.deepEqual(healthCheck.metadata.breadcrumbs, ['function health_check(request)']);
});

test('AstCodeSplitter Python text-symbol fallback spans multiline function bodies', async () => {
    const filler = Array.from({ length: 2500 }, (_, index) => `def filler_${index}():\n    return ${index}`).join('\n\n');
    const code = [
        filler,
        'def _attach_entry_telemetry(',
        '    trade: Any,',
        '    signal: Any | None = None,',
        '    entry_decision: EntryDecision | None = None,',
        '    pending: Any | None = None,',
        ') -> None:',
        '    if trade is None:',
        '        return',
        '',
        '    telemetry = build_entry_telemetry(',
        '        signal=signal,',
        '        entry_decision=entry_decision,',
        '        pending=pending,',
        '    )',
        '    trade.entry_telemetry_status = telemetry.status',
        '',
        'def next_phase():',
        '    return True',
    ].join('\n');

    const splitter = new AstCodeSplitter();
    const chunks = await splitter.split(code, 'python', 'src/phases.py');
    const target = chunks.find((chunk) => String(chunk.metadata.symbolLabel || '').includes('_attach_entry_telemetry'));

    assert.ok(target);
    assert.ok(target.content.includes('build_entry_telemetry('));
    assert.ok(target.metadata.endLine > target.metadata.startLine + 5);
    assert.equal(target.content.includes('def next_phase'), false);
});

test('AstCodeSplitter does not borrow overlap from a previous Python symbol into the next symbol start', async () => {
    const lines = [
        'def previous_phase():',
        '    return _rename_outputs("previous")',
        '',
        'def _attach_entry_telemetry(',
        '    trade: Any,',
        '    signal: Any | None = None,',
        '    entry_decision: EntryDecision | None = None,',
        '    pending: Any | None = None,',
        ') -> None:',
        '    telemetry = build_entry_telemetry(',
        '        signal=signal,',
        '        entry_decision=entry_decision,',
        '        pending=pending,',
        '    )',
        '    trade.entry_telemetry_status = telemetry.status',
    ];
    const splitter = new AstCodeSplitter(140, 48);
    const chunks = await splitter.split(lines.join('\n'), 'python', 'src/phases.py');
    const target = chunks.find((chunk) => chunk.metadata.symbolLabel === 'function _attach_entry_telemetry( trade: Any, signal: Any | None = None, entry_decision: EntryDecision | None = None, pending: Any | None = None, ) -> None');

    assert.ok(target);
    assert.equal(target.metadata.startLine, 4);
    assert.match(target.content, /^def _attach_entry_telemetry\(/);
    assert.doesNotMatch(target.content, /_rename_outputs\("previous"\)/);
});

test('AstCodeSplitter compacts Python AST multiline signatures into complete labels', async () => {
    const code = [
        'def multiline_owner(',
        '    first: str,',
        '    second: int,',
        ') -> str:',
        '    return first',
    ].join('\n');

    const splitter = new AstCodeSplitter();
    const chunks = await splitter.split(code, 'python', 'src/small.py');

    assert.ok(chunks.some((chunk) => (
        chunk.metadata.symbolLabel === 'function multiline_owner( first: str, second: int, ) -> str'
    )));
});

test('AstCodeSplitter legacy production parser languages have no-crash fixtures', async () => {
    const splitter = new AstCodeSplitter();
    const fixtures = [
        {
            language: 'java',
            filePath: 'src/Main.java',
            code: [
                'class Main {',
                '    Main() {}',
                '    void run() {}',
                '}',
            ].join('\n'),
        },
        {
            language: 'cpp',
            filePath: 'src/main.cpp',
            code: [
                'class Worker {',
                'public:',
                '    void run() {}',
                '};',
                'int main() { return 0; }',
            ].join('\n'),
        },
        {
            language: 'csharp',
            filePath: 'src/Program.cs',
            code: [
                'class Program {',
                '    Program() {}',
                '    void Run() {}',
                '}',
            ].join('\n'),
        },
        {
            language: 'scala',
            filePath: 'src/Main.scala',
            code: [
                'class Worker {',
                '  def run(): Unit = {}',
                '}',
            ].join('\n'),
        },
    ];

    for (const fixture of fixtures) {
        const chunks = await splitter.split(fixture.code, fixture.language, fixture.filePath);
        assert.ok(chunks.length > 0, fixture.language);
        assert.ok(chunks.every((chunk) => chunk.metadata.language === fixture.language), fixture.language);
    }
});
