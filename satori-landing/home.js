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

  // Hero: type the question, then let the answer resolve stage by stage.
  const ask = document.getElementById("ask");
  if (ask) {
    const typed = ask.querySelector(".ask-typed");
    const text = typed.dataset.text;
    const replay = ask.querySelector(".ask-replay");
    const steps = ["step-1", "step-2", "step-3", "step-4"];
    let run = 0;

    const finish = () => {
      typed.textContent = text;
      ask.classList.remove("is-typing");
      ask.classList.add(...steps);
    };

    async function play() {
      const id = ++run;
      ask.classList.remove(...steps);
      if (reduceMotion) return finish();
      ask.classList.add("is-typing");
      typed.textContent = "";
      await wait(700);
      for (let i = 1; i <= text.length; i++) {
        if (id !== run) return;
        typed.textContent = text.slice(0, i);
        await wait(text[i - 1] === "," ? 110 : 20);
      }
      await wait(260);
      if (id !== run) return;
      ask.classList.remove("is-typing");
      for (const [i, step] of steps.entries()) {
        if (id !== run) return;
        ask.classList.add(step);
        await wait(i === 0 ? 900 : 650);
      }
    }

    ask.classList.add("is-armed");
    play();
    replay.addEventListener("click", play);
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

  // Forms whose endpoint is still a placeholder stay hidden; the mailto links above still work.
  document.querySelectorAll("[data-configurable-form]").forEach((form) => {
    if (form.getAttribute("action").includes("REPLACE_WITH")) form.hidden = true;
  });

  // Tiles catch a soft light under the pointer (fine pointers only).
  if (!reduceMotion && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    document.querySelectorAll(".tile").forEach((tile) => {
      let frame = 0;
      tile.addEventListener("pointermove", (event) => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          const rect = tile.getBoundingClientRect();
          tile.style.setProperty("--mx", `${event.clientX - rect.left}px`);
          tile.style.setProperty("--my", `${event.clientY - rect.top}px`);
          frame = 0;
        });
      });
    });
  }
})();
