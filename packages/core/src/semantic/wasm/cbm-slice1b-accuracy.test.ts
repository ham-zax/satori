import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WasmSemanticProjectAnalyzer } from './wasm-analyzer';
import { WasmSemanticEngine } from './wasm-engine';

const enginePromise = WasmSemanticEngine.create();
const analyzer = new WasmSemanticProjectAnalyzer(() => enginePromise);

function src(path: string, source: string) {
    return { path, source, sourceHash: `hash:${path}` };
}

function aux(role: string, path: string, source: string) {
    return { role, path, source, sourceHash: `hash:${path}` };
}

test('Slice 1B Go: cross-file embedded struct promotion resolves o.Hello()', async () => {
    const res = await analyzer.analyze({
        language: 'go',
        auxiliaryFiles: [aux('manifest', 'go.mod', 'module example.com/app\n\ngo 1.22\n')],
        sourceFiles: [
            src('base/base.go', 'package base\ntype Base struct{}\nfunc (b Base) Hello() int { return 1 }\n'),
            src(
                'app/app.go',
                [
                    'package app',
                    'import "example.com/app/base"',
                    'type Outer struct {',
                    '\tbase.Base',
                    '}',
                    'func Run(o Outer) int {',
                    '\treturn o.Hello()',
                    '}',
                ].join('\n') + '\n',
            ),
        ],
    });
    const occs = res.occurrencesByFile.get('app/app.go') ?? [];
    assert.ok(
        occs.some(
            (o) =>
                o.decision === 'resolved' &&
                o.targetProvenance?.file === 'base/base.go' &&
                o.targetProvenance?.name === 'Hello',
        ),
        `expected o.Hello() to resolve to base/base.go Hello, got ${JSON.stringify(occs)}`,
    );
});

test('Slice 1B Go: cross-file package-level var/const typing resolves pkg.Default.Get() without treating var as callable', async () => {
    const res = await analyzer.analyze({
        language: 'go',
        auxiliaryFiles: [aux('manifest', 'go.mod', 'module example.com/app\n\ngo 1.22\n')],
        sourceFiles: [
            src(
                'cfg/cfg.go',
                [
                    'package cfg',
                    'type Client struct{}',
                    'func (c Client) Get() int { return 7 }',
                    'var Default = Client{}',
                    'var FnVal func()',
                ].join('\n') + '\n',
            ),
            src(
                'app/app.go',
                [
                    'package app',
                    'import "example.com/app/cfg"',
                    'func Run() int {',
                    '\tcfg.FnVal()',
                    '\treturn cfg.Default.Get()',
                    '}',
                ].join('\n') + '\n',
            ),
        ],
    });
    const occs = res.occurrencesByFile.get('app/app.go') ?? [];
    assert.ok(
        occs.some(
            (o) =>
                o.decision === 'resolved' &&
                o.targetProvenance?.file === 'cfg/cfg.go' &&
                o.targetProvenance?.name === 'Get',
        ),
        `expected cfg.Default.Get() to resolve to cfg/cfg.go Get, got ${JSON.stringify(occs)}`,
    );
    assert.equal(
        occs.some((o) => o.decision === 'resolved' && o.targetProvenance?.name === 'FnVal'),
        false,
        'package-level var FnVal must not resolve as a direct callable definition',
    );
});

test('Slice 1B Go: closure parameters in composite literal field bind receiver calls', async () => {
    const res = await analyzer.analyze({
        language: 'go',
        auxiliaryFiles: [aux('manifest', 'go.mod', 'module example.com/app\n\ngo 1.22\n')],
        sourceFiles: [
            src(
                'app/app.go',
                [
                    'package app',
                    'type Registry struct{}',
                    'func (r *Registry) Register() {}',
                    'type Entry struct { run func(reg *Registry) }',
                    'func Suite() Entry {',
                    '\treturn Entry{',
                    '\t\trun: func(reg *Registry) {',
                    '\t\t\treg.Register()',
                    '\t\t},',
                    '\t}',
                    '}',
                ].join('\n') + '\n',
            ),
        ],
    });
    const occs = res.occurrencesByFile.get('app/app.go') ?? [];
    assert.ok(
        occs.some(
            (o) =>
                o.decision === 'resolved' &&
                o.targetProvenance?.file === 'app/app.go' &&
                o.targetProvenance?.name === 'Register',
        ),
        `expected reg.Register() inside struct literal closure to resolve, got ${JSON.stringify(occs)}`,
    );
});

test('Slice 1B Go: block-scoped local type shadows package type only in its block', async () => {
    const source = [
        'package app',
        'type T struct{}',
        'func (T) Ping() int { return 1 }',
        'func F(cond bool) int {',
        '\tif cond {',
        '\t\ttype T struct{}',
        '\t\tvar localT T',
        '\t\t_ = localT.Ping()',
        '\t}',
        '\tvar pkgT T',
        '\treturn pkgT.Ping()',
        '}',
    ].join('\n') + '\n';
    const res = await analyzer.analyze({
        language: 'go',
        auxiliaryFiles: [aux('manifest', 'go.mod', 'module example.com/app\n\ngo 1.22\n')],
        sourceFiles: [src('app/app.go', source)],
    });
    const occs = res.occurrencesByFile.get('app/app.go') ?? [];
    const localLine = source.indexOf('localT.Ping()');
    const pkgLine = source.indexOf('pkgT.Ping()');
    assert.equal(
        occs.some((o) => o.callSpan.startByte >= localLine && o.callSpan.startByte < localLine + 20 && o.decision === 'resolved'),
        false,
        `inner block localT.Ping() must abstain because local type T shadows package T, got ${JSON.stringify(occs)}`,
    );
    assert.ok(
        occs.some(
            (o) =>
                o.callSpan.startByte >= pkgLine &&
                o.decision === 'resolved' &&
                o.targetProvenance?.file === 'app/app.go' &&
                o.targetProvenance?.name === 'Ping',
        ),
        `expected pkgT.Ping() after inner block local type T to resolve, got ${JSON.stringify(occs)}`,
    );
});

test('Slice 1B Go: cross-file type alias resolves method calls', async () => {
    const res = await analyzer.analyze({
        language: 'go',
        auxiliaryFiles: [aux('manifest', 'go.mod', 'module example.com/app\n\ngo 1.22\n')],
        sourceFiles: [
            src('pkg/base.go', 'package pkg\ntype Target struct{}\nfunc (Target) Act() int { return 1 }\n'),
            src('pkg/alias.go', 'package pkg\ntype Alias = Target\n'),
            src(
                'cmd/main.go',
                [
                    'package main',
                    'import "example.com/app/pkg"',
                    'func Run(a pkg.Alias) int {',
                    '\treturn a.Act()',
                    '}',
                ].join('\n') + '\n',
            ),
        ],
    });
    const occs = res.occurrencesByFile.get('cmd/main.go') ?? [];
    assert.ok(
        occs.some(
            (o) =>
                o.decision === 'resolved' &&
                o.targetProvenance?.file === 'pkg/base.go' &&
                o.targetProvenance?.name === 'Act',
        ),
        `expected a.Act() via cross-file type alias to resolve, got ${JSON.stringify(occs)}`,
    );
});

test('Slice 1B Go: bare init() never binds to package init() and multi-file init() resolves outbound calls', async () => {
    const res = await analyzer.analyze({
        language: 'go',
        auxiliaryFiles: [aux('manifest', 'go.mod', 'module example.com/app\n\ngo 1.22\n')],
        sourceFiles: [
            src(
                'pkg/a.go',
                [
                    'package pkg',
                    'func Helper() {}',
                    'func init() { Helper() }',
                ].join('\n') + '\n',
            ),
            src(
                'pkg/b.go',
                [
                    'package pkg',
                    'func Run() {',
                    '\tinit := func() {}',
                    '\tinit()',
                    '}',
                    'func DirectBare() {',
                    '\tinit()',
                    '}',
                ].join('\n') + '\n',
            ),
        ],
    });
    const aOccs = res.occurrencesByFile.get('pkg/a.go') ?? [];
    const bOccs = res.occurrencesByFile.get('pkg/b.go') ?? [];
    assert.ok(aOccs.some((o) => o.decision === 'resolved' && o.targetProvenance?.name === 'Helper'));
    assert.equal(
        bOccs.some((o) => o.decision === 'resolved' && o.targetProvenance?.name === 'init'),
        false,
        `bare init() call must never resolve to package init(), got ${JSON.stringify(bOccs)}`,
    );
});

test('Slice 1B Java: proven-external receiver suppresses short-name guesses and own-package shadows java.lang', async () => {
    const res = await analyzer.analyze({
        language: 'java',
        auxiliaryFiles: [aux('manifest', 'pom.xml', '<project/>')],
        sourceFiles: [
            src(
                'src/com/acme/Seen.java',
                [
                    'package com.acme;',
                    'public record Seen(boolean nonNull) {',
                    '  public static void check() {}',
                    '}',
                ].join('\n') + '\n',
            ),
            src(
                'src/com/acme/Enum.java',
                [
                    'package com.acme;',
                    'public class Enum {',
                    '  public static void verify() {}',
                    '}',
                ].join('\n') + '\n',
            ),
            src(
                'src/com/acme/Caller.java',
                [
                    'package com.acme;',
                    'import java.util.List;',
                    'import java.util.Objects;',
                    'import org.external.Client;',
                    'public class Caller {',
                    '  public void run(Object o, List<String> xs, Client c) {',
                    '    Objects.nonNull(o);',
                    '    xs.size();',
                    '    c.check();',
                    '    Enum.verify();',
                    '  }',
                    '}',
                ].join('\n') + '\n',
            ),
        ],
    });
    const occs = res.occurrencesByFile.get('src/com/acme/Caller.java') ?? [];
    const externalCalls = occs.filter(
        (o) =>
            o.targetProvenance?.name === 'nonNull' ||
            o.targetProvenance?.name === 'size' ||
            o.targetProvenance?.name === 'check',
    );
    assert.equal(
        externalCalls.some((o) => o.decision === 'resolved'),
        false,
        `proven-external Java calls must never resolve to project symbols: ${JSON.stringify(externalCalls)}`,
    );
    const verifyCall = occs.find(
        (o) =>
            o.decision === 'resolved' &&
            o.targetProvenance?.file === 'src/com/acme/Enum.java' &&
            o.targetProvenance?.name === 'verify',
    );
    assert.ok(verifyCall, `own-package Enum must shadow java.lang.Enum, got ${JSON.stringify(occs)}`);
    // Specifically check Objects.nonNull and c.check() did not emit type_dispatch/direct_call
    const callerSrc = 'package com.acme;\nimport java.util.List;\nimport java.util.Objects;\nimport org.external.Client;\npublic class Caller {\n  public void run(Object o, List<String> xs, Client c) {\n    Objects.nonNull(o);\n    xs.size();\n    c.check();\n    Enum.verify();\n  }\n}\n';
    const checkStart = callerSrc.indexOf('c.check()');
    const cCheck = occs.find((o) => o.callSpan.startByte >= checkStart && o.callSpan.startByte < checkStart + 10);
    assert.equal(
        cCheck?.proof.strategy,
        'unknown',
        `proven-external c.check() must have strategy unknown (lsp_external), got ${JSON.stringify(cCheck)}`,
    );
});

test('Slice 1B C#: >256 namespace blocks before using static and nested type qualifier new Command.Result()', async () => {
    const manyNamespaces = Array.from({ length: 300 }, (_, i) => `namespace N${i} { class D${i} {} }`).join('\n');
    const res = await analyzer.analyze({
        language: 'csharp',
        auxiliaryFiles: [aux('manifest', 'App.csproj', '<Project Sdk="Microsoft.NET.Sdk"/>')],
        sourceFiles: [
            src(
                'Helpers.cs',
                [
                    'namespace Helpers {',
                    '  public static class MathEx {',
                    '    public static int Sqrt(int x) { return x; }',
                    '  }',
                    '}',
                ].join('\n') + '\n',
            ),
            src(
                'Command.cs',
                [
                    'namespace App {',
                    '  public class Command {',
                    '    public class Result {',
                    '      public int Code() { return 0; }',
                    '    }',
                    '  }',
                    '}',
                ].join('\n') + '\n',
            ),
            src(
                'Runner.cs',
                [
                    manyNamespaces,
                    'namespace App {',
                    '  using static Helpers.MathEx;',
                    '  public class Runner {',
                    '    public int Run() {',
                    '      var r = new Command.Result();',
                    '      r.Code();',
                    '      return Sqrt(4);',
                    '    }',
                    '  }',
                    '}',
                ].join('\n') + '\n',
            ),
        ],
    });
    const occs = res.occurrencesByFile.get('Runner.cs') ?? [];
    assert.ok(
        occs.some(
            (o) =>
                o.decision === 'resolved' &&
                o.targetProvenance?.file === 'Helpers.cs' &&
                o.targetProvenance?.name === 'Sqrt',
        ),
        `expected using static Sqrt after 300 namespaces to resolve, got ${JSON.stringify(occs)}`,
    );
    assert.ok(
        occs.some(
            (o) =>
                o.decision === 'resolved' &&
                o.targetProvenance?.file === 'Command.cs' &&
                o.targetProvenance?.name === 'Code',
        ),
        `expected new Command.Result().Code() to resolve via nested type qualifier, got ${JSON.stringify(occs)}`,
    );
});

test('Slice 1B C#: global-namespace spec order, no global partial twins, and cyclic alias termination', async () => {
    const res = await analyzer.analyze({
        language: 'csharp',
        auxiliaryFiles: [aux('manifest', 'App.csproj', '<Project Sdk="Microsoft.NET.Sdk"/>')],
        sourceFiles: [
            src('GlobalHelper.cs', 'public class Helper { public static int Pick() { return 1; } }\n'),
            src('AltHelper.cs', 'namespace Alt { public class Helper { public static int Pick() { return 2; } } }\n'),
            src(
                'ParseDamaged.cs',
                [
                    'namespace Fake {',
                    '  public ref partial struct Bad { int X => 1; }',
                    '  public class Helper { public static int Pick() { return 9; } }',
                    '}',
                ].join('\n') + '\n',
            ),
            src(
                'GlobalBaseTwin.cs',
                [
                    'public class BaseSvc { public int Run() { return 1; } }',
                    'public class Svc : BaseSvc {}',
                ].join('\n') + '\n',
            ),
            src('OtherGlobalTwin.cs', 'public class Svc { public int Run() { return 2; } }\n'),
            src(
                'Caller.cs',
                [
                    'using Alt;',
                    'using Loop = Loop.Inner;',
                    'namespace Consumer {',
                    '  public class Test {',
                    '    public void Go(Svc s) {',
                    '      Helper.Pick();',
                    '      s.Run();',
                    '    }',
                    '  }',
                    '}',
                ].join('\n') + '\n',
            ),
            src(
                'NamespaceUsingCaller.cs',
                [
                    'namespace Consumer {',
                    '  using Alt;',
                    '  public class Test2 {',
                    '    public void Go() {',
                    '      Helper.Pick();',
                    '    }',
                    '  }',
                    '}',
                ].join('\n') + '\n',
            ),
        ],
    });
    const occs = res.occurrencesByFile.get('Caller.cs') ?? [];
    assert.ok(
        occs.some(
            (o) =>
                o.decision === 'resolved' &&
                o.targetProvenance?.file === 'GlobalHelper.cs' &&
                o.targetProvenance?.name === 'Pick',
        ),
        `compilation-unit using Alt must lose to global Helper per C# spec order, got ${JSON.stringify(occs)}`,
    );
    assert.ok(
        occs.some(
            (o) =>
                o.decision === 'resolved' &&
                o.targetProvenance?.file === 'GlobalBaseTwin.cs' &&
                o.targetProvenance?.name === 'Run',
        ),
        `s.Run() must resolve to GlobalBaseTwin.cs BaseSvc.Run (no global partial twins), got ${JSON.stringify(occs)}`,
    );
    const nsOccs = res.occurrencesByFile.get('NamespaceUsingCaller.cs') ?? [];
    assert.ok(
        nsOccs.some(
            (o) =>
                o.decision === 'resolved' &&
                o.targetProvenance?.file === 'AltHelper.cs' &&
                o.targetProvenance?.name === 'Pick',
        ),
        `namespace-body using Alt must beat global Helper per C# spec order, got ${JSON.stringify(nsOccs)}`,
    );
});

test('Slice 1B C/C++: CRLF line splice before cross-file call and GoogleTest TEST body calls', async () => {
    const res = await analyzer.analyze({
        language: 'cpp',
        auxiliaryFiles: [],
        sourceFiles: [
            src('inc/util.h', '#ifndef UTIL_H\n#define UTIL_H\nstruct Ops { int run(int x); };\nint helper(int x);\n#endif\n'),
            src('src/util.cpp', '#include "../inc/util.h"\nint Ops::run(int x) { return x; }\nint helper(int x) { return x + 1; }\n'),
            src(
                'src/main.cpp',
                '#include "../inc/util.h"\r\n#define MULTI "a\\\r\nb"\r\nint main() { Ops ops; return ops.run(1) + helper(1); }\r\n',
            ),
            src(
                'tests/math_test.cpp',
                '#include "../inc/util.h"\n#define TEST(a, b) void TEST_##a##_##b()\nTEST(MathSuite, Adds) {\n  helper(2);\n}\nTEST(MathSuite, Subs) {\n  helper(3);\n}\n',
            ),
        ],
    });
    const mainOccs = res.occurrencesByFile.get('src/main.cpp') ?? [];
    assert.ok(
        mainOccs.some(
            (o) =>
                o.decision === 'resolved' &&
                o.targetProvenance?.file === 'src/util.cpp' &&
                o.targetProvenance?.name === 'run',
        ),
        `CRLF splice in main.cpp must still resolve cross-file ops.run(), got ${JSON.stringify(mainOccs)}`,
    );
    const testOccs = res.occurrencesByFile.get('tests/math_test.cpp') ?? [];
    assert.ok(
        testOccs.filter(
            (o) =>
                o.decision === 'resolved' &&
                o.targetProvenance?.file === 'src/util.cpp' &&
                o.targetProvenance?.name === 'helper',
        ).length === 2,
        `GoogleTest TEST bodies must resolve both helper() calls, got ${JSON.stringify(testOccs)}`,
    );
});

test('Slice 1B PHP: inline HTML ?> ... <?php masking preserves calls after close tag', async () => {
    const res = await analyzer.analyze({
        language: 'php',
        auxiliaryFiles: [aux('manifest', 'composer.json', '{}')],
        sourceFiles: [
            src('src/target.php', '<?php\nnamespace App;\nfunction targetFn(): int { return 1; }\n'),
            src(
                'src/view.php',
                '<?php\nnamespace App;\n?>\n<div><?= "hi" ?></div>\n<?php\nfunction render(): int {\n  return targetFn();\n}\n',
            ),
        ],
    });
    const occs = res.occurrencesByFile.get('src/view.php') ?? [];
    assert.ok(
        occs.some(
            (o) =>
                o.decision === 'resolved' &&
                o.targetProvenance?.file === 'src/target.php' &&
                o.targetProvenance?.name === 'targetFn',
        ),
        `PHP call after ?> ... <?php must resolve, got ${JSON.stringify(occs)}`,
    );
});

test('Slice 1B Rust: use paths resolve inside importing crate and external imports never bind project symbols', async () => {
    const res = await analyzer.analyze({
        language: 'rust',
        auxiliaryFiles: [
            aux('manifest', 'crates/a/Cargo.toml', '[package]\nname = "crate_a"\nversion = "0.1.0"\n'),
            aux('manifest', 'crates/b/Cargo.toml', '[package]\nname = "crate_b"\nversion = "0.1.0"\n'),
        ],
        sourceFiles: [
            src('crates/a/src/lib.rs', 'pub mod util;\npub fn json() -> i32 { 1 }\n'),
            src('crates/a/src/util.rs', 'pub fn helper() -> i32 { 10 }\n'),
            src(
                'crates/a/src/main.rs',
                [
                    'use crate::util::helper;',
                    'use serde_json::json;',
                    'fn run() -> i32 {',
                    '  let _ = json();',
                    '  helper()',
                    '}',
                ].join('\n') + '\n',
            ),
            src('crates/b/src/lib.rs', 'pub mod util;\n'),
            src('crates/b/src/util.rs', 'pub fn helper() -> i32 { 20 }\n'),
            src('crates/b/src/main.rs', 'fn other() -> i32 { helper() }\n'),
        ],
    });
    const aMain = res.occurrencesByFile.get('crates/a/src/main.rs') ?? [];
    assert.ok(
        aMain.some(
            (o) =>
                o.decision === 'resolved' &&
                o.targetProvenance?.file === 'crates/a/src/util.rs' &&
                o.targetProvenance?.name === 'helper',
        ),
        `crate_a use crate::util::helper must resolve to crates/a/src/util.rs, got ${JSON.stringify(aMain)}`,
    );
    assert.equal(
        aMain.some((o) => o.decision === 'resolved' && o.targetProvenance?.name === 'json'),
        false,
        `use serde_json::json must not bind to crate_a's fn json(), got ${JSON.stringify(aMain)}`,
    );
    const bMain = res.occurrencesByFile.get('crates/b/src/main.rs') ?? [];
    assert.equal(
        bMain.some((o) => o.targetProvenance?.file === 'crates/a/src/util.rs'),
        false,
        `crate_b bare helper() must never cross-bind to crate_a, got ${JSON.stringify(bMain)}`,
    );
});

test('Slice 1B Go: multi-identifier struct field declaration allocates exact capacity and resolves all fields', async () => {
    const res = await analyzer.analyze({
        language: 'go',
        auxiliaryFiles: [aux('manifest', 'go.mod', 'module example.com/multi\n\ngo 1.22\n')],
        sourceFiles: [
            src('pkg/ops.go', 'package pkg\ntype Ops struct{}\nfunc (o *Ops) Run() int { return 1 }\n'),
            src(
                'pkg/holder.go',
                [
                    'package pkg',
                    'type Holder struct {',
                    '  a, b, c, d, e, f, g, h *Ops',
                    '}',
                    'func Use(x *Holder) int {',
                    '  return x.a.Run() + x.h.Run()',
                    '}',
                ].join('\n') + '\n',
            ),
        ],
    });
    const occs = res.occurrencesByFile.get('pkg/holder.go') ?? [];
    const hits = occs.filter(
        (o) =>
            o.decision === 'resolved' &&
            o.targetProvenance?.file === 'pkg/ops.go' &&
            o.targetProvenance?.name === 'Run',
    );
    assert.equal(hits.length, 2, `both first and 8th multi-id fields must resolve Run(), got ${JSON.stringify(occs)}`);
});

test('Slice 1B C++/PHP: masked sources without trailing newline edit virtual newline safely', async () => {
    const cppRes = await analyzer.analyze({
        language: 'cpp',
        auxiliaryFiles: [],
        sourceFiles: [
            src('inc/u.h', 'int helper(int x);\n'),
            src('src/u.cpp', '#include "../inc/u.h"\nint helper(int x) { return x + 1; }\n'),
            // No trailing newline + CRLF splice -> masked arena copy + virtual_newline edit
            src('src/no_nl.cpp', '#include "../inc/u.h"\r\n#define S "a\\\r\nb"\r\nint run() { return helper(7); }'),
        ],
    });
    const cppOccs = cppRes.occurrencesByFile.get('src/no_nl.cpp') ?? [];
    assert.ok(
        cppOccs.some(
            (o) =>
                o.decision === 'resolved' &&
                o.targetProvenance?.file === 'src/u.cpp' &&
                o.targetProvenance?.name === 'helper',
        ),
        `CRLF-masked C++ file without trailing newline must resolve helper(), got ${JSON.stringify(cppOccs)}`,
    );

    const phpRes = await analyzer.analyze({
        language: 'php',
        auxiliaryFiles: [aux('manifest', 'composer.json', '{}')],
        sourceFiles: [
            src('src/target.php', '<?php\nnamespace App;\nfunction ping(): int { return 1; }\n'),
            // No trailing newline + inline HTML -> masked arena copy + virtual_newline edit
            src('src/view.php', '<?php\nnamespace App;\n?>\n<div>x</div>\n<?php\nfunction render(): int { return ping(); }'),
        ],
    });
    const phpOccs = phpRes.occurrencesByFile.get('src/view.php') ?? [];
    assert.ok(
        phpOccs.some(
            (o) =>
                o.decision === 'resolved' &&
                o.targetProvenance?.file === 'src/target.php' &&
                o.targetProvenance?.name === 'ping',
        ),
        `HTML-masked PHP file without trailing newline must resolve ping(), got ${JSON.stringify(phpOccs)}`,
    );
});

test('Slice 1B Go: indexed population resolves many structs and type aliases without quadratic scan', async () => {
    const count = 250;
    const structs = Array.from(
        { length: count },
        (_, i) => `type S${i} struct { Base }\ntype Alias${i} = S${i}`,
    ).join('\n');
    const res = await analyzer.analyze({
        language: 'go',
        auxiliaryFiles: [aux('manifest', 'go.mod', 'module example.com/many\n\ngo 1.22\n')],
        sourceFiles: [
            src('pkg/base.go', 'package pkg\ntype Base struct{}\nfunc (b Base) Ping() int { return 1 }\n'),
            src(
                'pkg/many.go',
                `package pkg\n${structs}\nfunc Run(a Alias${count - 1}) int { return a.Ping() }\n`,
            ),
        ],
    });
    const occs = res.occurrencesByFile.get('pkg/many.go') ?? [];
    assert.ok(
        occs.some(
            (o) =>
                o.decision === 'resolved' &&
                o.targetProvenance?.file === 'pkg/base.go' &&
                o.targetProvenance?.name === 'Ping',
        ),
        `alias to 250th struct must resolve embedded Ping(), got ${JSON.stringify(occs)}`,
    );
});
