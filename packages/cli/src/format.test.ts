import test from "node:test";
import assert from "node:assert/strict";
import { formatToolResultText, formatToolsListText } from "./format.js";

test("formatToolsListText aligns names with each tool's first description sentence", () => {
    const text = formatToolsListText({
        tools: [
            { name: "list_codebases", description: "List indexed codebases.  Second sentence\nis dropped." },
            { name: "search_codebase", description: "Search a codebase. More detail." },
            { name: "no_description" },
        ],
    });
    assert.equal(text, [
        "list_codebases   List indexed codebases.",
        "search_codebase  Search a codebase.",
        "no_description",
        "",
        "Use --format json for full tool descriptions and input schemas.",
        "",
    ].join("\n"));
});

test("formatToolsListText truncates long lines to the requested width and tolerates malformed results", () => {
    const text = formatToolsListText({ tools: [{ name: "t", description: "x".repeat(200) }] }, 40);
    const [line] = text.split("\n");
    assert.equal(line?.length, 40);
    assert.equal(line?.endsWith("…"), true);
    assert.match(formatToolsListText(null), /^\nUse --format json/);
});

function textResult(text: string) {
    return { isError: false, content: [{ type: "text", text }] };
}

test("formatToolResultText prefers a payload's humanText", () => {
    const payload = { status: "ok", humanText: "Indexed 3 files.", detail: { a: 1 } };
    assert.equal(formatToolResultText(textResult(JSON.stringify(payload))), "Indexed 3 files.\n");
});

test("formatToolResultText pretty-prints JSON payloads without humanText", () => {
    assert.equal(
        formatToolResultText(textResult(JSON.stringify({ status: "ok", n: 1 }))),
        '{\n  "status": "ok",\n  "n": 1\n}\n',
    );
});

test("formatToolResultText passes plain text through and falls back to JSON without text content", () => {
    assert.equal(formatToolResultText(textResult("started indexing")), "started indexing\n");
    assert.equal(formatToolResultText(textResult("already terminated\n")), "already terminated\n");
    assert.equal(formatToolResultText({ content: [] }), '{\n  "content": []\n}\n');
});
