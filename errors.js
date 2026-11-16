// Error pages for the public site — one renderer, two uses:
//   • server.js renders them live (400, 401, 403, 404, 405, 413, 429, 500, …);
//   • `node errors.js --build` writes standalone copies to public/errors/ that Caddy serves
//     when the app itself is down (502/503/504), with the CSS inlined since /css won't load then.
// Both languages ship in the page; a tiny inline script picks the visitor's (same `dialog_lang`
// key the app and the landing use), so static copies work without the server.

export const ERRORS = {
  400: { en: ["Bad request", "That request didn't make sense to us. Check the link or try again."], ru: ["Неверный запрос", "Мы не поняли этот запрос. Проверьте ссылку или попробуйте ещё раз."] },
  401: { en: ["Sign in first", "You need to be signed in to see this page."], ru: ["Сначала войдите", "Чтобы открыть эту страницу, нужно войти в аккаунт."] },
  403: { en: ["Not allowed", "You don't have access to this. If you think you should, ask whoever sent you the link."], ru: ["Нет доступа", "У вас нет доступа к этому. Если он должен быть — спросите того, кто прислал ссылку."] },
  404: { en: ["Nothing here", "This page doesn't exist, or it moved. The link might have a typo."], ru: ["Здесь ничего нет", "Такой страницы нет или она переехала. Возможно, в ссылке опечатка."] },
  405: { en: ["Not like that", "This address doesn't accept that kind of request."], ru: ["Так нельзя", "Этот адрес не принимает такой запрос."] },
  408: { en: ["Took too long", "The request timed out. Check your connection and try again."], ru: ["Слишком долго", "Время ожидания истекло. Проверьте соединение и попробуйте снова."] },
  410: { en: ["Gone for good", "This page used to exist, but it's been removed."], ru: ["Удалено навсегда", "Эта страница была, но её удалили."] },
  413: { en: ["Too big", "That upload is larger than we accept. Try a smaller file."], ru: ["Слишком большой файл", "Файл больше, чем мы принимаем. Попробуйте файл поменьше."] },
  414: { en: ["Link too long", "That address is longer than we can handle."], ru: ["Слишком длинная ссылка", "Эта ссылка длиннее, чем мы можем обработать."] },
  429: { en: ["Slow down a little", "Too many requests in a short time. Wait a minute, then try again."], ru: ["Чуть помедленнее", "Слишком много запросов за короткое время. Подождите минуту и попробуйте снова."] },
  500: { en: ["Something broke", "That's on us, not you. Try again in a moment."], ru: ["Что-то сломалось", "Это наша ошибка, не ваша. Попробуйте через минуту."] },
  501: { en: ["Not built yet", "This isn't something Dialog does — at least not yet."], ru: ["Пока не умеем", "Dialog этого пока не умеет."] },
  502: { en: ["Back in a moment", "Dialog is restarting, usually for an update. Give it a minute."], ru: ["Скоро вернёмся", "Dialog перезапускается — обычно из-за обновления. Подождите минуту."] },
  503: { en: ["Down for a moment", "Dialog is temporarily unavailable. Please try again shortly."], ru: ["Временно недоступно", "Dialog ненадолго недоступен. Попробуйте чуть позже."] },
  504: { en: ["Taking too long", "The server didn't answer in time. Try again in a moment."], ru: ["Сервер не отвечает", "Сервер не ответил вовремя. Попробуйте через минуту."] },
};
const UI = {
  en: { home: "Go home", open: "Open Dialog", retry: "Try again", signin: "Sign in", back: "Go back" },
  ru: { home: "На главную", open: "Открыть Dialog", retry: "Повторить", signin: "Войти", back: "Назад" },
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function pickLang(acceptLanguage) { return /^\s*ru\b/i.test(acceptLanguage || "") ? "ru" : "en"; }

// code: HTTP status. opts: { lang, css (inline CSS string, else /css/site.css is linked),
//   title/heading/body (overrides, e.g. the email-verification pages), action ({ href, en, ru }) }
export function renderErrorPage(code, opts = {}) {
  const e = ERRORS[code] || ERRORS[code >= 500 ? 500 : 400];
  const lang = opts.lang === "ru" ? "ru" : "en";
  const tx = { en: [opts.heading || e.en[0], opts.body || e.en[1]], ru: [opts.headingRu || opts.heading || e.ru[0], opts.bodyRu || opts.body || e.ru[1]] };
  // Primary action per kind of error: sign in, retry, or home.
  const primary = opts.action || (code === 401 ? { href: "/login", key: "signin" } : code >= 500 || code === 408 || code === 429 ? { href: "", key: "retry" } : { href: "/", key: "home" });
  const pLabel = (l) => primary.key ? UI[l][primary.key] : primary[l];
  const second = code === 401 ? { href: "/", key: "home" } : { href: "/login", key: "open" };
  const digits = String(code).split("");
  const codeHtml = opts.showCode === false ? "" : `<div class="err-code" aria-hidden="true">${esc(digits[0])}<em>${esc(digits[1])}</em>${esc(digits[2])}</div>`;
  const style = opts.css ? `<style>${opts.css}</style>` : `<link rel="stylesheet" href="/css/site.css" />`;
  const t = (k) => `data-en="${esc(k.en)}" data-ru="${esc(k.ru)}"`;
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex" />
<title>${esc(opts.title || `${code} · ${tx[lang][0]}`)} — Dialog</title>
<meta name="theme-color" content="#00ff5a" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
${style}
</head>
<body>
<nav class="err-nav"><div class="wrap"><a class="err-brand" href="/"><svg viewBox="0 0 28 28" aria-hidden="true"><rect x="1" y="4" width="22" height="18" rx="5" fill="none" stroke="#00ff5a" stroke-width="2.4"/><circle cx="8" cy="13" r="1.8" fill="#00ff5a"/><circle cx="12" cy="13" r="1.8" fill="#00ff5a"/><circle cx="16" cy="13" r="1.8" fill="#00ff5a"/><path d="M7 22l-2 4 6-4" fill="#00ff5a"/><path d="M21 2.5a6 6 0 0 1 4.5 4.5M21 6a2.5 2.5 0 0 1 1.5 1.5" fill="none" stroke="#00ff5a" stroke-width="2" stroke-linecap="round"/></svg>Dialog</a></div></nav>
<main class="err">
  <div class="err-box">
    ${codeHtml}
    <h1 ${t({ en: tx.en[0], ru: tx.ru[0] })}>${esc(tx[lang][0])}</h1>
    <p ${t({ en: tx.en[1], ru: tx.ru[1] })}>${esc(tx[lang][1])}</p>
    <div class="btn-row">
      <a class="btn btn-accent" href="${esc(primary.href)}" ${primary.href ? "" : 'data-retry="1"'} ${t({ en: pLabel("en"), ru: pLabel("ru") })}>${esc(pLabel(lang))}</a>
      <a class="btn btn-line" href="${second.href}" ${t({ en: UI.en[second.key], ru: UI.ru[second.key] })}>${esc(UI[lang][second.key])}</a>
    </div>
    ${opts.showCode === false ? "" : `<div class="meta">HTTP ${esc(code)}</div>`}
  </div>
</main>
<script>
(function () {
  var l = null; try { l = localStorage.getItem("dialog_lang"); } catch (e) {}
  if (l !== "en" && l !== "ru") l = (navigator.language || "en").slice(0, 2) === "ru" ? "ru" : "en";
  document.documentElement.lang = l;
  document.querySelectorAll("[data-en]").forEach(function (el) { el.textContent = el.getAttribute("data-" + l); });
  document.querySelectorAll("[data-retry]").forEach(function (a) { a.href = location.href; a.onclick = function (ev) { ev.preventDefault(); location.reload(); }; });
})();
</script>
</body>
</html>`;
}

// `node errors.js --build` → public/errors/{500,502,503,504}.html with site.css inlined.
// Re-run after changing this file or public/css/site.css, and commit the output.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/")) && process.argv.includes("--build")) {
  const { readFileSync, writeFileSync, mkdirSync } = await import("fs");
  const { fileURLToPath } = await import("url");
  const { dirname, join } = await import("path");
  const root = dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(join(root, "public/css/site.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
  mkdirSync(join(root, "public/errors"), { recursive: true });
  for (const code of [500, 502, 503, 504]) {
    writeFileSync(join(root, "public/errors", `${code}.html`), renderErrorPage(code, { css }));
    console.log(`public/errors/${code}.html`);
  }
}
