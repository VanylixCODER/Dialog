/* ============================================================================
   Tiny EN/RU switch for the public site (landing + downloads).
   The messenger has its own i18n (js/i18n.js); this one is deliberately
   separate and dependency-free so the marketing pages stay static files.

   Usage:
     <span class="lang-pick" id="langPick"></span>       ← picker mounts here
     <h1 data-t="hL1"></h1>                              ← textContent
     <ul data-t-html="roadS"></ul>                       ← innerHTML
     DialogI18n.init({ en: {...}, ru: {...} }, onApply?)

   The choice is stored under the same `dialog_lang` key the app uses, so
   picking ru here also opens the messenger in Russian.
   ========================================================================= */
window.DialogI18n = (function () {
  var KEY = "dialog_lang";

  function stored() {
    try {
      var s = localStorage.getItem(KEY);
      if (s === "en" || s === "ru") return s;
    } catch (e) {}
    return (navigator.language || "en").slice(0, 2) === "ru" ? "ru" : "en";
  }

  function init(dicts, onApply) {
    var pick = document.getElementById("langPick");
    if (pick && !pick.children.length) {
      pick.innerHTML =
        '<button type="button" data-lang="en">EN</button>' +
        '<span>/</span>' +
        '<button type="button" data-lang="ru">RU</button>';
    }

    function apply(l) {
      var dict = dicts[l] || dicts.en;
      document.documentElement.lang = l;
      document.querySelectorAll("[data-t]").forEach(function (el) {
        var v = dict[el.getAttribute("data-t")];
        if (v != null) el.textContent = v;
      });
      document.querySelectorAll("[data-t-html]").forEach(function (el) {
        var v = dict[el.getAttribute("data-t-html")];
        if (v != null) el.innerHTML = v;
      });
      if (pick) {
        pick.querySelectorAll("button").forEach(function (b) {
          b.classList.toggle("active", b.getAttribute("data-lang") === l);
        });
      }
      try { localStorage.setItem(KEY, l); } catch (e) {}
      if (typeof onApply === "function") onApply(l, dict);
    }

    if (pick) {
      pick.querySelectorAll("button").forEach(function (b) {
        b.onclick = function () { apply(b.getAttribute("data-lang")); };
      });
    }
    apply(stored());
  }

  return { init: init, stored: stored };
})();
