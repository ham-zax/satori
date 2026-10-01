import assert from "node:assert/strict";
import test from "node:test";
import type { SymbolRecord, SymbolRegistry } from "@satori-code/core";
import { buildSearchRerankSourceReferences } from "./search-rerank-source-references.js";

function fixture(newline = "\n") {
    const source = ["function compareInputs() {}", "function updateMemo() { compareInputs(deps); }",
        "function updateCallback() { compareInputs(deps); }", "function updateOther() { compareInputs(deps); }",
        "function updateEffect() { compareInputs(deps); }", "function shadow(compareInputs) { compareInputs(); }",
        "function comment() { /* compareInputs is mentioned */ }",
        "function partial() { compareInputsExtended(); }"].join(newline);
    const symbols = ["compareInputs", "updateMemo", "updateCallback", "updateOther", "updateEffect", "shadow", "comment", "partial"]
        .map((name, index) => ({ name, label: `function ${name}`, file: "src/hooks.js", fileHash: "hash",
            symbolInstanceId: name, kind: "function", span: { startLine: index + 1, endLine: index + 1 } }) as SymbolRecord);
    return { source, symbols, registry: { symbolsByFile: new Map([["src/hooks.js", symbols]]) } as SymbolRegistry };
}

test("query-conditioned textual references preserve exact source without claiming resolved callers", () => {
    for (const newline of ["\n", "\r\n"]) {
        const f = fixture(newline);
        const refs = buildSearchRerankSourceReferences({ ...f, owner: f.symbols[0], sourceStartLine: 1,
            observedHash: "hash", query: "useEffect dependencies" });
        assert.equal(refs.length, 3);
        assert.equal(refs[0].containing_symbol_label, "function updateEffect");
        assert.equal(refs[0].source_line, 5);
        assert.equal(refs[0].reference_source_excerpt, "function updateEffect() { compareInputs(deps); }");
        assert.equal("relation" in refs[0], false);
    }
});

test("textual references fail closed on source hash mismatch and name fragments", () => {
    const f = fixture();
    assert.deepEqual(buildSearchRerankSourceReferences({ ...f, owner: f.symbols[0], sourceStartLine: 1,
        observedHash: "changed", query: "partial" }), []);
    const refs = buildSearchRerankSourceReferences({ ...f, owner: f.symbols[0], sourceStartLine: 1,
        observedHash: "hash", query: "partial shadow comment" });
    assert.ok(refs.some((ref) => ref.containing_symbol_label === "function shadow"));
    assert.ok(refs.some((ref) => ref.containing_symbol_label === "function comment"));
    assert.ok(refs.every((ref) => ref.containing_symbol_label !== "function partial"));
});
