// Shared bits for the public pages: mobile menu, the nav's hairline once you scroll, footer year.
(function () {
  var burger = document.getElementById("burger"), links = document.getElementById("navLinks");
  if (burger && links) {
    burger.onclick = function () {
      var open = links.classList.toggle("open");
      burger.setAttribute("aria-expanded", open ? "true" : "false");
    };
    links.addEventListener("click", function (e) { if (e.target.closest("a")) { links.classList.remove("open"); burger.setAttribute("aria-expanded", "false"); } });
  }
  var nav = document.getElementById("nav") || document.querySelector(".nav");
  if (nav && "IntersectionObserver" in window) {
    var s = document.createElement("div");
    s.style.cssText = "position:absolute;top:0;left:0;width:1px;height:8px;pointer-events:none";
    document.body.prepend(s);
    new IntersectionObserver(function (e) { nav.classList.toggle("scrolled", !e[0].isIntersecting); }).observe(s);
  }
  var yr = document.getElementById("yr"); if (yr) yr.textContent = new Date().getFullYear();
})();
