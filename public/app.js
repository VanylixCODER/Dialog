const socket = io();
const $ = (id) => document.getElementById(id);

// ---------- Состояние ----------
let token = localStorage.getItem("dialog_token") || null;
let profile = null, myName = "";
let myRoom = "", curKind = "dm", curTitle = "", activeKey = "";
let avaVer = Date.now();
let myStatus = "online", myDesc = "";
const chats = new Map();             // key -> {key,type,name,login,id,last,ts,unread}
const peers = new Map();             // socketId -> {name, login}
const presence = new Map();          // login -> 'online'|'dnd'|'offline'
const relations = { friends: [], blocked: [], sent: [], incoming: [] };
const blocked = new Set();
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
document.addEventListener("pointerdown", ensureAudioCtx, { once: true });

// ---------- Темы ----------
// Конфиг каждой темы: ключ применяется к <body data-theme="...">; name/desc — i18n-ключи;
// swatch — 4 hex-цвета для превью в #themeGrid (фон, акцент 1, акцент 2, тёмный фон).
const THEMES = [
  { key: "matrix",   name: "theme_matrix",   desc: "theme_desc_matrix",   swatch: ["#00ff5a", "#00cc48", "#138a4a", "#020a04"] },
  { key: "amber",    name: "theme_amber",    desc: "theme_desc_amber",    swatch: ["#ff8c00", "#ffae40", "#b36800", "#180d00"] },
  { key: "red",      name: "theme_red",      desc: "theme_desc_red",      swatch: ["#dd2828", "#ff5252", "#aa1414", "#200404"] },
  { key: "contrast", name: "theme_contrast", desc: "theme_desc_contrast", swatch: ["#00ff5a", "#88ffaa", "#ffffff", "#000000"] },
  { key: "lofi",     name: "theme_lofi",     desc: "theme_desc_lofi",     swatch: ["#6a8e7a", "#84a892", "#557766", "#131917"] },
];
function applyTheme(key) {
  if (!THEMES.find((x) => x.key === key)) key = "matrix";
  document.body.dataset.theme = key;
  try { localStorage.setItem("dialog_theme", key); } catch {}
  const grid = $("themeGrid");
  if (grid) grid.querySelectorAll(".theme-opt").forEach((o) => o.classList.toggle("active", o.dataset.theme === key));
}
applyTheme(localStorage.getItem("dialog_theme") || "matrix"); // применяем сразу, до рендера чатов


// ---------- Язык ----------
function initLang() {
  const v = window.getLang();
  [$("langSelect"), $("langSelect2")].forEach((sel) => { if (sel) { sel.value = v; sel.onchange = () => window.setLang(sel.value); } });
  applyI18n();
}
window.addEventListener("langchange", () => { [$("langSelect"), $("langSelect2")].forEach((s) => s && (s.value = window.getLang())); renderChatList($("searchInput").value); });

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
async function checkSession() {
  if (!token) return;
  const { ok, data } = await api("/api/me", null, "GET");
  if (ok) { profile = data.profile; enterApp(); } else localStorage.removeItem("dialog_token");
}

function enterApp() {
  myName = profile.name; myStatus = profile.status || "online"; myDesc = profile.description || "";
  presence.set(profile.login, myStatus === "invisible" ? "offline" : myStatus);
  $("login").classList.add("hidden"); $("app").classList.remove("hidden");
  $("myName").textContent = myName; setMyAvatar(); renderMeStatus();
  socket.emit("identify", { token });
  loadStoredChats(); loadGroups(); loadRelations(); renderChatList();
  refreshPresence(); // начальный снимок присутствия для DM/друзей; дальше клиент держится за socket «presence» ивенты — 25-сек poll убран, иначе он ре-фетчил /api/avatar моей авы в холодном HTTP-кеше (см. updateDots ниже).
  initPush();
}
socket.on("connect", () => {
  if (!token) return;
  socket.emit("identify", { token });
  if (myRoom) socket.emit("join", { token, room: myRoom });
  // звонок (LiveKit) переподключается сам — наш сокет лишь восстанавливает чат
});
socket.on("auth-error", () => { localStorage.removeItem("dialog_token"); location.reload(); });

// ---------- Хранилище чатов (ЛС в localStorage, группы с сервера) ----------
const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || "[]"); } catch { return []; } };
const lsSet = (k, v) => localStorage.setItem(k, JSON.stringify(v));
function dmKey(login) { return "@dm:" + [profile.login, login].sort().join("~"); }
function loadStoredChats() { lsGet("dialog_dms").forEach((c) => chats.set(c.key, c)); }
function persistDMs() { lsSet("dialog_dms", [...chats.values()].filter((c) => c.type === "dm").slice(0, 50)); }
function upsertChat(c) { const ex = chats.get(c.key); if (ex) { Object.assign(ex, { name: c.name || ex.name, ts: c.ts || ex.ts }); return ex; } chats.set(c.key, c); return c; }
async function loadGroups() {
  const { ok, data } = await api("/api/groups", null, "GET");
  if (!ok) return;
  data.groups.forEach((g) => { const key = "@grp:" + g.id; if (!chats.has(key)) chats.set(key, { key, type: "group", id: g.id, name: g.name, last: "", ts: 0, unread: 0 }); });
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
  const list = [...chats.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  let shown = 0;
  for (const c of list) {
    if (filter && !(c.name || "").toLowerCase().includes(filter)) continue;
    shown++;
    const li = document.createElement("li");
    li.className = "chat-item" + (c.key === activeKey ? " active" : "");
    li._chatKey = c.key; // метка для быстрого in-place обновления точек (см. updateDots)
    const dot = c.type === "dm" ? `<span class="st-dot ci-status st-${statusClass(presence.get(c.login))}"></span>` : "";
    const avaInner = c.type === "group"
      ? `<img src="/api/group-avatar/${c.id}?v=${avaVer}" onerror="this.remove()">#`
      : `<img src="${avaUrl(c.login)}" onerror="this.remove()">${initials(c.name)}`;
    li.innerHTML = `<div class="avatar ${c.type === "group" ? "grp" : ""}" ${c.type === "dm" ? `data-login="${c.login}"` : ""}>${avaInner}${dot}</div>
      <div class="ci-body"><div class="ci-top"><span class="ci-name">${escapeHtml(c.name)}</span><span class="ci-time">${c.ts ? fmtTime(c.ts) : ""}</span></div>
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
    li.onclick = (e) => { if (e.target.closest(".ci-del")) { e.stopPropagation(); deleteChat(c); return; } openChat(c); };
    ul.appendChild(li);
  }
  $("chatsEmpty").classList.toggle("hidden", shown > 0);
}
function deleteChat(c) {
  if (c.type === "group") { if (!confirm(t("leave_group"))) return; api("/api/groups/" + c.id + "/leave"); }
  chats.delete(c.key); persistDMs();
  if (c.key === activeKey) { activeKey = myRoom = ""; $("chatHead").classList.add("hidden"); $("messages").classList.add("hidden"); $("composer").classList.add("hidden"); $("emptyState").classList.remove("hidden"); }
  renderChatList($("searchInput").value);
}

// ---------- Открытие чата ----------
function openChat(c) {
  c = upsertChat(c);
  activeKey = c.key; myRoom = c.key; curKind = c.type; curTitle = c.name; c.unread = 0;
  socket.emit("join", { token, room: c.key }); // звонок НЕ завершаем — он живёт отдельно
  watermarkSnapshotApplied = false; // следующий watermark-снимок — это первый для новой комнаты, пересчитываем
  setTimeout(() => markDeliveredSeenUpToLast(), 300); // отметить переписку как доставленную/просмотренную
  $("emptyState").classList.add("hidden");
  $("chatHead").classList.remove("hidden"); $("messages").classList.remove("hidden"); $("composer").classList.remove("hidden");
  $("messages").innerHTML = "";
  $("chatTitle").textContent = c.name;
  $("chatSub").textContent = c.type === "group" ? t("room_sub_group") : t("room_sub_dm");
  $("chatAva").className = "avatar ch-ava" + (c.type === "group" ? " grp" : "");
  $("chatAva").setAttribute("data-login", c.type === "dm" ? c.login : "");
  $("chatAva").innerHTML = c.type === "group" ? `<img src="/api/group-avatar/${c.id}?v=${avaVer}" onerror="this.remove()">#` : `<img src="${avaUrl(c.login)}" onerror="this.remove()">${initials(c.name)}`;
  $("muteBtn").innerHTML = isMuted(c.key) ? window.ICON.bellOff : window.ICON.bell;
  $("app").classList.add("in-chat");
  // боковая панель участников для групп (на десктопе)
  groupMembers = [];
  if (c.type === "group") { loadGroupMembers(); if (!isMobile()) { $("infoTitle").textContent = t("info"); $("infoPanel").classList.remove("hidden"); } }
  else if (c.type === "dm") $("infoPanel").classList.add("hidden");
  renderChatList($("searchInput").value);
  if (call.active && c.key === call.roomKey) call.minimized = false; // вернулись в чат звонка
  syncCallUI(); updateCallButton();
}
$("backBtnMobile").onclick = () => { $("app").classList.remove("in-chat"); activeKey = ""; renderChatList($("searchInput").value); };
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
    item(t("group_settings"), "settings", () => openSettings("groups"));
    item(t("leave_group_btn"), "phoneOff", () => { if (confirm(t("leave_group"))) leaveCurrentGroup(); }, true);
  } else if (curKind === "dm") {
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
    const err = $("gsError"); if (err) err.textContent = "Failed to load group"; // без i18n — отдельный ключ «t(\"err_*\")» в словаре не подходит
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
  return { ok: true };
}
$("gsAvaBtn").onclick = () => $("gsAvaFile").click();
$("gsAvaFile").onchange = (e) => { const f = e.target.files[0]; if (!f) return; if (f.size > 2 * 1024 * 1024) { $("gsError").textContent = "≤ 2 MB"; return; } const r = new FileReader(); r.onload = () => { gsAvatar = r.result; $("gsAvaImg").src = r.result; $("gsAvaImg").style.display = "block"; $("gsAvaInit").style.display = "none"; }; r.readAsDataURL(f); };
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
// group-updated: если пейн groups активен — перечитать; иначе просто обновить список чатов/панели.
socket.on("group-updated", () => {
  loadGroups();
  // Обновляем пейн groups если он сейчас открыт над активной группой.
  if (curKind === "group" && settingsOpen && $("settingsTabs")?.querySelector('.settings-tab.active')?.dataset.tab === "groups") populateGroupSettingsPane();
  if (curKind === "group" && !$("infoPanel").classList.contains("hidden")) renderMembers();
});
socket.on("group-deleted", ({ id }) => { const key = "@grp:" + id; chats.delete(key); if (myRoom === key) { activeKey = myRoom = ""; $("chatHead").classList.add("hidden"); $("messages").classList.add("hidden"); $("composer").classList.add("hidden"); $("emptyState").classList.remove("hidden"); } if (settingsOpen) closeSettings(); renderChatList($("searchInput").value); });

// ---------- Аватары ----------
function avaUrl(login) { return "/api/avatar/" + encodeURIComponent(login || "") + "?v=" + avaVer; }
function initials(n) { return (n || "?").trim().charAt(0).toUpperCase(); }
function setMyAvatar() { const a = $("myAvatar"); a.setAttribute("data-login", profile.login); a.innerHTML = `<img src="${avaUrl(profile.login)}" onerror="this.remove()">${initials(myName)}<span class="st-dot ci-status st-${statusClass(myStatus === "invisible" ? "offline" : myStatus)}"></span>`; }

// ---------- Новый чат ----------
$("newChatBtn").onclick = () => { $("newChatModal").classList.remove("hidden"); $("dmError").textContent = ""; $("groupError").textContent = ""; renderFriendChips(); renderGroupPick(); };
// (#newChatCancel устарел вместе с #newChatModal — форма «Новый чат» теперь в #settingsOverlay → пейн «newchat».)
$("newChatCancel") && ($("newChatCancel").onclick = () => closeSettings());
$("emptyNewChat").onclick = () => $("newChatBtn").click();
$("emptyAddFriend").onclick = () => $("contactsBtn").click();
function renderFriendChips() {
  const box = $("friendsQuick"); box.innerHTML = "";
  relations.friends.forEach((l) => { const b = document.createElement("button"); b.className = "room-chip"; b.textContent = l; b.onclick = () => openDM(l); box.appendChild(b); });
}
// Мультивыбор друзей для новой группы
const groupPicked = new Set();
function renderGroupPick() {
  groupPicked.clear(); const box = $("groupFriendPick"); box.innerHTML = "";
  relations.friends.forEach((l) => {
    const b = document.createElement("button"); b.className = "fp-chip"; b.textContent = l;
    b.onclick = () => { if (groupPicked.has(l)) { groupPicked.delete(l); b.classList.remove("on"); } else { groupPicked.add(l); b.classList.add("on"); } };
    box.appendChild(b);
  });
}
async function openDM(login) {
  login = (login || $("dmInput")?.value || "").trim().toLowerCase();
  if (!login || login === profile.login) { const e = $("dmError"); if (e) e.textContent = t("err_user_not_found"); return; }
  const { ok, data } = await api("/api/user/" + login, null, "GET");
  if (!ok) { const e = $("dmError"); if (e) e.textContent = t("err_user_not_found"); return; }
  closeSettings(); const di = $("dmInput"); if (di) di.value = "";
  openChat({ key: dmKey(login), type: "dm", login, name: data.name || login, last: "", ts: Date.now(), unread: 0 });
  persistDMs();
}
$("dmOpenBtn").onclick = () => openDM();
$("createGroupBtn").onclick = async () => {
  const name = ($("groupName")?.value || "").trim();
  if (!name) { const e = $("groupError"); if (e) e.textContent = t("err_group_name"); return; }
  const { ok, data } = await api("/api/groups", { name, members: [...groupPicked].join(",") });
  if (!ok) { const e = $("groupError"); if (e) e.textContent = data.error || "error"; return; }
  closeSettings(); const gn = $("groupName"); if (gn) gn.value = ""; groupPicked.clear();
  const key = "@grp:" + data.id; chats.set(key, { key, type: "group", id: data.id, name: data.name, last: "", ts: Date.now(), unread: 0 });
  openChat(chats.get(key));
};

// ---------- Профиль (пейн «Profile» в #settingsOverlay) ----------
// Старые #profileModal / #contactsModal / #newChatModal / #groupSettingsModal удалены —
// их кнопки перенаправлены на openSettings(tab) выше; формы живут как пейны в #settingsOverlay.
let pendingAvatar = null;
$("avaUploadBtn") && ($("avaUploadBtn").onclick = () => $("avaFile").click());
$("avaFile") && ($("avaFile").onchange = (e) => {
  const f = e.target.files[0]; if (!f) return;
  if (f.size > 2 * 1024 * 1024) { $("profileError").textContent = "≤ 2 MB"; return; }
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
  Object.assign(relations, data); blocked.clear(); (data.blocked || []).forEach((l) => blocked.add(l));
  renderContacts(); renderFriendChips(); renderChatList($("searchInput").value);
}
function contactRow(login, buttons) {
  const row = document.createElement("div"); row.className = "contact-row";
  row.innerHTML = `<div class="avatar" style="width:30px;height:30px;font-size:13px"><img src="${avaUrl(login)}" onerror="this.remove()">${initials(login)}</div><span class="c-name">${escapeHtml(login)}</span>`;
  buttons.forEach(([label, fn, danger]) => { const b = document.createElement("button"); b.textContent = label; if (danger) b.className = "danger"; b.onclick = fn; row.appendChild(b); });
  row.querySelector(".c-name").onclick = () => openMiniProfile(login);
  return row;
}
function renderContacts() {
  const reqList = $("reqList"); if (!reqList) return;
  reqList.innerHTML = ""; const fL = $("friendsListEl"); if (fL) fL.innerHTML = ""; const sL = $("sentList"); if (sL) sL.innerHTML = "";
  const reqEmpty = $("reqEmpty"); if (reqEmpty) reqEmpty.classList.toggle("hidden", relations.incoming.length > 0);
  relations.incoming.forEach((l) => reqList.appendChild(contactRow(l, [["✓", () => friend(l, "accept")], ["✕", () => friend(l, "decline"), true]])));
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
$("chatAva").onclick = () => { if (curKind === "dm") openMiniProfile(myRoom.slice(4).split("~").find((l) => l !== profile.login)); };

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
socket.on("presence", ({ login, status }) => { presence.set(login, status); updateDots(); });
socket.on("relations-changed", () => loadRelations());

// ---------- Участники (инфо-панель) ----------
let groupMembers = []; // [{login,name}] текущей группы (для боковой панели)
async function loadGroupMembers() {
  if (curKind !== "group") { groupMembers = []; return; }
  const id = myRoom.slice(5);
  const { ok, data } = await api("/api/groups/" + id, null, "GET");
  if (ok && myRoom === "@grp:" + id) { groupMembers = data.members || []; renderMembers(); }
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
    li.innerHTML = `<div class="avatar" data-login="${login}" style="width:30px;height:30px;font-size:13px"><img src="${avaUrl(login)}" onerror="this.remove()">${initials(name)}</div><span class="m-name">${escapeHtml(name)}</span>${callIcon}`;
    // Клавиатурная навигация по сайдпанели участников: Tab → focus (кольцо из .member:focus-visible), Enter/Space → то же, что и клик.
    li.tabIndex = 0; li.setAttribute("role", "button");
    li.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openMiniProfile(login); } };
    li.onclick = () => openMiniProfile(login);
    ul.appendChild(li);
  }
}
socket.on("peers", (list) => { peers.clear(); list.forEach((p) => peers.set(p.id, { name: p.name, login: p.login })); if (!$("infoPanel").classList.contains("hidden")) renderMembers(); });
socket.on("peer-joined", (p) => { peers.set(p.id, { name: p.name, login: p.login }); if (!$("infoPanel").classList.contains("hidden")) renderMembers(); });
socket.on("peer-left", (p) => { peers.delete(p.id); if (!$("infoPanel").classList.contains("hidden")) renderMembers(); });

// ---------- Сообщения ----------
const messagesEl = $("messages");
socket.on("history", (list) => {
  messagesEl.innerHTML = "";
  if (list.length) { const sep = document.createElement("div"); sep.className = "system-msg"; sep.textContent = t("prev_messages"); messagesEl.appendChild(sep); }
  list.forEach((m) => renderMessage(m, false, isPingForMe(m)));
  const last = list[list.length - 1]; const c = chats.get(myRoom);
  if (c && last) { c.last = preview(last); c.ts = last.ts; renderChatList($("searchInput").value); }
  scrollDown();
  // Курсоры доставки/просмотра: на открытии чата пометим всё видимое партнёру как «доставлено» + «просмотрено».
  setTimeout(markDeliveredSeenUpToLast, 50);
});
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
  if (!mine && !isDnd()) { if (ping) sfx.call(); else if (!isMuted(myRoom)) sfx.msg(); }
  // «delivery» путём отправляется в renderMessage (там же и для истории, и для live), дублировать не нужно.
  // «seen» ставим ТОЛЬКО на явных действиях пользователя: открыл чат / сделал его видимым.
});
// Сервер подтвердил сохранение нашего сообщения — снимаем «pending».
socket.on("msg-ack", ({ localId, id, room: ackRoom }) => {
  if (!ackRoom || ackRoom !== myRoom) return;
  const el = messagesEl.querySelector(`.msg.me[data-localid="${localId}"]`);
  if (el) { el.dataset.id = id != null ? id : (el.dataset.id || ""); el.dataset.acked = "1"; statusOf(el); }
});
// Снимок курсоров для всей комнаты (приходит на join и при каждом обновлении).
socket.on("watermark", ({ updates }) => { applyWatermarkUpdates(updates); });
socket.on("dm-ping", ({ room, fromLogin, fromName }) => {
  const c = upsertChat({ key: dmKey(fromLogin), type: "dm", login: fromLogin, name: fromName, last: "", ts: Date.now(), unread: 0 });
  c.ts = Date.now();
  if (myRoom !== room) { c.unread = (c.unread || 0) + 1; if (!isMuted(room) && !isDnd()) { sfx.msg(); notify(t("dm_ping", { name: fromName })); } }
  persistDMs(); renderChatList($("searchInput").value);
});
socket.on("dm-blocked", () => notify(t("dm_need_friend")));
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
  if (yid) { const d = document.createElement("div"); d.className = "yt-embed"; d.innerHTML = `<iframe src="https://www.youtube.com/embed/${yid}" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture" allowfullscreen></iframe>`; wrap.appendChild(d); scrollDown(); return; }
  fetch("/api/link-preview?url=" + encodeURIComponent(url), { headers: { Authorization: "Bearer " + token } })
    .then((r) => r.json()).then((d) => {
      if (!d || (!d.title && !d.image)) return;
      const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.className = "link-preview";
      a.innerHTML = (d.image ? `<img class="lp-img" src="${escapeHtml(d.image)}" onerror="this.remove()">` : "") +
        `<div class="lp-body"><div class="lp-site">${escapeHtml(d.site || "")}</div><div class="lp-title">${escapeHtml(d.title || "")}</div><div class="lp-desc">${escapeHtml(d.description || "")}</div></div>`;
      wrap.appendChild(a); scrollDown();
    }).catch(() => {});
}

function renderMessage(m, scroll = true, ping = false) {
  const mine = profile && m.fromLogin === profile.login;
  const isB = !mine && m.fromLogin && blocked.has(m.fromLogin);
  const wrap = document.createElement("div");
  wrap.className = "msg" + (mine ? " me" : "") + (ping ? " ping" : "") + (isB ? " blocked" : "");
  wrap.dataset.id = m.id != null ? m.id : "";
  if (m.localId != null) wrap.dataset.localid = String(m.localId);
  if (m._optimistic) wrap.dataset.acked = ""; // ещё не подтверждено сервером
  else if (m.id != null) wrap.dataset.acked = "1";
  if (isB) wrap.dataset.blocklabel = t("blocked_msg");
  let inner = "";
  if (!mine && curKind === "group") inner += `<div class="who">${escapeHtml(m.name)}</div>`;
  if (m.type === "text") inner += `<div class="bubble">${formatMessage(m.text)}</div>`;
  else if (m.type === "image" || m.type === "gif") inner += `<div class="bubble media"><img src="${m.media}" alt=""></div>`;
  else if (m.type === "video") inner += `<div class="bubble media"><video src="${m.media}" controls></video></div>`;
  else if (m.type === "audio") inner += `<div class="bubble audio">🎤 <audio controls src="${m.media}"></audio></div>`;
  // Для исходящих — статус-иконка (pending / sent / delivered / read)
  const statusSpan = mine ? `<span class="msg-status" data-status="pending" title="${t("status_pending")}">${window.ICON.clock}</span>` : "";
  inner += `<div class="time">${fmtTime(m.ts)}<span class="edited-tag">${m.edited ? " · " + t("edited") : ""}</span>${statusSpan}</div>`;
  inner += `<div class="reactions"></div>`;
  if (m.id != null && !isB) {
    inner += `<div class="msg-actions"><button class="ma-btn ma-react" title="${t("react")}">${window.ICON.smile}</button>` +
      (mine && m.type === "text" ? `<button class="ma-btn ma-edit" title="${t("edit")}">${window.ICON.edit}</button>` : "") +
      (mine ? `<button class="ma-btn ma-del" title="${t("delete_msg")}">${window.ICON.trash}</button>` : "") + `</div>`;
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
  if (!mine && m.id) setTimeout(() => socket.emit("delivery", { maxId: m.id }), 0);
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
function sendText() {
  const input = $("msgInput"); const text = input.value.trim();
  if (!text || !myRoom) return;
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

// ---------- Медиа ----------
$("attachBtn").onclick = () => $("fileInput").click();
$("fileInput").addEventListener("change", (e) => {
  const file = e.target.files[0]; if (!file || !myRoom) return;
  if (file.size > 20 * 1024 * 1024) { alert(t("file_too_big")); return; }
  const r = new FileReader();
  r.onload = () => { let type = "file"; if (file.type.startsWith("image/")) type = file.type === "image/gif" ? "gif" : "image"; else if (file.type.startsWith("video/")) type = "video"; socket.emit("message", { type, media: r.result, mediaName: file.name }); };
  r.readAsDataURL(file); e.target.value = "";
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
$("emojiBtn").onclick = (e) => { e.stopPropagation(); $("gifPanel").classList.add("hidden"); if (!picker.dataset.built) { buildEmoji(); picker.dataset.built = "1"; } picker.classList.toggle("hidden"); };
document.addEventListener("click", (e) => { if (!picker.contains(e.target) && e.target !== $("emojiBtn")) picker.classList.add("hidden"); });

// ---------- GIF (GIPHY) ----------
const gifPanel = $("gifPanel"); let gifTimer;
$("gifBtn").onclick = (e) => { e.stopPropagation(); picker.classList.add("hidden"); const show = gifPanel.classList.contains("hidden"); gifPanel.classList.toggle("hidden"); if (show) { loadGifs(""); $("gifSearch").focus(); } };
$("gifSearch").addEventListener("input", (e) => { clearTimeout(gifTimer); gifTimer = setTimeout(() => loadGifs(e.target.value.trim()), 400); });
async function loadGifs(q) {
  const grid = $("gifGrid");
  const res = await fetch("/api/gif?q=" + encodeURIComponent(q), { headers: { Authorization: "Bearer " + token } });
  const d = await res.json(); $("gifNote").classList.toggle("hidden", !d.nokey); grid.innerHTML = "";
  (d.results || []).forEach((g) => { const img = new Image(); img.src = g.preview; img.className = "gif-item"; img.loading = "lazy"; img.onclick = () => { if (myRoom) socket.emit("message", { type: "gif", media: g.url, mediaName: "gif" }); gifPanel.classList.add("hidden"); }; grid.appendChild(img); });
}
document.addEventListener("click", (e) => { if (!gifPanel.contains(e.target) && e.target !== $("gifBtn")) gifPanel.classList.add("hidden"); });

// ====================== ЗВОНКИ (LiveKit SFU — надёжно через медиа-сервер) ======================
const call = { active: false, room: null, roomKey: null, roomTitle: "", minimized: false, fullscreen: false, micOn: true, camOn: false, sharing: false, ns: true, deaf: false, micWasOn: true, audioInId: null, audioOutId: null };
const audioEls = new Map(); // identity -> <audio> (звук участника)
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
      (isMe ? "" : `<div class="tile-ctrl"><button class="tctrl-mute" title="${t("mute_user")}">${window.ICON.volume}</button><input class="tctrl-vol" type="range" min="0" max="1" step="0.05" value="1" title="${t("volume")}"></div>`);
    vGrid.appendChild(tile);
    if (!isMe) wireTileControls(tile, identity);
  }
  updateCallCount(); return tile;
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
  updateCallCount();
}
function removeTile(id) { const t = $("tile-" + id); if (t) t.remove(); }
function setTileAvatar(id, show) { const t = $("tile-" + id); if (t) t.classList.toggle("show-avatar", show); }
function addScreenTile(id, name, mediaTrack) {
  let tile = $("tile-screen-" + id);
  if (!tile) {
    tile = document.createElement("div"); tile.id = "tile-screen-" + id; tile.className = "tile screen";
    tile.innerHTML = `<video autoplay playsinline ${id === "me" ? "muted" : ""}></video><div class="tile-name">🖥 ${escapeHtml(name)}</div><button class="tile-expand" title="${t("fullscreen")}">⛶</button>`;
    vGrid.appendChild(tile);
    // увеличение демонстрации — клик или кнопка → полноэкранное видео
    const enlarge = () => { const vv = tile.querySelector("video"); (vv.requestFullscreen || vv.webkitRequestFullscreen || (() => {})).call(vv); };
    tile.querySelector(".tile-expand").onclick = (e) => { e.stopPropagation(); enlarge(); };
    tile.querySelector("video").onclick = enlarge;
  }
  const v = tile.querySelector("video"); if (mediaTrack) mediaTrack.attach(v); v.play().catch(() => {});
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
    let a = audioEls.get(identity); if (!a) { a = document.createElement("audio"); a.autoplay = true; document.body.appendChild(a); audioEls.set(identity, a); }
    track.attach(a); applySinkId(a); a.muted = call.deaf;
    setMicIndicator(lkTile(identity), pub.isMuted);
  }
}
function detachTrack(track, pub, participant) {
  const identity = participant.identity;
  if (track.kind === "video") { if (pub.source === "screen_share") removeTile("screen-" + lkTile(identity)); else { track.detach(); setTileAvatar(lkTile(identity), true); } }
  else if (track.kind === "audio") { track.detach(); }
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
      else { const tile = ensureTile(profile.login, myName, true); pub.track.attach(tile.querySelector("video")); setTileAvatar("me", false); }
    }
  });
  room.on(E.LocalTrackUnpublished, (pub) => {
    if (pub.source === "screen_share") removeTile("screen-me");
    else if (pub.track && pub.track.kind === "video") setTileAvatar("me", true);
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
  btn.title = inThis ? t("t_hangup") : ongoing ? t("join_call") : t("t_call");
  btn.innerHTML = inThis ? window.ICON.phoneOff : window.ICON.phone;
}
// Показ/сворачивание оверлея звонка в зависимости от просматриваемого чата и флага minimized
// Звонок = левая колонка переписки (ПК): сообщения адаптивно справа, не под звонком. Телефон — стек сверху.
function syncCallUI() {
  const stage = $("callStage"), vb = $("voiceBar"), pane = $("chatPane");
  if (!call.active) { stage.classList.add("hidden"); stage.classList.remove("fullscreen"); vb.classList.add("hidden"); pane.classList.remove("has-call"); return; }
  const here = myRoom === call.roomKey;
  const fs = stage.classList.contains("fullscreen");
  const showStage = here && !(isMobile() && call.minimized);
  stage.classList.toggle("hidden", !showStage);
  if (!here) stage.classList.remove("fullscreen");
  pane.classList.toggle("has-call", showStage && !fs && !isMobile()); // ПК: звонок — колонка/полоса чата
  applyDock();
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
  call.room = room; call.active = true; call.roomKey = myRoom; call.roomTitle = curTitle; call.minimized = false; wireRoom(room, LK); startCallMatrix();
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
  } catch (e) { console.error("livekit connect", e); alert(t("err_media") + (e.message || "")); endCall(); return; }
  call.micOn = true; call.camOn = false; call.sharing = false; call.ns = true;
  $("toggleMic").classList.remove("off"); $("toggleCam").classList.add("off"); $("shareScreen").classList.remove("active"); $("noiseToggle").classList.add("on");
  $("toggleMic").innerHTML = window.ICON.mic; $("toggleCam").innerHTML = window.ICON.cameraOff;
  populateDevices(); startKeepAlive(); updateCallStatus(); updateCallButton();
  $("toggleDeafen").classList.remove("off"); $("toggleDeafen").innerHTML = window.ICON.headphones;
  socket.emit("call-join", { title: curTitle }); // ring others + объявить звонок в комнате
}
function endCall() {
  const wasActive = call.active;
  if (call.active) socket.emit("call-leave");
  if (pipWin) { try { pipWin.close(); } catch {} pipWin = null; clearInterval(pipPoll); returnGridHome(); }
  if (call.room) { try { call.room.disconnect(); } catch {} call.room = null; }
  for (const a of audioEls.values()) { try { a.srcObject = null; a.remove(); } catch {} } audioEls.clear();
  vGrid.innerHTML = "";
  $("expandBtn").classList.remove("active");
  $("callStage").classList.add("hidden"); $("callStage").classList.remove("fullscreen"); $("voiceBar").classList.add("hidden");
  $("chatPane").classList.remove("has-call"); // убрать grid-колонку звонка — без неё была чёрная зона
  $("startCallBtn").classList.remove("in-call");
  Object.assign(call, { active: false, sharing: false, micOn: true, camOn: false, ns: true, deaf: false, micWasOn: true, roomKey: null, minimized: false, fullscreen: false });
  krispNode = null; stopCallMatrix();
  $("toggleMic").classList.remove("off"); $("toggleCam").classList.remove("off"); $("toggleDeafen").classList.remove("off"); $("shareScreen").classList.remove("active"); $("noiseToggle").classList.add("on"); $("micDropdown").classList.remove("open");
  $("toggleMic").innerHTML = window.ICON.mic; $("toggleCam").innerHTML = window.ICON.camera; $("toggleDeafen").innerHTML = window.ICON.headphones; $("callStatus").textContent = "";
  stopKeepAlive(); updateCallButton();
  if (wasActive) sfx.end();
}
$("hangUp").onclick = endCall;

// Ringing (через Socket.IO + push) — медиа поднимает LiveKit
socket.on("call-ring", (p) => { if (call.active) return; const kind = p.room.startsWith("@grp:") ? "group" : "dm"; showToast(p.from, p.name, { room: p.room, title: p.title, kind }); });

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
  $("toggleDeafen").classList.toggle("off", call.deaf);
  $("toggleDeafen").innerHTML = window.ICON[call.deaf ? "headphonesOff" : "headphones"];
  if (call.deaf) { call.micWasOn = call.micOn; if (call.micOn) setMic(false); }
  else if (call.micWasOn) setMic(true);
};
$("toggleCam").onclick = async () => { if (!call.room) return; call.camOn = !call.camOn; try { await call.room.localParticipant.setCameraEnabled(call.camOn, { resolution: { width: 640, height: 360 } }); if (call.camOn && call.audioInId) {} } catch { call.camOn = false; } $("toggleCam").classList.toggle("off", !call.camOn); $("toggleCam").innerHTML = window.ICON[call.camOn ? "camera" : "cameraOff"]; if (!call.camOn) setTileAvatar("me", true); };
$("shareScreen").onclick = async () => { if (!call.room) return; call.sharing = !call.sharing; try { await call.room.localParticipant.setScreenShareEnabled(call.sharing); } catch { call.sharing = false; } $("shareScreen").classList.toggle("active", call.sharing); };

// Дропдаун микрофона + устройства
$("micDrop").onclick = (e) => { e.stopPropagation(); $("micDropdown").classList.toggle("open"); if ($("micDropdown").classList.contains("open")) populateDevices(); };
document.addEventListener("click", (e) => { if (!e.target.closest(".call-btn-group")) $("micDropdown").classList.remove("open"); });
$("toggleNoise").onclick = (e) => { e.stopPropagation(); call.ns = !call.ns; $("noiseToggle").classList.toggle("on", call.ns); applyNoiseFilter(call.ns); };
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
$("micSelect").onchange = async () => { call.audioInId = $("micSelect").value; if (call.room) { try { await call.room.switchActiveDevice("audioinput", call.audioInId); } catch {} } };
$("spkSelect").onchange = () => { call.audioOutId = $("spkSelect").value; audioEls.forEach(applySinkId); if (call.room) call.room.switchActiveDevice("audiooutput", call.audioOutId).catch(() => {}); };

// ⛶ Фуллскрин стейджа звонка (ПК)
$("expandBtn").onclick = () => { const fs = $("callStage").classList.toggle("fullscreen"); $("expandBtn").classList.toggle("active", fs); $("chatPane").classList.toggle("has-call", !fs && myRoom === call.roomKey && !isMobile()); };
// Вернуть сетку тайлов обратно в стейдж (после поп-аута)
function returnGridHome() { const stage = $("callStage"); if (vGrid.parentElement !== stage) stage.insertBefore(vGrid, stage.querySelector(".call-bar")); }
// ⧉ Поп-аут звонка: Document PiP (Chrome, поверх всех) или обычное окно window.open (Firefox и пр.)
let pipWin = null, pipPoll = 0;
function mountGridIn(win) {
  document.querySelectorAll('link[rel="stylesheet"], style').forEach((s) => win.document.head.appendChild(s.cloneNode(true)));
  win.document.body.style.cssText = "margin:0;background:#000700;overflow:hidden;display:flex;flex-direction:column;height:100vh";
  win.document.body.appendChild(vGrid);
  // прокси-кнопки управления в окне (проксируют клики на основные контролы)
  const bar = win.document.createElement("div"); bar.className = "call-bar";
  const actions = win.document.createElement("div"); actions.className = "call-actions";
  [["toggleMic", "mic"], ["toggleCam", "camera"], ["shareScreen", "monitor"], ["toggleDeafen", "headphones"], ["hangUp", "phoneOff", "end"]].forEach(([id, icon, cls]) => {
    const b = win.document.createElement("button"); b.className = "call-btn" + (cls ? " " + cls : ""); b.innerHTML = window.ICON[icon]; b.title = id; b.onclick = () => $(id) && $(id).click(); actions.appendChild(b);
  });
  bar.appendChild(actions); win.document.body.appendChild(bar);
}
$("popoutBtn").onclick = async () => {
  if (!call.active) return;
  if (pipWin) { try { pipWin.close(); } catch {} return; }
  try {
    if ("documentPictureInPicture" in window) {
      pipWin = await documentPictureInPicture.requestWindow({ width: 380, height: 480 });
      mountGridIn(pipWin);
      pipWin.addEventListener("pagehide", () => { const wasActive = call.active; returnGridHome(); pipWin = null; if (wasActive) endCall(); });
    } else {
      // Firefox / без Document PiP — обычное окно
      pipWin = window.open("", "dialogCall", "width=380,height=520,menubar=no,toolbar=no");
      if (!pipWin) { alert(t("pip_unsupported")); return; }
      pipWin.document.title = "Dialog — " + (call.roomTitle || "call");
      mountGridIn(pipWin);
      clearInterval(pipPoll);
      pipPoll = setInterval(() => { if (!pipWin || pipWin.closed) { clearInterval(pipPoll); const wasActive = call.active; returnGridHome(); pipWin = null; if (wasActive) endCall(); } }, 700);
    }
  } catch (e) { console.log("pip", e.message); pipWin = null; }
};

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
function startRingtone() {
  if (ring.audio) return; // двойной вызов не заводит второй луп
  ensureAudioCtx();
  ring.audio = { synth: true };
  playRingChord();
  ring.toneLoop = setInterval(playRingChord, 4500);
  startCava();
}
function stopRingtone() {
  clearInterval(ring.toneLoop); ring.toneLoop = null;
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
socket.io.on("reconnect", () => { if (connEl) connEl.classList.remove("show"); if (token) refreshPresence(); }); // после reconnect снимок присутствия мог устареть — догоняем одним вызовом вместо poll.

// ---------- Утилиты ----------
function scrollDown() { messagesEl.scrollTop = messagesEl.scrollHeight; }
function fmtTime(ts) { return new Date(ts).toLocaleTimeString(window.getLang() === "ru" ? "ru-RU" : "en-GB", { hour: "2-digit", minute: "2-digit" }); }
function escapeHtml(s) { return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function linkify(s) { return s.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color:#7dffaf">$1</a>'); }
function notify(text) { let el = $("notifyToast"); if (!el) { el = document.createElement("div"); el.id = "notifyToast"; el.className = "notify-toast"; document.body.appendChild(el); } el.textContent = text; el.classList.add("show"); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("show"), 3500); }

// ---------- Settings overlay (Discord-style, ~80vw × 80vh), status pill, ESC/click-outside ----------
// Все формы (профиль, контакты, темы, настройки группы, новый чат) живут в #settingsOverlay как пейны.
// 5 вкладок: profile / contacts / themes / groups / newchat. Клик по фону или Esc → закрыть.
let settingsOpen = false;
const SETTINGS_TABS = ["profile", "contacts", "themes", "groups", "newchat"];
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
  if (tab === "newchat") { renderFriendChips(); renderGroupPick(); }
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
  else if (tab === "newchat") { renderFriendChips(); renderGroupPick(); }
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
function renderThemes() {
  const grid = $("themeGrid"); if (!grid) return;
  grid.innerHTML = "";
  const cur = document.body.dataset.theme || "matrix";
  THEMES.forEach((th) => {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "theme-opt" + (th.key === cur ? " active" : "");
    opt.dataset.theme = th.key;
    opt.innerHTML =
      `<div class="theme-swatch">${th.swatch.map((c) => `<span style="background:${c}"></span>`).join("")}</div>` +
      `<div class="theme-name">${escapeHtml(t(th.name))}</div>` +
      `<div class="theme-desc">${escapeHtml(t(th.desc))}</div>`;
    opt.onclick = () => applyTheme(th.key);
    grid.appendChild(opt);
  });
  const ov = $("settingsOverlay"); if (ov) ov._themesRendered = true;
}

// Перенаправляем хедер-кнопки на settings overlay.
$("contactsBtn").onclick = () => openSettings("contacts");
$("profileBtn").onclick = () => openSettings("profile");
$("newChatBtn").onclick = () => openSettings("newchat");
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
  const map = { emojiBtn: "emoji", attachBtn: "attach", voiceBtn: "mic", sendBtn: "send", muteBtn: "bell", startCallBtn: "phone", infoBtn: "info", backBtnMobile: "back", profileBtn: "settings", contactsBtn: "users", toggleMic: "mic", toggleCam: "camera", toggleDeafen: "headphones", shareScreen: "monitor", hangUp: "phoneOff", infoClose: "close", mpCancel: "close" };
  const tips = { muteBtn: "mute_room", startCallBtn: "t_call", infoBtn: "info", emojiBtn: "t_emoji", attachBtn: "t_attach", voiceBtn: "t_voice", sendBtn: "t_send", toggleMic: "t_mic", toggleCam: "t_cam", toggleDeafen: "t_deafen", shareScreen: "t_screen", hangUp: "t_hangup", profileBtn: "settings", contactsBtn: "contacts", popoutBtn: "popout", expandBtn: "fullscreen", minBtn: "minimize", vbMic: "t_mic", vbDeafen: "t_deafen", vbHang: "t_hangup" };
  for (const [id, name] of Object.entries(map)) { const el = $(id); if (el && window.ICON[name]) el.innerHTML = window.ICON[name]; }
  for (const [id, key] of Object.entries(tips)) { const el = $(id); if (el) el.setAttribute("data-tip", t(key)); }
  // Кнопки входящего звонка получают подпись снизу (инлайн .ci-label — без data-tip,
  // чтобы [data-tip]::after не дублировал ту же подпись при наведении).
  const toastJoin = $("toastJoin"), toastClose = $("toastClose");
  if (toastJoin) { toastJoin.innerHTML = window.ICON.phone + '<span class="ci-label">' + t("toast_join") + '</span>'; }
  if (toastClose) { toastClose.innerHTML = window.ICON.phoneOff + '<span class="ci-label">' + t("t_hangup") + '</span>'; }
}
$("searchInput").addEventListener("input", (e) => renderChatList(e.target.value));

// ---------- Старт ----------
initLang(); setIcons(); checkSession();
