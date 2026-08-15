import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Utf8SourceMap } from '../../language-analysis/source-map';
import { WasmSemanticEngine } from './wasm-engine';

test('UTF-8 multi-byte span parity: byte offsets and SourceMap match across multi-byte characters', async () => {
    const engine = await WasmSemanticEngine.create();
    const session = await engine.createSession('go');

    // Multi-byte characters in comments, strings, identifiers
    const goSrc = `package main

// 世界 (World in Chinese - 6 bytes)
// 🚀 (Rocket emoji - 4 bytes)
func こんにちは(msg string) string {
    return msg + " 世界"
}

type User struct {
    Name string
}

func (u *User) Greet(greeting string) string {
    return greeting + " " + u.Name
}

func main() {
    _ = こんにちは("hello")
    u := &User{Name: "Antigravity"}
    _ = u.Greet("Hi")
}
`;
    session.addSource('utf8.go', goSrc);
    const results = await session.resolve();

    assert.ok(results.length >= 2, `Expected at least 2 resolved calls, saw ${results.length}`);

    const sourceMap = new Utf8SourceMap(goSrc);
    const srcBytes = Buffer.from(goSrc, 'utf8');

    for (const res of results) {
        // Verify call occurrence byte span
        assert.ok(res.callStartByte >= 0);
        assert.ok(res.callEndByte > res.callStartByte);
        assert.ok(res.callEndByte <= srcBytes.length);

        const callSpan = sourceMap.span(res.callStartByte, res.callEndByte);
        assert.ok(callSpan.startLine >= 1);
        assert.ok(callSpan.endLine >= callSpan.startLine);
        assert.equal(callSpan.startByte, res.callStartByte);
        assert.equal(callSpan.endByte, res.callEndByte);

        // Verify target definition byte span
        if (res.targetStartByte !== undefined && res.targetEndByte !== undefined) {
            assert.ok(res.targetStartByte >= 0);
            assert.ok(res.targetEndByte > res.targetStartByte);
            assert.ok(res.targetEndByte <= srcBytes.length);

            const targetSpan = sourceMap.span(res.targetStartByte, res.targetEndByte);
            assert.ok(targetSpan.startLine >= 1);
            assert.ok(targetSpan.endLine >= targetSpan.startLine);
            assert.equal(targetSpan.startByte, res.targetStartByte);
            assert.equal(targetSpan.endByte, res.targetEndByte);
        }
    }

    session.destroy();
});
