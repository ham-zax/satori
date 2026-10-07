# Browser counters

Inject the meter before the interaction, run the interaction a fixed number of
times, and read `window.__perf` afterwards. It works from DevTools, Playwright
(`page.addInitScript` / `page.evaluate`), Puppeteer, or any browser tool your
harness has.

## In-page meter

```js
(() => {
  const perf = (window.__perf = {
    domMutations: 0, styleRecalcs: 0, layoutShift: 0, shiftsByRegion: {},
    longFrames: 0, longFrameMs: 0, worstFrameMs: 0, frames: 0, reactCommits: 0,
  });

  // DOM mutations: every node added/removed/attribute/text change.
  new MutationObserver((records) => { perf.domMutations += records.length; })
    .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });

  // Layout shifts, attributed to a named region (closest [data-region] or tag#id).
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.hadRecentInput) continue;
      perf.layoutShift += e.value;
      for (const s of e.sources ?? []) {
        const el = s.node?.closest?.('[data-region]');
        const region = el?.dataset.region ?? s.node?.nodeName ?? 'unknown';
        perf.shiftsByRegion[region] = (perf.shiftsByRegion[region] ?? 0) + e.value;
      }
    }
  }).observe({ type: 'layout-shift', buffered: true });

  // Long animation frames (Chromium): main-thread frames over 50 ms, with script attribution.
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) { perf.longFrames++; perf.longFrameMs += e.duration; }
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch {}

  // Frame meter from requestAnimationFrame timestamps.
  let last = 0;
  const tick = (t) => {
    if (last) { perf.frames++; perf.worstFrameMs = Math.max(perf.worstFrameMs, t - last); }
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // React commits: wrap the DevTools hook if present (dev or profiling builds).
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (hook?.onCommitFiberRoot) {
    const orig = hook.onCommitFiberRoot.bind(hook);
    hook.onCommitFiberRoot = (...a) => { perf.reactCommits++; return orig(...a); };
  }
})();
```

For React without DevTools, wrap the measured subtree in
`<Profiler id="journey" onRender={() => window.__perf.reactCommits++}>` in a
profiling build. For Vue, use `app.config.performance = true` together with the
`renderTracked`/`renderTriggered` hooks. For Svelte or Solid, count effect runs in
a wrapper.

## Style recalcs and layouts via CDP

The web platform does not expose the style-recalc count directly; read it through
the Chrome DevTools Protocol:

```js
// Playwright (Chromium)
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const read = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const before = await read();
await runInteraction(page);              // fixed, scripted journey
const after = await read();
const delta = (k) => after[k] - before[k];
console.log({ recalcStyle: delta('RecalcStyleCount'), layouts: delta('LayoutCount'),
              scriptMs: delta('ScriptDuration') * 1000, taskMs: delta('TaskDuration') * 1000 });
```

`RecalcStyleCount` and `LayoutCount` are near-deterministic for a scripted
interaction. The `*Duration` values are wall time: treat them as truth, not as gates.

## Deterministic frame stepping (frame budget in CI)

Headless Chromium can be driven one frame at a time, so frame-budget tests
do not depend on machine speed:

1. Launch with `--deterministic-mode` (or `--enable-begin-frame-control --run-all-compositor-stages-before-draw`) in headless mode.
2. For each frame, call CDP `HeadlessExperimental.beginFrame({ frameTimeTicks, interval: 8.333 })` for 120 Hz, or 16.667 for 60 Hz, advancing `frameTimeTicks` by the interval.
3. Around each frame, read the main-thread task time (tracing or `Performance.getMetrics` `TaskDuration` delta). Flag frames whose work exceeds the budget.
4. Gate on **total main-thread blocking** and the **worst frame** over a long fixture, such as a long streamed reply or a big table render.

Headless mode does not have the real browser UI. Prerendering, tab-strip
resizes, and extensions do not happen there. When field layout-shift or frame
data disagrees with the lab, simulate the field condition explicitly (for
example, resize the viewport mid-load to mimic browser UI changes) and keep it as a test.

## Gating

Write the counts per journey into `metrics.json`, for example
`{"open-conversation.domMutations": 412, "open-conversation.recalcStyle": 9}`, and
run `node scripts/ratchet.mjs check perf-baseline.json metrics.json`.
