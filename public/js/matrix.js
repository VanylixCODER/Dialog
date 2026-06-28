// Матрица-дождь на фоне экрана входа — многослойный, с глубиной и мягкой «вспышкой» головной буквы.
(function () {
  const login = document.getElementById("login");
  if (!login) return;
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;z-index:1;opacity:0;pointer-events:none;transition:opacity .8s ease";
  login.prepend(canvas);
  const ctx = canvas.getContext("2d", { alpha: true });
  // Палитра: катакана, латница, цифры, символы — для разнородного дождя
  const glyphs = (
    "アイウエオカキクケコサシスセソタチツテト" +
    "ナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン" +
    "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ" +
    "░▒▓<>{}[]#$%&+=*/\\"
  ).split("");
  const headChance = 0.018;   // шанс «головной» яркой буквы
  let dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  let cols = 0, drops = [], speeds = [], alphas = [];
  let raf = 0;

  function resize() {
    dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width = login.clientWidth * dpr;
    canvas.height = login.clientHeight * dpr;
    canvas.style.width = login.clientWidth + "px";
    canvas.style.height = login.clientHeight + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.floor(login.clientWidth / 16);
    drops = Array.from({ length: cols }, () => Math.random() * (login.clientHeight / 16));
    speeds = Array.from({ length: cols }, () => 0.55 + Math.random() * 0.5);
    alphas = Array.from({ length: cols }, () => 0.5 + Math.random() * 0.5);
  }

  function frame() {
    if (document.hidden) { raf = 0; return; }
    raf = requestAnimationFrame(frame);
    const W = login.clientWidth, H = login.clientHeight;
    // лёгкий «след» — чем меньше alpha, тем длиннее хвост
    ctx.fillStyle = "rgba(0,4,0,0.07)";
    ctx.fillRect(0, 0, W, H);
    ctx.font = "14px 'JetBrains Mono', ui-monospace, monospace";
    ctx.textBaseline = "top";
    for (let i = 0; i < cols; i++) {
      const x = i * 16;
      const y = drops[i] * 16;
      const g = glyphs[(Math.random() * glyphs.length) | 0];
      const fade = Math.min(1, alphas[i]);
      if (Math.random() < headChance) { // головная буква — белая
        ctx.fillStyle = `rgba(220,255,225,${0.95 * fade})`;
        ctx.shadowColor = "rgba(0,255,90,0.95)";
        ctx.shadowBlur = 12;
        ctx.fillText(g, x, y);
        ctx.shadowBlur = 0;
      } else {
        const tone = 0.55 + 0.45 * fade;
        ctx.fillStyle = `rgba(0,255,${Math.round(90 * tone)},${0.75 * fade})`;
        ctx.fillText(g, x, y);
      }
      if (y > H - 16 && Math.random() > 0.972) drops[i] = -Math.random() * 20;
      drops[i] += speeds[i] * 0.7;
    }
  }

  function start() {
    if (raf) return;
    if (!cols) resize();
    canvas.style.opacity = "0.42";
    frame();
  }
  function stop() {
    canvas.style.opacity = "0";
    cancelAnimationFrame(raf);
    raf = 0;
  }

  resize();
  // постепенный fade-in при монтировании, чтобы экран не «мигал»
  setTimeout(() => { canvas.style.opacity = "0.42"; }, 80);

  window.addEventListener("resize", resize);

  // Прячем дождь после логина
  new MutationObserver(() => {
    if (login.classList.contains("hidden")) stop();
    else if (!document.hidden) start();
  }).observe(login, { attributes: true, attributeFilter: ["class"] });

  // вернуть дождь при возврате на вкладку
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !login.classList.contains("hidden")) start();
  });

  frame();
})();
