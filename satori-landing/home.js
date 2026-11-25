// Landing-page choreography: the hero question, the evidence journey, use-case tabs, tile light.
(() => {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Headline words come into focus one after another, then the seal-dot stamps the period.
  const title = document.querySelector(".hero-title");
  if (title) {
    title.querySelectorAll(".word").forEach((word, i) => word.style.setProperty("--w", i));
    requestAnimationFrame(() => title.classList.add("is-in"));
  }

  // Hero: fast (~1.9s) real v4 trace with interactive With Satori / Native grep switcher.
  const ask = document.getElementById("ask");
  if (ask) {
    const typed = ask.querySelector(".ask-typed");
    const text = typed.dataset.text;
    const replay = ask.querySelector(".ask-replay");
    const statPill = ask.querySelector("[data-ask-stat]");
    const tabs = [...ask.querySelectorAll("[data-ask-mode]")];
    const panels = {
      satori: ask.querySelector('[data-ask-panel="satori"]'),
      native: ask.querySelector('[data-ask-panel="native"]'),
    };
    const satoriSteps = ["step-1", "step-2", "step-3", "step-4"];
    const nativeSteps = ["nstep-1", "nstep-2", "nstep-3", "nstep-4"];
    const allSteps = [...satoriSteps, ...nativeSteps];
    let mode = "satori";
    let run = 0;

    const setStat = (m) => {
      if (!statPill) return;
      statPill.textContent = m === "satori"
        ? "5 calls \u00b7 37.5k tokens"
        : "25 calls \u00b7 201.9k tokens";
    };

    const syncModeDom = (m) => {
      mode = m;
      ask.dataset.mode = m;
      tabs.forEach((tab) => {
        const on = tab.dataset.askMode === m;
        tab.setAttribute("aria-selected", String(on));
        tab.tabIndex = on ? 0 : -1;
      });
      if (panels.satori) panels.satori.hidden = m !== "satori";
      if (panels.native) panels.native.hidden = m !== "native";
      setStat(m);
    };

    const finish = (m) => {
      typed.textContent = text;
      ask.classList.remove("is-typing", ...allSteps);
      ask.classList.add(...(m === "satori" ? satoriSteps : nativeSteps));
    };

    async function play(m = mode, fastType = true) {
      const id = ++run;
      syncModeDom(m);
      ask.classList.remove(...allSteps);
      void ask.offsetWidth;
      if (reduceMotion) return finish(m);

      if (fastType) {
        ask.classList.add("is-typing");
        typed.textContent = "";
        await wait(140);
        // Type 2-3 chars per tick so the 65-char question completes in ~420ms.
        for (let i = 3; i <= text.length + 2; i += 3) {
          if (id !== run) return;
          typed.textContent = text.slice(0, Math.min(i, text.length));
          await wait(18);
        }
        if (id !== run) return;
        ask.classList.remove("is-typing");
        await wait(80);
      } else {
        typed.textContent = text;
        ask.classList.remove("is-typing");
        await wait(60);
      }

      const seq = m === "satori" ? satoriSteps : nativeSteps;
      const delays = m === "satori" ? [340, 360, 320, 260] : [280, 280, 320, 260];
      for (const [i, step] of seq.entries()) {
        if (id !== run) return;
        ask.classList.add(step);
        await wait(delays[i]);
      }
    }

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const next = tab.dataset.askMode;
        if (next === mode) return play(next, false);
        play(next, false);
      });
      tab.addEventListener("keydown", (event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const other = tabs.find((t) => t !== tab);
          if (other) {
            other.focus();
            play(other.dataset.askMode, false);
          }
        }
      });
    });

    ask.classList.add("is-armed");
    play("satori", true);
    if (replay) replay.addEventListener("click", () => play(mode, true));
  }

  // Evidence journey: the ink line runs through each stage once it is on screen.
  const journey = document.querySelector("[data-journey]");
  if (journey) {
    if (reduceMotion || !("IntersectionObserver" in window)) {
      journey.classList.add("is-live");
    } else {
      journey.classList.add("is-armed");
      const io = new IntersectionObserver(([entry]) => {
        if (!entry.isIntersecting) return;
        journey.classList.add("is-live");
        io.disconnect();
      }, { threshold: 0.4 });
      io.observe(journey);
    }
  }

  // Use cases: accessible tabs; without JS every panel stays visible.
  document.querySelectorAll("[data-tabs]").forEach((root) => {
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    const panels = tabs.map((tab) => document.getElementById(tab.getAttribute("aria-controls")));
    root.classList.add("is-tabbed");

    const select = (index, focus) => {
      tabs.forEach((tab, i) => {
        const on = i === index;
        tab.setAttribute("aria-selected", String(on));
        tab.tabIndex = on ? 0 : -1;
        panels[i].hidden = !on;
      });
      if (focus) tabs[index].focus();
    };

    tabs.forEach((tab, i) => {
      tab.addEventListener("click", () => select(i, false));
      tab.addEventListener("keydown", (event) => {
        const keys = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
        if (event.key in keys) {
          event.preventDefault();
          select((i + keys[event.key] + tabs.length) % tabs.length, true);
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          select(event.key === "Home" ? 0 : tabs.length - 1, true);
        }
      });
    });
    select(0, false);
  });

  // Demo video: plays muted while on screen, never autoplays under reduced motion.
  const video = document.getElementById("demo-video");
  if (video) {
    if (!reduceMotion && "IntersectionObserver" in window) {
      new IntersectionObserver(([entry]) => {
        if (entry.isIntersecting) video.play().catch(() => {});
        else video.pause();
      }, { threshold: 0.5 }).observe(video);
    }
    document.querySelectorAll("[data-play-demo]").forEach((link) => {
      link.addEventListener("click", () => video.play().catch(() => {}));
    });
  }

  // Interactive quota & API spend waste calculator grounded in Nov 23 v4 medians.
  const calc = document.querySelector("[data-calculator]");
  if (calc) {
    const PLANS = {
      sonnet: { mode: "api", inRate: 3.0, cacheRate: 0.3, outRate: 15.0 },
      opus: { mode: "api", inRate: 15.0, cacheRate: 1.5, outRate: 75.0 },
      codex: { mode: "api", inRate: 2.5, cacheRate: 0.25, outRate: 10.0 },
      quota: { mode: "quota" },
    };
    // Per-task median deltas (Satori offline vs guarded native, Nov 23 2026 v4 + Nov 25 2026 default-on hydrateExact):
    // unknown: 201,905 -> 37,549 input (29,081 uncached + 135,275 cached), 9,807 -> 2,991 output (5,404 reasoning), 93.3s, 20 calls.
    // known (with default-on hydrateExact): 77,784 -> 39,045 input (3,772 uncached + 34,967 cached), 1,250 output (1,247 reasoning), 16.4s, 8 calls.
    // blended (50/50 avg of unknown + known medians): 101,548 input (16,426 uncached + 85,122 cached), 4,033 output (3,326 reasoning), 54.8s, 14 calls.
    const MIX = {
      blended: {
        uncachedIn: 16426,
        cachedIn: 85122,
        totalIn: 101548,
        out: 4033,
        reasoning: 3326,
        wallSec: 54.8,
        calls: 14,
        quotaMult: 3.7,
      },
      unknown: {
        uncachedIn: 29081,
        cachedIn: 135275,
        totalIn: 164356,
        out: 6816,
        reasoning: 5404,
        wallSec: 93.3,
        calls: 20,
        quotaMult: 5.4,
      },
    };
    const WORKDAYS = 22;
    let planKey = "sonnet";
    let mixKey = "blended";

    const devsInput = calc.querySelector("#calc-devs");
    const tasksInput = calc.querySelector("#calc-tasks");
    const devsOut = calc.querySelector("#calc-devs-out");
    const tasksOut = calc.querySelector("#calc-tasks-out");
    const primaryLabel = calc.querySelector("[data-calc-primary-label]");
    const primaryVal = calc.querySelector("[data-calc-primary]");
    const primarySub = calc.querySelector("[data-calc-primary-sub]");
    const tokensVal = calc.querySelector("[data-calc-tokens]");
    const tokensSub = calc.querySelector("[data-calc-tokens-sub]");
    const timeVal = calc.querySelector("[data-calc-time]");
    const timeSub = calc.querySelector("[data-calc-time-sub]");

    const fmtTok = (n) => {
      if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
      if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
      return String(Math.round(n));
    };
    const fmtUsd = (n) => {
      if (n >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
      if (n >= 10) return `$${Math.round(n)}`;
      return `$${n.toFixed(1)}`;
    };

    const update = () => {
      const devs = Math.max(1, Number(devsInput.value) || 1);
      const tasksPerDay = Math.max(1, Number(tasksInput.value) || 1);
      devsOut.textContent = String(devs);
      tasksOut.textContent = String(tasksPerDay);

      const tasksPerMonth = devs * tasksPerDay * WORKDAYS;
      const m = MIX[mixKey];
      const p = PLANS[planKey];

      const inSaved = tasksPerMonth * m.totalIn;
      const outSaved = tasksPerMonth * m.out;
      const reasonSaved = tasksPerMonth * m.reasoning;
      const totalTokSaved = inSaved + outSaved;
      const hoursSaved = (tasksPerMonth * m.wallSec) / 3600;
      const callsSaved = tasksPerMonth * m.calls;

      if (p.mode === "quota") {
        const extraTasksPerCap = Math.round((m.quotaMult - 1) * 100);
        primaryLabel.textContent = "Quota headroom recovered";
        primaryVal.textContent = `${m.quotaMult.toFixed(1)}\u00d7 more tasks`;
        primarySub.textContent = `+${extraTasksPerCap}% more discovery work before hitting 5-hr Pro/Max limits`;
      } else {
        const costPerTask =
          (m.uncachedIn * p.inRate + m.cachedIn * p.cacheRate + m.out * p.outRate) / 1e6;
        const monthlyUsd = tasksPerMonth * costPerTask;
        const yearlyUsd = monthlyUsd * 12;
        primaryLabel.textContent = "Monthly API spend wasted on grep loops";
        primaryVal.textContent = `${fmtUsd(monthlyUsd)} / mo`;
        primarySub.textContent = `${fmtUsd(yearlyUsd)} / yr recovered \u00b7 ${m.quotaMult.toFixed(1)}\u00d7 quota headroom`;
      }

      tokensVal.textContent = fmtTok(totalTokSaved);
      tokensSub.textContent = `${fmtTok(inSaved)} input \u00b7 ${fmtTok(outSaved)} output (${fmtTok(reasonSaved)} reasoning)`;
      timeVal.textContent = hoursSaved >= 100 ? `${Math.round(hoursSaved)} hrs` : `${hoursSaved.toFixed(1)} hrs`;
      timeSub.textContent = `${Math.round(callsSaved).toLocaleString("en-US")} redundant grep/read calls eliminated`;
    };

    calc.querySelectorAll("[data-calc-plans] .calc-pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        planKey = btn.dataset.plan;
        calc.querySelectorAll("[data-calc-plans] .calc-pill").forEach((b) => {
          b.setAttribute("aria-pressed", String(b === btn));
        });
        update();
      });
    });

    calc.querySelectorAll("[data-calc-mix] .calc-pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        mixKey = btn.dataset.mix;
        calc.querySelectorAll("[data-calc-mix] .calc-pill").forEach((b) => {
          b.setAttribute("aria-pressed", String(b === btn));
        });
        update();
      });
    });

    devsInput.addEventListener("input", update);
    tasksInput.addEventListener("input", update);
    update();
  }

  // Forms whose endpoint is still a placeholder stay hidden; the mailto links above still work.
  document.querySelectorAll("[data-configurable-form]").forEach((form) => {
    if (form.getAttribute("action").includes("REPLACE_WITH")) form.hidden = true;
  });
})();
