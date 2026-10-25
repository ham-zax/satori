import assert from "node:assert/strict";
import test from "node:test";
import { resolveBehaviorAliases, resolveBehaviorSearchTerms } from "./search-behavior-aliases.js";

test("cleanup bridges to the measured code term destroy", () => {
    assert.deepEqual(resolveBehaviorAliases("where does React run the cleanup function"), ["destroy"]);
});

test("only the whole behavior word matches", () => {
    assert.deepEqual(resolveBehaviorAliases("clean up the state"), []);
    assert.deepEqual(resolveBehaviorAliases("cleanupfoo"), []);
});

test("unmeasured behavior words emit nothing", () => {
    assert.deepEqual(resolveBehaviorAliases("where is the teardown handled"), []);
    assert.deepEqual(resolveBehaviorAliases("where is dispose called"), []);
});

test("caller terms win and aliases do not fire", () => {
    const terms = resolveBehaviorSearchTerms({
        query: "where does React run the cleanup function",
        callerTerms: ["release"],
        enabled: true,
        routeKind: "conceptual",
    });
    assert.deepEqual(terms.termsEmitted, ["release"]);
});

test("the flag off emits nothing", () => {
    const terms = resolveBehaviorSearchTerms({
        query: "where does React run the cleanup function",
        enabled: false,
        routeKind: "conceptual",
    });
    assert.deepEqual(terms.termsEmitted, []);
});

test("a references route emits nothing", () => {
    const terms = resolveBehaviorSearchTerms({
        query: "where does React run the cleanup function",
        enabled: true,
        routeKind: "references",
    });
    assert.deepEqual(terms.termsEmitted, []);
});
