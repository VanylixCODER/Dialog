const socket = io();
const $ = (id) => document.getElementById(id);

// Capture ?invite=<code> from URL на самом раннем этапе (до login-flow). Function declaration hoisting
// позволяет вызвать readInviteFromUrl() здесь, пока она объявлена ниже в файле. Если уже залогинены,
// redeem подхватит enterApp(). Если нет — код сохранится в sessionStorage и будет подхвачен после
// логина/регистрации. Без этого IIFE весь URL-invite-флоу немой.
(function () { try { readInviteFromUrl(); } catch {} })();


function debounce(fn, ms) {
  let t;
  return function () {
    const args = arguments, ctx = this;
    clearTimeout(t);
    t = setTimeout(() => fn.apply(ctx, args), ms);
  };
}

// ---- Live preview wiring for the custom-theme editor ----
// Bound once: typing in #ctCss re-wraps the CSS via wrapCssInScope under .ct-preview-scope
// and injects into a dedicated <style id="ct-live-preview">. Debounced so we don't thrash
// on every keystroke while still feeling live.
// ---------- Состояние ----------
let token = localStorage.getItem("dialog_token") || null;
let profile = null, myName = "";
let myRoom = "", curKind = "dm", curTitle = "", activeKey = "";
let avaVer = Date.now();
let myStatus = "online", myDesc = "";
const chats = new Map();             // key -> {key,type,name,login,id,last,ts,unread,pinned}
let chatTypeFilter = "all";          // "all" | "dm" | "group"
const peers = new Map();             // socketId -> {name, login}
const presence = new Map();          // login -> 'online'|'dnd'|'offline'
const relations = { friends: [], blocked: [], sent: [], incoming: [] };
const blocked = new Set(), blockedBy = new Set();
const clearedChats = new Map(); // room -> timestamp (ms)
try { const c = JSON.parse(localStorage.getItem("clearedChats") || "{}"); for (const [k, v] of Object.entries(c)) clearedChats.set(k, v); } catch {}
function persistCleared() { localStorage.setItem("clearedChats", JSON.stringify(Object.fromEntries(clearedChats))); }
const isDnd = () => myStatus === "dnd";

// ---------- Звуки (WebAudio) ----------
let audioCtx = null;
function ensureAudioCtx() { if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} } if (audioCtx && audioCtx.state === "suspended") audioCtx.resume(); return audioCtx; }
function beep(freq, dur, vol = 0.05) {
  const ctx = ensureAudioCtx(); if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = freq; o.type = "sine"; g.gain.value = vol;
  o.connect(g); g.connect(ctx.destination); o.start();
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur); o.stop(ctx.currentTime + dur);
}
function beepSeq(notes) { let dt = 0; notes.forEach(([f, d, v]) => { setTimeout(() => beep(f, d, v ?? 0.05), dt); dt += d * 900; }); }
const sfx = {
  msg: () => beep(660, 0.12),
  call: () => beep(880, 0.18),
  start: () => beepSeq([[440, 0.1], [660, 0.1], [880, 0.13]]),   // вход в звонок
  end: () => beepSeq([[523, 0.12], [330, 0.18]]),                // выход из звонка
  join: () => beepSeq([[523, 0.09], [784, 0.12]]),               // участник зашёл
  leave: () => beepSeq([[784, 0.09], [415, 0.13]]),              // участник вышел
  mute: () => beep(300, 0.07),
  unmute: () => beep(560, 0.07),
};

// Per-theme msg SFX hook (currently uniform for all built-in themes).
function msgSfxForTheme() { return sfx.msg; }
document.addEventListener("pointerdown", ensureAudioCtx, { once: true });

// ---- Wallpaper (global + per-chat background images) ----
// BSAV: хранилище — localStorage. Один глобальный dataURL + map chatKey→dataURL
// для per-chat overrides. Resolution: per-chat > global > null (тема по умолчанию).
// Cap 2 MB raw (~2.7 MB base64) — фактор 1.36x для localStorage budget; там же
// живут token, profile, ringtone, до 50 DM чатов. Превышение лимита ловим в UI:
// показываем i18n error в .form-error, файл просто не сохраняем.
const BG_MAX_BYTES = 2 * 1024 * 1024;
const BG_GLOBAL_KEY = "dialog_bg_global";
const BG_PER_CHAT_KEY = "dialog_bg_per_chat";
function getGlobalBg() { try { const v = localStorage.getItem(BG_GLOBAL_KEY); return v && v.startsWith("data:") ? v : null; } catch { return null; } }
// Общий детектор quota-exceeded: разные браузеры называют ошибку по-разному —
// Firefox использует `name === "QuotaExceededError"`, WebKit `code === 22`, Safari
// (iOS) исторически кидал `code === 1014` для QUOTA_EXCEEDED_ERR. Если не эта ошибка
// — пробрасываем дальше (это либо наш баг, либо недоступность storage, не проглатываем).
function isQuotaError(e) { return e && (e.name === "QuotaExceededError" || e.code === 22 || e.code === 1014); }
// Булль возврата: `true` — запись прошла (или был удалён), `false` — quota exceeded.
// Старый silent try/catch проглатывал quota-ошибки — обои «сохранялись» в UI, исчезали
// после reload. Caller теперь показывает локализованную "bg_quota" ошибку в .form-error.
function setGlobalBg(dataUrl) {
  try { if (dataUrl) localStorage.setItem(BG_GLOBAL_KEY, dataUrl); else localStorage.removeItem(BG_GLOBAL_KEY); return true; }
  catch (e) { if (isQuotaError(e)) return false; throw e; }
}
function getBgPerChatMap() { try { const raw = localStorage.getItem(BG_PER_CHAT_KEY); return raw ? JSON.parse(raw) : {}; } catch { return {}; } }
function setBgPerChatMap(map) {
  try { localStorage.setItem(BG_PER_CHAT_KEY, JSON.stringify(map || {})); return true; }
  catch (e) { if (isQuotaError(e)) return false; throw e; }
}
function getChatBg(chatKey) { return chatKey ? (getBgPerChatMap()[chatKey] || null) : null; }
function setChatBg(chatKey, dataUrl) {
  if (!chatKey) return true;
  const map = getBgPerChatMap();
  if (dataUrl) map[chatKey] = dataUrl; else delete map[chatKey];
  return setBgPerChatMap(map);
}
function resolveBgForChat(chatKey) {
  const per = getChatBg(chatKey);
  if (per && per.startsWith("data:")) return per;
  const glob = getGlobalBg();
  if (glob && glob.startsWith("data:")) return glob;
  const theme = document.body.dataset.theme;
  if (theme && theme !== "matrix") return "/src/DefaultBG.png";
  return null;
}
// Применяем wallpaper на уровне .chat (= #chatPane): при активном чате достаём URL
// из resolveBg, кладём в CSS custom property + добавляем .has-wallpaper. При отсутствии
// чата (empty state / log outs) — снимаем оба. Также обновляем статус-строки в
// открытых настроечных UI (Settings → Themes + chat-bg modal) — текст мог устареть.
function applyWallpaper() {
  const cp = $("chatPane");
  if (!cp) return;
  const url = myRoom ? resolveBgForChat(myRoom) : null;
  if (url) {
    // URL-escape кавычек (теоретически dataURL содержит base64 без них, но безопаснее).
    cp.style.setProperty("--chat-wallpaper-url", "url(\"" + url.replace(/"/g, "%22") + "\")");
    cp.classList.add("has-wallpaper");
  } else {
    cp.style.removeProperty("--chat-wallpaper-url");
    cp.classList.remove("has-wallpaper");
  }
  refreshBgStatusTexts();
}
// Обновить «status: global/per-chat/none» подписи в обоих местах: Settings секция и
// chat-bg modal. Используется И после изменения apply (upload/clear), И из langchange
// листенера ниже чтобы при переключении языка цифры переводились на лету.
function refreshBgStatusTexts() {
  const gEl = $("bgGlobalStatus");
  if (gEl) { const hasG = !!getGlobalBg(); const k = hasG ? "bg_status_global" : "bg_status_none"; gEl.dataset.i18n = k; gEl.textContent = t(k); }
  // Скрываем "Use global" если глобального фона нет — иначе клик просто снимает per-chat
  // override и откатывает к теме по дефолту (а не «использует глобальный»), что misleading.
  // "Remove" остаётся видимым — clearing override семантически валиден в любом случае.
  const useGlobalBtn = $("cbgUseGlobalBtn");
  if (useGlobalBtn) useGlobalBtn.classList.toggle("hidden", !getGlobalBg());
  const m = $("chatBgModal"); const cEl = $("cbgStatus");
  if (cEl && m && m.dataset.chatkey) {
    const per = getChatBg(m.dataset.chatkey);
    const hasPB = !!(per && per.startsWith("data:"));
    const hasG = !!getGlobalBg();
    let k;
    if (hasPB) k = "bg_status_per_chat";
    else if (hasG) k = "bg_per_chat_use_global_help";
    else k = "bg_status_none";
    cEl.textContent = t(k);
  }
}
// Превью-thumbnails (если картинка загружена) — в обеих UI локациях.
function renderBgPreviews() {
  const globalP = $("bgGlobalPreview"); if (globalP) {
    globalP.innerHTML = "";
    const u = getGlobalBg();
    if (u) { const img = document.createElement("img"); img.src = u; globalP.appendChild(img); }
    // Явный класс вместо `:not(:empty)` — последний ломается от любого whitespace внутри
    // блока, который легко залетает через VS Code "format on save" / prettier-html.
    globalP.classList.toggle("has-img", !!u);
  }
  const chatP = $("cbgPreview"); const m = $("chatBgModal");
  if (chatP && m && m.dataset.chatkey) {
    chatP.innerHTML = "";
    const u = resolveBgForChat(m.dataset.chatkey);
    if (u) { const img = document.createElement("img"); img.src = u; chatP.appendChild(img); }
    chatP.classList.toggle("has-img", !!u);
  }
}
// Глобальная фон-секция (Settings → Themes): wire кнопок и загрузку файла.
$("bgChooseGlobal") && ($("bgChooseGlobal").onclick = () => $("bgFileGlobal")?.click());
$("bgFileGlobal") && $("bgFileGlobal").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  const err = $("bgGlobalError"); if (err) err.textContent = "";
  if (f.size > BG_MAX_BYTES) { if (err) err.textContent = t("bg_too_big"); e.target.value = ""; return; }
  const r = new FileReader();
  r.onload = () => {
    if (!setGlobalBg(r.result)) { if (err) err.textContent = t("bg_quota"); return; }
    renderBgPreviews(); applyWallpaper();
  };
  r.onerror = () => { if (err) err.textContent = "Read error"; };
  r.readAsDataURL(f); e.target.value = "";
});
$("bgRemoveGlobal") && ($("bgRemoveGlobal").onclick = () => { setGlobalBg(null); renderBgPreviews(); applyWallpaper(); });

// Per-chat wallpaper modal: open/close + file upload + удалить override + сбросить на глобальный.
// modal.dataset.chatkey хранит текущий ключ комнаты (chatKey) — ставим при open, чистим при close.
function openChatBgModal() {
  if (!myRoom) return;
  const m = $("chatBgModal"); if (!m) return;
  m.dataset.chatkey = myRoom;
  renderBgPreviews(); refreshBgStatusTexts(); m.classList.remove("hidden");
}
function closeChatBgModal() {
  const m = $("chatBgModal"); if (m) { m.removeAttribute("data-chatkey"); m.classList.add("hidden"); }
}
$("cbgCloseBtn") && ($("cbgCloseBtn").onclick = closeChatBgModal);
$("chatBgModal") && $("chatBgModal").addEventListener("click", (e) => { if (e.target === $("chatBgModal")) closeChatBgModal(); });
// Esc отдельно ловим здесь, чтобы не конфликтовать с существующим Escape-listener на lightbox/createGroupModal
// (каждый modal сам проверяет свою открытость).
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("chatBgModal").classList.contains("hidden")) closeChatBgModal(); });
$("cbgChooseBtn") && ($("cbgChooseBtn").onclick = () => $("bgFileChat")?.click());
$("bgFileChat") && $("bgFileChat").addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  const err = $("cbgError"); if (err) err.textContent = "";
  if (f.size > BG_MAX_BYTES) { if (err) err.textContent = t("bg_too_big"); e.target.value = ""; return; }
  const key = $("chatBgModal").dataset.chatkey; if (!key) return;
  const r = new FileReader();
  r.onload = () => {
    if (!setChatBg(key, r.result)) { if (err) err.textContent = t("bg_quota"); return; }
    renderBgPreviews(); applyWallpaper(); refreshBgStatusTexts();
  };
  r.onerror = () => { if (err) err.textContent = "Read error"; };
  r.readAsDataURL(f); e.target.value = "";
});
// «Remove» — снимает override для текущего чата. Если глобальный фон задан, chat
// автоматически перейдёт на него (resolveBgForChat). Если глобального нет — уйдёт
// в тему по умолчанию.
$("cbgClearBtn") && ($("cbgClearBtn").onclick = () => {
  const key = $("chatBgModal").dataset.chatkey; if (!key) return;
  setChatBg(key, null); renderBgPreviews(); applyWallpaper(); refreshBgStatusTexts();
});
// «Use global background» — то же действие семантически (снять override). Дублируем
// для UX ясности. Если нет глобального, перейдёт на тему по умолчанию.
$("cbgUseGlobalBtn") && ($("cbgUseGlobalBtn").onclick = () => {
  const key = $("chatBgModal").dataset.chatkey; if (!key) return;
  setChatBg(key, null); renderBgPreviews(); applyWallpaper(); refreshBgStatusTexts();
});
// При смене языка — пере-отрисовать status-строки wallpaper-UI (они написаны напрямую
// через t(), а не через data-i18n, поэтому applyI18n не подхватит).
window.addEventListener("langchange", refreshBgStatusTexts);

// ---------- Темы ----------

// ---------- Темы ----------
// 5 pre-stabilized themes. Matrix — дефолт; legacy "contrast"/"high_contrast" localStorage
// значения мигрируются в "matrix" в applyTheme() ниже. swatch = [accent1, accent2, accent3, bg]
// — 4 цвета для превью-полоски в #themeGrid.
const THEMES = [
  { key: "matrix",    name: "theme_matrix",    desc: "theme_desc_matrix",    swatch: ["#00ff5a", "#88ffaa", "#b6ffd2", "#000000"] },
  { key: "mono",      name: "theme_mono",      desc: "theme_desc_mono",      swatch: ["#ffffff", "#cccccc", "#888888", "#000000"] },
  { key: "midnight",  name: "theme_midnight",  desc: "theme_desc_midnight",  swatch: ["#5a8aff", "#88aedb", "#3868d8", "#0a0e1c"] },
  { key: "dracula",   name: "theme_dracula",   desc: "theme_desc_dracula",   swatch: ["#bd93f9", "#ff79c6", "#8be9fd", "#21222c"] },
  { key: "flashbang", name: "theme_flashbang", desc: "theme_desc_flashbang", swatch: ["#16a34a", "#16a34a", "#111827", "#ffffff"] },
];
function applyTheme(key) {
  // Legacy "contrast"/"high_contrast" → matrix (migration for users with old localStorage);
  // unknown keys → matrix. Custom themes no longer exist, so we don't try to remap those.
  if (key === "contrast" || key === "high_contrast") key = "matrix";
  else if (!THEMES.find((x) => x.key === key)) key = "matrix";
  document.body.dataset.theme = key;
  try { localStorage.setItem("dialog_theme", key); } catch {}
  const grid = $("themeGrid");
  if (grid) grid.querySelectorAll(".theme-opt").forEach((o) => o.classList.toggle("active", o.dataset.theme === key));
}
// Restore theme from localStorage on init WITHOUT triggering the flashbang easter egg.
// Reads the saved key and stamps body[data-theme] directly. Invalid/missing keys leave
// the attribute empty, so :root defaults (matrix-style tokens) apply — same as before
// this fix, except now an actual saved pick keeps across reloads.
// User-facing theme entry. For every theme except flashbang, just applyTheme() directly.
  // For flashbang, open the centered confirmation modal first; only on confirm do we call
  // applyTheme() (which then runs maybeFlashbangEgg() after the 2s timer). loadSavedTheme()
  // still calls applyTheme() directly so init restore never shows the modal.
  function selectTheme(key) {
    if (key === "flashbang") {
      openFlashbangConfirm(() => applyTheme(key));
      return;
    }
    applyTheme(key);
  }
  // Show the centered flashbang confirm dialog with a "Don't show again" checkbox.
  // Skips the dialog entirely if the user previously checked the box.
  // Closes on: Yes, Cancel, ✕, backdrop click, Escape. Idempotent.
  // Auto-focuses the Yes button so Enter confirms without tabbing.
  const FLASHBANG_CONFIRM_KEY = "dialog_fb_confirm";
  function flashbangConfirmSkipped() {
    try { return localStorage.getItem(FLASHBANG_CONFIRM_KEY) === "1"; } catch { return false; }
  }
  function openFlashbangConfirm(onConfirm) {
    if (flashbangConfirmSkipped()) { if (onConfirm) onConfirm(); return; }
    const m = $("flashbangConfirmModal");
    if (!m) return;
    if (!m.classList.contains("hidden")) return;
    const yesBtn   = $("flashbangConfirmYes");
    const noBtn    = $("flashbangConfirmNo");
    const closeBtn = $("flashbangConfirmClose");
    const cb       = $("flashbangDontShow");
    const onYes  = () => { m.classList.add("hidden"); cleanup(); if (cb && cb.checked) try { localStorage.setItem(FLASHBANG_CONFIRM_KEY, "1"); } catch {} if (onConfirm) onConfirm(); };
    const onNo   = () => { m.classList.add("hidden"); cleanup(); };
    const onKey  = (e) => { if (e.key === "Escape") onNo(); };
    const onBack = (e) => { if (e.target === m) onNo(); };
    function cleanup() {
      if (yesBtn)   yesBtn.removeEventListener("click", onYes);
      if (noBtn)    noBtn.removeEventListener("click", onNo);
      if (closeBtn) closeBtn.removeEventListener("click", onNo);
      document.removeEventListener("keydown", onKey);
      m.removeEventListener("click", onBack);
    }
    m.classList.remove("hidden");
    if (yesBtn)   yesBtn.addEventListener("click", onYes);
    if (noBtn)    noBtn.addEventListener("click", onNo);
    if (closeBtn) closeBtn.addEventListener("click", onNo);
    document.addEventListener("keydown", onKey);
    m.addEventListener("click", onBack);
    if (yesBtn) yesBtn.focus();
  }
    function loadSavedTheme() {
  try {
    const saved = localStorage.getItem("dialog_theme");
    if (saved && THEMES.find((x) => x.key === saved)) document.body.dataset.theme = saved;
  } catch {}
}



function renderThemes() {
  const grid = $("themeGrid");
  if (!grid) return;
  grid.querySelectorAll(".theme-opt").forEach((el) => el.remove());
  // Loop var MUST not be `t` — local `t` would shadow window.t() (i18n) and the
  // first `t("theme_" + …)` would throw, leaving the theme grid empty.
  for (const theme of THEMES) {
    const b = document.createElement("button");
    b.className = "theme-opt";
    b.dataset.theme = theme.key;
    b.type = "button";
    b.innerHTML = `<div class="theme-swatch">${theme.swatch.map((c) => `<span style="background:${c}"></span>`).join("")}</div><span class="theme-name">${escapeHtml(window.t("theme_" + theme.key))}</span><span class="theme-desc">${escapeHtml(window.t("theme_desc_" + theme.key))}</span>`;
    b.onclick = () => selectTheme(theme.key);
    grid.appendChild(b);
  }
  // Highlight active
  const active = document.body.dataset.theme;
  grid.querySelectorAll(".theme-opt").forEach((o) => o.classList.toggle("active", o.dataset.theme === active));
}




// ---------- Язык ----------
function initLang() {
  const v = window.getLang();
  const sel = $("settingsLang");
  if (sel) { sel.value = v; sel.onchange = () => window.setLang(sel.value); }
  applyI18n();
}
window.addEventListener("langchange", () => {
  const sel = $("settingsLang");
  if (sel) sel.value = window.getLang();
  renderChatList($("searchInput").value);
  applyI18n(document.querySelector('[data-pane="themes"]'));
  updateCallButton();
  pushState();
});

// ---------- API ----------
async function api(path, body, method = "POST") {
  const res = await fetch(path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { ok: res.ok, data: await res.json().catch(() => ({})) };
}

// ---------- Аутентификация ----------
document.querySelectorAll(".auth-tab").forEach((tab) => tab.onclick = () => {
  document.querySelectorAll(".auth-tab").forEach((x) => x.classList.toggle("active", x === tab));
  $("loginForm").classList.toggle("hidden", tab.dataset.mode !== "login");
  $("registerForm").classList.toggle("hidden", tab.dataset.mode !== "register");
});
$("loginForm").onsubmit = async (e) => {
  e.preventDefault(); const f = e.target;
  const { ok, data } = await api("/api/login", { login: f.login.value.trim(), password: f.password.value });
  if (!ok) { $("loginError").textContent = data.error || t("err_login_failed"); return; }
  onAuth(data);
};
$("registerForm").onsubmit = async (e) => {
  e.preventDefault(); const f = e.target;
  if (f.password.value !== f.password2.value) { $("registerError").textContent = t("err_pass_mismatch"); return; }
  const { ok, data } = await api("/api/register", { name: f.name.value.trim(), login: f.login.value.trim(), password: f.password.value });
  if (!ok) { $("registerError").textContent = data.error || t("err_register_failed"); return; }
  onAuth(data);
};
function onAuth({ token: tk, profile: p }) { token = tk; profile = p; localStorage.setItem("dialog_token", tk); enterApp(); }
function showLogin() {
  $("loginLoading").classList.add("hidden");
  $("loginAuth").classList.remove("hidden");
}
async function checkSession() {
  // Save the current URL route before any auth redirect — so after login we can
  // jump straight to the intended DM/group instead of staring at the empty app.
  const route = window.parsePath ? parsePath() : { lang: null, login: null, groupId: null };
  if (route.login || route.groupId) sessionStorage.setItem("dialog_route", JSON.stringify(route));
  if (!token) { showLogin(); return; }
  const { ok, data } = await api("/api/me", null, "GET");
  if (ok) { profile = data.profile; enterApp(); } else { localStorage.removeItem("dialog_token"); showLogin(); }
}

function enterApp() {
  myName = profile.name; myStatus = profile.status || "online"; myDesc = profile.description || "";
  presence.set(profile.login, myStatus === "invisible" ? "offline" : myStatus);
  $("login").classList.add("hidden"); $("app").classList.remove("hidden");
  $("myName").textContent = myName; setMyAvatar(); renderMeStatus();
  socket.emit("identify", { token });
  loadDevicePrefs();
  loadStoredChats(); loadGroups(); loadRelations(); renderChatList();
  refreshPresence(); // начальный снимок присутствия для DM/друзей; дальше клиент держится за socket «presence» ивенты — 25-сек poll убран, иначе он ре-фетчил /api/avatar моей авы в холодном HTTP-кеше (см. updateDots ниже).
  initPush(); requestMediaPermissions();
  // Если пользователь пришёл по ?invite= ссылке (код лежит в sessionStorage), redeem'им сейчас —
  // это первая пост-логин точка где есть валидный Authorization для /api/groups/redeem.
  redeemStoredInvite();
  // Initial URL route (DM/group from path) — runs after chats/groups are loaded.
  // Prefer a previously saved route (set before auth redirect) over the current URL,
  // so a reload while logged out still opens the right chat after login.
  let route;
  try { route = JSON.parse(sessionStorage.getItem("dialog_route")); } catch {}
  if (!route || (!route.login && !route.groupId)) route = window.parsePath ? parsePath() : { lang: null, login: null, groupId: null };
  sessionStorage.removeItem("dialog_route");
  if (route.lang && window.setLang) window.setLang(route.lang);
  if (route.login && window.openDM) {
    const key = "@dm:" + [profile.login, route.login].sort().join("~");
    const existing = chats.get(key);
    if (existing) openChat(existing);
    else openDM(route.login);
  } else if (route.groupId) {
    const key = "@grp:" + route.groupId;
    const existing = chats.get(key);
    if (existing) openChat(existing);
  }
}
socket.on("connect", () => {
  if (!token) return;
  socket.emit("identify", { token });
  if (myRoom) socket.emit("join", { token, room: myRoom });
  // звонок (LiveKit) переподключается сам — наш сокет лишь восстанавливает чат
});
socket.on("auth-error", () => { localStorage.removeItem("dialog_token"); location.reload(); });

// ---------- Хранилище чатов (ЛС на сервере + localStorage fallback) ----------
const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || "[]"); } catch { return []; } };
const lsSet = (k, v) => localStorage.setItem(k, JSON.stringify(v));
function dmKey(login) { return "@dm:" + [profile.login, login].sort().join("~"); }
let _dmsSynced = false;
function loadStoredChats() {
  lsGet("dialog_dms").forEach((c) => chats.set(c.key, c));
  loadPins();
  if (!_dmsSynced) { _dmsSynced = true; syncDMsFromServer(); }
}
function savePins() { lsSet("dialog_pins", [...chats.values()].filter((c) => c.pinned).map((c) => c.key)); }
function loadPins() { const pinned = new Set(lsGet("dialog_pins")); for (const c of chats.values()) c.pinned = pinned.has(c.key); }
function upsertChat(c) { const ex = chats.get(c.key); if (ex) { Object.assign(ex, { name: c.name || ex.name, ts: c.ts || ex.ts }); return ex; } chats.set(c.key, c); return c; }
async function syncDMsFromServer() {
  const { ok, data } = await api("/api/dms", null, "GET");
  if (!ok || !Array.isArray(data)) return;
  const localKeys = new Set([...chats.values()].filter((c) => c.type === "dm").map((c) => c.key));
  for (const d of data) {
    if (!localKeys.has(d.key)) chats.set(d.key, d);
  }
  _dmsSynced = true;
  renderChatList($("searchInput").value);
}
async function persistDMs() {
  const dms = [...chats.values()].filter((c) => c.type === "dm").slice(0, 50);
  lsSet("dialog_dms", dms);
  await api("/api/dms", { dms });
}
async function loadGroups() {
  const { ok, data } = await api("/api/groups", null, "GET");
  if (!ok) return;
  data.groups.forEach((g) => { const key = "@grp:" + g.id; if (!chats.has(key)) chats.set(key, { key, type: "group", id: g.id, name: g.name, last: "", ts: 0, unread: 0, pinned: false }); });
  loadPins();
  renderChatList($("searchInput").value);
}
function isMuted(room) { return lsGet("dialog_muted").includes(room); }
function toggleMute(room) { const m = lsGet("dialog_muted"); const i = m.indexOf(room); if (i === -1) m.push(room); else m.splice(i, 1); lsSet("dialog_muted", m); }

function preview(m) {
  if (!m) return "";
  if (m.type === "text") return m.text;
  if (m.type === "image" || m.type === "gif") return "🖼 " + t("pv_photo");
  if (m.type === "video") return "🎬 " + t("pv_video");
  if (m.type === "audio") return "🎤 " + t("pv_voice");
  if (m.type === "file") return "📎 " + (m.mediaName || t("pv_file"));
  return "media";
}

// ---------- Статусы доставки / просмотра ----------
function refreshOutgoingStatuses() {
  if (!messagesEl) return;
  messagesEl.querySelectorAll(".msg.me").forEach(statusOf);
}
function statusOf(el) {
  if (!el.classList.contains("me")) return;
  const id = Number(el.dataset.id) || 0;
  const acked = el.dataset.acked === "1";
  // Кэшируем <span.status> на самом элементе — на большой ленте это снимает сотни querySelector за один watermark-event.
  const icon = el._statusIcon || (el._statusIcon = el.querySelector(".msg-status"));
  if (!icon) return;
  if (!acked || !id) { setStatus(icon, "pending"); return; }
  const others = othersInRoom();
  if (!others.length) { setStatus(icon, "sent"); return; }
  let minDelivered = Infinity, minSeen = Infinity;
  for (const l of others) {
    const w = watermarks.get(l);
    if (!w) { minDelivered = 0; minSeen = 0; break; }
    if (w.delivered < minDelivered) minDelivered = w.delivered;
    if (w.seen < minSeen) minSeen = w.seen;
  }
  if (minSeen >= id) setStatus(icon, "read");
  else if (minDelivered >= id) setStatus(icon, "delivered");
  else setStatus(icon, "sent");
}
// Статусы доставки монотонны: галочки «не откатываются» назад при обновлении курсоров.
// pending (0) → sent (1) → delivered (2) → read (3). Достигнутый максимум сохраняется.
const STATUS_RANK = { pending: 0, sent: 1, delivered: 2, read: 3 };
function setStatus(iconEl, status) {
  if (!iconEl) return;
  const cur = iconEl.dataset.status || "pending";
  if (STATUS_RANK[status] <= STATUS_RANK[cur]) return; // постоянное состояние — не понижаем
  iconEl.dataset.status = status;
  if (status === "pending") iconEl.innerHTML = window.ICON.clock;     // ⏱ печатаем/ждём
  else if (status === "read") iconEl.innerHTML = window.ICON.checkCheck; // ✓✓ только когда ПРОЧИТАНО
  else iconEl.innerHTML = window.ICON.check;                          // ✓ sent/delivered — одинарная
  iconEl.title = t("status_" + status);
}
function othersInRoom() {
  if (!myRoom) return [];
  if (curKind === "dm") {
    const partner = myRoom.slice(4).split("~").find((l) => l !== profile.login);
    return partner ? [partner] : [];
  }
  // group: все из groupMembers + присоединившиеся peers
  const set = new Set();
  if (Array.isArray(groupMembers)) for (const m of groupMembers) if (m.login !== profile.login) set.add(m.login);
  peers.forEach((v) => { if (v.login && v.login !== profile.login) set.add(v.login); });
  return [...set];
}
function lastVisiblePartnerId() {
  // id последнего НЕ-нашего сообщения в ленте — до этой точки помечаем «доставлено/просмотрено».
  const els = messagesEl.querySelectorAll(".msg");
  for (let i = els.length - 1; i >= 0; i--) {
    const el = els[i]; if (el.classList.contains("me")) continue;
    const id = Number(el.dataset.id) || 0; if (id) return id;
  }
  return 0;
}
function markDeliveredSeenUpToLast() {
  const id = lastVisiblePartnerId();
  if (id && !isDnd() && myRoom) {
    socket.emit("delivery", { maxId: id });
    if (document.visibilityState === "visible") socket.emit("seen", { maxId: id });
  }
}
function renderChatList(filter = "") {
  const ul = $("chatList"); ul.innerHTML = ""; filter = filter.toLowerCase();
  const list = [...chats.values()].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return (b.ts || 0) - (a.ts || 0);
  });
  let shown = 0;
  for (const c of list) {
    if (filter && !(c.name || "").toLowerCase().includes(filter)) continue;
    if (chatTypeFilter === "pinned") {
      if (!c.pinned) continue;
    } else if (chatTypeFilter === "online") {
      if (c.type === "group") { /* always show groups */ }
      else if (c.type === "dm" && presence.get(c.login) !== "online" && presence.get(c.login) !== "dnd") continue;
      else if (c.type !== "dm") continue;
    } else if (chatTypeFilter !== "all" && c.type !== chatTypeFilter) continue;
    shown++;
    const li = document.createElement("li");
    li.className = "chat-item" + (c.key === activeKey ? " active" : "") + (c.pinned ? " pinned" : "");
    li._chatKey = c.key; // метка для быстрого in-place обновления точек (см. updateDots)
    const dot = c.type === "dm" ? `<span class="st-dot ci-status st-${statusClass(presence.get(c.login))}"></span>` : "";
    const avaInner = c.type === "group"
      ? `<img src="/api/group-avatar/${c.id}?v=${avaVer}" onerror="this.onerror=null;this.src='/src/group.svg'">`
      : `<img src="${avaUrl(c.login)}" onerror="this.remove()">${initials(c.name)}`;
    li.innerHTML = `<div class="ava-wrap"><div class="avatar ${c.type === "group" ? "grp" : ""}" ${c.type === "dm" ? `data-login="${c.login}"` : ""}>${avaInner}</div>${dot}</div>
      <div class="ci-body"><div class="ci-top"><span class="ci-name">${escapeHtml(c.name)}</span><span class="ci-pin" data-key="${c.key}"><svg viewBox="0 0 16 16" width="12" height="12"><path d="${c.pinned ? 'M9.5 1.5v5l2 2v1h-3.5v6h-1v-6H3.5v-1l2-2v-5h.5V1h4v.5h.5z' : 'M9.5 1.5v5l2 2v1h-3.5v6h-1v-6H3.5v-1l2-2v-5h.5V1h4v.5h.5z'}" fill="${c.pinned ? '#fff' : 'none'}" stroke="#888" stroke-width="1.2"/></svg></span><span class="ci-time">${c.ts ? fmtTime(c.ts) : ""}</span></div>
      <div class="ci-bot"><span class="ci-last">${escapeHtml(c.last || "")}</span>${c.unread ? `<span class="badge">${c.unread}</span>` : `<span class="ci-del" title="${t("delete_chat")}">✕</span>`}</div></div>`;
    // Клавиатурная навигация по списку чатов: Tab → focus (зелёное кольцо из .chat-item:focus-visible),
    // Enter/Space → то же, что и клик (открыть чат), Delete/Backspace → то же, что и клик по крестику.
    // Сам крестик — <span.c i-del> без tabindex, поэтому курсором он недоступен; это запасной клавиатурный путь.
    li.tabIndex = 0; li.setAttribute("role", "button");
    li.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (e.target.closest(".ci-del")) { deleteChat(c); return; }
        openChat(c);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        // Дребезг автоповтора клавиши: key-repeat (~30 Гц) иначе завалит очередь confirm()/deleteChat().
        // Пер-ли кешем — соседние строки под Дел не теряются.
        if (e.timeStamp - (li._lastDelete || 0) < 150) return;
        li._lastDelete = e.timeStamp;
        deleteChat(c);
      }
    };
    li.onclick = (e) => {
      if (e.target.closest(".ci-del")) { e.stopPropagation(); deleteChat(c); return; }
      if (e.target.closest(".ci-pin")) { e.stopPropagation(); togglePin(c); return; }
      openChat(c);
    };
    ul.appendChild(li);
  }
  $("chatsEmpty").classList.toggle("hidden", shown > 0);
}
function togglePin(c) {
  c.pinned = !c.pinned;
  savePins();
  renderChatList($("searchInput").value);
}
function deleteChat(c) {
  if (c.type === "group") { if (!confirm(t("leave_group"))) return; api("/api/groups/" + c.id + "/leave"); chats.delete(c.key); persistDMs(); savePins(); if (c.key === activeKey) resetToEmpty(); renderChatList($("searchInput").value); return; }
  const modal = $("deleteChatModal");
  const doDelete = (everyone) => {
    modal.classList.add("hidden");
    clearedChats.set(c.key, Date.now()); persistCleared();
    if (everyone) api("/api/room/" + encodeURIComponent(c.key) + "/delete", null, "POST");
    chats.delete(c.key);
    persistDMs(); savePins();
    if (c.key === activeKey) resetToEmpty();
    renderChatList($("searchInput").value);
  };
  modal.querySelector("#deleteChatMe").onclick = () => doDelete(false);
  modal.querySelector("#deleteChatEveryone").onclick = () => doDelete(true);
  modal.querySelector("#deleteChatClose").onclick = () => modal.classList.add("hidden");
  modal.onclick = (e) => { if (e.target === modal) modal.classList.add("hidden"); };
  modal.classList.remove("hidden");
}
function resetToEmpty() { activeKey = myRoom = ""; $("chatHead").classList.add("hidden"); $("messages").classList.add("hidden"); $("composer").classList.add("hidden"); $("emptyState").classList.remove("hidden"); const bn = document.getElementById("blockNotice"); if (bn) bn.remove(); applyWallpaper(); }

// ---------- Открытие чата ----------
function openChat(c) {
  c = upsertChat(c);
  activeKey = c.key; myRoom = c.key; curKind = c.type; curTitle = c.name; c.unread = 0;
  dismissNotif(c.key);
  socket.emit("join", { token, room: c.key }); // звонок НЕ завершаем — он живёт отдельно
  watermarkSnapshotApplied = false; // следующий watermark-снимок — это первый для новой комнаты, пересчитываем
  setTimeout(() => markDeliveredSeenUpToLast(), 300); // отметить переписку как доставленную/просмотренную
  $("emptyState").classList.add("hidden");
  $("chatHead").classList.remove("hidden"); $("messages").classList.remove("hidden"); $("composer").classList.remove("hidden");
  $("messages").innerHTML = "";
  $("chatTitle").textContent = c.name;
  if (c.type === "group") {
    $("chatSub").textContent = t("room_sub_group");
  } else {
    const st = presence.get(c.login);
    $("chatSub").textContent = st ? t("status_" + st) : t("room_sub_dm");
  }
  $("chatAva").className = "avatar ch-ava" + (c.type === "group" ? " grp" : "");
  $("chatAva").setAttribute("data-login", c.type === "dm" ? c.login : "");
  if (c.type === "group") {
    $("chatAva").innerHTML = `<img src="/api/group-avatar/${c.id}?v=${avaVer}" onerror="this.onerror=null;this.src='/src/group.svg'">`;
  } else {
    const st = presence.get(c.login);
    $("chatAva").innerHTML = `<img src="${avaUrl(c.login)}" onerror="this.remove()">${initials(c.name)}<span class="st-dot ch-status st-${statusClass(st)}"></span>`;
  }
  // Title для чат-аватара: DM → open_profile (мини-профиль собеседника), группа → settings overlay
  // (пейн «groups»). Ставим напрямую .title — applyI18n() бежит только в init, поэтому меняем
  // по факту смены чата, а не через data-i18n-title.
  $("chatAva").title = t(c.type === "group" ? "group_settings" : "open_profile");
  $("muteBtn").innerHTML = isMuted(c.key) ? window.ICON.bellOff : window.ICON.bell;
  syncBlockComposer();
  $("app").classList.add("in-chat");
  // боковая панель участников для групп (на десктопе)
  groupMembers = [];
  $("infoBtn").classList.toggle("hidden", c.type !== "group");
  if (c.type === "group") { loadGroupMembers(); if (!isMobile()) { $("infoTitle").textContent = t("info"); $("infoPanel").classList.remove("hidden"); } }
  else if (c.type === "dm") $("infoPanel").classList.add("hidden");
  renderChatList($("searchInput").value);
  if (call.active && c.key === call.roomKey) call.minimized = false; // вернулись в чат звонка
  syncCallUI(); updateCallButton();
  applyWallpaper();  // per-chat→global wallpaper resolution, вызывается при каждой смене чата
  pushState();
}
function syncBlockComposer() {
  if (!myRoom || !myRoom.startsWith("@dm:")) return;
  const partner = myRoom.slice(4).split("~").find((l) => l !== profile.login);
  const isBlocked = partner && blocked.has(partner);
  const isBlockedBy = partner && blockedBy.has(partner);
  const blockedMsg = isBlockedBy ? t("blocked_by_user") : isBlocked ? t("blocked_msg_send") : "";
  if (blockedMsg) {
    $("composer").classList.add("hidden");
    let bn = document.getElementById("blockNotice");
    if (!bn) { bn = document.createElement("div"); bn.id = "blockNotice"; bn.className = "block-notice"; $("messages").after(bn); }
    bn.textContent = blockedMsg;
  } else {
    $("composer").classList.remove("hidden");
    const bn = document.getElementById("blockNotice"); if (bn) bn.remove();
  }
}
$("backBtnMobile").onclick = $("esBackBtn").onclick = () => { $("app").classList.remove("in-chat"); activeKey = ""; renderChatList($("searchInput").value); };
$("muteBtn").onclick = () => { if (!myRoom) return; toggleMute(myRoom); $("muteBtn").innerHTML = isMuted(myRoom) ? window.ICON.bellOff : window.ICON.bell; };
$("infoBtn").onclick = () => { if (!myRoom) return; renderMembers(); $("infoTitle").textContent = t("info"); $("infoPanel").classList.toggle("hidden"); };
$("infoClose").onclick = () => $("infoPanel").classList.add("hidden");

// ---------- Меню чата (⋮) ----------
$("chatMenuBtn").onclick = (e) => {
  e.stopPropagation(); const menu = $("chatMenu");
  if (!menu.classList.contains("hidden")) { menu.classList.add("hidden"); return; }
  menu.innerHTML = "";
  const item = (label, icon, fn, danger) => { const b = document.createElement("button"); if (danger) b.className = "danger"; b.innerHTML = (window.ICON[icon] || "") + "<span>" + label + "</span>"; b.onclick = () => { menu.classList.add("hidden"); fn(); }; menu.appendChild(b); };
  if (curKind === "group") {
    // Wallpaper — первым пунктом (эстетический, не чат-контроль). Пункты ниже — control.
    item(t("chat_wallpaper"), "image", () => openChatBgModal());
    // Не-овнер может предложить участника; овнеру предлагать не нужно (у него есть + в панели info).
    if (!groupOwner) item(t("suggest_member_btn"), "userPlus", () => openAddMembers());
    item(t("group_settings"), "settings", () => openSettings("groups"));
    item(t("leave_group_btn"), "phoneOff", () => { if (confirm(t("leave_group"))) leaveCurrentGroup(); }, true);
  } else if (curKind === "dm") {
    // DM background — первым пунктом (эстетика выше блокировки).
    item(t("chat_wallpaper"), "image", () => openChatBgModal());
    const partner = myRoom.slice(4).split("~").find((l) => l !== profile.login);
    const isB = blocked.has(partner);
    item(isB ? t("unblock_user") : t("block_user"), "block", () => block(partner, isB ? "unblock" : "block"), !isB);
    item(t("delete_chat"), "trash", () => { const c = chats.get(myRoom); if (c) deleteChat(c); }, true);
  }
  menu.classList.remove("hidden");
  // позиционируем фикс-меню под кнопкой, прижимая к правому краю (не вылезает за экран)
  const r = $("chatMenuBtn").getBoundingClientRect();
  menu.style.top = (r.bottom + 4) + "px";
  menu.style.left = Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8)) + "px";
};
document.addEventListener("click", (e) => { if (!e.target.closest(".chat-menu-wrap") && !e.target.closest(".chat-menu")) $("chatMenu").classList.add("hidden"); });
function leaveCurrentGroup() { const c = chats.get(myRoom); if (c) deleteChat(c); }

// ---------- Добавление/предложение участников (group) ----------
// Отдельная точка фхода от ⋮-меню и + над участниками → #addMemberModal. Один пейлоад, но ДВА
// режима: amMode='add' для овнера (POST /members), amMode='suggest' для не-овнера (POST /suggest),
// который создаёт заявку в pending-очередь и ждёт одобрения. gmAdd локально хранит выбранных.
let gmAdd = new Set();
let amMode = "add";     // 'add' | 'suggest' — определяется в openAddMembers() по data.owner
function syncAddMemberUI() {
  // Только овнер текущей открытой группы видит infoAddBtn (быстрое добавление). НЕ-овнер использует
  // только эту же модалку через ⋮-меню (suggest-режим) — так что infoAddBtn остатётся владельческим.
  const show = curKind === "group" && groupOwner;
  const infoBtn = $("infoAddBtn"); if (infoBtn) infoBtn.classList.toggle("hidden", !show);
}
async function openAddMembers() {
  if (curKind !== "group") return;
  const id = myRoom.slice(5);
  const { ok, data } = await api("/api/groups/" + id, null, "GET");
  if (!ok) return;
  amMode = (data.owner === profile.login) ? "add" : "suggest";
  // Сервер тоже проверит на '/members', но мы заранее выбираем endpoint чтобы клиент не шёл POST
  // с пустой формой и не получал 403. amTargetLogin остаётся null (это не redeem-флоу).
  amTargetLogin = null;
  const memberSet = new Set((data.members || []).map((m) => m.login));
  gmAdd.clear();
  // Подтянем свежие relations, если friends не загружались — пикер бывает пуст от старта сессии.
  if (!relations.friends.length) await loadRelations();
  renderAmPicker([...relations.friends].filter((l) => !memberSet.has(l)));
  $("amError").textContent = "";
  // Заголовок и кнопка подписи зависят от режима (i18n).
  const title = $("addMemberModal").querySelector(".modal-title");
  if (title) title.textContent = t(amMode === "add" ? "add_members_title" : "suggest_members_title");
  $("amConfirm").textContent = t(amMode === "add" ? "add_member_btn" : "suggest_member_btn");
  $("amConfirm").disabled = true;
  $("addMemberModal").classList.remove("hidden");
}
function renderAmPicker(candidates) {
  const box = $("amPicker"); box.innerHTML = "";
  $("amEmpty").classList.toggle("hidden", candidates.length > 0);
  candidates.forEach((l) => {
    const b = document.createElement("button"); b.className = "fp-chip"; b.textContent = l;
    b.onclick = () => {
      if (gmAdd.has(l)) { gmAdd.delete(l); b.classList.remove("on"); }
      else { gmAdd.add(l); b.classList.add("on"); }
      $("amConfirm").disabled = gmAdd.size === 0;
    };
    box.appendChild(b);
  });
}
$("amCancel").onclick = () => $("addMemberModal").classList.add("hidden");
$("addMemberModal").addEventListener("click", (e) => { if (e.target === $("addMemberModal")) $("addMemberModal").classList.add("hidden"); });
$("infoAddBtn").onclick = () => openAddMembers();
$("amConfirm").onclick = async () => {
  $("amError").textContent = "";
  if (curKind !== "group" || !gmAdd.size) return;
  const id = myRoom.slice(5);
  if (amMode === "add") {
    const payload = { add: [...gmAdd] };
    const { ok, data } = await api("/api/groups/" + id + "/members", payload);
    if (!ok) { $("amError").textContent = data.error || "Couldn't add members"; return; }
    notify(t("add_member_btn") + ": " + payload.add.join(", "));
  } else {
    // suggest: comma-list на сервере перебирает и молча пропускает уже-участников / несуществующих.
    const payload = { target: [...gmAdd].join(",") };
    const { ok, data } = await api("/api/groups/" + id + "/suggest", payload);
    if (!ok) { $("amError").textContent = data.error || "error"; return; }
    notify(data?.created ? t("redeem_pending") : t("redeem_already"));
  }
  gmAdd.clear();
  $("addMemberModal").classList.add("hidden");
  loadGroupMembers();
  loadGroups();
};

// ---------- Настройки группы (живёт в settingsOverlay → пейн groups) ----------
let gsId = null, gsOwner = false, gsAvatar = null, gsAdd = new Set();
// Заполняет пейн groups в #settingsOverlay. Если группа не открыта — показывает placeholder.
async function populateGroupSettingsPane() {
  const placeholder = $("groupPanelPlaceholder"); const body = $("groupSettingsBody");
  if (curKind !== "group") {
    if (placeholder) placeholder.classList.remove("hidden");
    if (body) body.classList.add("hidden");
    return { ok: true, noGroup: true }; // placeholder — это успешный рендер (без API-вызова), кешируем
  }
  gsId = myRoom.slice(5); gsAvatar = null; gsAdd.clear();
  if (placeholder) placeholder.classList.add("hidden");
  if (body) body.classList.remove("hidden");
  const { ok, data } = await api("/api/groups/" + gsId, null, "GET");
  if (!ok) {
    const err = $("gsError"); if (err) err.textContent = t("err_load_group"); // без i18n — отдельный ключ «t(\"err_*\")» в словаре не подходит
    return { ok: false };
  }
  gsOwner = data.owner === profile.login;
  // 'is-owner' модификатор вешаем на сам #settingsOverlay вместо удалённого модала
  $("settingsOverlay").classList.toggle("is-owner", gsOwner);
  $("gsError").textContent = "";
  $("gsName").value = data.name; $("gsName").disabled = !gsOwner;
  $("gsAvaImg").src = "/api/group-avatar/" + gsId + "?v=" + Date.now();
  $("gsAvaImg").onerror = () => { $("gsAvaImg").style.display = "none"; $("gsAvaInit").style.display = "block"; };
  $("gsAvaImg").style.display = "block"; $("gsAvaInit").style.display = "none";
  const box = $("gsMembers"); box.innerHTML = "";
  data.members.forEach((m) => {
    const row = document.createElement("div"); row.className = "contact-row";
    const ownerTag = m.login === data.owner ? `<span class="owner-tag">(${t("owner")})</span>` : "";
    row.innerHTML = `<div class="avatar" data-login="${m.login}" style="width:30px;height:30px;font-size:13px"><img src="${avaUrl(m.login)}" onerror="this.remove()">${initials(m.name)}</div><span class="c-name">${escapeHtml(m.name)}</span>${ownerTag}`;
    if (gsOwner && m.login !== data.owner) { const b = document.createElement("button"); b.className = "danger"; b.textContent = t("remove"); b.onclick = () => removeGroupMember(m.login); row.appendChild(b); }
    box.appendChild(row);
  });
  const memberSet = new Set(data.members.map((m) => m.login));
  const addBox = $("gsAddPick"); addBox.innerHTML = "";
  relations.friends.filter((l) => !memberSet.has(l)).forEach((l) => {
    const b = document.createElement("button"); b.className = "fp-chip"; b.textContent = l;
    b.onclick = () => { if (gsAdd.has(l)) { gsAdd.delete(l); b.classList.remove("on"); } else { gsAdd.add(l); b.classList.add("on"); } };
    addBox.appendChild(b);
  });
  // Параллельный рефетч инвайтов + (если овнер) заявок сразу после основного рендера. Без
  // Promise.all пришлось бы делать последовательно — лишний RTT. Сетевые ошибки тихо проглатываем,
  // соответствующий раздел UI просто останется пустым (см. gsInviteEmpty / gsPendingEmpty).
  const [ir, pr] = await Promise.all([
    api("/api/groups/" + gsId + "/invites", null, "GET"),
    gsOwner ? api("/api/groups/" + gsId + "/pending", null, "GET") : Promise.resolve({ ok: false, data: {} }),
  ]);
  if (ir.ok) renderInviteList(ir.data.invites || []);
  if (gsOwner && pr.ok) renderPendingList(pr.data.pending || []);
  return { ok: true };
}
$("gsAvaBtn").onclick = () => $("gsAvaFile").click();
$("gsAvaFile").onchange = (e) => { const f = e.target.files[0]; if (!f) return; if (f.size > 5 * 1024 * 1024) { $("gsError").textContent = t("err_avatar_too_big"); return; } const r = new FileReader(); r.onload = () => { gsAvatar = r.result; $("gsAvaImg").src = r.result; $("gsAvaImg").style.display = "block"; $("gsAvaInit").style.display = "none"; }; r.readAsDataURL(f); };
$("gsSave").onclick = async () => {
  if (!gsOwner) return;
  const body = { name: $("gsName").value.trim() }; if (gsAvatar) body.avatar = gsAvatar;
  await api("/api/groups/" + gsId, body);
  if (gsAdd.size) await api("/api/groups/" + gsId + "/members", { add: [...gsAdd] });
  avaVer = Date.now(); closeSettings(); loadGroups();
};
async function removeGroupMember(login) { await api("/api/groups/" + gsId + "/members", { remove: login }); populateGroupSettingsPane(); }
$("gsLeave").onclick = () => { closeSettings(); if (confirm(t("leave_group"))) leaveCurrentGroup(); };
$("gsDelete").onclick = async () => { if (!gsOwner) return; if (!confirm(t("confirm_del_group"))) return; await api("/api/groups/" + gsId, null, "DELETE"); closeSettings(); };

// ---------- Group invites + pending queue (UI рисует; владельцу — pending, всем — инвайты) ----------
// Копирование в буфер с fallback на execCommand: navigator.clipboard требует user gesture и secure
// context, иначе promise reject — тогда используем textarea. В HTTP на ip-адресе это основной путь.
async function copyToClipboard(text) {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.left = "-9999px"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand("copy"); document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}
function renderInviteList(invites) {
  const box = $("gsInviteList"); if (!box) return;
  box.innerHTML = "";
  $("gsInviteEmpty").classList.toggle("hidden", invites.length > 0);
  // Все участники видят все активные коды (прозрачность внутри группы). Revoke — овнер (любые)
  // или сам создатель (свои).
  invites.forEach((inv) => {
    const row = document.createElement("div"); row.className = "contact-row";
    const creator = inv.creator_login;
    const label = creator === profile.login ? t("you_suffix") : creator;
    row.innerHTML = `<div class="avatar" data-login="${escapeHtml(creator)}" style="width:30px;height:30px;font-size:13px"><img src="${avaUrl(creator)}" onerror="this.remove()">${initials(creator)}</div><span class="c-name">${escapeHtml(label)}<span class="owner-tag" style="margin-left:6px">#${inv.id}</span></span>`;
    const canRevoke = gsOwner || creator === profile.login;
    if (canRevoke) {
      const b = document.createElement("button"); b.className = "danger"; b.textContent = t("invite_revoke");
      b.onclick = async () => {
        if (!confirm(t("invite_revoke") + "?")) return;
        await api("/api/groups/" + gsId + "/invites/" + inv.id, null, "DELETE");
        renderInviteList(invites.filter((x) => x.id !== inv.id));
      };
      row.appendChild(b);
    }
    box.appendChild(row);
  });
}
function renderPendingList(items) {
  const box = $("gsPendingList"); if (!box) return;
  box.innerHTML = "";
  $("gsPendingEmpty").classList.toggle("hidden", items.length > 0);
  items.forEach((p) => {
    const row = document.createElement("div"); row.className = "contact-row";
    const byName = p.invited_by === profile.login ? t("you_suffix") : p.invited_by;
    const label = p.name || p.login;
    row.innerHTML = `<div class="avatar" data-login="${escapeHtml(p.login)}" style="width:30px;height:30px;font-size:13px"><img src="${avaUrl(p.login)}" onerror="this.remove()">${initials(label)}</div><span class="c-name">${escapeHtml(label)}<span class="owner-tag" style="margin-left:6px">${escapeHtml(t("pending_by", { name: byName }))}</span></span>`;
    const a = document.createElement("button"); a.textContent = "✓"; a.style.color = "var(--accent-300)";
    a.title = t("pending_approve");
    a.onclick = () => resolvePending(p.id, "approve");
    row.appendChild(a);
    const d = document.createElement("button"); d.className = "danger"; d.textContent = "✕";
    d.title = t("pending_decline");
    d.onclick = () => resolvePending(p.id, "decline");
    row.appendChild(d);
    box.appendChild(row);
  });
}
async function resolvePending(pid, action) {
  if (action === "approve" && !confirm(t("pending_approve") + "?")) return;
  if (action === "decline" && !confirm(t("pending_decline") + "?")) return;
  const { ok, data } = await api("/api/groups/" + gsId + "/pending/" + pid, { action });
  if (!ok) { const e = $("gsInviteError"); if (e) e.textContent = data.error || "error"; return; }
  // approve триггерит server-side group-updated через addGroupMembers: loadGroupMembers всё равно
  // подхватит через socket; локальный рефетч pending ниже — UI сразу отражает решение.
  const { ok: okList, data: dataList } = await api("/api/groups/" + gsId + "/pending", null, "GET");
  if (okList) renderPendingList(dataList.pending || []);
  if (action === "approve") loadGroupMembers();
}
$("gsGenerateCode").onclick = async () => {
  $("gsInviteError").textContent = "";
  const { ok, data } = await api("/api/groups/" + gsId + "/invites", {});
  if (!ok) { $("gsInviteError").textContent = data.error || t("err_invite_create"); return; }
  // Endpoint возвращает plaintext ОДИН РАЗ (как пароль) — формируем полный URL и кладём в clipboard.
  // Fallback: буфер недоступен → показываем URL/код в тосте, чтобы пользователь мог скопировать вручную.
  const link = location.origin + (data.url || ("/?invite=" + encodeURIComponent(data.code || "")));
  const okCopy = await copyToClipboard(link);
  notify(t("invite_link_copied") + (okCopy ? "" : ": " + link));
  // Рефетч списка:创建атель увидит новую запись; revoke теперь доступен.
  const { ok: okList, data: dataList } = await api("/api/groups/" + gsId + "/invites", null, "GET");
  if (okList) renderInviteList(dataList.invites || []);
};
async function refreshGsLists(id) {
  // Работает только если активная группа соответствует интересующей И пейн groups сейчас открыт;
  // иначе пользователь не смотрит на UI — фоновый refresh будет лишней работой.
  if (curKind !== "group" || myRoom !== "@grp:" + id) return;
  if (!settingsOpen) return;
  const tab = $("settingsTabs")?.querySelector(".settings-tab.active")?.dataset.tab;
  if (tab !== "groups") return;
  const grpId = myRoom.slice(5);
  const [ir, pr] = await Promise.all([
    api("/api/groups/" + grpId + "/invites", null, "GET"),
    groupOwner ? api("/api/groups/" + grpId + "/pending", null, "GET") : Promise.resolve({ ok: false, data: {} }),
  ]);
  if (ir.ok) renderInviteList(ir.data.invites || []);
  if (groupOwner && pr.ok) renderPendingList(pr.data.pending || []);
}

// Capture URL ?invite=<code> на самом раннем этапе (top of file) — до login-flow. После авторизации
// enterApp() подхватит код из sessionStorage и вызовет redeemStoredInvite(). Сохраняем и снимаем
// query из адресной строки чтобы не «светить» код дальше по share.
function readInviteFromUrl() {
  try {
    const p = new URLSearchParams(location.search);
    const c = p.get("invite");
    if (!c) return;
    try { sessionStorage.setItem("dialog_inv", c); } catch {}
    try {
      const u = new URL(location.href);
      u.searchParams.delete("invite");
      const next = u.pathname + (u.searchParams.toString() ? "?" + u.searchParams.toString() : "") + u.hash;
      history.replaceState(null, "", next);
    } catch {}
  } catch {}
}
async function redeemStoredInvite() {
  let code;
  try { code = sessionStorage.getItem("dialog_inv"); } catch {}
  if (!code) return;
  // Удаляем сразу — при retry ниже (loginRequired) положим обратно. Защита от двойного POST.
  try { sessionStorage.removeItem("dialog_inv"); } catch {}
  const { ok, data } = await api("/api/groups/redeem", { code });
  if (!ok) return;
  if (data.loginRequired) {
    // Не залогинен — пусть висит до следующего enterApp(). Если token вообще нет, UI логина
    // покажется и пользователь сам выберет регистрацию или вход.
    try { sessionStorage.setItem("dialog_inv", code); } catch {}
    return;
  }
  if (data.status === "already") {
    notify(t("redeem_already")); loadGroups();
    if (data.group) openRoomByKey("@grp:" + data.group);
  } else if (data.status === "pending" || data.status === "duplicate") {
    // duplicate — пользователь уже предложил этого юзера ранее; UX одинаков с pending.
    notify(t("redeem_pending")); loadGroups();
  } else if (data.status === "invalid") {
    notify(t("redeem_invalid"));
  }
}
// group-updated: если пейн groups активен — перечитать; иначе просто обновить список чатов/панели.
// Если активна группа — перечитать её участников сразу (add/remove с любого клиента). Внутри
// loadGroupMembers уже есть защита от stale ответов (сверка myRoom === "@grp:" + id) и она же
// обновит groupOwner + renderMembers + syncAddMemberUI.
socket.on("group-updated", () => {
  loadGroups();
  if (curKind === "group") loadGroupMembers();
  if (curKind === "group" && settingsOpen && $("settingsTabs")?.querySelector('.settings-tab.active')?.dataset.tab === "groups") populateGroupSettingsPane();
});

// Invites + pending queue: сервер шлёт эти события когда кто-то создал/отозвал инвайт или
// появилась новая заявка / заявка была approve/decline. UI-списки в settings → groups перерисуем
// через refreshGsLists() если пейн сейчас открыт; тосты целевым юзерам — через notify().
socket.on("invite-created", (p) => refreshGsLists(p.id));
socket.on("invites-changed", (p) => refreshGsLists(p.id));
socket.on("pending-new", (p) => {
  refreshGsLists(p.id);
  // Тот, кого пригласили, получает тост «заявка отправлена» даже если пейн закрыт — иначе
  // действие invisible.
  if (profile && p.login === profile.login) notify(t("redeem_pending"));
});
socket.on("pending-resolved", (p) => {
  if (profile) notify(p.action === "approve" ? t("pending_approve") : t("pending_decline"));
  if (p.action === "approve") {
    loadGroups();
    if (curKind === "group" && String(p.id || p.group) === myRoom.slice(5)) loadGroupMembers();
  }
  refreshGsLists(p.id);
});
socket.on("group-deleted", ({ id }) => { const key = "@grp:" + id; chats.delete(key); if (myRoom === key) resetToEmpty(); if (settingsOpen) closeSettings(); renderChatList($("searchInput").value); });
socket.on("room-cleared", ({ room }) => { clearedChats.set(room, Date.now()); persistCleared(); if (chats.has(room)) { chats.delete(room); persistDMs(); if (myRoom === room) resetToEmpty(); renderChatList($("searchInput").value); } });

// ---------- Аватары ----------
function avaUrl(login) { return "/api/avatar/" + encodeURIComponent(login || "") + "?v=" + avaVer; }
function initials(n) { 
  // Берём ПЕРВЫЙ непробельный символ имени; пустая/пробельная строка → "?", чтобы аватар никогда
  // не оказался пустым. Раньше было `(n || "?").trim().charAt(0)` — а при name=" " (truthy!)
  // trim() возвращал пустую строку, charAt(0) давал "", аватар выглядел blank-квадратом.
  const s = String(n == null ? "" : n).trim();
  return (s.charAt(0) || "?").toUpperCase();
}
function setMyAvatar() { const a = $("myAvatar"); a.setAttribute("data-login", profile.login); a.innerHTML = `<img src="${avaUrl(profile.login)}" onerror="this.remove()">${initials(myName)}<span class="st-dot ci-status st-${statusClass(myStatus === "invisible" ? "offline" : myStatus)}"></span>`; }

// ---------- Создание новой группы с друзьями ----------
// (#newchat пейн в #settingsOverlay удалён → новая группа создаётся через #createGroupModal.
// Точки входа: + в хедере чатлиста (#newGroupBtn) и CTA empty-state (#emptyNewGroup). Один и тот
// же flow, одна и та же модалка из двух мест.)
let cgPicked = new Set();    // логин → выбранный для новой группы
let cgAvatar = null;          // dataURL или null (опциональный логотип)
let cgFriends = [];           // отфильтрованный список при search
function openCreateGroup() {
  if (!profile) return;
  cgPicked.clear(); cgAvatar = null; cgFriends = [];
  const nameInp = $("cgName"); if (nameInp) nameInp.value = "";
  const search = $("cgSearch"); if (search) search.value = "";
  if (!relations.friends.length) loadRelations().then(() => renderCgPicker());
  else renderCgPicker();
  $("cgAvaImg").style.display = "none";
  $("cgAvaInit").style.display = "grid";
  $("cgAvaImg").src = "";
  $("cgAvaInit").textContent = "#";
  $("cgAvaClear").classList.add("hidden");
  $("cgError").textContent = "";
  updateCgCount();
  $("cgCreate").disabled = true;
  $("createGroupModal").classList.remove("hidden");
  setTimeout(() => nameInp?.focus(), 50);
}
function closeCreateGroup() {
  $("createGroupModal").classList.add("hidden");
  const p = $("cgPicker"); if (p) p.innerHTML = "";
  const err = $("cgError"); if (err) err.textContent = "";
}
function renderCgPicker() {
  const q = ($("cgSearch")?.value || "").trim().toLowerCase();
  // Любой подходящий суффикс матчится — username быстрее печатать, но display name тоже полезен.
  cgFriends = (relations.friends || []).filter((l) => l.toLowerCase().includes(q));
  // Если есть relations.friendsNames (login→name), фильтруем по имени тоже. Раньше этот маппинг
  // не хранился на клиенте; загружаем по требованию — каждый draw уже подтянут через /api/relations
  // с friends:[logins], без отдельных имён. Поэтому матчим только по логину (он уникальный).
  const box = $("cgPicker"); if (!box) return; box.innerHTML = "";
  $("cgEmpty").classList.toggle("hidden", cgFriends.length > 0);
  $("cgSelectAll").classList.toggle("hidden", cgFriends.length === 0);
  cgFriends.forEach((l) => {
    const row = document.createElement("div");
    row.className = "cg-row" + (cgPicked.has(l) ? " on" : "");
    row.dataset.login = l;
    row.innerHTML = `<div class="avatar cg-ava-mini" data-login="${escapeHtml(l)}"><img src="${avaUrl(l)}" onerror="this.remove()">${initials(l)}</div>` +
      `<span class="cg-row-name">${escapeHtml(l)}</span>` +
      `<span class="cg-tick" aria-hidden="true">${cgPicked.has(l) ? "✓" : ""}</span>`;
    row.onclick = () => {
      if (cgPicked.has(l)) cgPicked.delete(l); else cgPicked.add(l);
      row.classList.toggle("on", cgPicked.has(l));
      row.querySelector(".cg-tick").textContent = cgPicked.has(l) ? "✓" : "";
      updateCgCount();
    };
    box.appendChild(row);
  });
  updateCgCount();
}
function updateCgCount() {
  const total = (relations.friends || []).length;
  const picked = cgPicked.size;
  const el = $("cgCount");
  if (el) {
    el.textContent = t("members_n_of_m", { n: picked, m: total });
    el.classList.toggle("full", picked > 0);
  }
  const nm = ($("cgName")?.value || "").trim();
  $("cgCreate").disabled = !(nm && picked > 0);
}
$("cgCloseBtn")?.addEventListener?.("click", closeCreateGroup);
$("cgCancel")?.addEventListener?.("click", closeCreateGroup);
$("createGroupModal")?.addEventListener?.("click", (e) => { if (e.target === $("createGroupModal")) closeCreateGroup(); });
$("cgAvaBtn")?.addEventListener?.("click", () => $("cgAvaFile")?.click());
$("cgAvaFile")?.addEventListener?.("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  if (f.size > 5 * 1024 * 1024) { $("cgError").textContent = t("err_avatar_too_big"); return; }
  const r = new FileReader();
  r.onload = () => {
    cgAvatar = r.result;
    const img = $("cgAvaImg"); img.src = r.result; img.style.display = "block";
    $("cgAvaInit").style.display = "none";
    $("cgAvaClear").classList.remove("hidden");
  };
  r.readAsDataURL(f);
  e.target.value = "";
});
$("cgAvaClear")?.addEventListener?.("click", () => {
  cgAvatar = null;
  const img = $("cgAvaImg"); img.src = ""; img.style.display = "none";
  $("cgAvaInit").style.display = "grid";
  $("cgAvaClear").classList.add("hidden");
});
$("cgName")?.addEventListener?.("input", updateCgCount);
$("cgSearch")?.addEventListener?.("input", renderCgPicker);
$("cgSelectAll")?.addEventListener?.("click", () => {
  // Тоггл «выбрать всех видимых» — клик на пустом фильтре = все друзья. Если уже все выбраны → сброс.
  const allInView = cgFriends.length > 0 && cgFriends.every((l) => cgPicked.has(l));
  cgFriends.forEach((l) => allInView ? cgPicked.delete(l) : cgPicked.add(l));
  renderCgPicker();
});
async function submitCreateGroup() {
  $("cgError").textContent = "";
  const name = ($("cgName")?.value || "").trim();
  if (!name) { $("cgError").textContent = t("err_group_name"); return; }
  if (cgPicked.size === 0) { $("cgError").textContent = t("err_pick_members"); return; }
  const body = { name, members: [...cgPicked].join(",") };
  if (cgAvatar) body.avatar = cgAvatar;
  $("cgCreate").disabled = true;
  const { ok, data } = await api("/api/groups", body);
  if (!ok) {
    $("cgCreate").disabled = false;
    $("cgError").textContent = data.error || "error";
    return;
  }
  closeCreateGroup();
  const key = "@grp:" + data.id;
  chats.set(key, { key, type: "group", id: data.id, name: data.name, last: "", ts: Date.now(), unread: 0, pinned: false });
  renderChatList($("searchInput").value);
  openChat(chats.get(key));
  notify(t("group_created_toast", { name }));
  // Очищаем FormData-state, чтобы следующее открытие было чистым
  cgPicked.clear(); cgAvatar = null; cgFriends = [];
  $("cgName").value = ""; $("cgSearch").value = "";
}
$("cgCreate")?.addEventListener?.("click", submitCreateGroup);

// Хедер чатлиста: doвесить пусковые кнопки к фиксированным id.
$("newGroupBtn")?.addEventListener?.("click", openCreateGroup);
$("emptyNewGroup")?.addEventListener?.("click", openCreateGroup);
$("emptyAddFriend")?.addEventListener?.("click", () => $("contactsBtn")?.click());

// Settings overlay → Groups pane → "Create group" CTA. До рефакторинга флоу
// создания группы присутствовал в HTML двумя формами одновременно (Compact-inline gc-* и
// полноценная #createGroupModal). JS обслуживал только cg-* модалку, поэтому клики по
// #gcCreateBtn / #gcCancelBtn ничего не делали → жалобы «buttons work like shit».
// Сейчас в пейне остался только CTA, который открывает ту же модалку, что и #newGroupBtn
// (там и аватар, и поиск, и мультивыбор). На закрытии оверлея настроек он перекрывал бы
// .modal (z-index 1100 > 250) → закрываем его перед open.
$("gcCreateBtn")?.addEventListener?.("click", () => {
  if (settingsOpen) closeSettings();
  openCreateGroup();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("createGroupModal").classList.contains("hidden")) closeCreateGroup();
});
async function openDM(login) {
  login = (login || "").trim().toLowerCase();
  if (!login || !profile || login === profile.login) return;
  const { ok, data } = await api("/api/user/" + login, null, "GET");
  if (!ok) return notify(t("err_user_not_found"));
  openChat({ key: dmKey(login), type: "dm", login, name: data.name || login, last: "", ts: Date.now(), unread: 0, pinned: false });
  persistDMs();
}

// ---------- Профиль (пейн «Profile» в #settingsOverlay) ----------
// Старые #profileModal / #contactsModal / #newChatModal / #groupSettingsModal удалены —
// их кнопки перенаправлены на openSettings(tab) выше; формы живут как пейны в #settingsOverlay.
let pendingAvatar = null;
$("avaUploadBtn") && ($("avaUploadBtn").onclick = () => $("avaFile").click());
$("avaFile") && ($("avaFile").onchange = (e) => {
  const f = e.target.files[0]; if (!f) return;
  if (f.size > 5 * 1024 * 1024) { $("profileError").textContent = t("err_avatar_too_big"); return; }
  const r = new FileReader();
  r.onload = () => { pendingAvatar = r.result; const img = $("profileAvaImg"); img.src = r.result; img.style.display = "block"; $("profileAvaInit").style.display = "none"; };
  r.readAsDataURL(f);
  e.target.value = "";
});
$("profileSave") && ($("profileSave").onclick = async () => {
  $("profileError").textContent = "";
  const body = { name: ($("profileName").value || "").trim(), description: $("profileDesc").value || "" };
  if (pendingAvatar) body.avatar = pendingAvatar;
  const { ok, data } = await api("/api/profile", body);
  if (!ok) { $("profileError").textContent = data.error || "Failed to save profile"; return; }
  profile = data.profile; myName = profile.name; myDesc = body.description;
  // Тоже синхронизируем статус — раньше жил в #profileModal.status-opt и сохранялся здесь же.
  // Если статус-пилл в хедере уже поменял myStatus, отдаём его в payload, чтобы /api/profile
  // не «откатил» статус обратно к старому значению.
  if (profile.status && profile.status !== myStatus) { myStatus = profile.status; renderMeStatus(); }
  avaVer = Date.now(); pendingAvatar = null;
  $("myName").textContent = myName; setMyAvatar(); renderMeStatus();
  closeSettings(); renderChatList($("searchInput").value);
});
$("logoutBtn") && ($("logoutBtn").onclick = async () => { await api("/api/logout"); localStorage.removeItem("dialog_token"); location.reload(); });

// ---------- Контакты / друзья ----------
$("contactsBtn").onclick = () => openSettings("contacts");
// Кнопка отправки заявки работает по тому же #reqInput, который теперь живёт в settingsOverlay → contacts пейн.
$("reqSendBtn").onclick = async () => {
  const inp = $("reqInput"); const target = (inp?.value || "").trim().toLowerCase();
  if (!target) return;
  const { ok, data } = await api("/api/friend", { target, action: "request" });
  if (!ok) { const e = $("reqError"); if (e) e.textContent = data.error || t("err_user_not_found"); return; }
  if (inp) inp.value = ""; loadRelations();
};
async function loadRelations() {
  const { ok, data } = await api("/api/relations", null, "GET");
  if (!ok) return;
  Object.assign(relations, data); blocked.clear(); blockedBy.clear(); (data.blocked || []).forEach((l) => blocked.add(l)); (data.blockedBy || []).forEach((l) => blockedBy.add(l));
  renderContacts(); renderChatList($("searchInput").value); syncBlockComposer();
}
function contactRow(login, buttons) {
  const row = document.createElement("div"); row.className = "contact-row";
  row.innerHTML = `<div class="avatar" style="width:30px;height:30px;font-size:13px"><img src="${avaUrl(login)}" onerror="this.remove()">${initials(login)}</div><span class="c-name">${escapeHtml(login)}</span>`;
  row.onclick = (e) => { if (e.target.closest("button")) return; openDM(login); };
  buttons.forEach(([label, fn, danger]) => { const b = document.createElement("button"); b.textContent = label; if (danger) b.className = "danger"; b.onclick = (e) => { e.stopPropagation(); fn(); }; row.appendChild(b); });
  return row;
}
// Бейдж со счётчиком входящих заявок на кнопке «Контакты» в шапке списка чатов.
// setIcons() выставляет innerHTML кнопки один раз на старте, после чего бейдж живёт как
// дочерний элемент — поэтому ищем/создаём его лениво и просто обновляем текст/видимость.
function updateReqBadge() {
  const btn = $("contactsBtn"); if (!btn) return;
  let badge = btn.querySelector(".req-badge");
  if (!badge) { badge = document.createElement("span"); badge.className = "req-badge"; btn.appendChild(badge); }
  const n = (relations.incoming || []).length;
  badge.textContent = n > 99 ? "99+" : String(n);
  badge.classList.toggle("show", n > 0);
}
function renderContacts() {
  updateReqBadge();
  const reqList = $("reqList"); if (!reqList) return;
  reqList.innerHTML = ""; const fL = $("friendsListEl"); if (fL) fL.innerHTML = ""; const sL = $("sentList"); if (sL) sL.innerHTML = "";
  const reqEmpty = $("reqEmpty"); if (reqEmpty) reqEmpty.classList.toggle("hidden", relations.incoming.length > 0);
  relations.incoming.forEach((l) => reqList.appendChild(contactRow(l, [["✓", async () => { await friend(l, "accept"); await refreshPresence(); openDM(l); }], ["✕", () => friend(l, "decline"), true]])));
  relations.friends.forEach((l) => fL.appendChild(contactRow(l, [[t("dm_open"), () => { openDM(l); }], [t("remove_friend"), () => friend(l, "remove"), true]])));
  relations.sent.forEach((l) => sL.appendChild(contactRow(l, [[t("pending"), () => {}]])));
}
async function friend(target, action) { await api("/api/friend", { target, action }); loadRelations(); }
async function block(target, action) { await api("/api/relations", { target, action }); loadRelations(); }

// ---------- Мини-профиль ----------
async function openMiniProfile(login) {
  if (!login || login === profile.login) return;
  const { ok, data } = await api("/api/profile/" + login, null, "GET");
  if (!ok) return;
  $("mpModal").classList.remove("hidden");
  $("mpAva").setAttribute("data-login", login);
  $("mpAva").innerHTML = `<img src="${avaUrl(login)}" onerror="this.remove()"><span class="ava-fallback">${initials(data.name)}</span>`;
  $("mpName").textContent = data.name; $("mpLogin").textContent = data.login;
  $("mpStatus").textContent = t("status_" + (data.status === "offline" ? "offline" : data.status));
  $("mpDesc").textContent = data.description || "";
  $("mpJoined").textContent = data.created_at ? t("joined", { date: new Date(data.created_at).toLocaleDateString() }) : "";
  $("mpMessage").onclick = () => { $("mpModal").classList.add("hidden"); openDM(login); };
}
$("mpCancel").onclick = () => $("mpModal").classList.add("hidden");
$("chatAva").onclick = () => {
  // DM: открывает мини-профиль собеседника. Группа: открывает settings overlay на пейне «groups»
  // с её составом, инвайтами и pending (как у myName → «Open profile», только это групповая страница).
  if (curKind === "dm") openMiniProfile(myRoom.slice(4).split("~").find((l) => l !== profile.login));
  else if (curKind === "group") openSettings("groups");
};
$("chatAva").onkeydown = (e) => {
  // Клавиатурная активация для tabindex=0/role=button; предотвращаем скролл по Space.
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("chatAva").click(); }
};

// ---------- Присутствие ----------
async function refreshPresence() {
  const logins = [...new Set([...chats.values()].filter((c) => c.type === "dm").map((c) => c.login).concat(relations.friends))].filter(Boolean);
  if (!logins.length) { updateDots(); return; }
  const { ok, data } = await api("/api/presence", { logins });
  if (ok) { for (const [l, st] of Object.entries(data)) presence.set(l, st); updateDots(); }
}
function statusClass(s) { return s === "online" ? "online" : s === "dnd" ? "dnd" : "offline"; }
function updateDots() {
  // Точечное обновление: меняем только статус-точку на видимых строках списка чатов,
  // не пересобирая весь список и не перезагружая аватарки (раньше на каждый presence-событие
  // делался полный innerHTML="" + appendChild N <li> с новыми <img src> — это и был главный источник лагов).
  //
  // ВАЖНО: setMyAvatar() тут НЕ вызываем — оно ребилдит #myAvatar (avatar моего аккаунта) на
  // КАЖДЫЙ presence-ивен, что при пустом HTTP-кеше перезапрашивает /api/avatar. Своя ава
  // уже переустанавливается в enterApp() и в profileSave(); статус-точка моя зависит только
  // от локальной переменной myStatus, не от чужого присутствия.
  const ul = $("chatList");
  if (ul) {
    for (const li of ul.children) {
      const key = li._chatKey;
      if (!key) continue;
      const c = chats.get(key);
      if (!c || c.type !== "dm") continue;
      const dot = li.querySelector(".ci-status");
      if (!dot) continue;
      const cls = "st-dot ci-status st-" + statusClass(presence.get(c.login));
      if (dot.className === cls) continue;
      dot.className = cls;
    }
  }
}
socket.on("presence", ({ login, status }) => {
  presence.set(login, status); updateDots();
  if (curKind === "dm" && myRoom && login === myRoom.slice(4).split("~").find((l) => l !== profile.login)) {
    $("chatSub").textContent = t("status_" + status);
    const dot = $("chatAva")?.querySelector(".ch-status");
    if (dot) dot.className = "st-dot ch-status st-" + statusClass(status);
  }
});
socket.on("relations-changed", () => loadRelations());
socket.on("profile-updated", ({ login, name, avatarChanged }) => {
  if (!login) return;
  if (profile && login === profile.login) {
    if (name && name !== myName) { myName = name; profile.name = name; const pn = $("profileName"); if (pn) pn.value = name; if (settingsOpen) renderChatList($("searchInput").value); }
    if (avatarChanged) avaVer = Date.now();
    return;
  }
  let changed = false;
  for (const [, c] of chats) {
    if (c.type === "dm" && c.login === login) {
      if (name) c.name = name;
      changed = true;
    }
  }
  if (name) {
    for (const [, p] of peers) { if (p.login === login) p.name = name; }
    for (const m of groupMembers) { if (m.login === login) m.name = name; }
    if (curKind === "dm" && chats.get(myRoom)?.login === login) $("chatTitle").textContent = name;
    if (!$("infoPanel").classList.contains("hidden")) renderMembers();
  }
  if (avatarChanged) avaVer = Date.now();
  if (changed) { persistDMs(); renderChatList($("searchInput").value); }
});

// ---------- Участники (инфо-панель) ----------
let groupMembers = []; // [{login,name}] текущей группы (для боковой панели)
// Овнерство текущей группы — кешируем сразу при загрузке списка, чтобы чат-меню и кнопка + под
// участниками могли решать, показывать «Add member» (только овнеру). Сбрасывается в openChat, когда
// переключаемся на другой чат или в DM. disconnect/identify — отдельный путь, см. loadGroupMembers.
let groupOwner = false;
let groupOwnerLogin = "";
async function loadGroupMembers() {
  if (curKind !== "group") { groupMembers = []; groupOwner = false; groupOwnerLogin = ""; syncAddMemberUI(); return; }
  const id = myRoom.slice(5);
  const { ok, data } = await api("/api/groups/" + id, null, "GET");
  if (ok && myRoom === "@grp:" + id) {
    groupMembers = data.members || [];
    groupOwner = data.owner === profile.login;
    groupOwnerLogin = data.owner;
    renderMembers();
    syncAddMemberUI();
  }
}
function renderMembers() {
  const ul = $("members"); if (!ul) return; ul.innerHTML = "";
  const inCall = new Set((activeCalls.get(myRoom) || {}).logins || []);
  const byLogin = new Map();
  if (curKind === "group") for (const m of groupMembers) byLogin.set(m.login, m.name); // все участники группы
  for (const [, info] of peers) if (info.login) byLogin.set(info.login, info.name);    // + присутствующие
  inCall.forEach((l) => { if (!byLogin.has(l)) byLogin.set(l, l); });
  if (byLogin.size === 0) { ul.innerHTML = `<li class="member" style="opacity:.5"><span class="m-name">${t("alone")}</span></li>`; return; }
  for (const [login, name] of byLogin) {
    const li = document.createElement("li"); li.className = "member";
    const online = login === profile.login ? (myStatus === "invisible" ? "offline" : myStatus) : (presence.get(login) || "offline");
    const callIcon = inCall.has(login) ? `<span class="m-incall" title="${t("in_call")}">${window.ICON.phone}</span>` : `<span class="st-dot st-${statusClass(online)}"></span>`;
    const crown = login === groupOwnerLogin ? `<span class="m-crown">👑</span>` : "";
    li.innerHTML = `<div class="avatar" data-login="${login}" style="width:30px;height:30px;font-size:13px"><img src="${avaUrl(login)}" onerror="this.remove()">${initials(name)}</div><span class="m-name">${crown}${escapeHtml(name)}</span>${callIcon}`;
    // Inline remove для овнера: раньше единственный путь «удалить участника» был Settings → Groups,
    // что далеко от списка, который сейчас у пользователя перед глазами. groupOwner уже учитывает
    // ds.owner === profile.login (см. loadGroupMembers) → self-сравнение login !== profile.login
    // одновременно исключает овнера из жертв и работает семантически «не удаляй самого себя».
    if (groupOwner && curKind === "group" && login !== profile.login) {
      const rm = document.createElement("button");
      rm.className = "member-remove";
      rm.title = t("remove");
      rm.textContent = "✕";
      rm.onclick = async (e) => {
        // stopPropagation — иначе клик «пройдёт» на li.onclick → открылся бы мини-профиль удалённого.
        e.stopPropagation();
        if (!confirm(t("remove") + " " + name + "?")) return;
        const gid = myRoom.slice(5);
        const { ok, data } = await api("/api/groups/" + gid + "/members", { remove: login });
        if (!ok) { notify(data.error || "Couldn't remove"); return; }
        // group-updated от сервера триггерит loadGroupMembers через socket handler — этот list
        // обновится автоматически. Дополнительный setTimeout отсутствует, ничего лишнего.
      };
      li.appendChild(rm);
    }
    // Клавиатурная навигация по сайдпанели участников: Tab → focus (кольцо из .member:focus-visible), Enter/Space → то же, что и клик.
    li.tabIndex = 0; li.setAttribute("role", "button");
    li.onkeydown = (e) => {
      const t_ = e.target;
      // Если фокус на кнопке удаления — пусть у неё свой обработчик (Enter/Space). Иначе открываем профиль.
      if (t_ && t_.classList && t_.classList.contains("member-remove")) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openMiniProfile(login); }
    };
    li.onclick = () => openMiniProfile(login);
    ul.appendChild(li);
  }
}
socket.on("peers", (list) => { peers.clear(); list.forEach((p) => peers.set(p.id, { name: p.name, login: p.login })); if (!$("infoPanel").classList.contains("hidden")) renderMembers(); });
socket.on("peer-joined", (p) => { peers.set(p.id, { name: p.name, login: p.login }); if (!$("infoPanel").classList.contains("hidden")) renderMembers(); });
socket.on("peer-left", (p) => { peers.delete(p.id); if (!$("infoPanel").classList.contains("hidden")) renderMembers(); });

// ---------- Сообщения ----------
const messagesEl = $("messages");
const CHUNK = 25;            // messages per chunk (initial load + each scroll-up)
const KEEP_CHUNKS = 3;       // max chunks kept in the DOM before older ones are unloaded
let _moreLoading = false;
let _moreHas = true;
let _moreOldest = null;
// Newest message id currently in the DOM — so "jump to newest" knows whether we
// already have the latest chunk or must re-fetch it from the server.
let _newestId = null;

// Chunks load INSTANTLY (no per-message animation). Initial load = 25 messages.
socket.on("history", (list) => {
  messagesEl.innerHTML = "";
  _moreLoading = false;
  const cleared = clearedChats.get(myRoom);
  if (cleared) list = list.filter((m) => m.ts > cleared);
  _moreHas = list.length >= CHUNK;
  _moreOldest = list.length ? list[0].id : null;
  _newestId = list.length ? list[list.length - 1].id : null;
  if (list.length && _moreHas) { const sep = document.createElement("div"); sep.className = "system-msg"; sep.textContent = t("prev_messages"); messagesEl.appendChild(sep); }
  list.forEach((m) => renderMessage(m, false, isPingForMe(m), true));
  const last = list[list.length - 1]; const c = chats.get(myRoom);
  if (c && last) { c.last = preview(last); c.ts = last.ts; renderChatList($("searchInput").value); }
  scrollDown();
  updateJumpBtn();
  setTimeout(markDeliveredSeenUpToLast, 50);
});
// Older chunk prepended on scroll-up — instant, scroll position preserved.
socket.on("more-messages", ({ msgs, before }) => {
  if (!msgs || !msgs.length) { _moreHas = false; _moreLoading = false; return; }
  const cleared = clearedChats.get(myRoom);
  if (cleared) msgs = msgs.filter((m) => m.ts > cleared);
  if (!msgs.length) { _moreHas = false; _moreLoading = false; return; }
  const prev = messagesEl.scrollHeight;
  const beforeCount = messagesEl.children.length;
  for (const m of msgs) renderMessage(m, false, isPingForMe(m), true);
  for (let i = messagesEl.children.length - 1; i >= beforeCount; i--)
    messagesEl.insertBefore(messagesEl.children[i], messagesEl.firstChild);
  messagesEl.scrollTop = messagesEl.scrollHeight - prev;
  _moreOldest = msgs[0].id;
  _moreHas = msgs.length >= CHUNK;
  _moreLoading = false;
  updateJumpBtn();
});

// Unload chunks above the newest KEEP_CHUNKS when we're back near the bottom, so
// the DOM stays small after scrolling up through history.
function pruneOldChunks() {
  const keep = CHUNK * KEEP_CHUNKS;
  const msgs = messagesEl.querySelectorAll(".msg");
  if (msgs.length <= keep) return;
  const firstKeep = msgs[msgs.length - keep];
  while (messagesEl.firstChild && messagesEl.firstChild !== firstKeep) messagesEl.removeChild(messagesEl.firstChild);
  const oid = Number(firstKeep.dataset.id);
  if (oid) { _moreOldest = oid; _moreHas = true; }
}

const atBottom = () => messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
function updateJumpBtn() { const b = $("jumpNewer"); if (b) b.classList.toggle("show", !atBottom()); }

// "Jump to newest": the newest chunk is always in the DOM (pruning only drops
// older/top chunks), so we unload the older chunks and scroll to the bottom.
function jumpToNewest() { pruneOldChunks(); scrollDown(); updateJumpBtn(); }

let _moreScrollTimer = null;
messagesEl.addEventListener("scroll", () => {
  updateJumpBtn();
  if (atBottom()) pruneOldChunks();
  if (_moreScrollTimer) clearTimeout(_moreScrollTimer);
  _moreScrollTimer = setTimeout(() => {
    if (_moreLoading || !_moreHas || !_moreOldest) return;
    if (messagesEl.scrollTop > 300) return;
    _moreLoading = true;
    socket.emit("load-more", { before: _moreOldest });
  }, 150);
});
{ const jb = $("jumpNewer"); if (jb) jb.onclick = jumpToNewest; }
socket.on("message", (m) => {
  const ping = isPingForMe(m);
  const mine = profile && m.fromLogin === profile.login;
  if (myRoom === m.room || !m.room) {
    // Своё сообщение пришло round-trip'ом — найдём локальный оптимистичный пузырь,
    // иначе отрендерим как обычно (на случай если локальный был утерян).
    if (mine && m.localId) {
      const localEl = messagesEl.querySelector(`.msg.me[data-localid="${m.localId}"]`);
      if (localEl) {
        // обновим data-id, статус acked и иконки; контент уже отрисован
        localEl.dataset.id = m.id != null ? m.id : "";
        localEl.dataset.acked = "1";
        statusOf(localEl); // пересчитать статус (pending → sent)
      } else {
        renderMessage(m, true, ping);
      }
    } else {
      renderMessage(m, true, ping);
    }
  }
  const c = chats.get(myRoom); if (c) { c.last = preview(m); c.ts = m.ts; if (c.type === "dm") persistDMs(); renderChatList($("searchInput").value); }
  if (!mine && !isDnd()) { if (ping) sfx.call(); else if (!isMuted(myRoom)) msgSfxForTheme()(); }
  // «delivery» путём отправляется в renderMessage (там же и для истории, и для live), дублировать не нужно.
  // «seen» ставим ТОЛЬКО на явных действиях пользователя: открыл чат / сделал его видимым.
});
// Сервер подтвердил сохранение нашего сообщения — снимаем «pending».
socket.on("msg-ack", ({ localId, id, room: ackRoom }) => {
  if (!ackRoom || ackRoom !== myRoom) return;
  const el = messagesEl.querySelector(`.msg.me[data-localid="${localId}"]`);
  if (el) { el.dataset.id = id != null ? id : (el.dataset.id || ""); el.dataset.acked = "1"; statusOf(el); }
});
// Сервер отклонил сообщение как спам (флуд/дубль). Обычно клиент режет раньше и сюда
// не доходит, но это бэкстоп: убираем оптимистичный пузырь и показываем подсказку.
socket.on("rate-limited", ({ reason, localId } = {}) => {
  if (localId != null) { const el = messagesEl.querySelector(`.msg.me[data-localid="${localId}"]`); if (el) el.remove(); }
  notify(t(reason === "duplicate" ? "spam_duplicate" : "spam_flood"));
});
// Снимок курсоров для всей комнаты (приходит на join и при каждом обновлении).
socket.on("watermark", ({ updates }) => { applyWatermarkUpdates(updates); });
socket.on("dm-ping", ({ room, fromLogin, fromName }) => {
  const c = upsertChat({ key: dmKey(fromLogin), type: "dm", login: fromLogin, name: fromName, last: "", ts: Date.now(), unread: 0 });
  c.ts = Date.now();    if (myRoom !== room) { c.unread = (c.unread || 0) + 1; if (!isMuted(room) && !isDnd()) { msgSfxForTheme()(); notify(t("dm_ping", { name: fromName }), room); } }
  persistDMs(); renderChatList($("searchInput").value);
});
socket.on("dm-blocked", (d) => { const r = d && d.reason; notify(r === "blocked_by_recipient" ? t("blocked_by_user") : r === "blocked_sender" ? t("blocked_msg_send") : t("dm_need_friend")); if (r) loadRelations(); });
function isPingForMe(m) { if (m.type !== "text" || !profile) return false; const x = (m.text || "").toLowerCase(); return x.includes("@" + profile.login.toLowerCase()) || (profile.name && x.includes("@" + profile.name.toLowerCase())); }
function highlightMentions(html) { return html.replace(/@([\w.Ѐ-ӿ]+)/g, (full, name) => { const me = profile && (name.toLowerCase() === profile.login.toLowerCase() || name.toLowerCase() === (profile.name || "").toLowerCase()); return `<span class="mention${me ? " me" : ""}">${full}</span>`; }); }
// Безопасное форматирование: сначала прячем URL в плейсхолдеры (чтобы упоминания не резали href), потом упоминания, потом возвращаем ссылки
function formatMessage(text) {
  let html = escapeHtml(text);
  const links = [];
  html = html.replace(/(https?:\/\/[^\s]+)/g, (u) => { const i = links.push(u) - 1; return "L" + i + ""; });
  html = highlightMentions(html);
  html = html.replace(/L(\d+)/g, (_, i) => `<a href="${links[i]}" target="_blank" rel="noopener noreferrer" style="color:#7dffaf">${links[i]}</a>`);
  return html;
}
function firstUrl(text) { const m = (text || "").match(/https?:\/\/[^\s]+/); return m ? m[0] : null; }
function ytId(url) { const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/); return m ? m[1] : null; }
// Превью ссылки/видео под сообщением
function addLinkExtras(wrap, text) {
  const url = firstUrl(text); if (!url) return;
  const yid = ytId(url);
  if (yid) { const d = document.createElement("div"); d.className = "yt-embed"; d.innerHTML = `<iframe src="https://www.youtube.com/embed/${yid}" allow="autoplay;encrypted-media;picture-in-picture" allowfullscreen></iframe>`; wrap.appendChild(d); scrollDown(); return; }
  fetch("/api/link-preview?url=" + encodeURIComponent(url), { headers: { Authorization: "Bearer " + token } })
    .then((r) => r.json()).then((d) => {
      if (!d || (!d.title && !d.image)) return;
      const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.className = "link-preview";
      a.innerHTML = (d.image ? `<img class="lp-img" src="${escapeHtml(d.image)}" onerror="this.remove()">` : "") +
        `<div class="lp-body"><div class="lp-site">${escapeHtml(d.site || "")}</div><div class="lp-title">${escapeHtml(d.title || "")}</div><div class="lp-desc">${escapeHtml(d.description || "")}</div></div>`;
      wrap.appendChild(a); scrollDown();
    }).catch(() => {});
}

function renderMessage(m, scroll = true, ping = false, instant = false) {
  const mine = profile && m.fromLogin === profile.login;
  const isB = !mine && m.fromLogin && blocked.has(m.fromLogin);
  const wrap = document.createElement("div");
  // `instant` (history / load-more chunks) skips the enter animation so a chunk
  // appears immediately instead of animating in one by one.
  wrap.className = "msg" + (mine ? " me" : "") + (ping ? " ping" : "") + (isB ? " blocked" : "") + (instant ? " no-anim" : "");
  wrap.dataset.id = m.id != null ? m.id : "";
  if (m.localId != null) wrap.dataset.localid = String(m.localId);
  if (m._optimistic) wrap.dataset.acked = ""; // ещё не подтверждено сервером
  else if (m.id != null) wrap.dataset.acked = "1";
  if (isB) wrap.dataset.blocklabel = t("blocked_msg");
  let inner = "";
  const sysType = ["call_started", "call_ended", "call_missed", "join", "leave"].includes(m.type);
  if (sysType) {
    const name = escapeHtml(m.name);
    if (m.type === "call_started") inner += `<div class="sys-line call">📞 ${t("call_started")}</div>`;
    else if (m.type === "call_ended") inner += `<div class="sys-line call">📞 ${t("call_ended")} — ${escapeHtml(m.text)}</div>`;
    else if (m.type === "call_missed") inner += `<div class="sys-line call missed">📞 ${t("call_missed")} (${escapeHtml(m.text)})</div>`;
    else if (m.type === "join") inner += `<div class="sys-line join">→ ${name} ${t("joined_chat")}</div>`;
    else if (m.type === "leave") inner += `<div class="sys-line leave">← ${name} ${t("left_chat")}</div>`;
  } else {
    if (!mine && curKind === "group") inner += `<div class="who">${escapeHtml(m.name)}</div>`;
    if (m.type === "text") inner += `<div class="bubble">${formatMessage(m.text)}</div>`;
    else if (m.type === "image" || m.type === "gif") inner += `<div class="bubble media"><img src="${m.media}" alt=""></div>`;
    else if (m.type === "video") inner += `<div class="bubble media"><video src="${m.media}" controls></video></div>`;
    else if (m.type === "audio") inner += `<div class="bubble audio">🎤 <audio controls src="${m.media}"></audio></div>`;
    else if (m.type === "file") {
      const safeName = escapeHtml(m.mediaName || t("file_untitled"));
      const sizeBytes = m.mediaSize || mediaBytesFromDataUrl(m.media);
      const sizeStr = sizeBytes ? formatFileSize(sizeBytes) : "";
      inner += `<a class="bubble file" href="${m.media}" download="${escapeHtml(m.mediaName || "file")}" title="${safeName}">` +
        `<span class="file-icon">📎</span>` +
        `<span class="file-meta"><span class="file-name">${safeName}</span>` +
        (sizeStr ? `<span class="file-size">${sizeStr}</span>` : "") +
        `</span><span class="file-dl" aria-hidden="true">⬇</span></a>`;
    }
    const statusSpan = mine ? `<span class="msg-status" data-status="pending" title="${t("status_pending")}">${window.ICON.clock}</span>` : "";
    inner += `<div class="time">${fmtTime(m.ts)}<span class="edited-tag">${m.edited ? " · " + t("edited") : ""}</span>${statusSpan}</div>`;
    inner += `<div class="reactions"></div>`;
    if (m.id != null && !isB) {
      inner += `<div class="msg-actions"><button class="ma-btn ma-react" title="${t("react")}">${window.ICON.smile}</button>` +
        (mine && m.type === "text" ? `<button class="ma-btn ma-edit" title="${t("edit")}">${window.ICON.edit}</button>` : "") +
        (mine ? `<button class="ma-btn ma-del" title="${t("delete_msg")}">${window.ICON.trash}</button>` : "") + `</div>`;
    }
  }
  // Разделитель дат — перед сообщением сменились сутки относительно последнего видимого.
  const curDay = new Date(m.ts).toDateString();
  const last = messagesEl.lastElementChild;
  if (last && last.dataset && last.dataset.day && last.dataset.day !== curDay) {
    const sep = document.createElement("div");
    sep.className = "day-sep";
    sep.textContent = dayLabel(curDay);
    messagesEl.appendChild(sep);
    sep.dataset.day = curDay;
  }
  wrap.dataset.day = curDay;
  wrap.innerHTML = inner;
  renderReactions(wrap, m.reactions || {});
  messagesEl.appendChild(wrap);
  if (m.type === "text" && !isB) addLinkExtras(wrap, m.text); // превью ссылки / YouTube
  // Для входящих сразу же отправляем ACK доставки (на любое сообщение, в т.ч. live broadcast).
  if (!mine && m.id && !sysType) setTimeout(() => socket.emit("delivery", { maxId: m.id }), 0);
  if (scroll) scrollDown();
}
function renderReactions(wrap, reactions) {
  const bar = wrap.querySelector(".reactions"); if (!bar) return; bar.innerHTML = "";
  for (const [emoji, logins] of Object.entries(reactions || {})) {
    if (!logins || !logins.length) continue;
    const mineR = profile && logins.includes(profile.login);
    const chip = document.createElement("button"); chip.className = "reaction" + (mineR ? " mine" : "");
    chip.innerHTML = `<span>${emoji}</span><span class="r-count">${logins.length}</span>`;
    chip.onclick = () => socket.emit("msg-react", { id: Number(wrap.dataset.id), emoji });
    bar.appendChild(chip);
  }
}
const REACT_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🔥", "🎉", "👎"];
let reactPicker;
function openReactPicker(btn, id) {
  if (!reactPicker) {
    reactPicker = document.createElement("div"); reactPicker.className = "react-picker hidden";
    REACT_EMOJIS.forEach((em) => { const b = document.createElement("button"); b.textContent = em; b.onclick = () => { socket.emit("msg-react", { id: reactPicker._id, emoji: em }); reactPicker.classList.add("hidden"); }; reactPicker.appendChild(b); });
    document.body.appendChild(reactPicker);
  }
  reactPicker._id = id; reactPicker.classList.remove("hidden");
  const r = btn.getBoundingClientRect();
  reactPicker.style.left = Math.min(r.left, innerWidth - reactPicker.offsetWidth - 8) + "px";
  reactPicker.style.top = (r.top - reactPicker.offsetHeight - 6) + "px";
}
document.addEventListener("click", (e) => { if (reactPicker && !reactPicker.contains(e.target) && !e.target.closest(".ma-react")) reactPicker.classList.add("hidden"); });
function startEdit(wrap) {
  const bubble = wrap.querySelector(".bubble"); if (!bubble || wrap.querySelector(".edit-box")) return;
  const old = bubble.textContent;
  const box = document.createElement("div"); box.className = "edit-box";
  const ta = document.createElement("textarea"); ta.value = old; ta.rows = 1;
  const hint = document.createElement("div"); hint.className = "edit-hint"; hint.textContent = t("edit_hint");
  box.append(ta, hint); bubble.style.display = "none"; bubble.after(box);
  ta.focus(); ta.setSelectionRange(old.length, old.length); ta.style.height = ta.scrollHeight + "px";
  ta.oninput = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
  const finish = (save) => { const v = ta.value.trim(); box.remove(); bubble.style.display = ""; if (save && v && v !== old) socket.emit("msg-edit", { id: Number(wrap.dataset.id), text: v }); };
  ta.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(true); } else if (e.key === "Escape") { e.preventDefault(); finish(false); } };
  ta.onblur = () => finish(true);
}
messagesEl.addEventListener("click", (e) => {
  const rb = e.target.closest(".ma-react"); if (rb) { e.stopPropagation(); openReactPicker(rb, Number(rb.closest(".msg").dataset.id)); return; }
  const eb = e.target.closest(".ma-edit"); if (eb) { startEdit(eb.closest(".msg")); return; }
  const db = e.target.closest(".ma-del"); if (db) { const w = db.closest(".msg"); if (confirm(t("confirm_delete"))) socket.emit("msg-delete", { id: Number(w.dataset.id) }); return; }
  const bl = e.target.closest(".msg.blocked:not(.revealed)"); if (bl) { bl.classList.add("revealed"); return; }
  const img = e.target.closest(".bubble.media img"); if (img) openLightbox(img.src);
});
socket.on("msg-deleted", ({ id }) => { const el = messagesEl.querySelector(`.msg[data-id="${id}"]`); if (el) el.remove(); });
socket.on("msg-edited", ({ id, text }) => { const el = messagesEl.querySelector(`.msg[data-id="${id}"]`); if (!el) return; const b = el.querySelector(".bubble"); if (b) b.innerHTML = formatMessage(text); const tag = el.querySelector(".edited-tag"); if (tag && !tag.textContent) tag.textContent = " · " + t("edited"); });
socket.on("msg-reaction", ({ id, reactions }) => { const el = messagesEl.querySelector(`.msg[data-id="${id}"]`); if (el) renderReactions(el, reactions); });

let localIdCounter = 0;
// Снимок курсоров доставки/просмотра по логинам (заполняется сервером и обновляется live).
const watermarks = new Map(); // login -> { delivered, seen }
// watermarkSnapshotApplied сбрасывается на openChat: первый снимок для активной комнаты
// всегда пересчитывает статусы; повторные event'ы без продвижения курсоров — нет.
let watermarkSnapshotApplied = false;
function applyWatermarkUpdates(updates) {
  if (!updates) return;
  let advanced = !watermarkSnapshotApplied;
  for (const u of updates) {
    const cur = watermarks.get(u.login) || { delivered: 0, seen: 0 };
    const nd = Math.max(Number(cur.delivered) || 0, Number(u.delivered) || 0);
    const ns = Math.max(Number(cur.seen) || 0, Number(u.seen) || 0);
    if (nd > cur.delivered || ns > cur.seen) advanced = true;
    cur.delivered = nd; cur.seen = ns;
    watermarks.set(u.login, cur);
  }
  watermarkSnapshotApplied = true;
  // Тяжёлая операция только если хотя бы один курсор реально сдвинулся вперёд.
  if (advanced) refreshOutgoingStatuses();
}
// Анти-спам на клиенте (зеркалит серверные лимиты — мгновенная реакция без round-trip;
// авторитетная проверка всё равно на сервере). Флуд: SPAM.max за SPAM.windowMs. Дубли:
// одинаковый текст подряд ≥ SPAM.dupMax за SPAM.dupWindowMs.
const SPAM = { windowMs: 5000, max: 8, dupWindowMs: 12000, dupMax: 4 };
let _spamTimes = [], _spamLast = "", _spamLastTs = 0, _spamDup = 1;
function spamBlock(text, isMedia) {
  const now = Date.now();
  _spamTimes = _spamTimes.filter((ts) => now - ts < SPAM.windowMs);
  if (_spamTimes.length >= SPAM.max) return "flood";
  const t = isMedia ? "" : (text || "").trim();
  if (t && t === _spamLast && now - _spamLastTs < SPAM.dupWindowMs && _spamDup + 1 >= SPAM.dupMax) return "duplicate";
  _spamTimes.push(now);
  if (t) { _spamDup = (t === _spamLast && now - _spamLastTs < SPAM.dupWindowMs) ? _spamDup + 1 : 1; _spamLast = t; _spamLastTs = now; }
  return null;
}
function spamNotify(reason) { notify(t(reason === "duplicate" ? "spam_duplicate" : "spam_flood")); }
function sendText() {
  const input = $("msgInput"); const text = input.value.trim();
  if (!text || !myRoom) return;
  const blocked = spamBlock(text, false);
  if (blocked) { spamNotify(blocked); return; } // не рендерим и не шлём — текст остаётся в поле
  const localId = ++localIdCounter;
  // Оптимистичный локальный рендер — мгновенная обратная связь, не ждём round-trip.
  const m = {
    localId, id: null, fromLogin: profile.login, name: myName, ts: Date.now(),
    type: "text", text, media: null, mediaName: "",
    room: myRoom, _optimistic: true,
  };
  renderMessage(m, true, false);
  socket.emit("message", { type: "text", text, localId });
  input.value = ""; input.style.height = "auto"; socket.emit("typing", false);
}
$("sendBtn").onclick = sendText;
$("msgInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendText(); } });
let typingTimer;
$("msgInput").addEventListener("input", (e) => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px"; socket.emit("typing", true); clearTimeout(typingTimer); typingTimer = setTimeout(() => socket.emit("typing", false), 1500); });
const typingUsers = new Set();
socket.on("typing", ({ name, isTyping }) => { if (isTyping) typingUsers.add(name); else typingUsers.delete(name); const arr = [...typingUsers]; $("typingIndicator").textContent = arr.length ? (arr.length === 1 ? t("typing_one", { name: arr[0] }) : t("typing_many", { names: arr.join(", ") })) : ""; });

// ---------- Медиа / файлы / прогресс ----------
const MAX_FILE_SIZE_MB = 75;
const MAX_FILE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
let uploadingCount = 0;

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return t("file_size_b", { n: bytes });
  if (bytes < 1024 * 1024) return t("file_size_kb", { n: (bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0) });
  if (bytes < 1024 * 1024 * 1024) return t("file_size_mb", { n: (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 1) });
  return t("file_size_gb", { n: (bytes / (1024 * 1024 * 1024)).toFixed(2) });
}

function mediaBytesFromDataUrl(url) {
  if (!url || typeof url !== "string") return 0;
  const i = url.indexOf(",");
  const b64 = i >= 0 ? url.slice(i + 1) : url;
  return Math.floor(b64.length * 3 / 4);
}

function pickMediaType(file) {
  if (!file) return "file";
  if (file.type) {
    if (file.type === "image/gif") return "gif";
    if (file.type.startsWith("image/")) return "image";
    if (file.type.startsWith("video/")) return "video";
    if (file.type.startsWith("audio/")) return "audio";
  }
  return "file";
}

function showProgress(file, pct) {
  const bar = $("uploadProgress"); if (!bar) return;
  bar.classList.remove("hidden");
  const fill = $("upFill"); if (fill) fill.style.width = Math.min(100, pct) + "%";
  const txt = $("upText");
  if (txt) {
    const total = formatFileSize(file.size);
    const done = formatFileSize(file.size * pct / 100);
    txt.textContent = Math.round(pct) + "%";
  }
}
function hideProgress() {
  const bar = $("uploadProgress"); if (bar) bar.classList.add("hidden");
  const fill = $("upFill"); if (fill) fill.style.width = "0%";
  const txt = $("upText"); if (txt) txt.textContent = "0%";
}
$("upCancel")?.addEventListener?.("click", () => {
  // Allow user to dismiss progress bar (file still uploads in background)
  uploadingCount = Math.max(0, uploadingCount - 1);
  if (uploadingCount <= 0) hideProgress();
});

function sendFile(file) {
  if (!file || !file.size || !myRoom) return null;
  const blocked = spamBlock("", true); // файлы — только анти-флуд, без проверки дублей
  if (blocked) { spamNotify(blocked); return "spam"; }
  if (file.size > MAX_FILE_BYTES) {
    notify(t("file_too_big_alert", { mb: MAX_FILE_SIZE_MB }));
    return "too_big";
  }
  const type = pickMediaType(file);
  const localId = ++localIdCounter;
  uploadingCount++;

  const reader = new FileReader();
  reader.onprogress = (e) => {
    if (e.lengthComputable) showProgress(file, (e.loaded / e.total) * 100);
  };
  reader.onload = () => {
    uploadingCount = Math.max(0, uploadingCount - 1);
    if (uploadingCount <= 0) hideProgress();
    const optimistic = {
      localId, id: null, fromLogin: profile.login, name: myName, ts: Date.now(),
      type, media: reader.result, mediaName: file.name, mediaSize: file.size,
      room: myRoom, _optimistic: true,
    };
    renderMessage(optimistic, true, false);
    socket.emit("message", { type, media: reader.result, mediaName: file.name, localId });
  };
  reader.onerror = () => {
    uploadingCount = Math.max(0, uploadingCount - 1);
    if (uploadingCount <= 0) hideProgress();
    notify("File read error");
  };
  reader.readAsDataURL(file);
  return null;
}
// ---------- Clipboard paste preview ----------
let _clipFile = null;
function showClipPreview(file) {
  const modal = $("clipPreview"); if (!modal) return;
  const img = $("clipImg"); if (img) { img.src = URL.createObjectURL(file); }
  const name = $("clipName"); if (name) name.textContent = file.name || t("file_untitled");
  const type = $("clipType"); if (type) type.textContent = file.type || "—";
  const size = $("clipSize"); if (size) size.textContent = formatFileSize(file.size);
  _clipFile = file;
  modal.classList.remove("hidden");
}
function hideClipPreview() {
  const modal = $("clipPreview"); if (!modal) return;
  modal.classList.add("hidden");
  const img = $("clipImg"); if (img && img.src) { URL.revokeObjectURL(img.src); img.src = ""; }
  _clipFile = null;
}
function mimeToExt(mime) {
  const map = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp", "image/svg+xml": "svg" };
  return map[mime] || "bin";
}
$("msgInput").addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) break;
      if (!file.name) Object.defineProperty(file, "name", { value: "clipboard." + mimeToExt(file.type), writable: true });
      if (file.size > MAX_FILE_BYTES) { notify(t("file_too_big_alert", { mb: MAX_FILE_SIZE_MB })); break; }
      showClipPreview(file);
      return;
    }
  }
});
$("clipSend")?.addEventListener("click", () => {
  if (_clipFile && myRoom) sendFile(_clipFile);
  hideClipPreview();
});
$("clipCancel")?.addEventListener("click", hideClipPreview);
$("clipClose")?.addEventListener("click", hideClipPreview);
$("clipPreview")?.addEventListener("click", (e) => { if (e.target === e.currentTarget) hideClipPreview(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("clipPreview")?.classList.contains("hidden")) hideClipPreview(); });

$("attachBtn").onclick = () => {
  // Без accept="image/*,..." теперь можно прикреплять ВСЁ; click() в chrome срабатывает
  // даже после programmatic reset value="".
  const fi = $("fileInput"); if (!fi) return;
  fi.value = "";
  fi.click();
};
$("fileInput").addEventListener("change", (e) => {
  const files = Array.from(e.target.files || []); if (!files.length) return;
  if (!myRoom) return; // без активного чата — молча игнорируем (file picker закрывается)
  files.forEach(sendFile);
  e.target.value = "";
});

// ---------- Drag & drop файлов в чат ----------
let _dragCounter = 0;
function isFileDrag(e) {
  const dt = e.dataTransfer;
  if (!dt) return false;
  if (dt.types && Array.from(dt.types).some(t => t === "Files")) return true;
  if (dt.files && dt.files.length > 0) return true;
  return false;
}
function showDropOverlay() {
  const cp = $("chatPane");
  if (cp) cp.classList.add("dragover");
}
function hideDropOverlay() {
  const cp = $("chatPane");
  if (cp) cp.classList.remove("dragover");
}
function handleDragEnter(e) {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  _dragCounter++;
  if (_dragCounter === 1) showDropOverlay();
}
function handleDragLeave(e) {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  _dragCounter = Math.max(0, _dragCounter - 1);
  if (_dragCounter === 0) hideDropOverlay();
}
function handleDragOver(e) {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
}
function handleDrop(e) {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  _dragCounter = 0; hideDropOverlay();
  if (!myRoom) { notify(t("drop_no_room")); return; }
  const files = Array.from(e.dataTransfer.files || []);
  if (!files.length) return;
  let rejected = 0;
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) { rejected++; continue; }
    sendFile(f);
  }
  if (rejected) notify(t("drop_some_too_big", { n: rejected, mb: MAX_FILE_SIZE_MB }));
}
function wireDragAndDrop() {
  const cp = $("chatPane"); if (!cp) return;
  cp.addEventListener("dragenter", handleDragEnter);
  cp.addEventListener("dragleave", handleDragLeave);
  cp.addEventListener("dragover", handleDragOver);
  cp.addEventListener("drop", handleDrop);
  window.addEventListener("dragover", (e) => { if (isFileDrag(e)) e.preventDefault(); });
  window.addEventListener("drop", (e) => { if (isFileDrag(e) && !e.defaultPrevented) e.preventDefault(); });
}
wireDragAndDrop();
// Сервер отклонил медиа по лимиту — показываем тост только отправившему (он и так уже
// увидит серый файл или отсутствие; здесь — понятная формулировка).
socket.on("file-rejected", ({ reason, maxMb } = {}) => {
  if (reason === "save_failed") notify(t("file_rejected_size", { mb: MAX_FILE_SIZE_MB }));
  else notify(t("file_rejected_size", { mb: maxMb || MAX_FILE_SIZE_MB }));
});
let mediaRecorder, recChunks = [], recStream, recTimer, recSec = 0;
$("voiceBtn").onclick = async () => {
  if (!myRoom) return;
  if (mediaRecorder && mediaRecorder.state === "recording") { mediaRecorder.stop(); return; }
  try { recStream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { alert(t("err_mic_voice")); return; }
  mediaRecorder = new MediaRecorder(recStream); recChunks = []; recSec = 0;
  mediaRecorder.ondataavailable = (e) => recChunks.push(e.data);
  mediaRecorder.onstop = () => {
    clearInterval(recTimer); recStream.getTracks().forEach((t) => t.stop()); resetVoice();
    const blob = new Blob(recChunks, { type: "audio/webm" });
    if (blob.size < 600 || blob.size > 20 * 1024 * 1024) return;
    const r = new FileReader(); r.onload = () => socket.emit("message", { type: "audio", media: r.result, mediaName: "voice" }); r.readAsDataURL(blob);
  };
  mediaRecorder.start();
  $("voiceBtn").classList.add("recording"); $("voiceBtn").innerHTML = window.ICON.stop;
  recTimer = setInterval(() => { if (++recSec >= 120) mediaRecorder.stop(); }, 1000);
};
function resetVoice() { $("voiceBtn").classList.remove("recording"); $("voiceBtn").innerHTML = window.ICON.mic; mediaRecorder = null; }

// Лайтбокс
const lb = $("lightbox"), lbImg = $("lightboxImg");
let lbScale = 1, lbX = 0, lbY = 0, lbDrag = null;
const applyLb = () => { lbImg.style.transform = `translate(${lbX}px,${lbY}px) scale(${lbScale})`; };
function openLightbox(src) { lbImg.src = src; lbScale = 1; lbX = lbY = 0; applyLb(); lb.classList.remove("hidden"); }
function closeLightbox() { lb.classList.add("hidden"); lbImg.src = ""; }
lb.addEventListener("click", (e) => { if (e.target === lb) closeLightbox(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLightbox(); });
lbImg.addEventListener("wheel", (e) => { e.preventDefault(); lbScale = Math.min(8, Math.max(1, lbScale + (e.deltaY < 0 ? 0.25 : -0.25))); if (lbScale === 1) { lbX = lbY = 0; } applyLb(); }, { passive: false });
lbImg.addEventListener("pointerdown", (e) => { if (lbScale <= 1) return; lbDrag = { x: e.clientX - lbX, y: e.clientY - lbY }; lbImg.setPointerCapture(e.pointerId); });
lbImg.addEventListener("pointermove", (e) => { if (!lbDrag) return; lbX = e.clientX - lbDrag.x; lbY = e.clientY - lbDrag.y; applyLb(); });
lbImg.addEventListener("pointerup", () => (lbDrag = null));

// ---------- Эмодзи-пикер ----------
const picker = $("emojiPicker");
function buildEmoji() {
  const tabs = $("emojiTabs"), grid = $("emojiGrid"); tabs.innerHTML = ""; grid.innerHTML = "";
  const cats = Object.keys(window.EMOJI);
  const show = (cat) => { grid.innerHTML = ""; window.EMOJI[cat].forEach((em) => { const b = document.createElement("button"); b.textContent = em; b.onclick = () => insertEmoji(em); grid.appendChild(b); }); [...tabs.children].forEach((c) => c.classList.toggle("active", c.dataset.cat === cat)); };
  cats.forEach((cat) => { const b = document.createElement("button"); b.textContent = cat; b.dataset.cat = cat; b.onclick = () => show(cat); tabs.appendChild(b); });
  show(cats[0]);
}
function insertEmoji(em) { const i = $("msgInput"); const s = i.selectionStart || i.value.length; i.value = i.value.slice(0, s) + em + i.value.slice(i.selectionEnd || s); i.focus(); }
function toggleEmoji(e) { e.stopPropagation(); $("gifPanel").classList.add("hidden"); if (!picker.dataset.built) { buildEmoji(); picker.dataset.built = "1"; } picker.classList.toggle("hidden"); }
$("emojiBtn").onclick = toggleEmoji;
document.addEventListener("click", (e) => { if (!picker.contains(e.target) && e.target !== $("emojiBtn") && !e.target.closest("#composerMore")) picker.classList.add("hidden"); });

const gifPanel = $("gifPanel"); let gifTimer;
function toggleGif(e) { e.stopPropagation(); picker.classList.add("hidden"); const show = gifPanel.classList.contains("hidden"); gifPanel.classList.toggle("hidden"); if (show) { loadGifs(""); $("gifSearch").focus(); } }
$("gifBtn").onclick = toggleGif;
$("gifSearch").addEventListener("input", (e) => { clearTimeout(gifTimer); gifTimer = setTimeout(() => loadGifs(e.target.value.trim()), 400); });
async function loadGifs(q) {
  const grid = $("gifGrid");
  const res = await fetch("/api/gif?q=" + encodeURIComponent(q), { headers: { Authorization: "Bearer " + token } });
  const d = await res.json(); $("gifNote").classList.toggle("hidden", !d.nokey); grid.innerHTML = "";
  (d.results || []).forEach((g) => { const img = new Image(); img.src = g.preview; img.className = "gif-item"; img.loading = "lazy"; img.onclick = () => { if (myRoom) socket.emit("message", { type: "gif", media: g.url, mediaName: "gif" }); gifPanel.classList.add("hidden"); }; grid.appendChild(img); });
}
document.addEventListener("click", (e) => { if (!gifPanel.contains(e.target) && e.target !== $("gifBtn") && !e.target.closest("#composerMore")) gifPanel.classList.add("hidden"); });

// Mobile composer more dropdown
const moreBtn = $("moreBtn");
const moreDropdown = $("composerMore");
if (moreBtn && moreDropdown) {
  moreBtn.onclick = (e) => { e.stopPropagation(); moreDropdown.classList.toggle("hidden"); };
  moreDropdown.querySelectorAll(".cm-item").forEach((item) => {
    item.onclick = () => {
      moreDropdown.classList.add("hidden");
      const action = item.dataset.action;
      if (action === "emoji") $("emojiBtn").click();
      else if (action === "gif") $("gifBtn").click();
      else if (action === "attach") $("fileInput").click();
      else if (action === "voice") $("voiceBtn").click();
    };
  });
  document.addEventListener("click", (e) => { if (!moreDropdown.contains(e.target) && e.target !== moreBtn) moreDropdown.classList.add("hidden"); });
}

// ====================== ЗВОНКИ (LiveKit SFU — надёжно через медиа-сервер) ======================
const call = { active: false, room: null, roomKey: null, roomTitle: "", minimized: false, micOn: true, camOn: false, sharing: false, ns: true, deaf: false, micWasOn: true, audioInId: null, audioOutId: null, camId: null };
const audioEls = new Map(); // identity -> <audio> (голос участника / микрофон)
const screenAudioEls = new Map(); // identity -> <audio> (звук демонстрации экрана, отдельно от микрофона)
const activeCalls = new Map(); // roomKey -> {count, logins} — где сейчас идёт звонок
const isMobile = () => matchMedia("(max-width:720px)").matches;
const vGrid = $("videoGrid"); // кешируем — выживает при переносе в окно поп-аута

function lkTile(identity) { return "p-" + identity.replace(/[^a-zA-Z0-9_]/g, ""); }
function ensureTile(identity, name, isMe) {
  const id = isMe ? "me" : lkTile(identity);
  let tile = $("tile-" + id);
  if (!tile) {
    tile = document.createElement("div"); tile.id = "tile-" + id; tile.className = "tile show-avatar" + (isMe ? " me" : "");
    tile.dataset.identity = identity;
    tile.innerHTML = `<video autoplay playsinline ${isMe ? "muted" : ""}></video>` +
      `<div class="tile-avatar" data-login="${isMe ? profile.login : identity}"><img src="${avaUrl(identity)}" onerror="this.style.display='none'"><span>${initials(name)}</span></div>` +
      `<div class="tile-name">${escapeHtml(name)}</div>` +
      `<button class="tile-expand" title="${t("t_window")}" aria-label="${t("t_window")}">${window.ICON.expand}</button>` +
      (isMe ? "" : `<div class="tile-ctrl"><button class="tctrl-mute" title="${t("mute_user")}">${window.ICON.volume}</button><input class="tctrl-vol" type="range" min="0" max="1" step="0.05" value="1" title="${t("volume")}"></div>`);
    vGrid.appendChild(tile);
    if (!isMe) wireTileControls(tile, identity);
    if (vGrid.classList.contains("has-focus")) relocateNewTile(tile);
  }
  updateCallCount(); scheduleFsLayout(); return tile;
}
// Громкость/мут конкретного участника (локально, через LiveKit setVolume)
const tileVol = new Map(); // identity -> {vol, muted}
function wireTileControls(tile, identity) {
  const muteBtn = tile.querySelector(".tctrl-mute"), vol = tile.querySelector(".tctrl-vol");
  const st = tileVol.get(identity) || { vol: 1, muted: false }; tileVol.set(identity, st);
  const apply = () => { const p = call.room && (call.room.remoteParticipants?.get?.(identity) || call.room.getParticipantByIdentity?.(identity)); if (p && p.setVolume) try { p.setVolume(st.muted ? 0 : st.vol); } catch {} };
  vol.value = st.vol;
  vol.oninput = () => { st.vol = parseFloat(vol.value); if (st.muted) { st.muted = false; muteBtn.innerHTML = window.ICON.volume; muteBtn.classList.remove("muted"); } apply(); };
  muteBtn.onclick = () => { st.muted = !st.muted; muteBtn.innerHTML = st.muted ? window.ICON.volumeMute : window.ICON.volume; muteBtn.classList.toggle("muted", st.muted); apply(); };
  apply();
}
function removeParticipant(identity) {
  const id = lkTile(identity); removeTile(id); removeTile("screen-" + id);
  const a = audioEls.get(identity); if (a) { a.srcObject = null; a.remove(); audioEls.delete(identity); }
  const sa = screenAudioEls.get(identity); if (sa) { sa.srcObject = null; sa.remove(); screenAudioEls.delete(identity); }
  updateCallCount();
}
function removeTile(id) {
  const t = $("tile-" + id); if (!t) return;
  const wasFocused = t.classList.contains("focused");
  t.remove();
  if (wasFocused) { dissolveStrip(); vGrid.classList.remove("has-focus"); }
  scheduleFsLayout();
}
function setTileAvatar(id, show) { const t = $("tile-" + id); if (t) t.classList.toggle("show-avatar", show); }
// Свой self-view: всегда чистим <video>.srcObject перед attach, иначе на повторном
// включении камеры остаётся "мёртвая" дорожка и локально превью не видно (см. detach выше).
function attachLocalCamera(track) {
  const tile = ensureTile(profile.login, myName, true);
  const v = tile.querySelector("video");
  if (v) { v.srcObject = null; try { track.attach(v); } catch {} }
  setTileAvatar("me", false);
}
function addScreenTile(id, name, mediaTrack) {
  let tile = $("tile-screen-" + id);
  if (!tile) {
    tile = document.createElement("div"); tile.id = "tile-screen-" + id; tile.className = "tile screen";
    tile.innerHTML =
      `<video autoplay playsinline ${id === "me" ? "muted" : ""}></video>` +
      `<div class="tile-name">🖥 ${escapeHtml(name)}</div>` +
      `<button class="tile-expand" title="${t("t_window")}" aria-label="${t("t_window")}">${window.ICON.expand}</button>`;
    vGrid.appendChild(tile);
    // Clicks are handled by the delegated handler on vGrid (zoom / spotlight).
    if (vGrid.classList.contains("has-focus")) relocateNewTile(tile);
  }
  const v = tile.querySelector("video"); if (mediaTrack) mediaTrack.attach(v); v.play().catch(() => {});
  scheduleFsLayout();
}
// Spotlight: show one stream big, everyone else in a strip under it.
// In fullscreen the non-focused tiles are moved into a dedicated .faces-strip
// (so it can be a single centered, horizontally-scrollable row); focusTile(null)
// dissolves the strip and returns to the balanced grid.
function dissolveStrip() {
  const s = vGrid.querySelector(":scope > .faces-strip");
  if (s) { while (s.firstChild) vGrid.appendChild(s.firstChild); s.remove(); }
}
function buildStrip() {
  dissolveStrip();
  const s = document.createElement("div"); s.className = "faces-strip";
  vGrid.appendChild(s);
  vGrid.querySelectorAll(":scope > .tile:not(.focused)").forEach((t) => s.appendChild(t));
}
// A tile that appeared while a stream is spotlighted belongs in the strip.
function relocateNewTile(tile) {
  const s = vGrid.querySelector(":scope > .faces-strip");
  if (s && !tile.classList.contains("focused")) s.appendChild(tile);
}
function focusTile(tile) {
  dissolveStrip();
  vGrid.querySelectorAll(".tile.focused").forEach((t) => t.classList.remove("focused"));
  const fs = vGrid.classList.contains("fs");
  if (tile) {
    tile.classList.add("focused"); vGrid.classList.add("has-focus");
    if (fs) { buildStrip(); showGridHint(); }
  } else {
    vGrid.classList.remove("has-focus");
    if (fs) scheduleFsLayout();
  }
}

// Balanced, rectangular fullscreen grid (Discord-style): compute the column
// count + tile width that maximises tile size for 16:9 rectangles that fit the
// stage, so tiles are never stretched into tall portrait columns.
let fsLayoutRaf = 0;
function scheduleFsLayout() { cancelAnimationFrame(fsLayoutRaf); fsLayoutRaf = requestAnimationFrame(layoutFsTiles); }
function layoutFsTiles() {
  if (!vGrid.classList.contains("fs") || vGrid.classList.contains("has-focus")) return;
  const tiles = vGrid.querySelectorAll(":scope > .tile");
  const n = tiles.length; if (!n) return;
  const W = vGrid.clientWidth, H = vGrid.clientHeight; if (!W || !H) return;
  const gap = 12, ratio = 16 / 9;
  let best = { w: 0, cols: 1 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cw = (W - gap * (cols - 1)) / cols;
    const ch = (H - gap * (rows - 1)) / rows;
    let w = cw, h = w / ratio;
    if (h > ch) { h = ch; w = h * ratio; }
    if (w > best.w) best = { w, cols };
  }
  vGrid.style.setProperty("--fs-cols", best.cols);
  vGrid.style.setProperty("--fs-tw", Math.floor(best.w) + "px");
}

// Small, auto-fading hint telling the user how to leave the spotlight.
function showGridHint() {
  const st = callStageEl(); if (!st) return;
  let h = st.querySelector(".fs-hint");
  if (!h) { h = document.createElement("div"); h.className = "fs-hint"; st.appendChild(h); }
  h.textContent = t("fs_dblclick_hint") || "Double-click the stream to return to the grid";
  h.classList.add("show");
  clearTimeout(h._t); h._t = setTimeout(() => h.classList.remove("show"), 3200);
}
function updateCallCount() { $("callCount").textContent = vGrid.querySelectorAll(".tile:not(.screen)").length; }
function updateCallStatus() {
  const el = $("callStatus"); if (!el) return;
  const s = call.room ? call.room.state : ""; // 'connecting'|'connected'|'reconnecting'|'disconnected'
  const map = { connecting: "call_connecting", connected: "call_connected", reconnecting: "call_disconnected", disconnected: "call_disconnected" };
  el.textContent = call.active ? t(map[s] || "call_waiting") : "";
  el.className = "call-status " + (s === "connected" ? "ok" : s === "reconnecting" || s === "disconnected" ? "bad" : "");
}

function attachTrack(track, pub, participant) {
  const identity = participant.identity, name = participant.name || identity;
  ensureTile(identity, name, false); // тайл участника есть всегда (даже только с аудио)
  if (track.kind === "video") {
    if (pub.source === "screen_share") { addScreenTile(lkTile(identity), name, track); }
    else { const tile = ensureTile(identity, name, false); track.attach(tile.querySelector("video")); setTileAvatar(lkTile(identity), false); }
  } else if (track.kind === "audio") {
    if (pub.source === "screen_share_audio") {
      // Screen-share audio plays on its OWN element so it never overwrites the
      // participant's microphone audio (both are kind:"audio").
      let sa = screenAudioEls.get(identity);
      if (!sa) { sa = document.createElement("audio"); sa.autoplay = true; document.body.appendChild(sa); screenAudioEls.set(identity, sa); }
      track.attach(sa); applySinkId(sa); sa.muted = call.deaf;
    } else {
      let a = audioEls.get(identity); if (!a) { a = document.createElement("audio"); a.autoplay = true; document.body.appendChild(a); audioEls.set(identity, a); }
      track.attach(a); applySinkId(a); a.muted = call.deaf;
      setMicIndicator(lkTile(identity), pub.isMuted);
    }
  }
}
function detachTrack(track, pub, participant) {
  const identity = participant.identity;
  if (track.kind === "video") { if (pub.source === "screen_share") removeTile("screen-" + lkTile(identity)); else { track.detach(); setTileAvatar(lkTile(identity), true); } }
  else if (track.kind === "audio") {
    track.detach();
    if (pub.source === "screen_share_audio") { const sa = screenAudioEls.get(identity); if (sa) { sa.srcObject = null; sa.remove(); screenAudioEls.delete(identity); } }
  }
}
function wireRoom(room, LK) {
  const E = LK.RoomEvent;
  room.on(E.TrackSubscribed, attachTrack);
  room.on(E.TrackUnsubscribed, detachTrack);
  room.on(E.ParticipantConnected, (p) => { ensureTile(p.identity, p.name || p.identity, false); sfx.join(); });
  room.on(E.ParticipantDisconnected, (p) => { removeParticipant(p.identity); sfx.leave(); });
  room.on(E.ActiveSpeakersChanged, (speakers) => {
    const ids = new Set(speakers.map((s) => s.isLocal ? "me" : lkTile(s.identity)));
    vGrid.querySelectorAll(".tile:not(.screen)").forEach((tl) => tl.classList.toggle("speaking", ids.has(tl.id.replace("tile-", ""))));
  });
  room.on(E.LocalTrackPublished, (pub) => {
    if (pub.track.kind === "video") {
      if (pub.source === "screen_share") addScreenTile("me", myName + " " + t("you_suffix"), pub.track);
      else attachLocalCamera(pub.track);
    }
  });
  room.on(E.LocalTrackUnpublished, (pub) => {
    if (pub.source === "screen_share") removeTile("screen-me");
    else if (pub.track && pub.track.kind === "video") {
      // ВАЖНО: отцепляем дорожку от своего <video>, иначе на нём остаётся "мёртвый"
      // srcObject — и при повторном включении камеры локальный self-view не появляется
      // (приватность: другие видят камеру, а ты — нет). Удалёнными так и делается (detachTrack).
      try { pub.track.detach(); } catch {}
      setTileAvatar("me", true);
    }
  });
  // Индикатор «микрофон выключен» у участников
  room.on(E.TrackMuted, (pub, p) => { if (pub.kind === "audio") setMicIndicator(p.isLocal ? "me" : lkTile(p.identity), true); });
  room.on(E.TrackUnmuted, (pub, p) => { if (pub.kind === "audio") setMicIndicator(p.isLocal ? "me" : lkTile(p.identity), false); });
  room.on(E.ConnectionStateChanged, updateCallStatus);
  room.on(E.Disconnected, () => { if (call.active) endCall(); });
}
function setMicIndicator(tileId, muted) {
  const tile = $("tile-" + tileId); if (!tile) return;
  let ind = tile.querySelector(".tile-mic");
  if (muted) { if (!ind) { ind = document.createElement("div"); ind.className = "tile-mic"; ind.innerHTML = window.ICON.micOff; tile.appendChild(ind); } }
  else if (ind) ind.remove();
}

// Кнопка звонка: в звонке здесь → положить; идёт звонок здесь → войти; иначе начать/войти
$("startCallBtn").onclick = () => {
  if (!myRoom) return;
  if (call.active && call.roomKey === myRoom) { endCall(); return; }
  if (call.active && call.roomKey !== myRoom) endCall(); // выходим из звонка в другой комнате
  joinCall();
};
// Состояние звонка в комнате (для кнопки «войти» и боковой панели)
socket.on("call-state", ({ room, count, logins }) => {
  if (count > 0) activeCalls.set(room, { count, logins }); else activeCalls.delete(room);
  updateCallButton(); if (!$("infoPanel").classList.contains("hidden")) renderMembers();
});
function updateCallButton() {
  const btn = $("startCallBtn"); if (!btn) return;
  const inThis = call.active && call.roomKey === myRoom;
  const ongoing = !inThis && activeCalls.has(myRoom);
  btn.classList.toggle("in-call", inThis);
  btn.classList.toggle("join-call", ongoing);
  // «Групповой звонок» только в группах; в DM участников всего двое — просто «Звонок».
  const startLabel = curKind === "group" ? t("t_call") : t("call_dm");
  btn.title = inThis ? t("t_hangup") : ongoing ? t("join_call") : startLabel;
  btn.innerHTML = inThis ? window.ICON.phoneOff : window.ICON.phone;
}
// Показ/сворачивание оверлея звонка в зависимости от просматриваемого чата и флага minimized
// Звонок = левая колонка переписки (ПК): сообщения адаптивно справа, не под звонком. Телефон — стек сверху.
function syncCallUI() {
  const stage = $("callStage"), vb = $("voiceBar"), pane = $("chatPane");
  if (!call.active) { stage.classList.add("hidden"); stage.classList.remove("fullscreen"); vb.classList.add("hidden"); pane.classList.remove("has-call"); return; }
  const here = myRoom === call.roomKey;
  const showStage = here && !(isMobile() && call.minimized);
  stage.classList.toggle("hidden", !showStage);
  if (!here) { stage.classList.remove("fullscreen"); pane.classList.remove("fullscreen-call"); }
  pane.classList.toggle("has-call", showStage && !isMobile()); // ПК: звонок — колонка/полоса чата
  applyDock();
  // Мобильный «большой экран»: отдельных окон нет (телефоны их не поддерживают) —
  // показываем ту же красивую сетку .pip-grid прямо в полноэкранном стейдже, тап по
  // стриму разворачивает его (focusTile). На ПК в доке — обычная сетка.
  if (vGrid.parentElement === stage) vGrid.classList.toggle("pip-grid", isMobile() && showStage);
  vb.classList.toggle("hidden", showStage);
  updateVoiceBar();
}
function updateVoiceBar() {
  if (!call.active) return;
  $("vbInfo").querySelector(".vb-label").textContent = call.roomTitle || "";
  $("vbMic").innerHTML = window.ICON[call.micOn ? "mic" : "micOff"]; $("vbMic").classList.toggle("off", !call.micOn);
  $("vbDeafen").innerHTML = window.ICON[call.deaf ? "headphonesOff" : "headphones"]; $("vbDeafen").classList.toggle("off", call.deaf);
  $("vbHang").innerHTML = window.ICON.phoneOff;
}
$("vbInfo").onclick = () => { call.minimized = false; const c = chats.get(call.roomKey); if (c) openChat(c); else if (call.roomKey) openRoomByKey(call.roomKey, call.roomTitle); };
$("vbMic").onclick = () => setMic(!call.micOn);
$("vbDeafen").onclick = () => $("toggleDeafen").click();
$("vbHang").onclick = endCall;

// Док звонка: лево / право / верх — перетаскиванием грипа, сохраняется
let callDock = localStorage.getItem("dialog_dock") || "left";
function applyDock() {
  const p = $("chatPane"); p.classList.remove("dock-left", "dock-right", "dock-top"); p.classList.add("dock-" + callDock);
  const w = localStorage.getItem("dialog_callw"), h = localStorage.getItem("dialog_callh");
  if (w) p.style.setProperty("--call-w", w + "%"); if (h) p.style.setProperty("--call-h", h + "%");
}
// Ресайз панели звонка (тянуть внутренний край)
(function () {
  const rz = $("callResizer"), pane = $("chatPane"); let dr = false;
  rz.addEventListener("pointerdown", (e) => { dr = true; rz.setPointerCapture(e.pointerId); e.preventDefault(); });
  rz.addEventListener("pointermove", (e) => {
    if (!dr) return; const r = pane.getBoundingClientRect();
    if (callDock === "top") { let v = Math.max(15, Math.min(75, (e.clientY - r.top) / r.height * 100)); pane.style.setProperty("--call-h", v + "%"); localStorage.setItem("dialog_callh", v.toFixed(1)); }
    else { let v = callDock === "right" ? (r.right - e.clientX) / r.width * 100 : (e.clientX - r.left) / r.width * 100; v = Math.max(22, Math.min(70, v)); pane.style.setProperty("--call-w", v + "%"); localStorage.setItem("dialog_callw", v.toFixed(1)); }
  });
  rz.addEventListener("pointerup", () => (dr = false));
})();
$("minBtn").onclick = () => { call.minimized = true; syncCallUI(); };
(function () {
  const grip = $("callGrip"), pane = $("chatPane"); let hint = null, dragging = false;
  const zoneAt = (x, y) => { const r = pane.getBoundingClientRect(); if ((y - r.top) / r.height < 0.28) return "top"; return (x - r.left) / r.width < 0.5 ? "left" : "right"; };
  function showHint(zone) {
    if (!hint) { hint = document.createElement("div"); hint.className = "dock-hint"; pane.appendChild(hint); }
    let s = { left: "8px", right: "auto", top: "8px", bottom: "auto", width: "calc(34% - 16px)", height: "calc(100% - 16px)" };
    if (zone === "right") { s.left = "auto"; s.right = "8px"; }
    if (zone === "top") { s = { left: "8px", right: "8px", top: "8px", bottom: "auto", width: "auto", height: "40%" }; }
    Object.assign(hint.style, s); hint.classList.add("show");
  }
  grip.addEventListener("pointerdown", (e) => { dragging = true; grip.setPointerCapture(e.pointerId); showHint(callDock); });
  grip.addEventListener("pointermove", (e) => { if (dragging) showHint(zoneAt(e.clientX, e.clientY)); });
  grip.addEventListener("pointerup", (e) => { if (!dragging) return; dragging = false; if (hint) hint.classList.remove("show"); callDock = zoneAt(e.clientX, e.clientY); localStorage.setItem("dialog_dock", callDock); applyDock(); });
})();
async function joinCall() {
  ensureAudioCtx();
  const { ok, data } = await api("/api/livekit/token?room=" + encodeURIComponent(myRoom), null, "GET");
  if (!ok || !data.enabled) { alert(t("call_disabled")); return; }
  const LK = window.LivekitClient;
  if (!LK) { alert(t("call_disabled")); return; }
  const room = new LK.Room({ adaptiveStream: true, dynacast: true, audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  call.room = room; call.active = true; call.roomKey = myRoom; call.roomTitle = curTitle; call.minimized = false; wireRoom(room, LK); startCallMatrix(); startPing();
  $("startCallBtn").classList.add("in-call"); hideToast(); syncCallUI(); updateCallStatus(); sfx.start();
  ensureTile(profile.login, myName + " " + t("you_suffix"), true); setTileAvatar("me", true);
  try {
    await room.connect(data.url, data.token);
    await room.localParticipant.setMicrophoneEnabled(true);
    if (call.audioInId) await room.switchActiveDevice("audioinput", call.audioInId).catch(() => {});
    applyNoiseFilter(true); // усиленный шумодав по умолчанию
    // показать уже присутствующих участников (для них ParticipantConnected не приходит)
    const parts = room.remoteParticipants || room.participants;
    parts && parts.forEach((p) => {
      ensureTile(p.identity, p.name || p.identity, false);
      const pubs = p.trackPublications || p.tracks;
      pubs && pubs.forEach((pub) => { if (pub.track) attachTrack(pub.track, pub, p); });
      if (!p.isMicrophoneEnabled) setMicIndicator(lkTile(p.identity), true);
    });
  } catch (e) { console.error("livekit connect", e); if (call.active) { alert(t("err_media") + (e.message || "")); endCall(); } return; }
  call.micOn = true; call.camOn = false; call.sharing = false; call.ns = true;
  $("toggleMic").classList.remove("off"); $("toggleCam").classList.add("off"); $("shareScreen").classList.remove("active"); $("noiseToggle").classList.add("on");
  $("toggleMic").innerHTML = window.ICON.mic; $("toggleCam").innerHTML = window.ICON.cameraOff;
  populateDevices(); startKeepAlive(); updateCallStatus(); updateCallButton();
  $("toggleDeafen").classList.remove("off"); $("toggleDeafen").innerHTML = window.ICON.headphones;
  dismissNotif(myRoom);
  socket.emit("call-join", { title: curTitle }); // ring others + объявить звонок в комнате
}
function endCall() {
  hideToast(); stopRingtone();
  if (isCallFullscreen()) exitCallFullscreen(); // tear down native/overlay fullscreen
  const wasActive = call.active;
  if (call.active) socket.emit("call-leave");
  if (call.room) { try { call.room.disconnect(); } catch {} call.room = null; }
  for (const a of audioEls.values()) { try { a.srcObject = null; a.remove(); } catch {} } audioEls.clear();
  for (const a of screenAudioEls.values()) { try { a.srcObject = null; a.remove(); } catch {} } screenAudioEls.clear();
  vGrid.innerHTML = ""; vGrid.classList.remove("pip-grid", "has-focus"); // сброс мобильного большого экрана
  $("callStage").classList.add("hidden"); $("callStage").classList.remove("fullscreen"); $("voiceBar").classList.add("hidden");
  $("chatPane").classList.remove("has-call", "fullscreen-call"); // убрать grid-колонку звонка — без неё была чёрная зона
  $("startCallBtn").classList.remove("in-call");
  Object.assign(call, { active: false, sharing: false, micOn: true, camOn: false, ns: true, deaf: false, micWasOn: true, roomKey: null, minimized: false });
  screenTrack = null; screenAudioTrack = null; closeScreenModal(); // демонстрация экрана: сброс при выходе из звонка
  krispNode = null; stopCallMatrix();
  $("toggleMic").classList.remove("off"); $("toggleCam").classList.remove("off"); $("toggleDeafen").classList.remove("off"); $("shareScreen").classList.remove("active"); $("noiseToggle").classList.add("on"); $("micDropdown").classList.remove("open");
  $("toggleMic").innerHTML = window.ICON.mic; $("toggleCam").innerHTML = window.ICON.camera; $("toggleDeafen").innerHTML = window.ICON.headphones; $("callStatus").textContent = "";
  stopKeepAlive(); updateCallButton();
  if (wasActive) sfx.end();
  stopPing();
}
$("hangUp").onclick = endCall;

// Ringing (через Socket.IO + push) — медиа поднимает LiveKit
socket.on("call-ring", (p) => {
  if (call.active) return;
  ensureAudioCtx();
  if (!isMuted(p.room) && !isDnd()) {
    sfx.call();
    notify(t("call_in", { title: p.title }), p.room);
  }
  const kind = p.room.startsWith("@grp:") ? "group" : "dm";
  showToast(p.from, p.name, { room: p.room, title: p.title, kind });
});
socket.on("call-auto-end", () => { if (call.active) endCall(); });
socket.on("call-replaced", () => {
  if (call.active) { dismissNotif(call.roomKey || myRoom); endCall(); }
  showDeviceTakeover();
});
// Red notice (same style as the reconnecting banner) shown when another device
// of yours joins a call and takes it over from this one.
let takeoverEl = null;
function showDeviceTakeover() {
  if (!takeoverEl) { takeoverEl = document.createElement("div"); takeoverEl.className = "conn-status device-takeover"; document.body.appendChild(takeoverEl); }
  takeoverEl.textContent = t("call_other_device") || "A different device connected to a call";
  takeoverEl.classList.add("show");
  clearTimeout(takeoverEl._t); takeoverEl._t = setTimeout(() => takeoverEl.classList.remove("show"), 6000);
}

// Контролы
async function setMic(on) {
  call.micOn = on;
  try { await call.room.localParticipant.setMicrophoneEnabled(on); } catch {}
  $("toggleMic").classList.toggle("off", !on); $("toggleMic").innerHTML = window.ICON[on ? "mic" : "micOff"];
  setMicIndicator("me", !on); (on ? sfx.unmute : sfx.mute)();
}
$("toggleMic").onclick = () => { if (!call.room) return; setMic(!call.micOn); };
// Заглушить наушники (deafen) — глушим входящий звук; по-дискордовски выключаем и свой микрофон
$("toggleDeafen").onclick = () => {
  if (!call.room) return;
  call.deaf = !call.deaf;
  audioEls.forEach((a) => (a.muted = call.deaf));
  screenAudioEls.forEach((a) => (a.muted = call.deaf));
  $("toggleDeafen").classList.toggle("off", call.deaf);
  $("toggleDeafen").innerHTML = window.ICON[call.deaf ? "headphonesOff" : "headphones"];
  if (call.deaf) { call.micWasOn = call.micOn; if (call.micOn) setMic(false); }
  else if (call.micWasOn) setMic(true);
};
// Лимит одновременных видеопотоков в групповом звонке (камеры + демонстрации экрана).
// В DM участников максимум двое, поэтому ограничение касается только групп.
const STREAM_LIMIT = 3;
const isGroupCall = () => (call.roomKey || "").startsWith("@grp:");
function videoStreamCount() {
  return vGrid.querySelectorAll(".tile.screen").length
       + vGrid.querySelectorAll(".tile:not(.screen):not(.show-avatar)").length;
}
// true → можно включать свой поток; false → достигнут лимит (показываем уведомление)
function canStartStream() {
  if (isGroupCall() && videoStreamCount() >= STREAM_LIMIT) { notify(t("stream_limit", { n: STREAM_LIMIT })); return false; }
  return true;
}
$("toggleCam").onclick = async () => {
  if (!call.room) return;
  if (!call.camOn && !canStartStream()) return;
  call.camOn = !call.camOn;
  try {
    if (call.camOn && call.camId) await call.room.switchActiveDevice("videoinput", call.camId);
    await call.room.localParticipant.setCameraEnabled(call.camOn, { resolution: { width: 640, height: 360 } });
  } catch { call.camOn = false; }
  $("toggleCam").classList.toggle("off", !call.camOn);
  $("toggleCam").innerHTML = window.ICON[call.camOn ? "camera" : "cameraOff"];
  if (call.camOn) {
    // self-view сразу, не дожидаясь LocalTrackPublished (подстраховка от приватного бага)
    const Src = window.LivekitClient && window.LivekitClient.Track.Source.Camera;
    const pub = Src && call.room.localParticipant.getTrackPublication ? call.room.localParticipant.getTrackPublication(Src) : null;
    if (pub && pub.track) attachLocalCamera(pub.track); else setTileAvatar("me", false);
  } else {
    setTileAvatar("me", true);
  }
};
// ── Демонстрация экрана (Discord-стиль): сначала выбор качества, потом нативный
// выбор окна/экрана. Захватываем ВИДЕО + ЗВУК через getDisplayMedia и публикуем
// обе дорожки в комнату LiveKit (ScreenShare + ScreenShareAudio).
//
// Чтобы НЕ ловить эхо со звуком самого Dialog (голоса других участников):
//   • selfBrowserSurface:"exclude" — вкладку dialogmsg.xyz нельзя выбрать как
//     источник, поэтому её звук физически не попадёт в захват при шаринге вкладки;
//   • suppressLocalAudioPlayback:true — захваченный звук не дублируется в наши же
//     колонки, что разрывает петлю обратной связи.
let screenTrack = null, screenAudioTrack = null;
let screenQuality = { w: 1920, h: 1080, fps: 30 };
function openScreenModal() { const m = $("screenModal"); if (!m) return; $("ssError").textContent = ""; m.classList.remove("hidden"); }
function closeScreenModal() { const m = $("screenModal"); if (m) m.classList.add("hidden"); }
function setShareActive(on) { call.sharing = on; $("shareScreen").classList.toggle("active", on); }
async function startScreenShare() {
  const LK = window.LivekitClient;
  if (!call.room || !LK) return;
  const q = screenQuality;
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: q.fps } },
      audio: {
        // capture the shared audio raw (music/game quality) — no voice processing
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        // don't replay captured audio through our own speakers → no feedback loop
        suppressLocalAudioPlayback: true,
      },
      // don't offer the Dialog tab itself as a source (so its audio — other
      // participants' voices — can never be captured/echoed back)
      selfBrowserSurface: "exclude",
      systemAudio: "include",
    });
  } catch { closeScreenModal(); setShareActive(false); return; } // пользователь отменил выбор
  const vTrack = stream.getVideoTracks()[0];
  if (!vTrack) { stream.getTracks().forEach((t) => { try { t.stop(); } catch {} }); closeScreenModal(); setShareActive(false); return; }
  const aTrack = stream.getAudioTracks()[0] || null;
  const lp = call.room.localParticipant;
  try {
    const lkVideo = new LK.LocalVideoTrack(vTrack);
    await lp.publishTrack(lkVideo, {
      source: LK.Track.Source.ScreenShare,
      videoEncoding: { maxBitrate: q.h >= 1440 ? 6000000 : q.h >= 1080 ? 3000000 : 1500000, maxFramerate: q.fps },
      simulcast: false,
    });
    screenTrack = lkVideo;
    // Аудио — опционально: если пользователь не поделился звуком, просто нет дорожки.
    if (aTrack) {
      try {
        const lkAudio = new LK.LocalAudioTrack(aTrack);
        await lp.publishTrack(lkAudio, { source: LK.Track.Source.ScreenShareAudio, dtx: false, red: false, audioBitrate: 128000 });
        screenAudioTrack = lkAudio;
        aTrack.addEventListener("ended", () => { if (screenAudioTrack && call.room) { try { call.room.localParticipant.unpublishTrack(screenAudioTrack, true); } catch {} screenAudioTrack = null; } });
      } catch { try { aTrack.stop(); } catch {} } // видео оставляем, даже если звук не опубликовался
    }
    setShareActive(true);
    vTrack.addEventListener("ended", () => stopScreenShare()); // браузерная кнопка «Stop sharing»
    closeScreenModal();
  } catch {
    $("ssError").textContent = t("screen_share_failed");
    try { vTrack.stop(); } catch {} if (aTrack) { try { aTrack.stop(); } catch {} }
    setShareActive(false);
  }
}
async function stopScreenShare() {
  const lp = call.room && call.room.localParticipant;
  if (lp) {
    if (screenTrack) { try { await lp.unpublishTrack(screenTrack, true); } catch {} }
    if (screenAudioTrack) { try { await lp.unpublishTrack(screenAudioTrack, true); } catch {} }
  }
  screenTrack = null; screenAudioTrack = null; setShareActive(false);
}
$("shareScreen").onclick = () => {
  if (!call.room) return;
  if (call.sharing) { stopScreenShare(); return; }
  if (!canStartStream()) return;
  openScreenModal();
};
$("ssQuality").addEventListener("click", (e) => {
  const b = e.target.closest(".ss-opt"); if (!b) return;
  $("ssQuality").querySelectorAll(".ss-opt").forEach((o) => o.classList.remove("active"));
  b.classList.add("active");
  screenQuality = { w: +b.dataset.w, h: +b.dataset.h, fps: +b.dataset.fps };
});
$("ssConfirm").onclick = startScreenShare;
$("ssCancel").onclick = closeScreenModal;
$("ssCancelBtn").onclick = closeScreenModal;
$("screenModal").addEventListener("click", (e) => { if (e.target === $("screenModal")) closeScreenModal(); });

// Дропдаун микрофона + устройства
$("micDrop").onclick = (e) => { e.stopPropagation(); $("micDropdown").classList.toggle("open"); if ($("micDropdown").classList.contains("open")) populateDevices(); };
document.addEventListener("click", (e) => { if (!e.target.closest(".call-btn-group")) $("micDropdown").classList.remove("open"); });
$("toggleNoise").onclick = (e) => { e.stopPropagation(); call.ns = !call.ns; $("noiseToggle").classList.toggle("on", call.ns); const snt = $("settingsNoiseToggle"); if (snt) snt.classList.toggle("on", call.ns); applyNoiseFilter(call.ns); saveDevicePrefs(); };
// Усиленный шумодав Krisp (LiveKit Cloud). Грузим по требованию; при неудаче остаётся браузерный NS.
let krispMod = null, krispNode = null;
async function applyNoiseFilter(on) {
  if (!call.room || !window.LivekitClient) return;
  const pub = call.room.localParticipant.getTrackPublication(window.LivekitClient.Track.Source.Microphone);
  const track = pub && pub.track; if (!track) return;
  try {
    if (on) {
      if (!krispMod) krispMod = await import("https://esm.sh/@livekit/krisp-noise-filter");
      if (krispMod.isKrispNoiseFilterSupported && !krispMod.isKrispNoiseFilterSupported()) { console.log("krisp unsupported — браузерный NS"); return; }
      if (!krispNode) krispNode = krispMod.KrispNoiseFilter();
      await track.setProcessor(krispNode);
      console.log("Krisp шумодав включён");
    } else if (track.stopProcessor) { await track.stopProcessor().catch(() => {}); }
  } catch (e) { console.log("krisp:", e.message); }
}
function applySinkId(el) { if (call.audioOutId && el.setSinkId) el.setSinkId(call.audioOutId).catch(() => {}); }
async function populateDevices() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const fill = (sel, kind, cur, label) => { sel.innerHTML = ""; devs.filter((d) => d.kind === kind).forEach((d, i) => { const o = document.createElement("option"); o.value = d.deviceId; o.textContent = d.label || label + " " + (i + 1); if (d.deviceId === cur) o.selected = true; sel.appendChild(o); }); };
    fill($("micSelect"), "audioinput", call.audioInId, "Mic");
    const spk = $("spkSelect"); fill(spk, "audiooutput", call.audioOutId, "Speaker");
    if (!("setSinkId" in HTMLMediaElement.prototype)) { spk.style.display = "none"; if (spk.previousElementSibling) spk.previousElementSibling.style.display = "none"; }
  } catch {}
}
$("micSelect").onchange = async () => { call.audioInId = $("micSelect").value; if (call.room) { try { await call.room.switchActiveDevice("audioinput", call.audioInId); } catch {} } saveDevicePrefs(); };
$("spkSelect").onchange = () => { call.audioOutId = $("spkSelect").value; audioEls.forEach(applySinkId); if (call.room) call.room.switchActiveDevice("audiooutput", call.audioOutId).catch(() => {}); saveDevicePrefs(); };

// Устройства — сохранение и загрузка из localStorage
const DEVICE_KEY = "dialog_devices";
function loadDevicePrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(DEVICE_KEY));
    if (saved) {
      if (saved.audioInId) call.audioInId = saved.audioInId;
      if (saved.audioOutId) call.audioOutId = saved.audioOutId;
      if (saved.camId) call.camId = saved.camId;
      if (saved.ns !== undefined) call.ns = saved.ns;
    }
  } catch {}
}
function saveDevicePrefs() {
  try { localStorage.setItem(DEVICE_KEY, JSON.stringify({ audioInId: call.audioInId, audioOutId: call.audioOutId, camId: call.camId, ns: call.ns })); } catch {}
}
async function populateDeviceSettings() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const fill = (sel, kind, cur, label) => { sel.innerHTML = ""; devs.filter((d) => d.kind === kind).forEach((d, i) => { const o = document.createElement("option"); o.value = d.deviceId; o.textContent = d.label || label + " " + (i + 1); if (d.deviceId === cur) o.selected = true; sel.appendChild(o); }); };
    fill($("settingsMicSelect"), "audioinput", call.audioInId, "Mic");
    const spk = $("settingsSpkSelect"); fill(spk, "audiooutput", call.audioOutId, "Speaker");
    if (!("setSinkId" in HTMLMediaElement.prototype)) spk.style.display = "none";
    fill($("settingsCamSelect"), "videoinput", call.camId, "Camera");
    const snt = $("settingsNoiseToggle"); if (snt) snt.classList.toggle("on", call.ns);
  } catch {}
}
$("settingsMicSelect").onchange = async () => { call.audioInId = $("settingsMicSelect").value; if (call.room) { try { await call.room.switchActiveDevice("audioinput", call.audioInId); } catch {} } saveDevicePrefs(); };
$("settingsSpkSelect").onchange = () => { call.audioOutId = $("settingsSpkSelect").value; audioEls.forEach(applySinkId); if (call.room) call.room.switchActiveDevice("audiooutput", call.audioOutId).catch(() => {}); saveDevicePrefs(); };
$("settingsCamSelect").onchange = async () => { call.camId = $("settingsCamSelect").value; if (call.room) { try { await call.room.switchActiveDevice("videoinput", call.camId); } catch {} } saveDevicePrefs(); };
$("settingsNoiseToggle").onclick = () => { call.ns = !call.ns; $("settingsNoiseToggle").classList.toggle("on", call.ns); const nt = $("noiseToggle"); if (nt) nt.classList.toggle("on", call.ns); applyNoiseFilter(call.ns); saveDevicePrefs(); };

// ⛶ Большой экран: звонок открывается в отдельном окне и разворачивается на весь экран.
// Это заменяет и старый in-page фуллскрин, и кнопку поп-аута — теперь одна кнопка.
// Call-control icons now come from the Lucide set (see public/js/icons.js):
// window.ICON.monitor (screen-share) and window.ICON.expand (maximize).

// ---- Big screen: fullscreen the whole call view in-place (robust, works in
// the browser and the desktop app — no popup window). Toggle with the button
// or Esc. Uses the native Fullscreen API, same as clicking a stream tile.
// ── Big screen / fullscreen call (Discord-style) ──────────────────────────
// Fullscreen the call stage; a clicked stream is spotlighted big (not opened
// in the browser's native video player); the controls auto-hide.
const callStageEl = () => $("callStage");
// iOS Safari has no element-level Fullscreen API, so fall back to a fixed
// overlay (.manual-fs). manualFs tracks that mode; both paths run applyFsState.
let manualFs = false;
function nativeFsSupported() { const st = callStageEl(); return !!st && !!(st.requestFullscreen || st.webkitRequestFullscreen); }
function isCallFullscreen() { const st = callStageEl(); return manualFs || (!!st && (document.fullscreenElement === st || document.webkitFullscreenElement === st)); }
function enterCallFullscreen() {
  const st = callStageEl(); if (!st) return;
  if (nativeFsSupported()) { (st.requestFullscreen || st.webkitRequestFullscreen).call(st); }
  else { manualFs = true; applyFsState(true); }
}
function exitCallFullscreen() {
  if (manualFs) { manualFs = false; applyFsState(false); return; }
  (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
}
// Spotlight a tile. If not already fullscreen, go fullscreen first and apply the
// focus once the fullscreenchange lands (so the strip is built in fs context).
let pendingFocusId = null;
function watchStream(tile) {
  if (isCallFullscreen()) focusTile(tile);
  else { pendingFocusId = tile.id; enterCallFullscreen(); }
}
function toggleFsBar() {
  const st = callStageEl(); if (!st) return;
  if (st.classList.contains("controls-on")) fsHideControls(); else fsShowControls();
}
// Click/double-click behaviour on tiles (delegated so it covers webcams, screen
// shares and dynamically-added tiles):
//   • grid tile  → single click zooms/spotlights it
//   • focused    → single click toggles the control bar, double-click → grid
let tileClickTimer = 0;
vGrid.addEventListener("click", (e) => {
  if (e.target.closest(".tile-ctrl")) return; // per-user mute/volume
  const tile = e.target.closest(".tile"); if (!tile) return;
  e.stopPropagation();
  clearTimeout(tileClickTimer);
  tileClickTimer = setTimeout(() => {
    if (isCallFullscreen()) {
      if (tile.classList.contains("focused")) toggleFsBar();
      else focusTile(tile);
    } else {
      watchStream(tile); // docked: zoom into fullscreen spotlight
    }
  }, 230);
});
vGrid.addEventListener("dblclick", (e) => {
  const tile = e.target.closest(".tile"); if (!tile) return;
  e.stopPropagation(); clearTimeout(tileClickTimer);
  if (tile.classList.contains("focused")) focusTile(null); // back to the grid
  else watchStream(tile); // zoom (enters fullscreen from the dock if needed)
});

// Auto-hiding controls: cursor move (desktop) shows them; tap toggles (mobile);
// they fade away after 5s of no interaction.
let fsHideTimer = 0;
function fsShowControls() { const st = callStageEl(); if (!st) return; st.classList.add("controls-on"); clearTimeout(fsHideTimer); fsHideTimer = setTimeout(() => st.classList.remove("controls-on"), 5000); }
function fsHideControls() { clearTimeout(fsHideTimer); const st = callStageEl(); if (st) st.classList.remove("controls-on"); }
function fsBackgroundTap(e) {
  if (e.target.closest(".call-bar") || e.target.closest(".tile")) return; // controls / streams handle their own taps
  const st = callStageEl(); if (!st) return;
  if (st.classList.contains("controls-on")) fsHideControls(); else fsShowControls();
}
// Enter/exit setup shared by the native Fullscreen API and the iOS overlay.
function applyFsState(on) {
  const st = callStageEl(); if (!st) return;
  const btn = $("expandBtn"), facesBtn = $("toggleFaces");
  if (btn) btn.classList.toggle("active", on);
  st.classList.toggle("fs-call", on);
  st.classList.toggle("manual-fs", on && manualFs);
  if (on) {
    vGrid.classList.remove("pip-grid");
    vGrid.classList.add("fs");
    // Apply a spotlight requested from the docked view, else balanced grid.
    const pending = pendingFocusId && $(pendingFocusId); pendingFocusId = null;
    if (pending) focusTile(pending);
    else if (vGrid.classList.contains("has-focus")) buildStrip();
    else scheduleFsLayout();
    fsShowControls();
    st.addEventListener("mousemove", fsShowControls);
    st.addEventListener("touchstart", fsBackgroundTap, { passive: true });
    st.addEventListener("click", fsBackgroundTap);
    window.addEventListener("resize", scheduleFsLayout);
  } else {
    // Leaving fullscreen: dissolve the strip, drop the spotlight, restore dock.
    dissolveStrip();
    vGrid.classList.remove("fs", "has-focus", "faces-hidden");
    vGrid.querySelectorAll(".tile.focused").forEach((tl) => tl.classList.remove("focused"));
    vGrid.style.removeProperty("--fs-cols"); vGrid.style.removeProperty("--fs-tw");
    vGrid.classList.toggle("pip-grid", isMobile() && !st.classList.contains("hidden"));
    if (facesBtn) facesBtn.classList.remove("active");
    fsHideControls();
    st.removeEventListener("mousemove", fsShowControls);
    st.removeEventListener("touchstart", fsBackgroundTap);
    st.removeEventListener("click", fsBackgroundTap);
    window.removeEventListener("resize", scheduleFsLayout);
  }
}
(function initBigScreen() {
  const btn = $("expandBtn");
  if (btn) {
    btn.innerHTML = window.ICON.expand;
    btn.onclick = () => { if (!call.active) return; isCallFullscreen() ? exitCallFullscreen() : enterCallFullscreen(); };
  }
  // Hide/show the participant strip under the spotlighted stream (animated).
  const facesBtn = $("toggleFaces");
  if (facesBtn) {
    facesBtn.innerHTML = window.ICON.users;
    facesBtn.onclick = () => { const hidden = vGrid.classList.toggle("faces-hidden"); facesBtn.classList.toggle("active", hidden); };
  }
  const onFsChange = () => { if (!manualFs) applyFsState(isCallFullscreen()); };
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("webkitfullscreenchange", onFsChange);
})();

// Keep-alive (не глушить звонок в фоне)
let keepAlive = null, wakeLock = null;
function startKeepAlive() {
  const ctx = ensureAudioCtx();
  if (ctx && !keepAlive) { const osc = ctx.createOscillator(), g = ctx.createGain(); g.gain.value = 0.0001; osc.frequency.value = 30; osc.connect(g); g.connect(ctx.destination); osc.start(); keepAlive = { osc, g }; }
  if ("mediaSession" in navigator) { try { navigator.mediaSession.metadata = new MediaMetadata({ title: t("t_call"), artist: "Dialog" }); navigator.mediaSession.playbackState = "playing"; navigator.mediaSession.setActionHandler("stop", () => endCall()); } catch {} }
  requestWakeLock();
}
function stopKeepAlive() { if (keepAlive) { try { keepAlive.osc.stop(); keepAlive.osc.disconnect(); keepAlive.g.disconnect(); } catch {} keepAlive = null; } if ("mediaSession" in navigator) { try { navigator.mediaSession.playbackState = "none"; navigator.mediaSession.metadata = null; } catch {} } if (wakeLock) { try { wakeLock.release(); } catch {} wakeLock = null; } }
// Матрица-фон звонка (затемнённая)
let callMatrixRaf = 0;
function startCallMatrix() {
  const c = $("callMatrix"); if (!c) return; const ctx = c.getContext("2d");
  const chars = "アイウエオカキ0123456789ABCDEF<>/{}".split(""); let cols = 0, drops = [];
  const frame = () => {
    // Вкладка скрыта — пауза canvas: снижаем нагрузку на CPU в фоне; возобновляется через visibilitychange.
    if (document.hidden) { callMatrixRaf = 0; return; }
    callMatrixRaf = requestAnimationFrame(frame);
    if (c.width !== c.clientWidth || c.height !== c.clientHeight) { c.width = c.clientWidth; c.height = c.clientHeight; cols = Math.floor(c.width / 16); drops = new Array(cols).fill(0).map(() => Math.random() * -50); }
    ctx.fillStyle = "rgba(0,7,0,0.09)"; ctx.fillRect(0, 0, c.width, c.height); ctx.font = "14px monospace";
    for (let i = 0; i < cols; i++) { ctx.fillStyle = Math.random() > 0.98 ? "#b6ffd2" : "#00ff5a"; ctx.fillText(chars[(Math.random() * chars.length) | 0], i * 16, drops[i] * 16); if (drops[i] * 16 > c.height && Math.random() > 0.975) drops[i] = 0; drops[i]++; }
  };
  cancelAnimationFrame(callMatrixRaf); frame();
}
function stopCallMatrix() { cancelAnimationFrame(callMatrixRaf); callMatrixRaf = 0; const c = $("callMatrix"); if (c) { const x = c.getContext("2d"); x && x.clearRect(0, 0, c.width, c.height); } }
async function requestWakeLock() { if (!("wakeLock" in navigator)) return; try { wakeLock = await navigator.wakeLock.request("screen"); } catch {} }
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (call.active) { requestWakeLock(); vGrid.querySelectorAll("video").forEach((v) => v.play().catch(() => {}));
      if (!callMatrixRaf) startCallMatrix(); // матрица стояла на паузе на скрытой вкладке — вернём её
    }
    if (profile && myRoom) setTimeout(markDeliveredSeenUpToLast, 50); // пометить просмотренным при возврате на вкладку
  }
});

// ---------- Входящий звонок (поп-ап + рингтон + cava) ----------
const ring = { audio: null, raf: 0, data: null, bars: [], analyser: null, toneLoop: null };
// Ригнтон целиком на WebAudio (синтез). Файл /src/Ringtone.mp3 НЕ требуется:
// два коротких аккорда minor-септимы, повтор каждые 4.5 с — после минуты звонка не душно.
// Cava-визуализация рисует симулированный паттерн (см. startCava — ветка при ring.analyser == null).
const RING_NOTES = [
  [440, 0.42, 0.06], [659, 0.42, 0.05], [554, 0.42, 0.04],   // аккорд 1: A + E + C# (Am7-flavor)
  [0,   0.18, 0],                                              // малая пауза
  [494, 0.42, 0.05], [659, 0.42, 0.05], [587, 0.42, 0.04],   // аккорд 2: чуть выше (B + E + D)
  [0,   0.20, 0],                                              // длинная пауза
];
function playRingChord() {
  const ctx = ensureAudioCtx(); if (!ctx) return;
  let t0 = ctx.currentTime + 0.04;
  RING_NOTES.forEach(([f, d, v]) => {
    if (!f) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine"; o.frequency.value = f;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(v, t0 + 0.04);
    g.gain.setValueAtTime(v, t0 + d - 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    o.connect(g); g.connect(ctx.destination);
    o.start(t0); o.stop(t0 + d + 0.02);
    t0 += d + 0.06;
  });
}
// /ringtone.mp3 — основной путь для рингтона (HTMLAudioElement loop=true).
//   Cava-анимация (#cavaCanvas) запускается всегда.
//   Если файл 404 / NotSupportedError → постоянная отключка mp3 (ringMp3Disabled), на каждом
//   следующем звонке идём сразу в синтезатор (чтобы не спамить 404 в консоли).
//   Если autoplay заблокирован браузером (NotAllowedError — типично до первого user-gesture)
//   → только этот звонок уходит в синтезатор; mp3 пробуем снова на следующем звонке.
let ringAudioEl = null;
let ringMp3Disabled = false;
function startRingtone() {
  if (ring.audio) return; // двойной вызов не заводит второй луп
  ensureAudioCtx();
  startCava();
  if (!ringMp3Disabled) {
    if (!ringAudioEl) {
      ringAudioEl = new Audio("/ringtone.mp3");
      ringAudioEl.loop = true;
      // preload="none" — не тащим 24KB на каждой загрузке страницы, если звонка так и не будет.
      // Первый ring-ring всё равно быстро закэшируется (server/CDN) — лаг незаметный.
      ringAudioEl.preload = "none";
      ringAudioEl.addEventListener("error", () => {
        // 404 / decode-failure — отключаем mp3 навсегда и, если ринг активен на этом пути,
        // немедленно подхватываем синтезатор. Один console.warn чтобы не было «бесследного» фоллбэка:
        // если юзер кинет свой файл с битым именем/форматом, причина ищется в DevTools одной строкой.
        console.warn("ringtone.mp3 failed to load, falling back to synth chord");
        ringMp3Disabled = true;
        ringAudioEl = null;
        if (ring.audio && ring.audio.mp3) startRingtoneSynth();
      }, { once: true });
    }
    ring.audio = { mp3: true };
    ringAudioEl.currentTime = 0;
    const p = ringAudioEl.play();
    if (p && typeof p.catch === "function") {
      p.catch(() => {
        // NotAllowedError и подобные — на этот звонок синтезатор; ringMp3Disabled НЕ выставляем.
        if (ring.audio && ring.audio.mp3) startRingtoneSynth();
      });
    }
    return;
  }
  startRingtoneSynth();
}
function startRingtoneSynth() {
  // Старая логика рингтона (WebAudio chord каждые 4.5с) — fallback, если /ringtone.mp3 отсутствует
  // или autoplay заблокирован в этом звонке. startRingtone-ом вызывается, не напрямую.
  if (ring.toneLoop) return;
  ring.audio = { synth: true };
  playRingChord();
  ring.toneLoop = setInterval(playRingChord, 4500);
}
function stopRingtone() {
  clearInterval(ring.toneLoop); ring.toneLoop = null;
  if (ringAudioEl) { try { ringAudioEl.pause(); ringAudioEl.currentTime = 0; } catch {} }
  ring.audio = null;
  cancelAnimationFrame(ring.raf); ring.raf = 0;
  const c = $("cavaCanvas"); if (c) c.getContext("2d")?.clearRect(0, 0, c.width, c.height);
}

function startCava() {
  const canvas = $("cavaCanvas"), toast = $("callToast"); if (!canvas) return; const cx = canvas.getContext("2d"); const N = 40;
  if (ring.bars.length !== N) ring.bars = new Array(N).fill(0); cancelAnimationFrame(ring.raf);
  const frame = () => {
    ring.raf = requestAnimationFrame(frame); const dpr = devicePixelRatio || 1;
    canvas.width = toast.clientWidth * dpr; canvas.height = toast.clientHeight * dpr; const w = canvas.width, h = canvas.height; cx.clearRect(0, 0, w, h);
    if (ring.analyser) ring.analyser.getByteFrequencyData(ring.data); const bw = w / N;
    for (let i = 0; i < N; i++) { let target; if (ring.analyser) target = ring.data[Math.floor((i / N) * ring.data.length * 0.7)] / 255; else target = 0.25 + 0.55 * Math.abs(Math.sin(Date.now() / 180 + i * 0.5)); ring.bars[i] = Math.max(target, ring.bars[i] * 0.86); const bh = Math.max(2 * dpr, ring.bars[i] * h * 0.5); const g = cx.createLinearGradient(0, h, 0, h - bh); g.addColorStop(0, "rgba(0,255,90,0.1)"); g.addColorStop(1, "rgba(0,255,90,0.5)"); cx.fillStyle = g; cx.fillRect(i * bw + bw * 0.15, h - bh, bw * 0.7, bh); }
  };
  frame();
}
let toastTimer, pendingCall = null;
function showToast(from, name, ctx) {
  if (isDnd()) return;
  pendingCall = ctx || null; $("toastName").textContent = name;
  let callerLogin = ""; if (ctx?.room?.startsWith("@dm:")) callerLogin = ctx.room.slice(4).split("~").find((l) => l !== profile.login) || "";
  $("toastAvatar").innerHTML = callerLogin ? `<img src="${avaUrl(callerLogin)}" onerror="this.remove()"><span>${initials(name)}</span>` : `<span>${initials(name)}</span>`;
  $("toastSub").textContent = ctx ? t("call_in", { title: ctx.title }) : t("toast_started");
  $("callToast").classList.remove("hidden"); startRingtone();
  clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, 60000);
}
function hideToast() { clearTimeout(toastTimer); pendingCall = null; $("callToast").classList.add("hidden"); stopRingtone(); }
$("toastJoin").onclick = () => {
  const pc = pendingCall;
  if (pc && pc.room !== myRoom) { hideToast(); openRoomByKey(pc.room, pc.title); setTimeout(joinCall, 600); } else joinCall();
};
$("toastClose").onclick = hideToast;

// ---------- Push ----------
let swReg = null;
async function initPush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
  try {
    swReg = await navigator.serviceWorker.register("/sw.js");
    navigator.serviceWorker.addEventListener("message", (e) => { if (e.data?.type === "open-room" && e.data.room) { openRoomByKey(e.data.room); if (e.data.autojoin) setTimeout(() => { if (!call.active) joinCall(); }, 1200); } });
    if (Notification.permission === "granted") subscribePush();
    else if (Notification.permission === "default") { const ask = () => { document.removeEventListener("click", ask); Notification.requestPermission().then((p) => { if (p === "granted") subscribePush(); }); }; document.addEventListener("click", ask, { once: true }); }
  } catch (e) { console.log("SW", e.message); }
}
function urlB64ToUint8(b) { const pad = "=".repeat((4 - (b.length % 4)) % 4); const raw = atob((b + pad).replace(/-/g, "+").replace(/_/g, "/")); const a = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) a[i] = raw.charCodeAt(i); return a; }
async function subscribePush() {
  if (!swReg || !token) return;
  try { const { key } = await (await fetch("/api/push/key")).json(); if (!key) return; let sub = await swReg.pushManager.getSubscription(); if (!sub) sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) }); await api("/api/push/subscribe", sub); } catch (e) { console.log("push", e.message); }
}
async function requestMediaPermissions() {
  if (localStorage.getItem("media_perms_done") === "1") return;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    s.getTracks().forEach((t) => t.stop());
  } catch {}
  localStorage.setItem("media_perms_done", "1");
}
function openRoomByKey(room, title) {
  if (!room || !profile) return;
  const kind = room.startsWith("@grp:") ? "group" : "dm";
  const partner = kind === "dm" ? room.slice(4).split("~").find((l) => l !== profile.login) : undefined;
  openChat({ key: room, type: kind, login: partner, id: kind === "group" ? room.slice(5) : undefined, name: title || (kind === "dm" ? partner : chats.get(room)?.name || "Group"), last: "", ts: Date.now(), unread: 0 });
}
window.addEventListener("load", () => { const p = new URLSearchParams(location.search); const r = p.get("room"); if (r) setTimeout(() => { if (profile) { openRoomByKey(r); if (p.get("autojoin")) setTimeout(() => { if (!call.active) joinCall(); }, 1200); } }, 800); });

// ---------- Соединение ----------
let connEl;
socket.on("disconnect", () => { if (!connEl) { connEl = document.createElement("div"); connEl.className = "conn-status"; connEl.textContent = t("conn_offline"); document.body.appendChild(connEl); } connEl.classList.add("show"); });
socket.io.on("reconnect", () => { if (connEl) connEl.classList.remove("show"); if (token) refreshPresence(); });

// ---------- Ping meter (only during calls) ----------
let serverRegion = "";
socket.on("server-info", (info) => { serverRegion = info.region || ""; });
const pingEl = $("pingMeter");
function updatePing(ms) {
  if (!pingEl) return;
  const region = serverRegion ? serverRegion.toUpperCase() : "";
  pingEl.textContent = "";
  const dot = document.createElement("span");
  dot.style.cssText = "display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px;background:currentColor;flex-shrink:0";
  pingEl.appendChild(dot);
  if (region) { const r = document.createElement("span"); r.textContent = region + " "; pingEl.appendChild(r); }
  const v = document.createElement("span"); v.textContent = ms; pingEl.appendChild(v);
  const u = document.createElement("span"); u.textContent = "ms"; pingEl.appendChild(u);
  pingEl.className = "ping-" + (ms < 50 ? "green" : ms < 100 ? "orange" : "red");
}
let pingInterval = null;
function stopPing() {
  clearInterval(pingInterval);
  pingInterval = null;
  if (pingEl) { pingEl.className = ""; pingEl.textContent = ""; pingEl.style.display = "none"; }
}
function startPing() {
  if (pingInterval) clearInterval(pingInterval);
  if (pingEl) pingEl.style.display = "";
  const tick = () => {
    const start = performance.now();
    socket.emit("latency", () => {
      if (!call.active) { stopPing(); return; }
      const rtt = Math.round(performance.now() - start);
      updatePing(rtt);
    });
  };
  tick();
  pingInterval = setInterval(tick, 2000);
}

// ---------- Утилиты ----------
function scrollDown() { messagesEl.scrollTop = messagesEl.scrollHeight; }
function fmtTime(ts) { return new Date(ts).toLocaleTimeString(window.getLang() === "ru" ? "ru-RU" : "en-GB", { hour: "2-digit", minute: "2-digit" }); }
// Метка дня над лентой: «Today / Yesterday» для свежих суток, иначе локализованная дата.
// Раньше функция была потеряна при рефакторинге (браузер падал в ReferenceError на любом сообщении
// в новичок-комнате, где ещё не выставлен dataset.day) — добавляем обратно.
function dayLabel(dayStr) {
  const d = new Date(dayStr);
  const now = new Date();
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return t("today");
  const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(d, yest)) return t("yesterday");
  return d.toLocaleDateString(window.getLang() === "ru" ? "ru-RU" : "en-GB", { day: "numeric", month: "long", year: now.getFullYear() === d.getFullYear() ? undefined : "numeric" });
}
function escapeHtml(s) { return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function linkify(s) { return s.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color:#7dffaf">$1</a>'); }
function notify(text, room) { let el = $("notifyToast"); if (!el) { el = document.createElement("div"); el.id = "notifyToast"; el.className = "notify-toast"; document.body.appendChild(el); } el.textContent = text; el.dataset.room = room || ""; el.classList.add("show"); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("show"), 3500); }
function dismissNotif(room) {
  const el = $("notifyToast");
  if (el && el.dataset.room === room) { el.classList.remove("show"); clearTimeout(el._t); }
  if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.ready.then((reg) =>
      reg.getNotifications().then((ns) => { ns.filter((n) => n.tag === "call:" + room || n.tag === "msg:" + room).forEach((n) => n.close()); })
    );
  }
}

// ---------- Settings overlay (Discord-style, ~80vw × 80vh), status pill, ESC/click-outside ----------
// Все формы (профиль, контакты, темы, настройки группы, новый чат) живут в #settingsOverlay как пейны.
// 5 вкладок: profile / contacts / themes / groups / newchat. Клик по фону или Esc → закрыть.
let settingsOpen = false;
const SETTINGS_TABS = ["profile", "contacts", "themes", "groups", "devices"];
function openSettings(tab) {
  if (!SETTINGS_TABS.includes(tab)) tab = "profile";
  const ov = $("settingsOverlay"); if (!ov) return;
  // Если открываем groups без активной группы — показываем placeholder в пейне (ТОЛЬКО переключаем таб, не перенаправляем).
  // (Сохранение состояния открытого таба важнее, чем автоматический возврат на profile.)
  ov.classList.remove("hidden");
  settingsOpen = true;
  switchTab(tab);
  applyI18n(ov); // обновить лейблы и плейсхолдеры (темы/табы называния)
  if (!ov._themesRendered) renderThemes();
  if (tab === "contacts") loadRelations();
  if (tab === "profile") refreshProfilePane();
  if (tab === "groups") populateGroupSettingsPane();
  if (tab === "devices") populateDeviceSettings();
  // (newchat tab removed 2014 friends-picker flow now lives in #createGroupModal)
  renderChatList($("searchInput").value);
}
function closeSettings() {
  if (!settingsOpen) return;
  const ov = $("settingsOverlay"); if (ov) ov.classList.add("hidden");
  settingsOpen = false;
}
function switchTab(tab) {
  if (!SETTINGS_TABS.includes(tab)) tab = "profile";
  const tabs = $("settingsTabs"); if (tabs) tabs.querySelectorAll(".settings-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  const panes = $("settingsPanes"); if (panes) panes.querySelectorAll(".settings-pane").forEach((p) => p.classList.toggle("active", p.dataset.pane === tab));
  // Регидрация данных пейна при переключении вручную (иначе кликом по табу после открытия оверлея
  // демонстрируется placeholder / устаревший контент до явного повторного openSettings).
  hydratePane(tab);
}
// Объявлен ДО hydratePane, чтобы не упасть в TDZ при первом вызове из openSettings().
// { id: gsId, ts: Date.now() } — если уже фетчили эту группу в текущей открытой сессии оверлея, повторно не лупим /api/groups/:id.
let lastGsFetch = null; // success cache: {id (gsId или null для placeholder), ts}
let gsFetching = false;  // in-flight guard: предотвращает спам-clicks /api/groups/:id пока не вернулся первый запрос
function hydratePane(tab) {
  if (!settingsOpen) return;
  if (tab === "profile") refreshProfilePane();
  else if (tab === "contacts") loadRelations();
  else if (tab === "groups") {
    // Сентинел `id: null` кеширует и режим «без активной группы» (placeholder), чтобы повторные клики
    // по табу не гоняли populateGroupSettingsPane вхолостую — функция всё равно идемпотентна,
    // но дёргает каждый раз DOM-узлы #gsName / #gsMembers / #gsAvaImg.
    const wantId = curKind === "group" ? myRoom.slice(5) : null;
    if (lastGsFetch && lastGsFetch.id === wantId) return;
    if (gsFetching) return; // спам-click: ждём завершения текущего запроса
    gsFetching = true;
    populateGroupSettingsPane()
      .then((res) => { if (res && res.ok) lastGsFetch = { id: wantId, ts: Date.now() }; })
      .finally(() => { gsFetching = false; });
    return;
  }
  else if (tab === "devices") populateDeviceSettings();
  // themes: один раз через renderThemes() + _themesRendered guard
}
function refreshProfilePane() {
  if (!profile) return;
  $("profileError").textContent = "";
  $("profileLogin").textContent = profile.login;
  $("profileName").value = myName || "";
  $("profileDesc").value = myDesc || "";
  $("profileAvaImg").src = avaUrl(profile.login);
  $("profileAvaImg").onerror = () => { $("profileAvaImg").style.display = "none"; $("profileAvaInit").style.display = "block"; };
  $("profileAvaImg").style.display = "block"; $("profileAvaInit").style.display = "none";
  $("profileAvaInit").textContent = initials(myName);
}

// Перенаправляем хедер-кнопки на settings overlay. Гард `&&` на contactsBtn не нужен —
// он живой и в HTML, и в логике; зато аватар/profileSave/logoutBtn и т.д. обёрнуты
// в `&&` гард по тому же шаблону: разметка может их удалить, и тогда $() вернёт null,
// а .onclick на null роняет весь дальнейший init (один такой баг уже сломал скрипт после
// рефакторинга «new start for groups» — кнопки в settings и темах не открывались).
$("contactsBtn").onclick = () => openSettings("contacts");

// Клик по своему аватару/имени в хедере чатлиста открывает свой профиль. Элементы #myAvatar и
// #myName получают tabindex=0 и role="button" в HTML (см. <div class="cl-head">) — здесь
// навешиваем Enter/Space-активацию для клавиатурной навигации. Сам onclick переживает ре-рендер
// содержимого в setMyAvatar() (там меняется только innerHTML, сам узел и его листенеры остаются).
function openMyProfile() { openSettings("profile"); }
$("myAvatar").onclick = openMyProfile;
$("myName").onclick = openMyProfile;
["myAvatar", "myName"].forEach((id) => {
  const el = $(id); if (!el) return;
  el.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openMyProfile(); }
  };
});
// Табы / закрытие оверлея
$("settingsTabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".settings-tab");
  if (tab) switchTab(tab.dataset.tab);
});
$("settingsClose").onclick = closeSettings;

// Click-outside на бэкдроп (сам .settings-overlay div — фоновый слой) закрывает оверлей.
// ВАЖНО: проверяем ровно сам элемент overlay, а не вложенные карточки (event.target === overlay).
$("settingsOverlay").addEventListener("click", (e) => { if (e.target === $("settingsOverlay")) closeSettings(); });

// ---------- Status pill в хедере чатлиста (рядом с никнеймом, дефолт = online) ----------
function renderMeStatus() {
  const pill = $("meStatus"); if (!pill) return;
  const cls = statusClass(myStatus === "invisible" ? "offline" : myStatus);
  const labelKey = "status_" + (myStatus === "invisible" ? "offline" : myStatus);
  pill.innerHTML = `<span class="st-dot ms-dot st-${cls}"></span><span>${escapeHtml(t(labelKey))}</span>`;
  pill.classList.toggle("me-status-dnd", myStatus === "dnd");
  pill.classList.toggle("me-status-invisible", myStatus === "invisible");
}
function openStatusMenu() {
  const menu = $("meStatusMenu"); if (!menu) return;
  menu.innerHTML = "";
  // Порядок: online → dnd → invisible. Для invisible в UI подпись "Invisible", реальная точка — серый (offline).
  [[ "online", "online", "status_online" ], [ "dnd", "dnd", "status_dnd" ], [ "invisible", "offline", "status_invisible" ]]
    .forEach(([key, dot, labelKey]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = (myStatus === key) ? "on" : "";
      b.innerHTML = `<span class="st-dot ms-dot st-${statusClass(dot)}"></span><span>${escapeHtml(t(labelKey))}</span>`;
      b.onclick = (e) => { e.stopPropagation(); setMyStatus(key); };
      menu.appendChild(b);
    });
  menu.classList.remove("hidden");
  // Позиционируем под пиллой, прижимаем к левому краю чтобы не вылезало за экран.
  const r = $("meStatus").getBoundingClientRect();
  menu.style.top = (r.bottom + 4) + "px";
  menu.style.left = Math.max(8, Math.min(r.left, innerWidth - 240 - 8)) + "px";
}
function closeStatusMenu() { const m = $("meStatusMenu"); if (m) m.classList.add("hidden"); }
async function setMyStatus(key) {
  if (!profile) return;
  if (key === myStatus) { closeStatusMenu(); return; }
  closeStatusMenu();
  const prev = myStatus;
  myStatus = key;
  renderMeStatus();
  presence.set(profile.login, key === "invisible" ? "offline" : key);
  socket.emit("set-status", key);
  setMyAvatar();
  // Сохраняем на сервере минимальным пейлоадом — иначе /api/profile трется с `name/description`,
  // а пользователь мог что-то поменять но ещё не нажал Save.
  try {
    const { ok, data } = await api("/api/profile", { status: key });
    if (!ok) { myStatus = prev; renderMeStatus(); presence.set(profile.login, prev === "invisible" ? "offline" : prev); setMyAvatar(); notify(t("err_save_status") || "Status change failed"); return; }
    if (data.profile) profile.status = data.profile.status || key;
  } catch { myStatus = prev; renderMeStatus(); }
  renderChatList($("searchInput").value);
}
$("meStatus").onclick = (e) => { e.stopPropagation(); if ($("meStatusMenu").classList.contains("hidden")) openStatusMenu(); else closeStatusMenu(); };

// ---------- ESC + click-outside для всех видимых оверлеев ----------
// Один глобальный keydown обрабатывает Esc в порядке «сверху вниз» по важности.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  // Inline-edit в сообщении уже обрабатывает Esc сам (startEdit), не трогаем.
  if (!$("lightbox").classList.contains("hidden")) { closeLightbox(); return; }
  if (settingsOpen) { closeSettings(); return; }
  if (!$("meStatusMenu").classList.contains("hidden")) { closeStatusMenu(); return; }
  if (!$("chatMenu").classList.contains("hidden")) { $("chatMenu").classList.add("hidden"); return; }
  if (!$("emojiPicker").classList.contains("hidden")) { $("emojiPicker").classList.add("hidden"); return; }
  if (!$("gifPanel").classList.contains("hidden")) { $("gifPanel").classList.add("hidden"); return; }
  if (!$("composerMore").classList.contains("hidden")) { $("composerMore").classList.add("hidden"); return; }
  if (!$("callToast").classList.contains("hidden")) { hideToast(); return; }
});

// Click-outside для status-меню: глобальный click-проверка по DOM.
// (chat menu уже имел свой обработчик в исходниках — оставляем; добавляем сюда только для новых штук.)
document.addEventListener("click", (e) => {
  if (!$("meStatusMenu").classList.contains("hidden") && !e.target.closest("#meStatusMenu") && e.target !== $("meStatus")) closeStatusMenu();
});

// ---------- Иконки ----------
function setIcons() {
  // ВАЖНО: newChatBtn теперь это кнопка-шестерёнка «Settings» (⚙ в HTML) — иконку «edit»
  // мы не перетираем. profileBtn и contactsBtn — открывают settings overlay, для них оставляем наконечник-тултип.
  const map = { emojiBtn: "emoji", attachBtn: "attach", voiceBtn: "mic", sendBtn: "send", muteBtn: "bell", startCallBtn: "phone", infoBtn: "info", backBtnMobile: "back", contactsBtn: "users", toggleMic: "mic", toggleCam: "camera", toggleDeafen: "headphones", shareScreen: "monitor", hangUp: "phoneOff", infoClose: "close", mpCancel: "close" };
  const tips = { muteBtn: "mute_room", startCallBtn: "t_call", infoBtn: "info", emojiBtn: "t_emoji", attachBtn: "t_attach", voiceBtn: "t_voice", sendBtn: "t_send", toggleMic: "t_mic", toggleCam: "t_cam", toggleDeafen: "t_deafen", shareScreen: "t_screen", hangUp: "t_hangup", contactsBtn: "contacts", minBtn: "minimize", vbMic: "t_mic", vbDeafen: "t_deafen", vbHang: "t_hangup" };
  for (const [id, name] of Object.entries(map)) { const el = $(id); if (el && window.ICON[name]) el.innerHTML = window.ICON[name]; }
  for (const [id, key] of Object.entries(tips)) { const el = $(id); if (el) el.setAttribute("data-tip", t(key)); }
  // Кнопки входящего звонка получают подпись снизу (инлайн .ci-label — без data-tip,
  // чтобы [data-tip]::after не дублировал ту же подпись при наведении).
  const toastJoin = $("toastJoin"), toastClose = $("toastClose");
  if (toastJoin) { toastJoin.innerHTML = window.ICON.phone + '<span class="ci-label">' + t("toast_join") + '</span>'; }
  if (toastClose) { toastClose.innerHTML = window.ICON.phoneOff + '<span class="ci-label">' + t("t_hangup") + '</span>'; }
}
$("searchInput").addEventListener("input", (e) => renderChatList(e.target.value));
$("chatFilters").addEventListener("click", (e) => {
  const btn = e.target.closest(".clf-btn");
  if (!btn) return;
  $("chatFilters").querySelectorAll(".clf-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  chatTypeFilter = btn.dataset.filter;
  renderChatList($("searchInput").value);
});

// ---------- Старт ----------
loadSavedTheme(); initLang(); setIcons(); checkSession();
window.addEventListener("popstate", onPopState);

// ---------- PWA Install ----------
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const btn = $("installBtn");
  if (btn) btn.classList.remove("hidden");
});
$("installBtn")?.addEventListener?.("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const result = await deferredPrompt.userChoice;
  deferredPrompt = null;
  if (result.outcome === "accepted" || result.outcome === "dismissed") {
    $("installBtn")?.classList?.add("hidden");
  }
});
window.addEventListener("appinstalled", () => {
  deferredPrompt = null;
  $("installBtn")?.classList?.add("hidden");
});
// Already in standalone mode? Hide install button
if (window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone) {
  $("installBtn")?.classList?.add("hidden");
}

// Wire up custom-theme modal + + Custom button
(function () {
  // + new custom theme (delegation, button is inside #themeGrid and survives multiple renders)
  document.addEventListener("click", (e) => {
    const addBtn = e.target.closest(".theme-opt-add");
    if (addBtn) { e.preventDefault(); openCustomThemeModal(null); return; }
    const modal = $("customThemeModal");
    if (!modal) return;
    if (e.target === modal) { modal.classList.add("hidden"); return; }
    const close = e.target.closest("#ctClose");
    if (close) { modal.classList.add("hidden"); return; }
    const cancel = e.target.closest("#ctCancel");
    if (cancel) { modal.classList.add("hidden"); return; }
    const save = e.target.closest("#ctSave");
    if (save) { submitCustomTheme(); return; }
  });
  // Initial render of themes into the grid (called after i18n is wired)
  if (typeof renderThemes === "function") renderThemes();
})();
