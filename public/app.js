const socket = io();

// --- State ---
let myName = "";
let myRoom = "";          // ключ активного чата (@dm:.. / @grp:..)
let curKind = "dm";       // dm | group
let curTitle = "";
const peers = new Map();   // id -> {name, login}
const presence = new Map(); // login -> 'online'|'dnd'|'offline'
let myStatus = "online", myDesc = "";
const $ = (id) => document.getElementById(id);
let ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }], iceCandidatePoolSize: 4 };
fetch("/api/ice").then(r => r.json()).then(c => { c.iceCandidatePoolSize = 4; ICE = c; }).catch(() => {});

// ====================== ЯЗЫК ======================
function initLang() {
  const l = window.getLang();
  ["langSelect", "langSelect2"].forEach((id) => { const el = $(id); if (el) { el.value = l; el.onchange = () => window.setLang(el.value); } });
  applyI18n();
}
window.addEventListener("langchange", () => {
  ["langSelect", "langSelect2"].forEach((id) => { const el = $(id); if (el) el.value = window.getLang(); });
  updateMuteBtn();
  renderMembers();
  renderChatList($("searchInput").value);
  if (myRoom) { $("chatSub").textContent = curKind === "group" ? t("room_sub_group") : ""; $("callRoomLabel").textContent = t("call_label") + " · " + curTitle; }
});

// ====================== ЗВУКИ ======================
let audioCtx;
function ensureAudioCtx() {
  try { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === "suspended") audioCtx.resume(); } catch {}
  return audioCtx;
}
document.addEventListener("pointerdown", ensureAudioCtx);
function beep(freq, dur, type = "sine", vol = 0.07) {
  const ctx = ensureAudioCtx(); if (!ctx) return;
  try {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq; g.gain.value = vol;
    o.connect(g); g.connect(ctx.destination); o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur); o.stop(ctx.currentTime + dur);
  } catch {}
}
const sfx = {
  join: () => { beep(660, 0.12); setTimeout(() => beep(880, 0.12), 90); },
  leave: () => { beep(440, 0.12); setTimeout(() => beep(294, 0.16), 90); },
  call: () => { beep(784, 0.14); setTimeout(() => beep(1047, 0.2), 130); },
  msg: () => beep(560, 0.05, "triangle", 0.04),
};

// ====================== АУТЕНТИФИКАЦИЯ ======================
let token = localStorage.getItem("dialog_token") || null;
let profile = null;

document.querySelectorAll(".auth-tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".auth-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const mode = tab.dataset.mode;
    $("loginForm").classList.toggle("hidden", mode !== "login");
    $("registerForm").classList.toggle("hidden", mode !== "register");
    $("loginError").textContent = ""; $("registerError").textContent = "";
  };
});
async function api(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ok: res.ok, data: await res.json() };
}
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const { ok, data } = await api("/api/login", { login: f.login.value, password: f.password.value });
  if (!ok) { $("loginError").textContent = data.error || t("err_login_failed"); return; }
  onAuthSuccess(data);
});
$("registerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.password.value !== f.password2.value) { $("registerError").textContent = t("err_pass_mismatch"); return; }
  const { ok, data } = await api("/api/register", { name: f.name.value, login: f.login.value, password: f.password.value });
  if (!ok) { $("registerError").textContent = data.error || t("err_register_failed"); return; }
  onAuthSuccess(data);
});

function enterApp() {
  myName = profile.name;
  if (token) socket.emit("identify", { token }); // зарегистрировать сокет для звонков/пингов
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("myName").textContent = myName;
  setMyAvatar();
  chats.clear();
  loadStoredChats();
  renderChatList();
  loadGroups();
  loadRelations();
  loadMe();
  refreshPresence();
  if (!window._presInt) window._presInt = setInterval(refreshPresence, 25000);
}
function onAuthSuccess({ token: tk, profile: p }) {
  token = tk; profile = p;
  localStorage.setItem("dialog_token", tk);
  enterApp();
}
async function checkSession() {
  if (!token) return;
  try {
    const res = await fetch("/api/me", { headers: { Authorization: "Bearer " + token } });
    if (res.ok) { profile = (await res.json()).profile; enterApp(); }
    else localStorage.removeItem("dialog_token");
  } catch {}
}
$("logoutBtn").onclick = () => { localStorage.removeItem("dialog_token"); location.reload(); };

// ====================== СПИСОК ЧАТОВ ======================
const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || "[]"); } catch { return []; } };
const lsSet = (k, v) => localStorage.setItem(k, JSON.stringify(v));

const chats = new Map(); // key -> {key,type,login?,id?,name,last,ts,unread}
let activeKey = null;

function dmKey(login) { return "@dm:" + [profile.login, login].sort().join("~"); }
function upsertChat(meta) {
  let c = chats.get(meta.key);
  if (!c) { c = meta; chats.set(meta.key, c); }
  else if (meta.name) c.name = meta.name;
  return c;
}
function persistDMs() {
  const dms = [...chats.values()].filter((c) => c.type === "dm").sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .map((c) => ({ login: c.login, name: c.name, last: c.last, ts: c.ts }));
  lsSet("dialog_dms", dms.slice(0, 50));
}
function loadStoredChats() {
  lsGet("dialog_dms").forEach((d) =>
    upsertChat({ key: dmKey(d.login), type: "dm", login: d.login, name: d.name, last: d.last || "", ts: d.ts || 0, unread: 0 }));
}
async function loadGroups() {
  try {
    const res = await fetch("/api/groups", { headers: { Authorization: "Bearer " + token } });
    if (!res.ok) return;
    const { groups } = await res.json();
    groups.forEach((g) => upsertChat({ key: "@grp:" + g.id, type: "group", id: g.id, name: g.name, last: "", ts: 0, unread: 0 }));
    renderChatList($("searchInput").value);
  } catch {}
}
function renderChatList(filter = "") {
  const ul = $("chatList");
  const f = (filter || "").trim().toLowerCase();
  const items = [...chats.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  ul.innerHTML = "";
  let shown = 0;
  items.forEach((c) => {
    if (f && !c.name.toLowerCase().includes(f)) return;
    shown++;
    const li = document.createElement("li");
    li.className = "chat-item" + (c.key === activeKey ? " active" : "");
    const ava = c.type === "dm" ? avaHTML(c.login, c.name, 46, true)
      : `<span class="avatar grp" style="width:46px;height:46px">${window.ICON.users}</span>`;
    li.innerHTML = `${ava}
      <div class="ci-body">
        <div class="ci-top"><span class="ci-name">${escapeHtml(c.name)}</span><span class="ci-time">${c.ts ? fmtTime(c.ts) : ""}</span></div>
        <div class="ci-bot"><span class="ci-last">${escapeHtml(c.last || "")}</span>${c.unread ? `<span class="badge">${c.unread}</span>` : ""}</div>
      </div>
      <button class="ci-del" title="${t("delete_chat")}">${window.ICON.close}</button>`;
    li.onclick = (e) => { if (e.target.closest(".ci-del")) { e.stopPropagation(); deleteChat(c); return; } openChat(c); };
    ul.appendChild(li);
  });
  $("chatsEmpty").classList.toggle("hidden", shown > 0 || (f && chats.size));
  updateDots();
}
$("searchInput").addEventListener("input", (e) => renderChatList(e.target.value));

function preview(m) {
  if (m.type === "text") return m.text;
  if (m.type === "image" || m.type === "gif") return "🖼 " + t("pv_photo");
  if (m.type === "video") return "🎬 " + t("pv_video");
  if (m.type === "audio") return "🎤 " + t("pv_voice");
  return "media";
}

// ====================== ОТКРЫТИЕ ЧАТА ======================
function openChat(c) {
  c = upsertChat(c);
  activeKey = c.key; myRoom = c.key; curKind = c.type; curTitle = c.name;
  c.unread = 0;
  if (call.active) endCall();
  socket.emit("join", { token, room: c.key });

  $("emptyState").classList.add("hidden");
  $("chatHead").classList.remove("hidden");
  $("messages").classList.remove("hidden");
  $("composer").classList.remove("hidden");
  $("infoPanel").classList.add("hidden");
  $("chatTitle").textContent = c.name;
  $("chatSub").textContent = c.type === "group" ? t("room_sub_group") : "";
  setChatAva(c);
  $("callRoomLabel").textContent = t("call_label") + " · " + c.name;
  updateMuteBtn();
  document.body.classList.add("chat-open"); // мобильный: показать разговор
  renderChatList($("searchInput").value);
  refreshPresence();
  $("msgInput").focus();
}
function setChatAva(c) {
  const el = $("chatAva"); el.classList.add("ava");
  if (c.type === "dm") el.innerHTML = `<img src="${avaUrl(c.login)}" alt="" onerror="this.style.display='none'"><span class="ava-fallback">${initials(c.name)}</span>`;
  else el.innerHTML = `<span class="ava-fallback">${window.ICON.users}</span>`;
}
function openDM(login, name) {
  if (!login || login === profile.login) return;
  openChat({ key: dmKey(login), type: "dm", login, name, last: "", ts: 0, unread: 0 });
  persistDMs();
}
function enterGroup(id, name) { openChat({ key: "@grp:" + id, type: "group", id, name, last: "", ts: 0, unread: 0 }); }

async function deleteChat(c) {
  if (c.type === "group") {
    if (!confirm(t("leave_group"))) return;
    try { await fetch("/api/groups/" + c.id + "/leave", { method: "POST", headers: { Authorization: "Bearer " + token } }); } catch {}
  }
  chats.delete(c.key);
  if (c.type === "dm") persistDMs();
  if (activeKey === c.key) {
    activeKey = null; myRoom = ""; socket.emit("leave");
    $("chatHead").classList.add("hidden"); $("messages").classList.add("hidden"); $("composer").classList.add("hidden");
    $("emptyState").classList.remove("hidden"); document.body.classList.remove("chat-open");
  }
  renderChatList($("searchInput").value);
}

$("backBtnMobile").onclick = () => document.body.classList.remove("chat-open");

// ====================== НОВЫЙ ЧАТ ======================
$("newChatBtn").onclick = () => {
  $("dmError").textContent = ""; $("groupError").textContent = "";
  $("dmInput").value = ""; $("groupName").value = ""; $("groupMembers").value = "";
  renderFriendsQuick();
  $("newChatModal").classList.remove("hidden");
  $("dmInput").focus();
};
$("newChatCancel").onclick = () => $("newChatModal").classList.add("hidden");
function renderFriendsQuick() {
  const c = $("friendsQuick"); c.innerHTML = "";
  friendsList.forEach(({ login, name }) => {
    const b = document.createElement("button"); b.className = "room-chip";
    b.textContent = "@ " + name;
    b.onclick = () => { $("newChatModal").classList.add("hidden"); openDM(login, name); };
    c.appendChild(b);
  });
}
async function openDMByNick() {
  const login = $("dmInput").value.trim().toLowerCase();
  $("dmError").textContent = "";
  if (!login) return;
  if (login === profile.login) { $("dmError").textContent = t("err_user_not_found"); return; }
  try {
    const res = await fetch("/api/user/" + encodeURIComponent(login), { headers: { Authorization: "Bearer " + token } });
    if (!res.ok) { $("dmError").textContent = t("err_user_not_found"); return; }
    const u = await res.json();
    $("newChatModal").classList.add("hidden");
    openDM(u.login, u.name);
  } catch { $("dmError").textContent = t("err_user_not_found"); }
}
$("dmOpenBtn").onclick = openDMByNick;
$("dmInput").addEventListener("keydown", (e) => { if (e.key === "Enter") openDMByNick(); });

async function createGroupFromForm() {
  const name = $("groupName").value.trim();
  $("groupError").textContent = "";
  if (!name) { $("groupError").textContent = t("err_group_name"); return; }
  const members = $("groupMembers").value.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  try {
    const res = await fetch("/api/groups", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ name, members }),
    });
    const data = await res.json();
    if (!res.ok) { $("groupError").textContent = data.error || "error"; return; }
    $("newChatModal").classList.add("hidden");
    enterGroup(data.id, data.name);
  } catch { $("groupError").textContent = "error"; }
}
$("createGroupBtn").onclick = createGroupFromForm;

// ====================== ИНФО-ПАНЕЛЬ (участники) ======================
$("infoBtn").onclick = () => { if (!myRoom) return; renderMembers(); $("infoTitle").textContent = curTitle; $("infoPanel").classList.toggle("hidden"); };
$("infoClose").onclick = () => $("infoPanel").classList.add("hidden");
$("chatAva").onclick = () => {
  if (curKind === "dm") { const p = myRoom.slice(4).split("~").find((l) => l !== profile.login); openMiniProfile(p, curTitle); }
  else if (curKind === "group") $("infoBtn").click();
};

// ====================== МЬЮТ ======================
const isMuted = (room) => lsGet("dialog_muted").includes(room);
function updateMuteBtn() {
  if (!myRoom) return;
  const m = isMuted(myRoom);
  $("muteBtn").innerHTML = window.ICON[m ? "bellOff" : "bell"];
  $("muteBtn").classList.toggle("on", m);
  $("muteBtn").title = t(m ? "unmute_room" : "mute_room");
}
$("muteBtn").onclick = () => {
  if (!myRoom) return;
  let m = lsGet("dialog_muted");
  m = m.includes(myRoom) ? m.filter((x) => x !== myRoom) : [myRoom, ...m];
  lsSet("dialog_muted", m);
  updateMuteBtn();
};
function notify(text) {
  let el = $("notifyToast");
  if (!el) { el = document.createElement("div"); el.id = "notifyToast"; el.className = "notify-toast"; document.body.appendChild(el); }
  el.textContent = text; el.classList.add("show");
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("show"), 3500);
}

// ====================== ЛС-ПИНГ ======================
socket.on("dm-ping", ({ room, fromLogin, fromName }) => {
  const c = upsertChat({ key: dmKey(fromLogin), type: "dm", login: fromLogin, name: fromName, last: "", ts: Date.now(), unread: 0 });
  c.ts = Date.now();
  if (myRoom !== room) { c.unread = (c.unread || 0) + 1; if (!isMuted(room)) { sfx.msg(); notify(t("dm_ping", { name: fromName })); } }
  persistDMs(); renderChatList($("searchInput").value);
});

// ====================== АВАТАРЫ + ПРОФИЛЬ ======================
let avaVer = Date.now();
function avaUrl(login) { return "/api/avatar/" + encodeURIComponent(login) + "?v=" + avaVer; }
function avaHTML(login, name, size, dot) {
  const s = size || 28;
  return `<span class="avatar ava" style="width:${s}px;height:${s}px;font-size:${Math.round(s * 0.4)}px">` +
    `<img src="${avaUrl(login)}" alt="" onerror="this.style.display='none'">` +
    `<span class="ava-fallback">${initials(name)}</span>` +
    (dot ? `<span class="st-dot st-${presence.get(login) || "offline"}" data-login="${login}"></span>` : "") +
    `</span>`;
}
function setMyAvatar() {
  const el = $("myAvatar"); el.classList.add("ava");
  el.innerHTML = `<img src="${avaUrl(profile.login)}" alt="" onerror="this.style.display='none'"><span class="ava-fallback">${initials(myName)}</span><span class="st-dot st-${presence.get(profile.login) || "online"}" data-login="${profile.login}"></span>`;
}
let pendingAvatar = null;
let pendingStatus = "online";
document.querySelectorAll(".status-opt").forEach((b) => {
  b.onclick = () => { pendingStatus = b.dataset.st; document.querySelectorAll(".status-opt").forEach((x) => x.classList.toggle("active", x === b)); };
});
$("profileBtn").onclick = () => {
  pendingAvatar = null;
  $("profileLogin").textContent = profile.login;
  $("profileName").value = profile.name;
  $("profileDesc").value = myDesc;
  $("profileError").textContent = "";
  $("profileAvaInit").textContent = initials(profile.name);
  pendingStatus = myStatus;
  document.querySelectorAll(".status-opt").forEach((x) => x.classList.toggle("active", x.dataset.st === myStatus));
  const img = $("profileAvaImg"); img.style.display = ""; img.onerror = () => (img.style.display = "none"); img.src = avaUrl(profile.login);
  $("profileModal").classList.remove("hidden");
};
$("profileCancel").onclick = () => $("profileModal").classList.add("hidden");
$("avaUploadBtn").onclick = () => $("avaFile").click();
$("avaFile").addEventListener("change", (e) => {
  const file = e.target.files[0]; e.target.value = "";
  if (!file) return;
  const fr = new FileReader();
  fr.onload = () => {
    const im = new Image();
    im.onload = () => {
      const c = document.createElement("canvas"); c.width = c.height = 128;
      const sz = Math.min(im.width, im.height);
      c.getContext("2d").drawImage(im, (im.width - sz) / 2, (im.height - sz) / 2, sz, sz, 0, 0, 128, 128);
      pendingAvatar = c.toDataURL("image/jpeg", 0.85);
      const pi = $("profileAvaImg"); pi.src = pendingAvatar; pi.style.display = "";
    };
    im.src = fr.result;
  };
  fr.readAsDataURL(file);
});
$("profileSave").onclick = async () => {
  const name = $("profileName").value.trim();
  const desc = $("profileDesc").value.trim();
  const body = { description: desc };
  if (name && name !== profile.name) body.name = name;
  if (pendingAvatar) body.avatar = pendingAvatar;
  if (pendingStatus !== myStatus) body.status = pendingStatus;
  try {
    const res = await fetch("/api/profile", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { $("profileError").textContent = data.error || "error"; return; }
    profile = data.profile; myName = profile.name; avaVer = Date.now();
    myDesc = desc; myStatus = pendingStatus;
    presence.set(profile.login, myStatus === "invisible" ? "offline" : myStatus);
    $("profileModal").classList.add("hidden");
    $("myName").textContent = myName;
    setMyAvatar(); renderMembers(); renderChatList($("searchInput").value); updateDots();
  } catch { $("profileError").textContent = "error"; }
};

// ====================== ДРУЗЬЯ / ЗАЯВКИ / БЛОК ======================
let blocked = new Set();
let friendsList = [], blocksList = [], incomingReqs = [], outgoingReqs = [];
function applyRelations(d) {
  friendsList = d.friends || []; blocksList = d.blocks || [];
  incomingReqs = d.incoming || []; outgoingReqs = d.outgoing || [];
  blocked = new Set(blocksList.map((x) => x.login));
  $("contactsBtn") && $("contactsBtn").classList.toggle("has-req", incomingReqs.length > 0);
  renderContacts(); renderMembers(); refreshPresence();
}
async function loadRelations() {
  try {
    const res = await fetch("/api/relations", { headers: { Authorization: "Bearer " + token } });
    if (res.ok) applyRelations(await res.json());
  } catch {}
}
async function friendAction(target, action) {
  try {
    const res = await fetch("/api/friend", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify({ target, action }) });
    if (res.ok) applyRelations(await res.json());
  } catch {}
}
async function blockAction(target, action) {
  try {
    const res = await fetch("/api/relations", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify({ target, action }) });
    if (res.ok) applyRelations(await res.json());
  } catch {}
}
socket.on("relations-changed", loadRelations);

// Контакты
$("contactsBtn").onclick = () => { $("reqError").textContent = ""; $("reqInput").value = ""; renderContacts(); refreshPresence(); $("contactsModal").classList.remove("hidden"); };
$("contactsCancel").onclick = () => $("contactsModal").classList.add("hidden");
async function reqSend() {
  const login = $("reqInput").value.trim().toLowerCase();
  $("reqError").textContent = "";
  if (!login || login === profile.login) { $("reqError").textContent = t("err_user_not_found"); return; }
  const res = await fetch("/api/user/" + encodeURIComponent(login), { headers: { Authorization: "Bearer " + token } });
  if (!res.ok) { $("reqError").textContent = t("err_user_not_found"); return; }
  $("reqInput").value = "";
  await friendAction(login, "request");
}
$("reqSendBtn").onclick = reqSend;
$("reqInput").addEventListener("keydown", (e) => { if (e.key === "Enter") reqSend(); });

function contactRow(login, name, buttons) {
  const row = document.createElement("div");
  row.className = "contact-row";
  row.innerHTML = `${avaHTML(login, name, 32, true)}<span class="m-name">${escapeHtml(name)}</span><span class="cr-acts"></span>`;
  row.querySelector(".m-name").onclick = () => openMiniProfile(login, name);
  row.querySelector(".ava").onclick = () => openMiniProfile(login, name);
  const acts = row.querySelector(".cr-acts");
  buttons.forEach(({ txt, cls, fn }) => { const b = document.createElement("button"); b.className = "mini-btn " + (cls || ""); b.innerHTML = txt; b.onclick = fn; acts.appendChild(b); });
  return row;
}
function renderContacts() {
  if (!$("reqList")) return;
  const inc = $("reqList"); inc.innerHTML = "";
  incomingReqs.forEach(({ login, name }) => inc.appendChild(contactRow(login, name, [
    { txt: "✓", cls: "ok", fn: () => friendAction(login, "accept") },
    { txt: "✕", cls: "no", fn: () => friendAction(login, "decline") },
  ])));
  $("reqEmpty").classList.toggle("hidden", incomingReqs.length > 0);
  const fr = $("friendsListEl"); fr.innerHTML = "";
  friendsList.forEach(({ login, name }) => fr.appendChild(contactRow(login, name, [
    { txt: window.ICON.send, fn: () => { $("contactsModal").classList.add("hidden"); openDM(login, name); } },
    { txt: "✕", cls: "no", fn: () => friendAction(login, "remove") },
  ])));
  const sent = $("sentList"); sent.innerHTML = "";
  outgoingReqs.forEach(({ login, name }) => sent.appendChild(contactRow(login, name, [
    { txt: t("pending"), cls: "ghost", fn: () => friendAction(login, "remove") },
  ])));
}

// Сообщение заблокировано (нужна дружба/общая группа)
socket.on("dm-blocked", () => { notify(t("dm_need_friend")); loadRelations(); });

// ====================== ПРИСУТСТВИЕ (статусы) ======================
function updateDots() {
  document.querySelectorAll(".st-dot[data-login]").forEach((el) => {
    const st = el.dataset.login === profile.login ? (myStatus === "invisible" ? "offline" : myStatus) : (presence.get(el.dataset.login) || "offline");
    el.className = "st-dot st-" + st;
  });
}
async function refreshPresence() {
  const set = new Set();
  for (const c of chats.values()) if (c.type === "dm" && c.login) set.add(c.login);
  for (const [, info] of peers) if (info.login) set.add(info.login);
  friendsList.concat(incomingReqs, outgoingReqs).forEach((x) => set.add(x.login));
  set.delete(profile.login);
  if (!set.size) { updateDots(); return; }
  try {
    const res = await fetch("/api/presence?ids=" + [...set].join(","), { headers: { Authorization: "Bearer " + token } });
    if (res.ok) { const d = await res.json(); for (const k in d) presence.set(k, d[k]); }
  } catch {}
  updateDots();
}
socket.on("presence", ({ login, status }) => { presence.set(login, status); updateDots(); });

async function loadMe() {
  try {
    const res = await fetch("/api/profile/" + encodeURIComponent(profile.login), { headers: { Authorization: "Bearer " + token } });
    if (res.ok) { const c = await res.json(); myStatus = c.status === "offline" ? "invisible" : c.status; myDesc = c.description || ""; updateDots(); }
  } catch {}
}

// ====================== МИНИ-ПРОФИЛЬ ======================
let mpLogin = null;
async function openMiniProfile(login, name) {
  if (!login) return;
  mpLogin = login;
  $("mpAva").innerHTML = `<img src="${avaUrl(login)}" alt="" onerror="this.style.display='none'"><span class="ava-fallback">${initials(name || login)}</span>`;
  $("mpName").textContent = name || login;
  $("mpLogin").textContent = login;
  $("mpStatus").className = "mp-status"; $("mpStatus").textContent = "";
  $("mpDesc").textContent = ""; $("mpJoined").textContent = "";
  $("mpMessage").classList.toggle("hidden", login === profile.login);
  $("mpModal").classList.remove("hidden");
  try {
    const res = await fetch("/api/profile/" + encodeURIComponent(login), { headers: { Authorization: "Bearer " + token } });
    if (!res.ok) return;
    const c = await res.json();
    presence.set(login, c.status);
    $("mpName").textContent = c.name;
    $("mpStatus").className = "mp-status st-" + c.status;
    $("mpStatus").innerHTML = `<span class="st-dot st-${c.status}"></span>${t("status_" + c.status)}`;
    if (c.description) { $("mpDesc").textContent = c.description; $("mpDesc").classList.remove("hidden"); } else $("mpDesc").classList.add("hidden");
    const d = new Date(c.createdAt);
    $("mpJoined").textContent = t("joined", { date: d.toLocaleDateString(window.getLang() === "ru" ? "ru-RU" : "en-GB") });
  } catch {}
}
$("mpCancel").onclick = () => $("mpModal").classList.add("hidden");
$("mpMessage").onclick = () => { $("mpModal").classList.add("hidden"); const name = $("mpName").textContent; openDM(mpLogin, name); };

socket.on("auth-error", (msg) => { alert(msg || "Auth error"); localStorage.removeItem("dialog_token"); location.reload(); });

// --- Соединение + автоперезаход после реконнекта ---
socket.on("connect", () => {
  setConnStatus("online");
  if (token) socket.emit("identify", { token });        // ловить звонки/пинги где угодно
  if (token && myRoom) socket.emit("join", { token, room: myRoom });
});
socket.on("disconnect", () => setConnStatus("offline"));
socket.io.on("reconnect_attempt", () => setConnStatus("connecting"));
function setConnStatus(state) {
  let el = $("connStatus");
  if (!el) { el = document.createElement("div"); el.id = "connStatus"; el.className = "conn-status"; document.body.appendChild(el); }
  if (state === "online") el.classList.remove("show");
  else { el.classList.add("show"); el.textContent = t(state === "connecting" ? "conn_reconnect" : "conn_offline"); }
}

function initials(n) { return (n || "?").trim().charAt(0).toUpperCase(); }

// ====================== УЧАСТНИКИ (инфо-панель) ======================
function renderMembers() {
  const ul = $("members"); if (!ul) return;
  ul.innerHTML = "";
  if (peers.size === 0) { ul.innerHTML = `<li class="member" style="opacity:.5;cursor:default"><span class="m-name">${t("alone")}</span></li>`; return; }
  for (const [, info] of peers) {
    const li = document.createElement("li");
    li.className = "member";
    const isBlk = blocked.has(info.login);
    li.innerHTML = `${avaHTML(info.login, info.name, 30, true)}
      <span class="m-name">${escapeHtml(info.name)}</span>
      <span class="m-acts">
        <button class="m-act" data-act="friend" title="${t("add_friend")}">${window.ICON.userPlus}</button>
        <button class="m-act${isBlk ? " on" : ""}" data-act="block" title="${isBlk ? t("unblock_user") : t("block_user")}">${window.ICON.block}</button>
      </span>`;
    li.onclick = (e) => {
      const act = e.target.closest(".m-act");
      if (act) { e.stopPropagation(); if (act.dataset.act === "friend") friendAction(info.login, "request"); else blockAction(info.login, isBlk ? "remove" : "add"); return; }
      openMiniProfile(info.login, info.name);
    };
    ul.appendChild(li);
  }
  updateDots();
}
socket.on("peers", (list) => { peers.clear(); list.forEach((p) => peers.set(p.id, { name: p.name, login: p.login })); renderMembers(); refreshPresence(); if (curKind === "group") $("chatSub").textContent = t("members_n", { n: peers.size + 1 }); });
socket.on("peer-joined", ({ id, name, login }) => { peers.set(id, { name, login }); renderMembers(); if (myRoom && !isMuted(myRoom)) sfx.join(); if (curKind === "group") $("chatSub").textContent = t("members_n", { n: peers.size + 1 }); });
socket.on("peer-left", ({ id }) => { peers.delete(id); renderMembers(); if (call.pcs.has(id)) removePeerConn(id); if (myRoom && !isMuted(myRoom)) sfx.leave(); if (curKind === "group") $("chatSub").textContent = t("members_n", { n: peers.size + 1 }); });

// ====================== ИСТОРИЯ + ЧАТ ======================
const messagesEl = $("messages");
socket.on("history", (list) => {
  messagesEl.innerHTML = "";
  if (list.length) { const sep = document.createElement("div"); sep.className = "system-msg"; sep.textContent = t("prev_messages"); messagesEl.appendChild(sep); }
  list.forEach((m) => renderMessage(m, false, isPingForMe(m)));
  const last = list[list.length - 1];
  const c = chats.get(myRoom);
  if (c && last) { c.last = preview(last); c.ts = last.ts; renderChatList($("searchInput").value); }
  scrollDown();
  messagesEl.classList.remove("room-anim"); void messagesEl.offsetWidth; messagesEl.classList.add("room-anim");
});
socket.on("system", (data) => {
  const div = document.createElement("div");
  div.className = "system-msg";
  div.textContent = typeof data === "string" ? data : t("sys_" + data.key, { name: data.name });
  messagesEl.appendChild(div); scrollDown();
});
socket.on("message", (m) => {
  const ping = isPingForMe(m);
  renderMessage(m, true, ping);
  const c = chats.get(myRoom);
  if (c) { c.last = preview(m); c.ts = m.ts; if (c.type === "dm") persistDMs(); renderChatList($("searchInput").value); }
  const mine = profile && m.fromLogin === profile.login;
  if (!mine) { if (ping) sfx.call(); else if (!isMuted(myRoom)) sfx.msg(); }
});
function isPingForMe(m) {
  if (m.type !== "text" || !profile) return false;
  const txt = (m.text || "").toLowerCase();
  return txt.includes("@" + profile.login.toLowerCase()) || (profile.name && txt.includes("@" + profile.name.toLowerCase()));
}
function highlightMentions(html) {
  return html.replace(/@([\w.Ѐ-ӿ]+)/g, (full, name) => {
    const me = profile && (name.toLowerCase() === profile.login.toLowerCase() || name.toLowerCase() === (profile.name || "").toLowerCase());
    return `<span class="mention${me ? " me" : ""}">${full}</span>`;
  });
}
function renderMessage(m, scroll = true, ping = false) {
  const mine = profile && m.fromLogin === profile.login;
  const isBlocked = !mine && m.fromLogin && blocked.has(m.fromLogin);
  const wrap = document.createElement("div");
  wrap.className = "msg" + (mine ? " me" : "") + (ping ? " ping" : "") + (isBlocked ? " blocked" : "");
  if (isBlocked) wrap.dataset.blocklabel = t("blocked_msg");
  let inner = "";
  if (!mine && curKind === "group") inner += `<div class="who">${escapeHtml(m.name)}</div>`;
  if (m.type === "text") inner += `<div class="bubble">${highlightMentions(linkify(escapeHtml(m.text)))}</div>`;
  else if (m.type === "image" || m.type === "gif") inner += `<div class="bubble media"><img src="${m.media}" alt="${escapeHtml(m.mediaName)}" /></div>`;
  else if (m.type === "video") inner += `<div class="bubble media"><video src="${m.media}" controls></video></div>`;
  else if (m.type === "audio") inner += `<div class="bubble audio">🎤 <audio controls src="${m.media}"></audio></div>`;
  inner += `<div class="time">${fmtTime(m.ts)}</div>`;
  wrap.innerHTML = inner;
  messagesEl.appendChild(wrap);
  if (scroll) scrollDown();
}

function sendText() {
  const input = $("msgInput");
  const text = input.value.trim();
  if (!text || !myRoom) return;
  socket.emit("message", { type: "text", text });
  input.value = ""; input.style.height = "auto";
  socket.emit("typing", false);
}
$("sendBtn").onclick = sendText;
$("msgInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendText(); } });
let typingTimer;
$("msgInput").addEventListener("input", (e) => {
  e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
  socket.emit("typing", true);
  clearTimeout(typingTimer); typingTimer = setTimeout(() => socket.emit("typing", false), 1500);
});
const typingUsers = new Set();
socket.on("typing", ({ name, isTyping }) => {
  if (isTyping) typingUsers.add(name); else typingUsers.delete(name);
  const arr = [...typingUsers];
  $("typingIndicator").textContent = arr.length ? (arr.length === 1 ? t("typing_one", { name: arr[0] }) : t("typing_many", { names: arr.join(", ") })) : "";
});

// ====================== МЕДИА ======================
$("attachBtn").onclick = () => $("fileInput").click();
$("fileInput").addEventListener("change", (e) => {
  const file = e.target.files[0]; if (!file || !myRoom) return;
  if (file.size > 20 * 1024 * 1024) { alert(t("file_too_big")); return; }
  const reader = new FileReader();
  reader.onload = () => {
    let type = "file";
    if (file.type.startsWith("image/")) type = file.type === "image/gif" ? "gif" : "image";
    else if (file.type.startsWith("video/")) type = "video";
    socket.emit("message", { type, media: reader.result, mediaName: file.name });
  };
  reader.readAsDataURL(file); e.target.value = "";
});

// --- Голосовые ---
let mediaRecorder = null, recChunks = [], recStream = null, recTimer = null;
$("voiceBtn").onclick = async () => {
  if (!myRoom) return;
  if (mediaRecorder && mediaRecorder.state === "recording") { mediaRecorder.stop(); return; }
  try { recStream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { alert(t("err_mic_voice")); return; }
  recChunks = [];
  mediaRecorder = new MediaRecorder(recStream);
  mediaRecorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    recStream.getTracks().forEach((tr) => tr.stop()); clearInterval(recTimer);
    const blob = new Blob(recChunks, { type: mediaRecorder.mimeType || "audio/webm" });
    resetVoiceBtn();
    if (blob.size < 600) return;
    if (blob.size > 20 * 1024 * 1024) { alert(t("file_too_big")); return; }
    const reader = new FileReader();
    reader.onload = () => socket.emit("message", { type: "audio", media: reader.result, mediaName: "voice" });
    reader.readAsDataURL(blob);
  };
  mediaRecorder.start();
  let sec = 0;
  $("voiceBtn").classList.add("recording"); $("voiceBtn").innerHTML = window.ICON.stop;
  recTimer = setInterval(() => { sec++; $("voiceBtn").title = sec + "s"; if (sec >= 120) mediaRecorder.stop(); }, 1000);
};
function resetVoiceBtn() { $("voiceBtn").classList.remove("recording"); $("voiceBtn").innerHTML = window.ICON.mic; $("voiceBtn").title = t("t_voice"); mediaRecorder = null; }

// --- Лайтбокс ---
const lb = $("lightbox"), lbImg = $("lightboxImg");
let lbScale = 1, lbX = 0, lbY = 0, lbDrag = null;
function applyLb() { lbImg.style.transform = `translate(${lbX}px,${lbY}px) scale(${lbScale})`; }
function openLightbox(src) { lbImg.src = src; lbScale = 1; lbX = 0; lbY = 0; applyLb(); lb.classList.remove("hidden"); }
function closeLightbox() { lb.classList.add("hidden"); lbImg.src = ""; }
messagesEl.addEventListener("click", (e) => {
  const bl = e.target.closest(".msg.blocked:not(.revealed)");
  if (bl) { bl.classList.add("revealed"); return; }
  const img = e.target.closest(".bubble.media img");
  if (img) openLightbox(img.src);
});
lb.addEventListener("click", (e) => { if (e.target === lb) closeLightbox(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLightbox(); });
lbImg.addEventListener("wheel", (e) => { e.preventDefault(); lbScale = Math.min(8, Math.max(1, lbScale + (e.deltaY < 0 ? 0.25 : -0.25))); if (lbScale === 1) { lbX = 0; lbY = 0; } applyLb(); }, { passive: false });
lbImg.addEventListener("dblclick", () => { lbScale = lbScale > 1 ? 1 : 2.5; lbX = 0; lbY = 0; applyLb(); });
lbImg.addEventListener("pointerdown", (e) => { if (lbScale <= 1) return; lbDrag = { x: e.clientX - lbX, y: e.clientY - lbY }; lbImg.setPointerCapture(e.pointerId); });
lbImg.addEventListener("pointermove", (e) => { if (!lbDrag) return; lbX = e.clientX - lbDrag.x; lbY = e.clientY - lbDrag.y; applyLb(); });
lbImg.addEventListener("pointerup", () => (lbDrag = null));

// ====================== ЭМОДЗИ ======================
const picker = $("emojiPicker");
function buildPicker() {
  const tabs = $("emojiTabs"), grid = $("emojiGrid");
  const cats = Object.keys(window.EMOJI);
  cats.forEach((icon, i) => {
    const b = document.createElement("button");
    b.className = "emoji-tab" + (i === 0 ? " active" : "");
    b.textContent = icon;
    b.onclick = () => { showCat(icon); [...tabs.children].forEach((t) => t.classList.remove("active")); b.classList.add("active"); };
    tabs.appendChild(b);
  });
  showCat(cats[0]);
  function showCat(icon) {
    grid.innerHTML = "";
    const seg = [...new Intl.Segmenter().segment(window.EMOJI[icon])].map((s) => s.segment).filter((s) => /\p{Emoji}/u.test(s) && s.trim());
    seg.forEach((em) => { const btn = document.createElement("button"); btn.textContent = em; btn.onclick = () => insertEmoji(em); grid.appendChild(btn); });
  }
}
function insertEmoji(em) {
  const input = $("msgInput");
  const s = input.selectionStart || input.value.length;
  input.value = input.value.slice(0, s) + em + input.value.slice(input.selectionEnd || s);
  input.focus(); input.selectionStart = input.selectionEnd = s + em.length;
}
$("emojiBtn").onclick = (e) => { e.stopPropagation(); $("gifPanel").classList.add("hidden"); picker.classList.toggle("hidden"); };
document.addEventListener("click", (e) => { if (!picker.contains(e.target) && e.target !== $("emojiBtn")) picker.classList.add("hidden"); });
buildPicker();

// ====================== GIF (Tenor) ======================
const gifPanel = $("gifPanel");
let gifTimer;
$("gifBtn").onclick = (e) => {
  e.stopPropagation();
  picker.classList.add("hidden");
  const willShow = gifPanel.classList.contains("hidden");
  gifPanel.classList.toggle("hidden");
  if (willShow) { loadGifs(""); $("gifSearch").focus(); }
};
$("gifSearch").addEventListener("input", (e) => { clearTimeout(gifTimer); gifTimer = setTimeout(() => loadGifs(e.target.value.trim()), 400); });
async function loadGifs(q) {
  const grid = $("gifGrid");
  try {
    const res = await fetch("/api/gif?q=" + encodeURIComponent(q), { headers: { Authorization: "Bearer " + token } });
    const d = await res.json();
    $("gifNote").classList.toggle("hidden", !d.nokey);
    grid.innerHTML = "";
    (d.results || []).forEach((g) => {
      const img = document.createElement("img");
      img.src = g.preview; img.className = "gif-item"; img.loading = "lazy";
      img.onclick = () => { if (!myRoom) return; socket.emit("message", { type: "gif", media: g.url, mediaName: "gif" }); gifPanel.classList.add("hidden"); };
      grid.appendChild(img);
    });
  } catch {}
}
document.addEventListener("click", (e) => { if (!gifPanel.contains(e.target) && e.target !== $("gifBtn")) gifPanel.classList.add("hidden"); });

// Пустой экран — быстрые действия для новичка
$("emptyAddFriend").onclick = () => $("contactsBtn").click();
$("emptyNewChat").onclick = () => $("newChatBtn").click();

// ====================== ЗВОНКИ (mesh WebRTC) ======================
const call = { active: false, localStream: null, screenStream: null, sharing: false, micOn: true, camOn: false, pcs: new Map() };

const NS_AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const LOW_VIDEO = { width: { ideal: 640, max: 640 }, height: { ideal: 360, max: 360 }, frameRate: { ideal: 20, max: 24 } };
async function getLocalStream() {
  if (call.localStream) return call.localStream;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { const err = new Error("INSECURE"); err.name = "InsecureContext"; throw err; }
  // Сначала только аудио — видео добавим при включении камеры
  try { call.localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: NS_AUDIO }); }
  catch (e) { throw e; }
  call.ns = true;
  call.camOn = false;
  addTile("me", myName + " " + t("you_suffix"), call.localStream, true);
  setTileAvatar("me", true);
  return call.localStream;
}
function capBitrate(pc, kind, maxBps) {
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== kind) continue;
    try {
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = maxBps;
      sender.setParameters(p).catch(() => {});
    } catch {}
  }
}
function mediaErrorMessage(e) {
  if (!navigator.mediaDevices || e.name === "InsecureContext") return t("err_insecure");
  switch (e.name) {
    case "NotAllowedError": return t("err_denied");
    case "NotFoundError": return t("err_notfound");
    case "NotReadableError": return t("err_inuse");
    default: return t("err_media") + (e.name || e.message);
  }
}
function ensurePeer(peerId, peerName) {
  let st = call.pcs.get(peerId);
  if (st) { if (peerName) st.name = peerName; return st; }
  const pc = new RTCPeerConnection(ICE);
  st = { pc, name: peerName || (peers.get(peerId) || {}).name || "Peer", makingOffer: false, ignoreOffer: false, polite: socket.id < peerId, vol: 1, muted: false };
  call.pcs.set(peerId, st);
  if (call.localStream) call.localStream.getTracks().forEach((tr) => pc.addTrack(tr, call.localStream));
  pc.onnegotiationneeded = async () => {
    try {
      st.makingOffer = true; await pc.setLocalDescription(); socket.emit("signal", { to: peerId, kind: "desc", data: pc.localDescription });
      capBitrate(pc, "audio", 32000);   // 32 kbps аудио — Opus и так эффективен
      capBitrate(pc, "video", 250000);  // 250 kbps видео — достаточно для 360p
    } catch (e) { console.error("negotiation", e); } finally { st.makingOffer = false; }
  };
  pc.onicecandidate = (e) => { if (e.candidate) socket.emit("signal", { to: peerId, kind: "ice", data: e.candidate }); };
  pc.ontrack = (e) => {
    if (e.track.kind === "audio") {
      addTile(peerId, st.name, e.streams[0], false);
      return;
    }
    st.vtracks = (st.vtracks || 0) + 1;
    if (st.vtracks === 1) {
      const tile = addTile(peerId, st.name, e.streams[0], false);
      const v = tile.querySelector("video");
      v.srcObject = e.streams[0];
      v.play().catch(() => {});
      setupVideoDetect(peerId, e.track);
    } else {
      addScreenTile(peerId, st.name, e.streams[0]);
      e.track.onended = () => { removeTile("screen-" + peerId); st.vtracks = Math.max(1, st.vtracks - 1); };
    }
  };
  pc.onconnectionstatechange = () => {
    updateCallStatus();
    if (pc.connectionState === "failed") { pc.restartIce(); }
    else if (pc.connectionState === "closed") { removePeerConn(peerId); }
  };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === "disconnected") setTimeout(() => { if (pc.iceConnectionState === "disconnected") pc.restartIce(); }, 3000);
  };
  updateCallCount();
  return st;
}
// Статус звонка: подключение / подключено / отключение
function updateCallStatus() {
  const el = $("callStatus");
  if (!el || !call.active) return;
  const states = [...call.pcs.values()].map((s) => s.pc.connectionState);
  let key = "call_waiting";
  if (states.length) {
    if (states.some((s) => s === "connected")) key = "call_connected";
    else if (states.some((s) => s === "disconnected" || s === "failed")) key = "call_disconnected";
    else key = "call_connecting";
  }
  el.textContent = t(key);
  el.className = "call-status " + (key === "call_connected" ? "ok" : key === "call_disconnected" ? "bad" : "");
}
function removePeerConn(peerId) {
  const st = call.pcs.get(peerId);
  if (st) { try { st.pc.close(); } catch {} try { st.audioSrc?.disconnect(); st.gain?.disconnect(); } catch {} call.pcs.delete(peerId); }
  removeTile(peerId); updateCallCount();
}
$("startCallBtn").onclick = () => { if (!myRoom) return; call.active ? endCall() : joinCall(); };
async function joinCall() {
  ensureAudioCtx();
  try { await getLocalStream(); } catch (e) { if (!confirm(mediaErrorMessage(e) + t("viewer_join"))) return; }
  call.active = true;
  $("callOverlay").classList.remove("hidden");
  $("startCallBtn").classList.add("in-call");
  hideToast(); updateCallCount();
  $("toggleCam").classList.toggle("off", !call.camOn);
  $("toggleMic").classList.toggle("off", !call.micOn);
  $("toggleNoise").classList.toggle("active", call.ns);
  updateCallStatus();
  socket.emit("call-invite", { title: curTitle });
}
function endCall() {
  for (const id of [...call.pcs.keys()]) removePeerConn(id);
  if (call.localStream) { call.localStream.getTracks().forEach((tr) => tr.stop()); call.localStream = null; }
  if (call.screenStream) { call.screenStream.getTracks().forEach((tr) => tr.stop()); call.screenStream = null; }
  $("videoGrid").innerHTML = "";
  $("callOverlay").classList.add("hidden"); $("callOverlay").classList.remove("windowed"); $("callOverlay").style.cssText = "";
  $("startCallBtn").classList.remove("in-call");
  Object.assign(call, { active: false, sharing: false, micOn: true, camOn: false, ns: true });
  $("toggleMic").classList.remove("off"); $("toggleCam").classList.remove("off"); $("shareScreen").classList.remove("active");
  $("toggleNoise").classList.remove("active");
  $("toggleMic").innerHTML = window.ICON.mic; $("toggleCam").innerHTML = window.ICON.camera;
  $("callStatus").textContent = "";
}
// Шумодав (подавление шума браузером) — вкл/выкл
$("toggleNoise").onclick = async () => {
  if (!call.localStream) return;
  call.ns = !call.ns;
  $("toggleNoise").classList.toggle("active", call.ns);
  try {
    for (const tr of call.localStream.getAudioTracks())
      await tr.applyConstraints({ echoCancellation: call.ns, noiseSuppression: call.ns, autoGainControl: call.ns });
  } catch {}
};
$("hangUp").onclick = endCall;

socket.on("call-invite", ({ from, name }) => { if (call.active) ensurePeer(from, name); else showToast(from, name); });
socket.on("call-ring", (p) => {
  if (call.active || myRoom === p.room) return;
  const kind = p.room.startsWith("@grp:") ? "group" : "dm";
  showToast(p.from, p.name, { room: p.room, title: p.title, kind });
});
socket.on("signal", async ({ from, name, kind, data }) => {
  if (!call.active) return;
  const st = ensurePeer(from, name); const pc = st.pc;
  if (!st.iceBuf) st.iceBuf = [];
  try {
    if (kind === "desc") {
      const offerCollision = data.type === "offer" && (st.makingOffer || pc.signalingState !== "stable");
      st.ignoreOffer = !st.polite && offerCollision;
      if (st.ignoreOffer) return;
      await pc.setRemoteDescription(data);
      if (data.type === "offer") { await pc.setLocalDescription(); socket.emit("signal", { to: from, kind: "desc", data: pc.localDescription }); }
      for (const c of st.iceBuf) { try { await pc.addIceCandidate(c); } catch {} }
      st.iceBuf = [];
    } else if (kind === "ice") {
      if (!pc.remoteDescription) { st.iceBuf.push(data); }
      else { try { await pc.addIceCandidate(data); } catch (e) { if (!st.ignoreOffer) throw e; } }
    }
  } catch (e) { console.error("signal", e); }
});

// --- Тайлы ---
function addTile(id, name, stream, isMe) {
  let tile = $("tile-" + id);
  if (!tile) {
    tile = document.createElement("div");
    tile.id = "tile-" + id; tile.className = "tile show-avatar" + (isMe ? " me" : "");
    const avLogin = isMe ? profile.login : ((peers.get(id) || {}).login || "");
    tile.innerHTML =
      `<video autoplay playsinline ${isMe ? "muted" : ""}></video>` +
      `<div class="tile-avatar">${avLogin ? `<img src="${avaUrl(avLogin)}" alt="" onerror="this.style.display='none'">` : ""}<span>${initials(name)}</span></div>` +
      `<div class="tile-name">${escapeHtml(name)}</div>` +
      (isMe ? "" : `<div class="tile-ctrl"><button class="tctrl-mute" title="${t("mute_user")}">${window.ICON.volume}</button><input class="tctrl-vol" type="range" min="0" max="1" step="0.05" value="1" title="${t("volume")}"></div>`);
    $("videoGrid").appendChild(tile);
    if (!isMe) wireTileControls(tile, id);
  }
  const v = tile.querySelector("video");
  v.srcObject = stream;
  if (!isMe) { v.muted = false; v.play().catch(() => {}); } // звук собеседника играет через сам элемент
  updateCallCount();
  return tile;
}
function removeTile(id) { const tile = $("tile-" + id); if (tile) tile.remove(); }
function setTileAvatar(id, show) { const tile = $("tile-" + id); if (tile) tile.classList.toggle("show-avatar", show); }
function setupVideoDetect(peerId, track) { const apply = () => setTileAvatar(peerId, track.muted); track.onmute = apply; track.onunmute = apply; apply(); }
function setupAudioGain(peerId, stream) {
  const st = call.pcs.get(peerId); if (!st || st.gain) return;
  const ctx = ensureAudioCtx(); if (!ctx) return;
  try {
    const src = ctx.createMediaStreamSource(stream); const gain = ctx.createGain();
    gain.gain.value = st.muted ? 0 : st.vol; src.connect(gain); gain.connect(ctx.destination);
    st.gain = gain; st.audioSrc = src;
    const tile = $("tile-" + peerId); if (tile) tile.querySelector("video").muted = true;
  } catch (e) { console.error("audio gain", e); }
}
function wireTileControls(tile, peerId) {
  const muteBtn = tile.querySelector(".tctrl-mute"), vol = tile.querySelector(".tctrl-vol");
  const applyVol = () => {
    const st = call.pcs.get(peerId); if (!st) return;
    const v = st.muted ? 0 : st.vol;
    if (st.gain) st.gain.gain.value = v; else { const vid = tile.querySelector("video"); vid.muted = st.muted; vid.volume = Math.min(1, st.vol); }
  };
  vol.oninput = () => { const st = call.pcs.get(peerId); if (!st) return; st.vol = parseFloat(vol.value); if (st.muted) { st.muted = false; muteBtn.innerHTML = window.ICON.volume; muteBtn.classList.remove("muted"); } applyVol(); };
  muteBtn.onclick = () => { const st = call.pcs.get(peerId); if (!st) return; st.muted = !st.muted; muteBtn.innerHTML = st.muted ? window.ICON.volumeMute : window.ICON.volume; muteBtn.classList.toggle("muted", st.muted); applyVol(); };
}
function updateCallCount() { $("callCount").textContent = (call.active ? 1 : 0) + call.pcs.size; }

$("toggleMic").onclick = () => { if (!call.localStream) return; call.micOn = !call.micOn; call.localStream.getAudioTracks().forEach((tr) => (tr.enabled = call.micOn)); $("toggleMic").classList.toggle("off", !call.micOn); $("toggleMic").innerHTML = window.ICON[call.micOn ? "mic" : "micOff"]; };
$("toggleCam").onclick = async () => {
  if (!call.localStream) return;
  call.camOn = !call.camOn;
  if (call.camOn) {
    // Камера вкл — запрашиваем видео-трек только когда нужен
    const vTracks = call.localStream.getVideoTracks();
    if (!vTracks.length) {
      try {
        const vs = await navigator.mediaDevices.getUserMedia({ video: LOW_VIDEO, audio: false });
        const vt = vs.getVideoTracks()[0];
        call.localStream.addTrack(vt);
        for (const st of call.pcs.values()) { st.pc.addTrack(vt, call.localStream); capBitrate(st.pc, "video", 250000); }
      } catch { call.camOn = false; }
    } else { vTracks.forEach((tr) => (tr.enabled = true)); }
  } else {
    call.localStream.getVideoTracks().forEach((tr) => (tr.enabled = false));
  }
  $("toggleCam").classList.toggle("off", !call.camOn); $("toggleCam").innerHTML = window.ICON[call.camOn ? "camera" : "cameraOff"];
  if (!call.sharing) setTileAvatar("me", !call.camOn);
};

// Отдельный тайл для демонстрации экрана (свой и чужой)
function addScreenTile(id, name, stream) {
  let tile = $("tile-screen-" + id);
  if (!tile) {
    tile = document.createElement("div");
    tile.id = "tile-screen-" + id; tile.className = "tile screen";
    tile.innerHTML = `<video autoplay playsinline ${id === "me" ? "muted" : ""}></video><div class="tile-name">🖥 ${escapeHtml(name)}</div>`;
    $("videoGrid").appendChild(tile);
  }
  const v = tile.querySelector("video");
  v.srcObject = stream; if (id !== "me") { v.muted = false; } v.play().catch(() => {});
  updateCallCount();
}
$("shareScreen").onclick = async () => {
  if (!call.active) return;
  if (call.sharing) { await stopShare(); return; }
  try { call.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false }); } catch { return; }
  const track = call.screenStream.getVideoTracks()[0];
  for (const st of call.pcs.values()) {
    st.screenSender = st.pc.addTrack(track, call.screenStream);
    // screen share — 500 kbps макс (достаточно для текста/слайдов при 10fps)
    try {
      const p = st.screenSender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = 1500000;
      st.screenSender.setParameters(p).catch(() => {});
    } catch {}
  }
  addScreenTile("me", myName + " " + t("you_suffix"), call.screenStream);
  call.sharing = true; $("shareScreen").classList.add("active");
  socket.emit("screen", { on: true });
  track.onended = () => stopShare();
};
async function stopShare() {
  if (call.screenStream) { call.screenStream.getTracks().forEach((tr) => tr.stop()); call.screenStream = null; }
  for (const st of call.pcs.values()) { if (st.screenSender) { try { st.pc.removeTrack(st.screenSender); } catch {} st.screenSender = null; } }
  removeTile("screen-me");
  call.sharing = false; $("shareScreen").classList.remove("active");
  socket.emit("screen", { on: false });
}
// Партнёр прекратил демонстрацию — убираем его тайл-скрин
socket.on("screen", ({ from, on }) => {
  if (!on) { removeTile("screen-" + from); const st = call.pcs.get(from); if (st && st.vtracks) st.vtracks = Math.max(1, st.vtracks - 1); }
});

// --- Окно звонка (ПК) ---
$("windowToggle").onclick = () => {
  const o = $("callOverlay"); const win = o.classList.toggle("windowed");
  if (win) { o.style.left = ""; o.style.top = ""; o.style.right = "24px"; o.style.bottom = "24px"; }
  else { o.style.left = o.style.top = o.style.right = o.style.bottom = o.style.width = o.style.height = ""; }
};
let dragState = null;
$("callTopbar").addEventListener("pointerdown", (e) => {
  const o = $("callOverlay"); if (!o.classList.contains("windowed") || e.target.closest("button")) return;
  const r = o.getBoundingClientRect(); dragState = { dx: e.clientX - r.left, dy: e.clientY - r.top }; $("callTopbar").setPointerCapture(e.pointerId);
});
$("callTopbar").addEventListener("pointermove", (e) => {
  if (!dragState) return; const o = $("callOverlay");
  let x = Math.max(0, Math.min(window.innerWidth - o.offsetWidth, e.clientX - dragState.dx));
  let y = Math.max(0, Math.min(window.innerHeight - o.offsetHeight, e.clientY - dragState.dy));
  o.style.left = x + "px"; o.style.top = y + "px"; o.style.right = "auto"; o.style.bottom = "auto";
});
$("callTopbar").addEventListener("pointerup", () => (dragState = null));

// --- Рингтон + cava ---
const ring = { audio: null, src: null, analyser: null, raf: 0, data: null, bars: [] };
function startRingtone() {
  const ctx = ensureAudioCtx();
  if (!ring.audio) ring.audio = new Audio("/src/Ringtone.mp3");
  ring.audio.loop = true; ring.audio.currentTime = 0;
  const p = ring.audio.play(); if (p && p.catch) p.catch(() => {});
  if (ctx && !ring.analyser) {
    try {
      ring.src = ctx.createMediaElementSource(ring.audio); ring.analyser = ctx.createAnalyser(); ring.analyser.fftSize = 128;
      ring.src.connect(ring.analyser); ring.analyser.connect(ctx.destination); ring.data = new Uint8Array(ring.analyser.frequencyBinCount);
    } catch {}
  }
  startCava();
}
function stopRingtone() { if (ring.audio) ring.audio.pause(); stopCava(); }
function startCava() {
  const canvas = $("cavaCanvas"), toast = $("callToast"); if (!canvas) return;
  const cx = canvas.getContext("2d"); const N = 30;
  if (ring.bars.length !== N) ring.bars = new Array(N).fill(0);
  cancelAnimationFrame(ring.raf);
  const frame = () => {
    ring.raf = requestAnimationFrame(frame);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = toast.clientWidth * dpr; canvas.height = toast.clientHeight * dpr;
    const w = canvas.width, h = canvas.height; cx.clearRect(0, 0, w, h);
    if (ring.analyser) ring.analyser.getByteFrequencyData(ring.data);
    const bw = w / N;
    for (let i = 0; i < N; i++) {
      let target;
      if (ring.analyser) { const idx = Math.floor((i / N) * ring.data.length * 0.7); target = ring.data[idx] / 255; }
      else target = 0.25 + 0.55 * Math.abs(Math.sin(Date.now() / 180 + i * 0.5));
      ring.bars[i] = Math.max(target, ring.bars[i] * 0.86);
      const bh = Math.max(2 * dpr, ring.bars[i] * h * 0.92);
      const g = cx.createLinearGradient(0, h, 0, h - bh);
      g.addColorStop(0, "rgba(0,255,90,0.12)"); g.addColorStop(1, "rgba(0,255,90,0.65)");
      cx.fillStyle = g; cx.fillRect(i * bw + bw * 0.12, h - bh, bw * 0.76, bh);
    }
  };
  frame();
}
function stopCava() { cancelAnimationFrame(ring.raf); ring.raf = 0; const c = $("cavaCanvas"); if (c) { const cx = c.getContext("2d"); cx && cx.clearRect(0, 0, c.width, c.height); } }

// --- Тост входящего звонка ---
let toastTimer, pendingCall = null;
function showToast(from, name, ctx) {
  pendingCall = ctx || null;
  $("toastName").textContent = name;
  $("toastAvatar").textContent = initials(name);
  const sub = $("callToast").querySelector(".toast-sub");
  if (sub) sub.textContent = ctx ? t("call_in", { title: ctx.title }) : t("toast_started");
  $("callToast").classList.remove("hidden");
  startRingtone();
  clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, 60000);
}
function hideToast() { clearTimeout(toastTimer); pendingCall = null; $("callToast").classList.add("hidden"); stopRingtone(); }
$("toastJoin").onclick = () => {
  const pc = pendingCall;
  if (pc && pc.room !== myRoom) { hideToast(); openChat({ key: pc.room, type: pc.kind, login: pc.kind === "dm" ? pc.room.slice(4).split("~").find((l) => l !== profile.login) : undefined, id: pc.kind === "group" ? pc.room.slice(5) : undefined, name: pc.title, last: "", ts: Date.now(), unread: 0 }); setTimeout(joinCall, 500); }
  else joinCall();
};
$("toastClose").onclick = hideToast;

// ====================== УТИЛИТЫ ======================
function scrollDown() { messagesEl.scrollTop = messagesEl.scrollHeight; }
function fmtTime(ts) { return new Date(ts).toLocaleTimeString(window.getLang() === "ru" ? "ru-RU" : "en-GB", { hour: "2-digit", minute: "2-digit" }); }
function escapeHtml(s) { return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function linkify(s) { return s.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color:#7dffaf">$1</a>'); }

// ====================== ИКОНКИ ======================
function setIcons() {
  const map = {
    emojiBtn: "emoji", attachBtn: "attach", voiceBtn: "mic", sendBtn: "send",
    muteBtn: "bell", startCallBtn: "phone", infoBtn: "info", backBtnMobile: "back",
    newChatBtn: "edit", profileBtn: "settings", contactsBtn: "users",
    toggleMic: "mic", toggleCam: "camera", shareScreen: "monitor", hangUp: "phoneOff", toggleNoise: "shield",
    windowToggle: "window", newChatCancel: "close", profileCancel: "close",
    toastClose: "close", infoClose: "close", contactsCancel: "close", mpCancel: "close",
  };
  for (const [id, name] of Object.entries(map)) { const el = $(id); if (el && window.ICON[name]) el.innerHTML = window.ICON[name]; }
}

// ====================== СТАРТ ======================
initLang();
setIcons();
checkSession();
