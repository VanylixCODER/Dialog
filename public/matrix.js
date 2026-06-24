// Матрица-дождь на фоне экрана входа.
(function () {
  const login = document.getElementById("login");
  if (!login) return;
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;z-index:1;opacity:.35;pointer-events:none";
  login.prepend(canvas);
  const ctx = canvas.getContext("2d");
  const chars = "アイウエオカキクケコサシスセソ0123456789ABCDEF<>/{}[]#$%".split("");
  let cols, drops, raf;
  function resize() {
    canvas.width = login.clientWidth; canvas.height = login.clientHeight;
    cols = Math.floor(canvas.width / 16);
    drops = new Array(cols).fill(0).map(() => Math.random() * -50);
  }
  function frame() {
    raf = requestAnimationFrame(frame);
    ctx.fillStyle = "rgba(0,7,0,0.08)"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = "14px monospace";
    for (let i = 0; i < cols; i++) {
      const c = chars[(Math.random() * chars.length) | 0];
      const x = i * 16, y = drops[i] * 16;
      ctx.fillStyle = Math.random() > 0.975 ? "#b6ffd2" : "#00ff5a";
      ctx.fillText(c, x, y);
      if (y > canvas.height && Math.random() > 0.975) drops[i] = 0;
      drops[i]++;
    }
  }
  resize(); frame();
  window.addEventListener("resize", resize);
  // остановить дождь, когда вход скрыт (после логина)
  new MutationObserver(() => {
    if (login.classList.contains("hidden")) cancelAnimationFrame(raf);
    else if (!raf) frame();
  }).observe(login, { attributes: true, attributeFilter: ["class"] });
})();
