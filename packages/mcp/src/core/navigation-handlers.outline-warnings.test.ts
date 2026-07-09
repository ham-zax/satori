import test from "node:test";
import assert from "node:assert/strict";
import { formatOutlineSymbolRegistryWarnings } from "./navigation-handlers.js";

test("formatOutlineSymbolRegistryWarnings returns undefined when empty", () => {
    assert.equal(formatOutlineSymbolRegistryWarnings([]), undefined);
});

test("formatOutlineSymbolRegistryWarnings includes count, action, and sample keys", () => {
    const formatted = formatOutlineSymbolRegistryWarnings([
        "Duplicate symbolKey 'zeta' has 2 candidates",
        "Duplicate symbolKey 'alpha' has 3 candidates",
        "some other registry diagnostic",
        "Duplicate symbolKey 'beta' has 2 candidates",
        "Duplicate symbolKey 'gamma' has 2 candidates",
    ]);
    assert.equal(
        formatted,
        "OUTLINE_SYMBOL_REGISTRY_WARNINGS:5 action=treat_outline_as_degraded_identity sample=alpha,beta,gamma",
    );
});

test("formatOutlineSymbolRegistryWarnings keeps count without sample when keys are not parseable", () => {
    assert.equal(
        formatOutlineSymbolRegistryWarnings(["opaque registry issue", "another issue"]),
        "OUTLINE_SYMBOL_REGISTRY_WARNINGS:2 action=treat_outline_as_degraded_identity",
    );
});
