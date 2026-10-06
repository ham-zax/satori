import assert from "node:assert/strict";
import test from "node:test";
import type { FileOutlineResponseEnvelope } from "../core/search-types.js";
import { readCompleteFileOutline } from "./detect_changes.js";

const symbol = (symbolId: string, startLine: number, endLine: number) => ({
    symbolId, symbolLabel: symbolId, kind: "method", language: "typescript", file: "big.ts", span: { startLine, endLine },
});

test("readCompleteFileOutline follows nextPage so members of a large class reach change seeding", async () => {
    const pages = new Map<number | undefined, FileOutlineResponseEnvelope>([
        [undefined, { status: "ok", path: "/r", file: "big.ts", hasMore: true,
            outline: { symbols: [symbol("Big", 1, 900), symbol("first", 2, 10)] },
            hints: { nextPage: { tool: "file_outline", args: { start_line: 500 } } } } as unknown as FileOutlineResponseEnvelope],
        [500, { status: "ok", path: "/r", file: "big.ts", hasMore: false,
            outline: { symbols: [symbol("Big", 1, 900), symbol("edited", 500, 520)] } } as unknown as FileOutlineResponseEnvelope],
    ]);
    const requested: Array<number | undefined> = [];
    const merged = await readCompleteFileOutline(async startLine => {
        requested.push(startLine);
        return pages.get(startLine)!;
    });

    assert.deepEqual(requested, [undefined, 500]);
    assert.deepEqual(merged.outline?.symbols.map(entry => entry.symbolId), ["Big", "first", "edited"]);
    assert.equal(merged.hasMore, false);
});
