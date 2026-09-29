// Satori brand motion shared by every page: ensō marks, focus reveals, back-to-top, copy buttons.
(() => {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tpl = document.getElementById("enso-tpl");
  let ensoCount = 0;

  function draw(svg) {
    svg.classList.remove("is-drawing");
    void svg.getBoundingClientRect(); // restart the CSS animation
    svg.classList.add("is-drawing");
  }

  // Stamp the inline ensō into each placeholder. The <img> inside stays as the no-JS fallback.
  if (tpl) {
    const drawOnView = [];
    document.querySelectorAll("[data-enso]").forEach((host) => {
      const svg = tpl.content.firstElementChild.cloneNode(true);
      const id = `enso-mask-${++ensoCount}`;
      svg.querySelector("mask").id = id;
      svg.querySelector(".enso-ink").setAttribute("mask", `url(#${id})`);
      const when = host.dataset.ensoDraw;
      if (host.dataset.ensoDur) svg.style.setProperty("--enso-dur", `${host.dataset.ensoDur}s`);
      host.replaceChildren(svg);
      if (reduceMotion) return;
      if (when === "view") drawOnView.push(svg);
      else if (when !== undefined) {
        svg.style.setProperty("--enso-delay", `${parseFloat(when) || 0}s`);
        draw(svg);
      }
    });

    if (drawOnView.length) {
      // Hold the ink back until the mark is actually seen.
      drawOnView.forEach((svg) => svg.classList.add("is-waiting"));
      const io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.remove("is-waiting");
          draw(entry.target);
          io.unobserve(entry.target);
        });
      }, { threshold: 0.35 });
      drawOnView.forEach((svg) => io.observe(svg));
    }

    // The nav mark redraws when you reach for it: a small, earned flourish.
    const brand = document.querySelector(".nav-brand");
    const brandSvg = brand && brand.querySelector(".enso");
    if (brand && brandSvg && !reduceMotion) {
      let last = 0;
      brand.addEventListener("pointerenter", () => {
        const now = performance.now();
        if (now - last < 1600) return;
        last = now;
        brandSvg.style.setProperty("--enso-delay", "0s");
        brandSvg.style.setProperty("--enso-dur", "0.9s");
        draw(brandSvg);
      });
    }
  }

  // Focus reveal: content resolves from blur as it enters the viewport.
  const revealables = document.querySelectorAll("[data-reveal]");
  if (reduceMotion || !("IntersectionObserver" in window)) {
    revealables.forEach((el) => el.classList.add("is-in"));
  } else {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-in");
        io.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
    revealables.forEach((el) => io.observe(el));
  }

  // Back to top appears once the first screen has scrolled away.
  const backToTop = document.getElementById("backToTop");
  const firstScreen = document.querySelector("main > :first-child");
  if (backToTop && firstScreen && "IntersectionObserver" in window) {
    new IntersectionObserver(([entry]) => {
      const show = !entry.isIntersecting;
      backToTop.classList.toggle("visible", show);
      backToTop.tabIndex = show ? 0 : -1;
    }).observe(firstScreen);
    backToTop.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
    });
  }

  document.querySelectorAll(".copy-btn[data-copy-target]").forEach((btn) => {
    if (btn.dataset.copyBound) return;
    btn.dataset.copyBound = "1";
    btn.addEventListener("click", async () => {
      const source = document.getElementById(btn.dataset.copyTarget);
      if (!source) return;
      const label = btn.textContent;
      try {
        await navigator.clipboard.writeText(source.textContent.trim());
        btn.textContent = "Copied";
        btn.classList.add("copied");
      } catch {
        btn.textContent = "Copy failed";
      }
      setTimeout(() => {
        btn.textContent = label;
        btn.classList.remove("copied");
      }, 1400);
    });
  });
})();
