import test from "node:test";
import assert from "node:assert/strict";
import {
    BACKGROUND_FRESHNESS_THRESHOLD_MS,
    BACKGROUND_SYNC_INITIAL_DELAY_MS,
    BACKGROUND_SYNC_INTERVAL_MS,
    DEFAULT_WATCH_DEBOUNCE_MS,
    MANUAL_SYNC_FRESHNESS_THRESHOLD_MS,
    SEARCH_FRESHNESS_THRESHOLD_MS,
    WATCHER_DEBOUNCE_MS,
} from "../config.js";

test("freshness timing knobs keep distinct names and planned defaults", () => {
    assert.equal(WATCHER_DEBOUNCE_MS, 5_000);
    assert.equal(DEFAULT_WATCH_DEBOUNCE_MS, WATCHER_DEBOUNCE_MS);
    assert.equal(BACKGROUND_SYNC_INITIAL_DELAY_MS, 5_000);
    assert.equal(BACKGROUND_SYNC_INTERVAL_MS, 3 * 60 * 1000);
    assert.equal(SEARCH_FRESHNESS_THRESHOLD_MS, 3 * 60 * 1000);
    assert.equal(BACKGROUND_FRESHNESS_THRESHOLD_MS, 3 * 60 * 1000);
    assert.equal(MANUAL_SYNC_FRESHNESS_THRESHOLD_MS, 0);
});

test("watcher debounce and background initial delay stay conceptually independent knobs", () => {
    // Defaults may share a numeric value (both 5s) without sharing meaning.
    assert.equal(WATCHER_DEBOUNCE_MS, BACKGROUND_SYNC_INITIAL_DELAY_MS);
    // Search threshold must not silently track watcher debounce.
    assert.notEqual(SEARCH_FRESHNESS_THRESHOLD_MS, WATCHER_DEBOUNCE_MS);
    // Background interval and background freshness threshold default equal but named separately.
    assert.equal(BACKGROUND_SYNC_INTERVAL_MS, BACKGROUND_FRESHNESS_THRESHOLD_MS);
    // Manual force-check is not a recency window.
    assert.equal(MANUAL_SYNC_FRESHNESS_THRESHOLD_MS, 0);
    assert.notEqual(MANUAL_SYNC_FRESHNESS_THRESHOLD_MS, SEARCH_FRESHNESS_THRESHOLD_MS);
});
