// ============================================================================
// Scroll reveals for the marketing pages.
//
// Same authoring API as the AOS library — data-aos="fade-up", data-aos-delay,
// data-aos-duration, data-aos-once — but ~1 KB of our own IntersectionObserver
// instead of a third-party script. The site has no build step and no bundler, so
// every dependency would be another blocking request from another host; this is
// the same trade the old landing page made with its .reveal class.
//
// SAFETY: the hidden state lives under `html.aos`, which only this file adds.
// If the script fails to load, or the visitor prefers reduced motion, nothing
// is ever hidden — the page just renders. Never move the opacity:0 into a bare
// [data-aos] rule; that is how a broken script turns into a blank page.
// ============================================================================
(function () {
  var root = document.documentElement;
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // No observer (very old WebView) or motion turned off → leave everything visible.
  if (reduced || !("IntersectionObserver" in window)) return;

  root.classList.add("aos");

  function reveal(el) {
    var d = el.getAttribute("data-aos-delay");
    var dur = el.getAttribute("data-aos-duration");
    if (d) el.style.transitionDelay = (parseInt(d, 10) || 0) + "ms";
    if (dur) el.style.transitionDuration = (parseInt(dur, 10) || 0) + "ms";
    el.classList.add("aos-in");
  }

  var io = new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.isIntersecting) {
        reveal(e.target);
        // Default is once — re-animating on every pass up and down the page is
        // the thing that makes scroll animation feel cheap.
        if (e.target.getAttribute("data-aos-once") !== "false") io.unobserve(e.target);
      } else if (e.target.getAttribute("data-aos-once") === "false") {
        e.target.classList.remove("aos-in");
      }
    }
  }, { rootMargin: "0px 0px -12% 0px", threshold: 0.05 });

  function scan() {
    var nodes = document.querySelectorAll("[data-aos]:not([data-aos-seen])");
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].setAttribute("data-aos-seen", "");
      // Anything already on screen at load reveals immediately rather than
      // waiting for a scroll that may never come on a short viewport.
      var r = nodes[i].getBoundingClientRect();
      if (r.top < innerHeight * 0.92 && r.bottom > 0) reveal(nodes[i]);
      else io.observe(nodes[i]);
    }
  }

  // Safety sweep. The observer's bottom rootMargin means an element parked at the
  // very end of a short page can never satisfy it, and a hash jump can land past
  // things without ever intersecting them. On scroll-end, reveal anything that is
  // plainly on screen. Cheap, and it makes "content stuck invisible" impossible.
  var sweepTimer;
  function sweep() {
    var nodes = document.querySelectorAll("[data-aos]:not(.aos-in)");
    for (var i = 0; i < nodes.length; i++) {
      var r = nodes[i].getBoundingClientRect();
      if (r.top < innerHeight && r.bottom > 0) { reveal(nodes[i]); io.unobserve(nodes[i]); }
    }
  }
  addEventListener("scroll", function () {
    clearTimeout(sweepTimer);
    sweepTimer = setTimeout(sweep, 220);
  }, { passive: true });
  addEventListener("hashchange", function () { setTimeout(sweep, 260); });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan);
  else scan();
  // Language switches and the downloads grid rebuild their DOM.
  window.addEventListener("load", function () { scan(); sweep(); });
  window.DialogAOS = { scan: scan, sweep: sweep };
})();
