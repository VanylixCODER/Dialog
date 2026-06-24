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
const sfx = { msg: () => beep(660, 0.12), call: () => beep(880, 0.18) };
document.addEventListener("pointerdown", ensureAudioCtx, { once: true });

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
  $("myName").textContent = myName; setMyAvatar();
  socket.emit("identify", { token });
  loadStoredChats(); loadGroups(); loadRelations(); renderChatList();
  refreshPresence(); if (!window._presInt) window._presInt = setInterval(refreshPresence, 25000);
  initPush();
}
socket.on("connect", () => {
  if (!token) return;
  socket.emit("identify", { token });
  if (myRoom) socket.emit("join", { token, room: myRoom });
  // восстановление звонка после реконнекта: socket.id новый — пересоздаём пиров
  if (call.active) { for (const id of [...call.pcs.keys()]) removePeerConn(id); setTimeout(() => socket.emit("call-join", { title: curTitle }), 300); }
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
function renderChatList(filter = "") {
  const ul = $("chatList"); ul.innerHTML = ""; filter = filter.toLowerCase();
  const list = [...chats.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  let shown = 0;
  for (const c of list) {
    if (filter && !(c.name || "").toLowerCase().includes(filter)) continue;
    shown++;
    const li = document.createElement("li");
    li.className = "chat-item" + (c.key === activeKey ? " active" : "");
    const dot = c.type === "dm" ? `<span class="st-dot ci-status st-${(presence.get(c.login) || "offline") === "online" ? "online" : (presence.get(c.login) === "dnd" ? "dnd" : "offline")}"></span>` : "";
    li.innerHTML = `<div class="avatar ${c.type === "group" ? "grp" : ""}">${c.type === "group" ? "#" : `<img src="${avaUrl(c.login)}" onerror="this.remove()">${initials(c.name)}`}${dot}</div>
      <div class="ci-body"><div class="ci-top"><span class="ci-name">${escapeHtml(c.name)}</span><span class="ci-time">${c.ts ? fmtTime(c.ts) : ""}</span></div>
      <div class="ci-bot"><span class="ci-last">${escapeHtml(c.last || "")}</span>${c.unread ? `<span class="badge">${c.unread}</span>` : `<span class="ci-del" title="${t("delete_chat")}">✕</span>`}</div></div>`;
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
  if (call.active) endCall();
  socket.emit("join", { token, room: c.key });
  $("emptyState").classList.add("hidden");
  $("chatHead").classList.remove("hidden"); $("messages").classList.remove("hidden"); $("composer").classList.remove("hidden");
  $("messages").innerHTML = "";
  $("chatTitle").textContent = c.name;
  $("chatSub").textContent = c.type === "group" ? t("room_sub_group") : t("room_sub_dm");
  $("chatAva").className = "avatar ch-ava" + (c.type === "group" ? " grp" : "");
  $("chatAva").innerHTML = c.type === "group" ? "#" : `<img src="${avaUrl(c.login)}" onerror="this.remove()">${initials(c.name)}`;
  $("muteBtn").innerHTML = isMuted(c.key) ? window.ICON.bellOff : window.ICON.bell;
  $("app").classList.add("in-chat");
  renderChatList($("searchInput").value);
}
$("backBtnMobile").onclick = () => { $("app").classList.remove("in-chat"); activeKey = ""; renderChatList($("searchInput").value); };
$("muteBtn").onclick = () => { if (!myRoom) return; toggleMute(myRoom); $("muteBtn").innerHTML = isMuted(myRoom) ? window.ICON.bellOff : window.ICON.bell; };
$("infoBtn").onclick = () => { if (!myRoom) return; renderMembers(); $("infoTitle").textContent = t("info"); $("infoPanel").classList.toggle("hidden"); };
$("infoClose").onclick = () => $("infoPanel").classList.add("hidden");

// ---------- Аватары ----------
function avaUrl(login) { return "/api/avatar/" + encodeURIComponent(login || "") + "?v=" + avaVer; }
function initials(n) { return (n || "?").trim().charAt(0).toUpperCase(); }
function setMyAvatar() { const a = $("myAvatar"); a.innerHTML = `<img src="${avaUrl(profile.login)}" onerror="this.remove()">${initials(myName)}`; }

// ---------- Новый чат ----------
$("newChatBtn").onclick = () => { $("newChatModal").classList.remove("hidden"); $("dmError").textContent = ""; renderFriendChips(); };
$("newChatCancel").onclick = () => $("newChatModal").classList.add("hidden");
$("emptyNewChat").onclick = () => $("newChatBtn").click();
$("emptyAddFriend").onclick = () => $("contactsBtn").click();
function renderFriendChips() {
  const box = $("friendsQuick"); box.innerHTML = "";
  relations.friends.forEach((l) => { const b = document.createElement("button"); b.className = "room-chip"; b.textContent = l; b.onclick = () => openDM(l); box.appendChild(b); });
}
async function openDM(login) {
  login = (login || $("dmInput").value).trim().toLowerCase();
  if (!login || login === profile.login) { $("dmError").textContent = t("err_user_not_found"); return; }
  const { ok, data } = await api("/api/user/" + login, null, "GET");
  if (!ok) { $("dmError").textContent = t("err_user_not_found"); return; }
  $("newChatModal").classList.add("hidden"); $("dmInput").value = "";
  openChat({ key: dmKey(login), type: "dm", login, name: data.name || login, last: "", ts: Date.now(), unread: 0 });
  persistDMs();
}
$("dmOpenBtn").onclick = () => openDM();
$("createGroupBtn").onclick = async () => {
  const name = $("groupName").value.trim();
  if (!name) { $("groupError").textContent = t("err_group_name"); return; }
  const { ok, data } = await api("/api/groups", { name, members: $("groupMembers").value });
  if (!ok) { $("groupError").textContent = data.error || "error"; return; }
  $("newChatModal").classList.add("hidden"); $("groupName").value = ""; $("groupMembers").value = "";
  const key = "@grp:" + data.id; chats.set(key, { key, type: "group", id: data.id, name: data.name, last: "", ts: Date.now(), unread: 0 });
  openChat(chats.get(key));
};

// ---------- Профиль ----------
$("profileBtn").onclick = () => {
  $("profileModal").classList.remove("hidden"); $("profileError").textContent = "";
  $("profileLogin").textContent = profile.login; $("profileName").value = myName; $("profileDesc").value = myDesc;
  $("profileAvaImg").src = avaUrl(profile.login); $("profileAvaImg").onerror = () => { $("profileAvaImg").style.display = "none"; $("profileAvaInit").style.display = "block"; };
  $("profileAvaInit").textContent = initials(myName);
  document.querySelectorAll(".status-opt").forEach((x) => x.classList.toggle("active", x.dataset.st === myStatus));
};
$("profileCancel").onclick = () => $("profileModal").classList.add("hidden");
let pendingStatus = "online", pendingAvatar;
document.querySelectorAll(".status-opt").forEach((x) => x.onclick = () => { pendingStatus = x.dataset.st; document.querySelectorAll(".status-opt").forEach((y) => y.classList.toggle("active", y === x)); });
$("avaUploadBtn").onclick = () => $("avaFile").click();
$("avaFile").onchange = (e) => {
  const f = e.target.files[0]; if (!f) return;
  if (f.size > 2 * 1024 * 1024) { $("profileError").textContent = "≤ 2 MB"; return; }
  const r = new FileReader(); r.onload = () => { pendingAvatar = r.result; $("profileAvaImg").src = r.result; $("profileAvaImg").style.display = "block"; $("profileAvaInit").style.display = "none"; }; r.readAsDataURL(f);
};
$("profileSave").onclick = async () => {
  pendingStatus = document.querySelector(".status-opt.active")?.dataset.st || myStatus;
  const body = { name: $("profileName").value.trim(), description: $("profileDesc").value, status: pendingStatus };
  if (pendingAvatar) body.avatar = pendingAvatar;
  const { ok, data } = await api("/api/profile", body);
  if (!ok) { $("profileError").textContent = data.error || "error"; return; }
  profile = data.profile; myName = profile.name; myDesc = body.description; myStatus = pendingStatus; avaVer = Date.now(); pendingAvatar = null;
  presence.set(profile.login, myStatus === "invisible" ? "offline" : myStatus);
  socket.emit("set-status", myStatus);
  $("myName").textContent = myName; setMyAvatar(); $("profileModal").classList.add("hidden"); renderChatList($("searchInput").value);
};
$("logoutBtn").onclick = async () => { await api("/api/logout"); localStorage.removeItem("dialog_token"); location.reload(); };

// ---------- Контакты / друзья ----------
$("contactsBtn").onclick = () => { $("contactsModal").classList.remove("hidden"); $("reqError").textContent = ""; loadRelations(); };
$("contactsCancel").onclick = () => $("contactsModal").classList.add("hidden");
$("reqSendBtn").onclick = async () => {
  const target = $("reqInput").value.trim().toLowerCase();
  if (!target) return;
  const { ok, data } = await api("/api/friend", { target, action: "request" });
  if (!ok) { $("reqError").textContent = data.error || t("err_user_not_found"); return; }
  $("reqInput").value = ""; loadRelations();
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
  if (!$("reqList")) return;
  $("reqList").innerHTML = ""; $("friendsListEl").innerHTML = ""; $("sentList").innerHTML = "";
  $("reqEmpty").classList.toggle("hidden", relations.incoming.length > 0);
  relations.incoming.forEach((l) => $("reqList").appendChild(contactRow(l, [["✓", () => friend(l, "accept")], ["✕", () => friend(l, "decline"), true]])));
  relations.friends.forEach((l) => $("friendsListEl").appendChild(contactRow(l, [[t("dm_open"), () => { $("contactsModal").classList.add("hidden"); openDM(l); }], [t("remove_friend"), () => friend(l, "remove"), true]])));
  relations.sent.forEach((l) => $("sentList").appendChild(contactRow(l, [[t("pending"), () => {}]])));
}
async function friend(target, action) { await api("/api/friend", { target, action }); loadRelations(); }
async function block(target, action) { await api("/api/relations", { target, action }); loadRelations(); }

// ---------- Мини-профиль ----------
async function openMiniProfile(login) {
  if (!login || login === profile.login) return;
  const { ok, data } = await api("/api/profile/" + login, null, "GET");
  if (!ok) return;
  $("mpModal").classList.remove("hidden");
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
function updateDots() { renderChatList($("searchInput").value); }
socket.on("presence", ({ login, status }) => { presence.set(login, status); updateDots(); });
socket.on("relations-changed", () => loadRelations());

// ---------- Участники (инфо-панель) ----------
function renderMembers() {
  const ul = $("members"); if (!ul) return; ul.innerHTML = "";
  if (peers.size === 0) { ul.innerHTML = `<li class="member" style="opacity:.5"><span class="m-name">${t("alone")}</span></li>`; return; }
  for (const [, info] of peers) {
    const li = document.createElement("li"); li.className = "member";
    li.innerHTML = `<div class="avatar" style="width:30px;height:30px;font-size:13px"><img src="${avaUrl(info.login)}" onerror="this.remove()">${initials(info.name)}</div><span class="m-name">${escapeHtml(info.name)}</span>`;
    li.onclick = () => info.login && openMiniProfile(info.login);
    ul.appendChild(li);
  }
}
socket.on("peers", (list) => { peers.clear(); list.forEach((p) => peers.set(p.id, { name: p.name, login: p.login })); });
socket.on("peer-joined", (p) => { peers.set(p.id, { name: p.name, login: p.login }); }); // присутствие в чате (звонок — через call-*)
socket.on("peer-left", (p) => { peers.delete(p.id); });

// ---------- Сообщения ----------
const messagesEl = $("messages");
socket.on("history", (list) => {
  messagesEl.innerHTML = "";
  if (list.length) { const sep = document.createElement("div"); sep.className = "system-msg"; sep.textContent = t("prev_messages"); messagesEl.appendChild(sep); }
  list.forEach((m) => renderMessage(m, false, isPingForMe(m)));
  const last = list[list.length - 1]; const c = chats.get(myRoom);
  if (c && last) { c.last = preview(last); c.ts = last.ts; renderChatList($("searchInput").value); }
  scrollDown();
});
socket.on("message", (m) => {
  const ping = isPingForMe(m);
  if (myRoom === m.room || !m.room) renderMessage(m, true, ping);
  const c = chats.get(myRoom); if (c) { c.last = preview(m); c.ts = m.ts; if (c.type === "dm") persistDMs(); renderChatList($("searchInput").value); }
  const mine = profile && m.fromLogin === profile.login;
  if (!mine && !isDnd()) { if (ping) sfx.call(); else if (!isMuted(myRoom)) sfx.msg(); }
});
socket.on("dm-ping", ({ room, fromLogin, fromName }) => {
  const c = upsertChat({ key: dmKey(fromLogin), type: "dm", login: fromLogin, name: fromName, last: "", ts: Date.now(), unread: 0 });
  c.ts = Date.now();
  if (myRoom !== room) { c.unread = (c.unread || 0) + 1; if (!isMuted(room) && !isDnd()) { sfx.msg(); notify(t("dm_ping", { name: fromName })); } }
  persistDMs(); renderChatList($("searchInput").value);
});
socket.on("dm-blocked", () => notify(t("dm_need_friend")));
function isPingForMe(m) { if (m.type !== "text" || !profile) return false; const x = (m.text || "").toLowerCase(); return x.includes("@" + profile.login.toLowerCase()) || (profile.name && x.includes("@" + profile.name.toLowerCase())); }
function highlightMentions(html) { return html.replace(/@([\w.Ѐ-ӿ]+)/g, (full, name) => { const me = profile && (name.toLowerCase() === profile.login.toLowerCase() || name.toLowerCase() === (profile.name || "").toLowerCase()); return `<span class="mention${me ? " me" : ""}">${full}</span>`; }); }

function renderMessage(m, scroll = true, ping = false) {
  const mine = profile && m.fromLogin === profile.login;
  const isB = !mine && m.fromLogin && blocked.has(m.fromLogin);
  const wrap = document.createElement("div");
  wrap.className = "msg" + (mine ? " me" : "") + (ping ? " ping" : "") + (isB ? " blocked" : "");
  wrap.dataset.id = m.id != null ? m.id : "";
  if (isB) wrap.dataset.blocklabel = t("blocked_msg");
  let inner = "";
  if (!mine && curKind === "group") inner += `<div class="who">${escapeHtml(m.name)}</div>`;
  if (m.type === "text") inner += `<div class="bubble">${highlightMentions(linkify(escapeHtml(m.text)))}</div>`;
  else if (m.type === "image" || m.type === "gif") inner += `<div class="bubble media"><img src="${m.media}" alt=""></div>`;
  else if (m.type === "video") inner += `<div class="bubble media"><video src="${m.media}" controls></video></div>`;
  else if (m.type === "audio") inner += `<div class="bubble audio">🎤 <audio controls src="${m.media}"></audio></div>`;
  inner += `<div class="time">${fmtTime(m.ts)}<span class="edited-tag">${m.edited ? " · " + t("edited") : ""}</span></div>`;
  inner += `<div class="reactions"></div>`;
  if (m.id != null && !isB) {
    inner += `<div class="msg-actions"><button class="ma-btn ma-react" title="${t("react")}">${window.ICON.smile}</button>` +
      (mine && m.type === "text" ? `<button class="ma-btn ma-edit" title="${t("edit")}">${window.ICON.edit}</button>` : "") +
      (mine ? `<button class="ma-btn ma-del" title="${t("delete_msg")}">${window.ICON.trash}</button>` : "") + `</div>`;
  }
  wrap.innerHTML = inner;
  renderReactions(wrap, m.reactions || {});
  messagesEl.appendChild(wrap);
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
socket.on("msg-edited", ({ id, text }) => { const el = messagesEl.querySelector(`.msg[data-id="${id}"]`); if (!el) return; const b = el.querySelector(".bubble"); if (b) b.innerHTML = highlightMentions(linkify(escapeHtml(text))); const tag = el.querySelector(".edited-tag"); if (tag && !tag.textContent) tag.textContent = " · " + t("edited"); });
socket.on("msg-reaction", ({ id, reactions }) => { const el = messagesEl.querySelector(`.msg[data-id="${id}"]`); if (el) renderReactions(el, reactions); });

function sendText() {
  const input = $("msgInput"); const text = input.value.trim();
  if (!text || !myRoom) return;
  socket.emit("message", { type: "text", text }); input.value = ""; input.style.height = "auto"; socket.emit("typing", false);
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

// ====================== ЗВОНКИ (mesh WebRTC, см. §7) ======================
let ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }], iceCandidatePoolSize: 4 };
const FORCE_RELAY = new URLSearchParams(location.search).has("relay");
let iceReady = fetch("/api/ice").then((r) => r.json()).then((c) => { ICE = c; ICE.iceCandidatePoolSize = 4; if (FORCE_RELAY) ICE.iceTransportPolicy = "relay"; console.log("ICE:", c.iceServers.map((s) => s.urls).join(", ")); }).catch(() => {});

const call = { active: false, localStream: null, meStream: null, camTrack: null, screenStream: null, screenTrack: null, sharing: false, micOn: true, camOn: false, ns: true, pcs: new Map(), audioInId: null, audioOutId: null };
const NS_AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const LOW_VIDEO = { width: { ideal: 640, max: 640 }, height: { ideal: 360, max: 360 }, frameRate: { ideal: 22, max: 24 } };

async function getLocalStream() {
  if (call.localStream) return call.localStream;
  if (!navigator.mediaDevices?.getUserMedia) { const e = new Error("INSECURE"); e.name = "InsecureContext"; throw e; }
  call.localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: NS_AUDIO });
  call.ns = true; call.camOn = false; call.micOn = true;
  call.meStream = new MediaStream(call.localStream.getAudioTracks());
  addTile("me", myName + " " + t("you_suffix"), call.meStream, true); setTileAvatar("me", true);
  return call.localStream;
}
function mediaErr(e) { if (!navigator.mediaDevices || e.name === "InsecureContext") return t("err_insecure"); return { NotAllowedError: t("err_denied"), NotFoundError: t("err_notfound"), NotReadableError: t("err_inuse") }[e.name] || t("err_media") + (e.name || e.message); }
function setSenderBitrate(sender, bps) { if (!sender) return; try { const p = sender.getParameters(); if (!p.encodings?.length) p.encodings = [{}]; p.encodings[0].maxBitrate = bps; sender.setParameters(p).catch(() => {}); } catch {} }
function setBitrates(st) { setSenderBitrate(st.audioTx?.sender, 40000); setSenderBitrate(st.camTx?.sender, 350000); setSenderBitrate(st.screenTx?.sender, 1800000); }
const hasTrack = (s, tr) => s.getTracks().includes(tr);

async function makeOffer(st, peerId) {
  const pc = st.pc; if (st.makingOffer || pc.signalingState !== "stable") return;
  st.makingOffer = true;
  try { await pc.setLocalDescription(); socket.emit("signal", { to: peerId, kind: "desc", data: pc.localDescription }); setBitrates(st); }
  catch (e) { console.error("offer", e); } finally { st.makingOffer = false; }
}
function doRestart(st, peerId) {
  if (st.restarts >= 4) return; st.restarts++;
  if (st.initiator) { try { st.pc.restartIce(); } catch {} makeOffer(st, peerId); }
  else socket.emit("signal", { to: peerId, kind: "need-offer", restart: true });
}
function ensurePeer(peerId, peerName) {
  let st = call.pcs.get(peerId);
  if (st) { if (peerName) st.name = peerName; return st; }
  const pc = new RTCPeerConnection(ICE);
  const initiator = socket.id < peerId;
  st = { pc, name: peerName || (peers.get(peerId) || {}).name || "Peer", initiator, makingOffer: false, restarts: 0, iceBuf: [], vol: 1, muted: false };
  call.pcs.set(peerId, st);
  const mic = call.localStream ? call.localStream.getAudioTracks()[0] : null;
  st.audioTx = pc.addTransceiver(mic || "audio", { direction: "sendrecv" });
  st.camTx = pc.addTransceiver(call.camTrack || "video", { direction: "sendrecv" });
  st.screenTx = pc.addTransceiver(call.screenTrack || "video", { direction: "sendrecv" });
  pc.onnegotiationneeded = async () => { if (initiator) await makeOffer(st, peerId); else if (pc.remoteDescription) socket.emit("signal", { to: peerId, kind: "need-offer" }); };
  pc.onicecandidate = (e) => { if (e.candidate) socket.emit("signal", { to: peerId, kind: "ice", data: e.candidate }); };
  pc.ontrack = (e) => {
    const tx = e.transceiver, track = e.track;
    if (tx === st.screenTx) { st.screenIn = st.screenIn || new MediaStream(); if (!hasTrack(st.screenIn, track)) st.screenIn.addTrack(track); applyScreenView(peerId, st); return; }
    st.mainStream = st.mainStream || new MediaStream(); if (!hasTrack(st.mainStream, track)) st.mainStream.addTrack(track);
    const tile = addTile(peerId, st.name, st.mainStream, false); const v = tile.querySelector("video");
    v.srcObject = st.mainStream; v.muted = false; applySinkId(v); v.play().catch(() => { document.addEventListener("click", () => v.play().catch(() => {}), { once: true }); });
    if (tx === st.camTx) applyCamView(peerId, st);
  };
  pc.onconnectionstatechange = () => {
    updateCallStatus();
    if (pc.connectionState === "connected") { if (call.camOn) socket.emit("media", { to: peerId, kind: "cam", on: true }); if (call.sharing) socket.emit("media", { to: peerId, kind: "screen", on: true }); }
    else if (pc.connectionState === "closed") removePeerConn(peerId);
  };
  pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === "failed") doRestart(st, peerId); else if (pc.iceConnectionState === "disconnected") setTimeout(() => { if (pc.iceConnectionState === "disconnected") doRestart(st, peerId); }, 3000); };
  updateCallCount();
  return st;
}
function updateCallStatus() {
  const el = $("callStatus"); if (!el || !call.active) return;
  const states = [...call.pcs.values()].map((s) => s.pc.connectionState);
  let key = "call_waiting";
  if (states.length) { if (states.some((s) => s === "connected")) key = "call_connected"; else if (states.some((s) => s === "disconnected" || s === "failed")) key = "call_disconnected"; else key = "call_connecting"; }
  el.textContent = t(key); el.className = "call-status " + (key === "call_connected" ? "ok" : key === "call_disconnected" ? "bad" : "");
}
function removePeerConn(peerId) { const st = call.pcs.get(peerId); if (st) { try { st.pc.close(); } catch {} call.pcs.delete(peerId); } removeTile(peerId); removeTile("screen-" + peerId); updateCallCount(); }

$("startCallBtn").onclick = () => { if (!myRoom) return; call.active ? endCall() : joinCall(); };
async function joinCall() {
  ensureAudioCtx(); await iceReady;
  try { await getLocalStream(); } catch (e) { if (!confirm(mediaErr(e) + t("viewer_join"))) return; }
  call.active = true; $("callOverlay").classList.remove("hidden"); $("startCallBtn").classList.add("in-call"); hideToast(); updateCallCount();
  $("callRoomLabel").textContent = curTitle;
  $("toggleCam").classList.toggle("off", !call.camOn); $("toggleMic").classList.toggle("off", !call.micOn); $("noiseToggle").classList.toggle("on", call.ns);
  populateDevices(); startKeepAlive(); updateCallStatus();
  socket.emit("call-join", { title: curTitle });
}
function endCall() {
  if (call.active) socket.emit("call-leave");
  for (const id of [...call.pcs.keys()]) removePeerConn(id);
  if (call.localStream) { call.localStream.getTracks().forEach((t) => t.stop()); call.localStream = null; }
  if (call.camTrack) { call.camTrack.stop(); call.camTrack = null; }
  if (call.screenStream) { call.screenStream.getTracks().forEach((t) => t.stop()); call.screenStream = null; }
  call.screenTrack = null; call.meStream = null;
  $("videoGrid").innerHTML = ""; $("callOverlay").classList.add("hidden", "windowed"); $("callOverlay").classList.remove("windowed"); $("callOverlay").style.cssText = "";
  $("startCallBtn").classList.remove("in-call");
  Object.assign(call, { active: false, sharing: false, micOn: true, camOn: false, ns: true });
  $("toggleMic").classList.remove("off"); $("toggleCam").classList.remove("off"); $("shareScreen").classList.remove("active"); $("noiseToggle").classList.add("on"); $("micDropdown").classList.remove("open");
  $("toggleMic").innerHTML = window.ICON.mic; $("toggleCam").innerHTML = window.ICON.camera; $("callStatus").textContent = "";
  stopKeepAlive();
}
$("hangUp").onclick = endCall;

// Сигналинг
// Сессия звонка: обе стороны активны до обмена offer'ами (инициатор оффертит сам через onnegotiationneeded)
socket.on("call-participants", (list) => { if (!call.active) return; list.forEach((p) => ensurePeer(p.id, p.name)); });
socket.on("call-peer-joined", ({ id, name }) => { if (call.active) ensurePeer(id, name); });
socket.on("call-peer-left", ({ id }) => removePeerConn(id));
socket.on("call-ring", (p) => { if (call.active) return; const kind = p.room.startsWith("@grp:") ? "group" : "dm"; showToast(p.from, p.name, { room: p.room, title: p.title, kind }); });
socket.on("media", ({ from, kind, on }) => { if (!call.active) return; const st = call.pcs.get(from); if (!st) return; if (kind === "cam") { st.remoteCam = on; applyCamView(from, st); } else if (kind === "screen") { st.remoteScreen = on; applyScreenView(from, st); } });
socket.on("signal", async ({ from, name, kind, data, restart }) => {
  if (!call.active) return;
  const st = ensurePeer(from, name); const pc = st.pc; if (!st.iceBuf) st.iceBuf = [];
  try {
    if (kind === "need-offer") { if (st.initiator) { if (restart) { try { pc.restartIce(); } catch {} } await makeOffer(st, from); } }
    else if (kind === "desc") {
      await pc.setRemoteDescription(data);
      if (data.type === "offer") { await pc.setLocalDescription(); socket.emit("signal", { to: from, kind: "desc", data: pc.localDescription }); setBitrates(st); }
      for (const c of st.iceBuf) { try { await pc.addIceCandidate(c); } catch {} } st.iceBuf = [];
    } else if (kind === "ice") { if (!pc.remoteDescription) st.iceBuf.push(data); else { try { await pc.addIceCandidate(data); } catch (e) { console.warn("addIce", e.message); } } }
  } catch (e) { console.error("signal", e); }
});

// Тайлы
function addTile(id, name, stream, isMe) {
  let tile = $("tile-" + id);
  if (!tile) {
    tile = document.createElement("div"); tile.id = "tile-" + id; tile.className = "tile show-avatar" + (isMe ? " me" : "");
    const avLogin = isMe ? profile.login : (peers.get(id) || {}).login || "";
    tile.innerHTML = `<video autoplay playsinline ${isMe ? "muted" : ""}></video>` +
      `<div class="tile-avatar">${avLogin ? `<img src="${avaUrl(avLogin)}" onerror="this.style.display='none'">` : ""}<span>${initials(name)}</span></div>` +
      `<div class="tile-name">${escapeHtml(name)}</div>` +
      (isMe ? "" : `<div class="tile-ctrl"><button class="tctrl-mute" title="${t("mute_user")}">${window.ICON.volume}</button><input class="tctrl-vol" type="range" min="0" max="1" step="0.05" value="1" title="${t("volume")}"></div>`);
    $("videoGrid").appendChild(tile); if (!isMe) wireTileControls(tile, id);
  }
  const v = tile.querySelector("video"); v.srcObject = stream; if (!isMe) { v.muted = false; applySinkId(v); v.play().catch(() => {}); }
  updateCallCount(); return tile;
}
function removeTile(id) { const t = $("tile-" + id); if (t) t.remove(); }
function setTileAvatar(id, show) { const t = $("tile-" + id); if (t) t.classList.toggle("show-avatar", show); }
function applyCamView(peerId, st) { if ($("tile-" + peerId)) setTileAvatar(peerId, !st.remoteCam); }
function applyScreenView(peerId, st) { if (st.remoteScreen && st.screenIn) addScreenTile(peerId, st.name, st.screenIn); else removeTile("screen-" + peerId); }
function wireTileControls(tile, peerId) {
  const muteBtn = tile.querySelector(".tctrl-mute"), vol = tile.querySelector(".tctrl-vol");
  const applyVol = () => { const st = call.pcs.get(peerId); if (!st) return; const vid = tile.querySelector("video"); vid.muted = st.muted; vid.volume = st.muted ? 0 : Math.min(1, st.vol); };
  vol.oninput = () => { const st = call.pcs.get(peerId); if (!st) return; st.vol = parseFloat(vol.value); if (st.muted) { st.muted = false; muteBtn.innerHTML = window.ICON.volume; muteBtn.classList.remove("muted"); } applyVol(); };
  muteBtn.onclick = () => { const st = call.pcs.get(peerId); if (!st) return; st.muted = !st.muted; muteBtn.innerHTML = st.muted ? window.ICON.volumeMute : window.ICON.volume; muteBtn.classList.toggle("muted", st.muted); applyVol(); };
}
function updateCallCount() { $("callCount").textContent = (call.active ? 1 : 0) + call.pcs.size; }
function addScreenTile(id, name, stream) {
  let tile = $("tile-screen-" + id);
  if (!tile) { tile = document.createElement("div"); tile.id = "tile-screen-" + id; tile.className = "tile screen"; tile.innerHTML = `<video autoplay playsinline ${id === "me" ? "muted" : ""}></video><div class="tile-name">🖥 ${escapeHtml(name)}</div>`; $("videoGrid").appendChild(tile); }
  const v = tile.querySelector("video"); v.srcObject = stream; if (id !== "me") { v.muted = false; applySinkId(v); } v.play().catch(() => {});
}

// Контролы звонка
$("toggleMic").onclick = () => { if (!call.localStream) return; call.micOn = !call.micOn; call.localStream.getAudioTracks().forEach((t) => (t.enabled = call.micOn)); $("toggleMic").classList.toggle("off", !call.micOn); $("toggleMic").innerHTML = window.ICON[call.micOn ? "mic" : "micOff"]; };
$("toggleCam").onclick = async () => {
  if (!call.localStream) return; call.camOn = !call.camOn;
  if (call.camOn) {
    if (!call.camTrack) { try { const vs = await navigator.mediaDevices.getUserMedia({ video: LOW_VIDEO, audio: false }); call.camTrack = vs.getVideoTracks()[0]; } catch { call.camOn = false; } }
    if (call.camTrack) { for (const st of call.pcs.values()) { try { await st.camTx.sender.replaceTrack(call.camTrack); setSenderBitrate(st.camTx.sender, 350000); } catch {} } if (!hasTrack(call.meStream, call.camTrack)) call.meStream.addTrack(call.camTrack); const mv = document.querySelector("#tile-me video"); if (mv) mv.srcObject = call.meStream; }
  } else { for (const st of call.pcs.values()) { try { await st.camTx.sender.replaceTrack(null); } catch {} } if (call.camTrack) { call.meStream.removeTrack(call.camTrack); call.camTrack.stop(); call.camTrack = null; } }
  $("toggleCam").classList.toggle("off", !call.camOn); $("toggleCam").innerHTML = window.ICON[call.camOn ? "camera" : "cameraOff"];
  if (!call.sharing) setTileAvatar("me", !call.camOn);
  socket.emit("media", { kind: "cam", on: call.camOn });
};
$("shareScreen").onclick = async () => {
  if (!call.active) return; if (call.sharing) { await stopShare(); return; }
  try { call.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false }); } catch { return; }
  call.screenTrack = call.screenStream.getVideoTracks()[0];
  for (const st of call.pcs.values()) { try { await st.screenTx.sender.replaceTrack(call.screenTrack); setSenderBitrate(st.screenTx.sender, 1800000); } catch {} }
  addScreenTile("me", myName + " " + t("you_suffix"), call.screenStream);
  call.sharing = true; $("shareScreen").classList.add("active"); socket.emit("media", { kind: "screen", on: true });
  call.screenTrack.onended = () => stopShare();
};
async function stopShare() {
  for (const st of call.pcs.values()) { try { await st.screenTx.sender.replaceTrack(null); } catch {} }
  if (call.screenStream) { call.screenStream.getTracks().forEach((t) => t.stop()); call.screenStream = null; } call.screenTrack = null;
  removeTile("screen-me"); call.sharing = false; $("shareScreen").classList.remove("active"); socket.emit("media", { kind: "screen", on: false });
}

// Дропдаун микрофона + устройства
$("micDrop").onclick = (e) => { e.stopPropagation(); $("micDropdown").classList.toggle("open"); if ($("micDropdown").classList.contains("open")) populateDevices(); };
document.addEventListener("click", (e) => { if (!e.target.closest(".call-btn-group")) $("micDropdown").classList.remove("open"); });
$("toggleNoise").onclick = async (e) => { e.stopPropagation(); if (!call.localStream) return; call.ns = !call.ns; $("noiseToggle").classList.toggle("on", call.ns); try { for (const tr of call.localStream.getAudioTracks()) await tr.applyConstraints({ echoCancellation: call.ns, noiseSuppression: call.ns, autoGainControl: call.ns }); } catch {} };
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
$("micSelect").onchange = async () => {
  call.audioInId = $("micSelect").value; if (!call.localStream) return;
  try { const s = await navigator.mediaDevices.getUserMedia({ audio: { ...NS_AUDIO, deviceId: { exact: call.audioInId } }, video: false }); const nt = s.getAudioTracks()[0]; nt.enabled = call.micOn; for (const st of call.pcs.values()) { try { await st.audioTx.sender.replaceTrack(nt); } catch {} } const old = call.localStream.getAudioTracks()[0]; if (old) { call.localStream.removeTrack(old); old.stop(); } call.localStream.addTrack(nt); } catch (e) { console.error("mic", e.message); }
};
$("spkSelect").onchange = () => { call.audioOutId = $("spkSelect").value; document.querySelectorAll("#videoGrid video").forEach(applySinkId); };

// Оконный режим
$("windowToggle").onclick = () => { const o = $("callOverlay"); if (o.classList.toggle("windowed")) { o.style.right = "24px"; o.style.bottom = "24px"; } else o.style.cssText = ""; };
let dragState = null;
$("callTopbar").addEventListener("pointerdown", (e) => { const o = $("callOverlay"); if (!o.classList.contains("windowed") || e.target.closest("button")) return; const r = o.getBoundingClientRect(); dragState = { dx: e.clientX - r.left, dy: e.clientY - r.top }; $("callTopbar").setPointerCapture(e.pointerId); });
$("callTopbar").addEventListener("pointermove", (e) => { if (!dragState) return; const o = $("callOverlay"); o.style.left = Math.max(0, Math.min(innerWidth - o.offsetWidth, e.clientX - dragState.dx)) + "px"; o.style.top = Math.max(0, Math.min(innerHeight - o.offsetHeight, e.clientY - dragState.dy)) + "px"; o.style.right = "auto"; o.style.bottom = "auto"; });
$("callTopbar").addEventListener("pointerup", () => (dragState = null));

// Keep-alive (не глушить звонок в фоне) — §7.9
let keepAlive = null, wakeLock = null;
function startKeepAlive() {
  const ctx = ensureAudioCtx();
  if (ctx && !keepAlive) { const osc = ctx.createOscillator(), g = ctx.createGain(); g.gain.value = 0.0001; osc.frequency.value = 30; osc.connect(g); g.connect(ctx.destination); osc.start(); keepAlive = { osc, g }; }
  if ("mediaSession" in navigator) { try { navigator.mediaSession.metadata = new MediaMetadata({ title: t("t_call"), artist: "Dialog" }); navigator.mediaSession.playbackState = "playing"; navigator.mediaSession.setActionHandler("stop", () => endCall()); } catch {} }
  requestWakeLock();
}
function stopKeepAlive() { if (keepAlive) { try { keepAlive.osc.stop(); keepAlive.osc.disconnect(); keepAlive.g.disconnect(); } catch {} keepAlive = null; } if ("mediaSession" in navigator) { try { navigator.mediaSession.playbackState = "none"; navigator.mediaSession.metadata = null; } catch {} } if (wakeLock) { try { wakeLock.release(); } catch {} wakeLock = null; } }
async function requestWakeLock() { if (!("wakeLock" in navigator)) return; try { wakeLock = await navigator.wakeLock.request("screen"); } catch {} }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && call.active) { requestWakeLock(); document.querySelectorAll("#videoGrid video").forEach((v) => v.play().catch(() => {})); } });

// ---------- Входящий звонок (поп-ап + рингтон + cava) ----------
const ring = { audio: null, src: null, analyser: null, raf: 0, data: null, bars: [] };
function startRingtone() {
  const ctx = ensureAudioCtx();
  if (!ring.audio) ring.audio = new Audio("/src/Ringtone.mp3");
  ring.audio.loop = true; ring.audio.currentTime = 0; ring.audio.play().catch(() => {});
  if (ctx && !ring.analyser) { try { ring.src = ctx.createMediaElementSource(ring.audio); ring.analyser = ctx.createAnalyser(); ring.analyser.fftSize = 128; ring.src.connect(ring.analyser); ring.analyser.connect(ctx.destination); ring.data = new Uint8Array(ring.analyser.frequencyBinCount); } catch {} }
  startCava();
}
function stopRingtone() { if (ring.audio) ring.audio.pause(); cancelAnimationFrame(ring.raf); ring.raf = 0; const c = $("cavaCanvas"); if (c) c.getContext("2d")?.clearRect(0, 0, c.width, c.height); }
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
socket.io.on("reconnect", () => { if (connEl) connEl.classList.remove("show"); });

// ---------- Утилиты ----------
function scrollDown() { messagesEl.scrollTop = messagesEl.scrollHeight; }
function fmtTime(ts) { return new Date(ts).toLocaleTimeString(window.getLang() === "ru" ? "ru-RU" : "en-GB", { hour: "2-digit", minute: "2-digit" }); }
function escapeHtml(s) { return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function linkify(s) { return s.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color:#7dffaf">$1</a>'); }
function notify(text) { let el = $("notifyToast"); if (!el) { el = document.createElement("div"); el.id = "notifyToast"; el.className = "notify-toast"; document.body.appendChild(el); } el.textContent = text; el.classList.add("show"); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("show"), 3500); }

// ---------- Иконки ----------
function setIcons() {
  const map = { emojiBtn: "emoji", attachBtn: "attach", voiceBtn: "mic", sendBtn: "send", muteBtn: "bell", startCallBtn: "phone", infoBtn: "info", backBtnMobile: "back", newChatBtn: "edit", profileBtn: "settings", contactsBtn: "users", toggleMic: "mic", toggleCam: "camera", shareScreen: "monitor", hangUp: "phoneOff", windowToggle: "window", newChatCancel: "close", profileCancel: "close", toastJoin: "phone", toastClose: "phone", infoClose: "close", contactsCancel: "close", mpCancel: "close" };
  for (const [id, name] of Object.entries(map)) { const el = $(id); if (el && window.ICON[name]) el.innerHTML = window.ICON[name]; }
}
$("searchInput").addEventListener("input", (e) => renderChatList(e.target.value));

// ---------- Старт ----------
initLang(); setIcons(); checkSession();
