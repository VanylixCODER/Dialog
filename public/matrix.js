// Матричный дождь на экране входа (canvas в .login-bg).
(function () {
  // Уважаем «уменьшить движение»
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const bg = document.querySelector(".login-bg");
  if (!bg) return;

  const canvas = document.createElement("canvas");
  canvas.className = "matrix-rain";
  bg.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  const chars = "01<>/\\|=+-*#$%&{}[]ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃ日月火水木金土ﾊﾋﾌﾍﾎ".split("");
  const fontSize = 14;
  let cols, drops, w, h;

  function resize() {
    w = canvas.width = bg.offsetWidth;
    h = canvas.height = bg.offsetHeight;
    cols = Math.max(1, Math.floor(w / fontSize));
    drops = Array(cols).fill(0).map(() => Math.floor((Math.random() * h) / fontSize));
  }
  resize();
  window.addEventListener("resize", resize);

  function draw() {
    // лёгкий хвост-затухание
    ctx.fillStyle = "rgba(0, 7, 0, 0.08)";
    ctx.fillRect(0, 0, w, h);
    ctx.font = fontSize + "px 'JetBrains Mono', monospace";
    for (let i = 0; i < cols; i++) {
      const ch = chars[(Math.random() * chars.length) | 0];
      const x = i * fontSize;
      const y = drops[i] * fontSize;
      // голова потока ярче
      ctx.fillStyle = Math.random() > 0.95 ? "#aaffcc" : "#00ff5a";
      ctx.fillText(ch, x, y);
      if (y > h && Math.random() > 0.975) drops[i] = 0;
      drops[i]++;
    }
  }
  setInterval(draw, 55);
})();
