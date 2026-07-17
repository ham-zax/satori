import test from "node:test";
import assert from "node:assert/strict";
import { CapabilityResolver } from "../core/capabilities.js";
import { continueSearchTool } from "./continue_search.js";
import type { ToolContext } from "./types.js";

function buildContext(handleContinueSearch: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
}>): ToolContext {
    return {
        capabilities: new CapabilityResolver({
            name: "test",
            version: "1.0.0",
            executionProfile: "connected",
            networkPolicy: { kind: "remote-allowed" },
            vectorStoreProvider: "Milvus",
            encoderProvider: "VoyageAI",
            encoderModel: "voyage-4-large",
        }),
        toolHandlers: { handleContinueSearch },
    } as unknown as ToolContext;
}

test("continue_search validates its opaque handle and required offset before delegating", async () => {
    let calls = 0;
    const response = await continueSearchTool.execute({ handle: "invalid" }, buildContext(async () => {
        calls += 1;
        return { content: [{ type: "text", text: "unexpected" }] };
    }));

    assert.equal(response.isError, true);
    assert.match(response.content[0]?.text ?? "", /48-character lowercase hexadecimal/);
    assert.equal(calls, 0);

    const missingOffset = await continueSearchTool.execute({
        handle: "a".repeat(48),
    }, buildContext(async () => {
        calls += 1;
        return { content: [{ type: "text", text: "unexpected" }] };
    }));
    assert.equal(missingOffset.isError, true);
    assert.match(missingOffset.content[0]?.text ?? "", /expectedOffset/);
    assert.equal(calls, 0);
});

test("continue_search delegates a normalized handle and bounded page limit", async () => {
    const handle = "a".repeat(48);
    let delegated: Record<string, unknown> | undefined;
    const response = await continueSearchTool.execute({
        handle: `  ${handle}  `,
        expectedOffset: 1,
        limit: 3,
    }, buildContext(async (args) => {
        delegated = args;
        return { content: [{ type: "text", text: "ok" }] };
    }));

    assert.equal(response.isError, undefined);
    assert.equal(response.content[0]?.text, "ok");
    assert.deepEqual(delegated, { handle, expectedOffset: 1, limit: 3 });
});

test("continue_search rejects an offset outside the capability bound", async () => {
    let calls = 0;
    const response = await continueSearchTool.execute({
        handle: "a".repeat(48),
        expectedOffset: 51,
    }, buildContext(async () => {
        calls += 1;
        return { content: [{ type: "text", text: "unexpected" }] };
    }));

    assert.equal(response.isError, true);
    assert.match(response.content[0]?.text ?? "", /less than or equal to 50/);
    assert.equal(calls, 0);
});
