import assert from 'node:assert/strict';
import test from 'node:test';

import {
    PYTHON_STRUCTURAL_ANALYSIS_VERSION,
    analyzePythonSymbolStructure,
} from './tree-sitter-adapter';
import { createLanguageAnalysisService } from './service';

async function extractedPythonSymbol(
    content: string,
    qualifiedName: string,
) {
    const result = await createLanguageAnalysisService().analyze({
        content,
        language: 'python',
        relativePath: 'src/analysis.py',
    });
    assert.equal(result.structuralStatus, 'complete');
    const symbol = result.symbols.find((candidate) => candidate.qualifiedName === qualifiedName);
    assert.ok(symbol);
    return symbol;
}

test('Python imports distinguish TYPE_CHECKING consequences from runtime alternatives', async () => {
    const result = await createLanguageAnalysisService().analyze({
        language: 'python',
        relativePath: 'pkg/app.py',
        content: [
            'from typing import TYPE_CHECKING',
            'import typing as t',
            'if TYPE_CHECKING:',
            '    from .models import Widget',
            '    if enabled:',
            '        import pkg.helpers as helpers',
            'else:',
            '    from .runtime import Widget',
            'if t.TYPE_CHECKING:',
            '    import pkg.models',
            'elif enabled:',
            '    import pkg.fallback',
            'else:',
            '    import pkg.runtime',
            'def run():',
            '    if typing.TYPE_CHECKING:',
            '        from .helpers import helper',
            '    else:',
            '        import pkg.live',
        ].join('\n'),
    });

    assert.deepEqual(result.moduleBindings.filter((binding) => binding.kind === 'import').map((binding) => [
        binding.moduleSpecifier,
        binding.typeOnly,
    ]).sort(([left], [right]) => String(left).localeCompare(String(right))), [
        ['.helpers', true],
        ['.models', true],
        ['.runtime', false],
        ['pkg.fallback', false],
        ['pkg.helpers', true],
        ['pkg.live', false],
        ['pkg.models', true],
        ['pkg.runtime', false],
        ['typing', false],
        ['typing', false],
    ]);
});

test('Python structural v1 reports deterministic callable syntax and complexity', async () => {
    const content = [
        '@trace',
        'async def analyze(',
        '    self,',
        '    value: int,',
        '    /,',
        '    *items: str,',
        '    flag=True,',
        '    **options,',
        ') -> list[str]:',
        '    flattened = [item for group in items for item in group if item]',
        '    if value > 0 and flag:',
        '        for item in items:',
        '            while item:',
        '                break',
        '    elif options:',
        '        try:',
        '            use(options)',
        '        except ValueError:',
        '            recover()',
        '    match value:',
        '        case 0:',
        '            reset()',
        '        case _:',
        '            keep()',
        '    def nested(ignored):',
        '        for value in ignored:',
        '            use(value)',
        '    return flattened if flag else []',
        '',
    ].join('\n');
    const symbol = await extractedPythonSymbol(content, 'analyze');

    const result = await analyzePythonSymbolStructure({
        content,
        symbol: {
            kind: symbol.kind,
            name: symbol.name ?? '',
            qualifiedName: symbol.qualifiedName ?? '',
            span: symbol.span,
        },
    });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.analysis.analysisVersion, PYTHON_STRUCTURAL_ANALYSIS_VERSION);
    assert.equal(result.analysis.sourceBinding, 'current_source');
    assert.deepEqual(result.analysis.metrics.parameterCount, {
        derivationKind: 'exact_syntax',
        availability: 'available',
        value: 5,
    });
    assert.deepEqual(result.analysis.metrics.loopCount, {
        derivationKind: 'structural_metric',
        availability: 'available',
        value: 4,
    });
    assert.deepEqual(result.analysis.metrics.maxLoopDepth, {
        derivationKind: 'structural_metric',
        availability: 'available',
        value: 2,
    });
    assert.deepEqual(result.analysis.metrics.cyclomaticComplexity, {
        derivationKind: 'structural_metric',
        availability: 'available',
        value: 13,
    });
    assert.equal(
        result.analysis.metrics.signature.value,
        [
            'async def analyze(',
            '    self,',
            '    value: int,',
            '    /,',
            '    *items: str,',
            '    flag=True,',
            '    **options,',
            ') -> list[str]:',
        ].join('\n'),
    );
    assert.equal(result.analysis.metrics.declaredReturnType.value, 'list[str]');
});

test('Python structural v1 distinguishes zero and absent return syntax', async () => {
    const content = 'def zero():\n    return None\n';
    const symbol = await extractedPythonSymbol(content, 'zero');

    const result = await analyzePythonSymbolStructure({
        content,
        symbol: {
            kind: symbol.kind,
            name: symbol.name ?? '',
            qualifiedName: symbol.qualifiedName ?? '',
            span: symbol.span,
        },
    });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.analysis.metrics.parameterCount.value, 0);
    assert.equal(result.analysis.metrics.loopCount.value, 0);
    assert.equal(result.analysis.metrics.maxLoopDepth.value, 0);
    assert.equal(result.analysis.metrics.cyclomaticComplexity.value, 1);
    assert.equal(result.analysis.metrics.declaredReturnType.availability, 'available');
    assert.equal(result.analysis.metrics.declaredReturnType.value, null);
});

test('Python structural v1 fails closed for unsupported symbols and stale identity', async () => {
    const content = 'def owner(value):\n    return value\n';
    const symbol = await extractedPythonSymbol(content, 'owner');

    assert.deepEqual(await analyzePythonSymbolStructure({
        content,
        symbol: {
            kind: 'class',
            name: symbol.name ?? '',
            qualifiedName: symbol.qualifiedName ?? '',
            span: symbol.span,
        },
    }), {
        status: 'unavailable',
        reason: 'unsupported_symbol_kind',
    });

    assert.deepEqual(await analyzePythonSymbolStructure({
        content,
        symbol: {
            kind: symbol.kind,
            name: symbol.name ?? '',
            qualifiedName: symbol.qualifiedName ?? '',
            span: {
                ...symbol.span,
                startByte: (symbol.span.startByte ?? 0) + 1,
            },
        },
    }), {
        status: 'unavailable',
        reason: 'symbol_not_found',
    });
});

test('Python structural v1 resolves decorated duplicate method names by canonical qualified identity', async () => {
    const content = [
        '# π keeps byte and character offsets distinct',
        'class Alpha:',
        '    @trace',
        '    def run(self, value, /, *, flag=False, **options):',
        '        return value if flag else options',
        '',
        'class Beta:',
        '    def run(self):',
        '        return None',
        '',
    ].join('\n');
    const symbol = await extractedPythonSymbol(content, 'Alpha.run');

    const result = await analyzePythonSymbolStructure({
        content,
        symbol: {
            kind: symbol.kind,
            name: symbol.name ?? '',
            qualifiedName: symbol.qualifiedName ?? '',
            span: symbol.span,
        },
    });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.analysis.metrics.parameterCount.value, 4);
    assert.equal(
        result.analysis.metrics.signature.value,
        'def run(self, value, /, *, flag=False, **options):',
    );
    assert.equal(result.analysis.metrics.cyclomaticComplexity.value, 2);
});

test('Python structural v1 keeps Unicode byte spans and signature text coherent', async () => {
    const content = [
        '# λ before the selected symbol',
        'def café(π: list[str], *, naïve=True) -> dict[str, str]:',
        '    return {"π": str(naïve)}',
        '',
    ].join('\n');
    const symbol = await extractedPythonSymbol(content, 'café');
    const result = await analyzePythonSymbolStructure({
        content,
        symbol: {
            kind: symbol.kind,
            name: symbol.name ?? '',
            qualifiedName: symbol.qualifiedName ?? '',
            span: symbol.span,
        },
    });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.analysis.metrics.parameterCount.value, 2);
    assert.equal(
        result.analysis.metrics.signature.value,
        'def café(π: list[str], *, naïve=True) -> dict[str, str]:',
    );
    assert.equal(
        result.analysis.metrics.declaredReturnType.value,
        'dict[str, str]',
    );
});

test('Python structural v1 freezes isolated decision and loop counting rules', async () => {
    const fixtures = [
        {
            name: 'plain_for',
            body: ['for item in values:', '    use(item)'],
            loopCount: 1,
            loopDepth: 1,
            complexity: 2,
        },
        {
            name: 'nested_while_for',
            body: ['while ready:', '    for item in values:', '        use(item)'],
            loopCount: 2,
            loopDepth: 2,
            complexity: 3,
        },
        {
            name: 'comprehension',
            body: ['return [item for group in values for item in group if item]'],
            loopCount: 2,
            loopDepth: 2,
            complexity: 4,
        },
        {
            name: 'branches',
            body: [
                'if first and second or third:',
                '    return 1',
                'elif fourth:',
                '    return 2',
                'return 0',
            ],
            loopCount: 0,
            loopDepth: 0,
            complexity: 5,
        },
        {
            name: 'exceptions',
            body: [
                'try:',
                '    use(values)',
                'except ValueError:',
                '    recover()',
                'except TypeError:',
                '    recover()',
            ],
            loopCount: 0,
            loopDepth: 0,
            complexity: 3,
        },
        {
            name: 'match_cases',
            body: [
                'match value:',
                '    case 1:',
                '        return True',
                '    case _:',
                '        return False',
            ],
            loopCount: 0,
            loopDepth: 0,
            complexity: 3,
        },
    ] as const;

    for (const fixture of fixtures) {
        const content = [
            `def ${fixture.name}(values=None, ready=True, first=True, second=True, third=False, fourth=False, value=0):`,
            ...fixture.body.map((line) => `    ${line}`),
            '',
        ].join('\n');
        const symbol = await extractedPythonSymbol(content, fixture.name);
        const result = await analyzePythonSymbolStructure({
            content,
            symbol: {
                kind: symbol.kind,
                name: symbol.name ?? '',
                qualifiedName: symbol.qualifiedName ?? '',
                span: symbol.span,
            },
        });
        assert.equal(result.status, 'ok', fixture.name);
        if (result.status !== 'ok') continue;
        assert.equal(result.analysis.metrics.loopCount.value, fixture.loopCount, fixture.name);
        assert.equal(result.analysis.metrics.maxLoopDepth.value, fixture.loopDepth, fixture.name);
        assert.equal(
            result.analysis.metrics.cyclomaticComplexity.value,
            fixture.complexity,
            fixture.name,
        );
    }
});

test('Python structural v1 excludes every nested scope and fails closed on unrelated syntax errors', async () => {
    const content = [
        'def owner(values):',
        '    nested_lambda = lambda: [item for item in values]',
        '    def nested():',
        '        while True:',
        '            break',
        '    class Nested:',
        '        def method(self):',
        '            for item in values:',
        '                use(item)',
        '    return nested_lambda()',
        '',
    ].join('\n');
    const symbol = await extractedPythonSymbol(content, 'owner');
    const result = await analyzePythonSymbolStructure({
        content,
        symbol: {
            kind: symbol.kind,
            name: symbol.name ?? '',
            qualifiedName: symbol.qualifiedName ?? '',
            span: symbol.span,
        },
    });

    assert.equal(result.status, 'ok');
    if (result.status === 'ok') {
        assert.equal(result.analysis.metrics.loopCount.value, 0);
        assert.equal(result.analysis.metrics.maxLoopDepth.value, 0);
        assert.equal(result.analysis.metrics.cyclomaticComplexity.value, 1);
    }

    const invalidContent = `${content}\ndef broken(:\n`;
    assert.deepEqual(await analyzePythonSymbolStructure({
        content: invalidContent,
        symbol: {
            kind: symbol.kind,
            name: symbol.name ?? '',
            qualifiedName: symbol.qualifiedName ?? '',
            span: symbol.span,
        },
    }), {
        status: 'unavailable',
        reason: 'syntax_error',
    });
});
