const socket = io();

// --- State ---
let myName = "";
let myRoom = "";
const peers = new Map(); // id -> name
const $ = (id) => document.getElementById(id);

const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }] };

// ====================== ЯЗЫК ======================
function initLang() {
  const l = window.getLang();
  ["langSelect", "langSelect2"].forEach((id) => {
    const el = $(id);
    if (el) { el.value = l; el.onchange = () => window.setLang(el.value); }
  });
  applyI18n();
}
window.addEventListener("langchange", () => {
  ["langSelect", "langSelect2"].forEach((id) => { const el = $(id); if (el) el.value = window.getLang(); });
  setCallBtn(call.active);
  updateFavBtn();
  updateMuteBtn();
  renderMembers();
  renderRoomLists();
  renderDMList();
  loadGroups();
  renderDMHub();
  if (myRoom) applyRoomHeader();
});

// ====================== ЗВУКИ ======================
let audioCtx;
function ensureAudioCtx() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch {}
  return audioCtx;
}
document.addEventListener("pointerdown", ensureAudioCtx);
function beep(freq, dur, type = "sine", vol = 0.07) {
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  try {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq; g.gain.value = vol;
    o.connect(g); g.connect(ctx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.stop(ctx.currentTime + dur);
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
    $("loginError").textContent = "";
    $("registerError").textContent = "";
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

function onAuthSuccess({ token: tk, profile: p }) {
  token = tk; profile = p;
  localStorage.setItem("dialog_token", tk);
  showRoomStage();
}
function showRoomStage() {
  $("authStage").classList.add("hidden");
  $("roomStage").classList.remove("hidden");
  $("welcomeName").textContent = profile.name;
  renderRoomLists();
  renderDMHub();
  loadGroups();
  $("roomInput").focus();
}
$("logoutBtn").onclick = () => {
  localStorage.removeItem("dialog_token");
  token = null; profile = null;
  $("roomStage").classList.add("hidden");
  $("authStage").classList.remove("hidden");
};

async function checkSession() {
  if (!token) return;
  try {
    const res = await fetch("/api/me", { headers: { Authorization: "Bearer " + token } });
    if (res.ok) { profile = (await res.json()).profile; showRoomStage(); }
    else localStorage.removeItem("dialog_token");
  } catch {}
}

// ====================== НЕДАВНИЕ / ИЗБРАННЫЕ КОМНАТЫ ======================
const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || "[]"); } catch { return []; } };
const lsSet = (k, v) => localStorage.setItem(k, JSON.stringify(v));
function addRecent(room) { let r = lsGet("dialog_recent").filter((x) => x !== room); r.unshift(room); lsSet("dialog_recent", r.slice(0, 8)); }
function getFavs() { return lsGet("dialog_favs"); }
function toggleFav(room) {
  let f = getFavs();
  f = f.includes(room) ? f.filter((x) => x !== room) : [room, ...f];
  lsSet("dialog_favs", f);
}
function renderRoomLists() {
  const favs = getFavs();
  const recent = lsGet("dialog_recent").filter((r) => !favs.includes(r));
  renderChips("favRooms", "favRoomsList", favs);
  renderChips("recentRooms", "recentRoomsList", recent);
}
function renderChips(wrapId, listId, rooms) {
  const wrap = $(wrapId), list = $(listId);
  if (!wrap) return;
  list.innerHTML = "";
  wrap.classList.toggle("hidden", rooms.length === 0);
  rooms.forEach((r) => {
    const b = document.createElement("button");
    b.className = "room-chip";
    b.textContent = "# " + r;
    b.onclick = () => { $("roomInput").value = r; tryJoin(); };
    list.appendChild(b);
  });
}
function updateFavBtn() {
  if (!myRoom) return;
  const isFav = getFavs().includes(myRoom);
  $("favBtn").textContent = isFav ? "★" : "☆";
  $("favBtn").classList.toggle("on", isFav);
  $("favBtn").title = t(isFav ? "fav_remove" : "fav_add");
}
$("favBtn").onclick = () => { toggleFav(myRoom); updateFavBtn(); renderRoomLists(); };

// ====================== ВХОД / ВЫХОД ИЗ КОМНАТЫ ======================
let curKind = "room"; // room | dm | group
let curTitle = "";

function applyRoomHeader() {
  let prefix = "#", sub = t("room_sub"), showFav = true;
  if (curKind === "dm") { prefix = "@"; sub = t("room_sub_dm"); showFav = false; }
  else if (curKind === "group") { prefix = "▣"; sub = t("room_sub_group"); showFav = false; }
  $("roomLabel").textContent = curTitle;
  $("roomSub").textContent = sub;
  $("chatTitle").textContent = prefix + " " + curTitle;
  $("callRoomLabel").textContent = t("call_label") + " · " + prefix + " " + curTitle;
  $("favBtn").style.display = showFav ? "" : "none";
  if (showFav) updateFavBtn();
}

// Общий вход в комнату / ЛС / группу
function enterRoom(room, opts = {}) {
  if (!token) return;
  myName = profile.name;
  myRoom = room;
  curKind = opts.kind || "room";
  curTitle = opts.title || room;
  if (curKind === "room") addRecent(room);
  if (call.active) endCall();
  socket.emit("join", { token, room });

  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  applyRoomHeader();
  $("myName").textContent = myName;
  $("myAvatar").textContent = initials(myName);
  updateMuteBtn();
  renderDMList();
  $("msgInput").focus();
}
function tryJoin() {
  const room = ($("roomInput").value.trim() || "lobby").slice(0, 32);
  enterRoom(room, {});
}
$("joinBtn").onclick = tryJoin;
$("roomInput").addEventListener("keydown", (e) => { if (e.key === "Enter") tryJoin(); });

function leaveRoom() {
  if (call.active) endCall();
  socket.emit("leave");
  myRoom = ""; curKind = "room";
  peers.clear(); renderMembers();
  messagesEl.innerHTML = "";
  typingUsers.clear(); $("typingIndicator").textContent = "";
  $("favBtn").style.display = "";
  $("app").classList.add("hidden");
  $("login").classList.remove("hidden");
  showRoomStage();
}
$("backBtn").onclick = leaveRoom;
$("backBtnMobile").onclick = leaveRoom;

// ====================== ЛИЧНЫЕ СООБЩЕНИЯ (DM) ======================
function dmKey(otherLogin) { return "@dm:" + [profile.login, otherLogin].sort().join("~"); }
const dmUnread = new Map(); // login -> count
function saveDM(login, name) {
  let d = lsGet("dialog_dms").filter((x) => x.login !== login);
  d.unshift({ login, name });
  lsSet("dialog_dms", d.slice(0, 12));
}
function openDM(login, name) {
  if (!login || login === profile.login) return;
  saveDM(login, name);
  dmUnread.set(login, 0);
  enterRoom(dmKey(login), { kind: "dm", title: name });
}
function renderDMList() {
  const ul = $("dmList");
  if (!ul) return;
  const d = lsGet("dialog_dms");
  $("dmSection").classList.toggle("hidden", d.length === 0);
  ul.innerHTML = "";
  d.forEach(({ login, name }) => {
    const li = document.createElement("li");
    li.className = "member" + (myRoom === dmKey(login) ? " active-dm" : "");
    const unread = dmUnread.get(login) || 0;
    li.innerHTML = `<span class="avatar" style="width:26px;height:26px;font-size:12px">${initials(name)}</span>
      <span class="m-name">${escapeHtml(name)}</span>${unread ? `<span class="badge">${unread}</span>` : ""}`;
    li.onclick = () => openDM(login, name);
    ul.appendChild(li);
  });
}
socket.on("dm-ping", ({ room, fromLogin, fromName }) => {
  saveDM(fromLogin, fromName);
  if (myRoom !== room) {
    dmUnread.set(fromLogin, (dmUnread.get(fromLogin) || 0) + 1);
    sfx.call();
    notify(t("dm_ping", { name: fromName }));
  }
  renderDMList();
});

// ====================== МЬЮТ КОМНАТЫ ======================
const isMuted = (room) => lsGet("dialog_muted").includes(room);
function updateMuteBtn() {
  if (!myRoom) return;
  const m = isMuted(myRoom);
  $("muteBtn").textContent = m ? "🔕" : "🔔";
  $("muteBtn").classList.toggle("on", m);
  $("muteBtn").title = t(m ? "unmute_room" : "mute_room");
}
$("muteBtn").onclick = () => {
  let m = lsGet("dialog_muted");
  m = m.includes(myRoom) ? m.filter((x) => x !== myRoom) : [myRoom, ...m];
  lsSet("dialog_muted", m);
  updateMuteBtn();
};

// Короткое уведомление
function notify(text) {
  let el = $("notifyToast");
  if (!el) { el = document.createElement("div"); el.id = "notifyToast"; el.className = "notify-toast"; document.body.appendChild(el); }
  el.textContent = text; el.classList.add("show");
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("show"), 3500);
}

// ====================== ХАБ ВХОДА (комната / ЛС / группы) ======================
document.querySelectorAll(".hub-tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".hub-tab").forEach((x) => x.classList.remove("active"));
    tab.classList.add("active");
    const h = tab.dataset.hub;
    document.querySelectorAll(".hub-pane").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== h));
    if (h === "group") loadGroups();
    if (h === "dm") renderDMHub();
  };
});

// --- ЛС по нику ---
async function openDMByNick() {
  const login = $("dmInput").value.trim().toLowerCase();
  $("dmError").textContent = "";
  if (!login) return;
  if (login === profile.login) { $("dmError").textContent = t("err_user_not_found"); return; }
  try {
    const res = await fetch("/api/user/" + encodeURIComponent(login), { headers: { Authorization: "Bearer " + token } });
    if (!res.ok) { $("dmError").textContent = t("err_user_not_found"); return; }
    const u = await res.json();
    $("dmInput").value = "";
    openDM(u.login, u.name);
  } catch { $("dmError").textContent = t("err_user_not_found"); }
}
$("dmOpenBtn").onclick = openDMByNick;
$("dmInput").addEventListener("keydown", (e) => { if (e.key === "Enter") openDMByNick(); });
function renderDMHub() {
  const d = lsGet("dialog_dms");
  $("dmHub").classList.toggle("hidden", d.length === 0);
  const chips = $("dmHubChips");
  chips.innerHTML = "";
  d.forEach(({ login, name }) => {
    const b = document.createElement("button");
    b.className = "room-chip";
    b.textContent = "@ " + name;
    b.onclick = () => openDM(login, name);
    chips.appendChild(b);
  });
}

// --- Группы ---
async function loadGroups() {
  try {
    const res = await fetch("/api/groups", { headers: { Authorization: "Bearer " + token } });
    if (!res.ok) return;
    const { groups } = await res.json();
    $("groupsHub").classList.toggle("hidden", groups.length === 0);
    const chips = $("groupsChips");
    chips.innerHTML = "";
    groups.forEach((g) => {
      const b = document.createElement("button");
      b.className = "room-chip";
      b.textContent = "▣ " + g.name;
      b.onclick = () => enterGroup(g.id, g.name);
      chips.appendChild(b);
    });
  } catch {}
}
function enterGroup(id, name) { enterRoom("@grp:" + id, { kind: "group", title: name }); }
$("newGroupToggle").onclick = () => $("newGroupForm").classList.toggle("hidden");
async function createGroupFromForm() {
  const name = $("groupName").value.trim();
  $("groupError").textContent = "";
  if (!name) { $("groupError").textContent = t("err_group_name"); return; }
  const members = $("groupMembers").value.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  try {
    const res = await fetch("/api/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ name, members }),
    });
    const data = await res.json();
    if (!res.ok) { $("groupError").textContent = data.error || "error"; return; }
    $("groupName").value = ""; $("groupMembers").value = "";
    $("newGroupForm").classList.add("hidden");
    enterGroup(data.id, data.name);
  } catch { $("groupError").textContent = "error"; }
}
$("createGroupBtn").onclick = createGroupFromForm;

socket.on("auth-error", (msg) => {
  alert(msg || "Auth error");
  localStorage.removeItem("dialog_token");
  location.reload();
});

// --- Соединение + автоперезаход после реконнекта ---
socket.on("connect", () => {
  setConnStatus("online");
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

// ====================== УЧАСТНИКИ ======================
function renderMembers() {
  const ul = $("members");
  ul.innerHTML = "";
  if (peers.size === 0) {
    ul.innerHTML = `<li class="member" style="opacity:.5;cursor:default"><span class="m-name">${t("alone")}</span></li>`;
    return;
  }
  for (const [, info] of peers) {
    const li = document.createElement("li");
    li.className = "member";
    li.innerHTML = `<span class="dot"></span><span class="avatar" style="width:28px;height:28px;font-size:13px">${initials(info.name)}</span>
      <span class="m-name">${escapeHtml(info.name)}</span><span class="m-dm">${t("dm_open")}</span>`;
    li.onclick = () => openDM(info.login, info.name);
    ul.appendChild(li);
  }
}
socket.on("peers", (list) => { peers.clear(); list.forEach((p) => peers.set(p.id, { name: p.name, login: p.login })); renderMembers(); });
socket.on("peer-joined", ({ id, name, login }) => { peers.set(id, { name, login }); renderMembers(); if (myRoom && !isMuted(myRoom)) sfx.join(); });
socket.on("peer-left", ({ id }) => { peers.delete(id); renderMembers(); if (call.pcs.has(id)) removePeerConn(id); if (myRoom && !isMuted(myRoom)) sfx.leave(); });

// ====================== ИСТОРИЯ + ЧАТ ======================
const messagesEl = $("messages");
socket.on("history", (list) => {
  messagesEl.innerHTML = "";
  if (list.length) {
    const sep = document.createElement("div");
    sep.className = "system-msg";
    sep.textContent = t("prev_messages");
    messagesEl.appendChild(sep);
  }
  list.forEach((m) => renderMessage(m, false, isPingForMe(m)));
  scrollDown();
  // анимация смены комнаты/чата
  messagesEl.classList.remove("room-anim"); void messagesEl.offsetWidth; messagesEl.classList.add("room-anim");
});
socket.on("system", (data) => {
  const div = document.createElement("div");
  div.className = "system-msg";
  div.textContent = typeof data === "string" ? data : t("sys_" + data.key, { name: data.name });
  messagesEl.appendChild(div);
  scrollDown();
});
socket.on("message", (m) => {
  const ping = isPingForMe(m);
  renderMessage(m, true, ping);
  const mine = profile && m.fromLogin === profile.login;
  if (!mine) {
    if (ping) sfx.call();                       // @упоминание — звук всегда
    else if (!isMuted(myRoom)) sfx.msg();        // обычное — только если не замьючено
  }
});

function isPingForMe(m) {
  if (m.type !== "text" || !profile) return false;
  const txt = (m.text || "").toLowerCase();
  return txt.includes("@" + profile.login.toLowerCase()) ||
    (profile.name && txt.includes("@" + profile.name.toLowerCase()));
}
function highlightMentions(html) {
  return html.replace(/@([\w.Ѐ-ӿ]+)/g, (full, name) => {
    const me = profile && (name.toLowerCase() === profile.login.toLowerCase() || name.toLowerCase() === (profile.name || "").toLowerCase());
    return `<span class="mention${me ? " me" : ""}">${full}</span>`;
  });
}

function renderMessage(m, scroll = true, ping = false) {
  const mine = profile && m.fromLogin === profile.login;
  const wrap = document.createElement("div");
  wrap.className = "msg" + (mine ? " me" : "") + (ping ? " ping" : "");
  let inner = "";
  if (!mine) inner += `<div class="who">${escapeHtml(m.name)}</div>`;
  if (m.type === "text") inner += `<div class="bubble">${highlightMentions(linkify(escapeHtml(m.text)))}</div>`;
  else if (m.type === "image" || m.type === "gif") inner += `<div class="bubble media"><img src="${m.media}" alt="${escapeHtml(m.mediaName)}" /></div>`;
  else if (m.type === "video") inner += `<div class="bubble media"><video src="${m.media}" controls></video></div>`;
  inner += `<div class="time">${fmtTime(m.ts)}</div>`;
  wrap.innerHTML = inner;
  messagesEl.appendChild(wrap);
  if (scroll) scrollDown();
}

function sendText() {
  const input = $("msgInput");
  const text = input.value.trim();
  if (!text) return;
  socket.emit("message", { type: "text", text });
  input.value = ""; input.style.height = "auto";
  socket.emit("typing", false);
}
$("sendBtn").onclick = sendText;
$("msgInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendText(); } });
let typingTimer;
$("msgInput").addEventListener("input", (e) => {
  e.target.style.height = "auto";
  e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
  socket.emit("typing", true);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => socket.emit("typing", false), 1500);
});
const typingUsers = new Set();
socket.on("typing", ({ name, isTyping }) => {
  if (isTyping) typingUsers.add(name); else typingUsers.delete(name);
  const arr = [...typingUsers];
  $("typingIndicator").textContent = arr.length
    ? (arr.length === 1 ? t("typing_one", { name: arr[0] }) : t("typing_many", { names: arr.join(", ") })) : "";
});

// ====================== МЕДИА ======================
$("attachBtn").onclick = () => $("fileInput").click();
$("fileInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) { alert(t("file_too_big")); return; }
  const reader = new FileReader();
  reader.onload = () => {
    let type = "file";
    if (file.type.startsWith("image/")) type = file.type === "image/gif" ? "gif" : "image";
    else if (file.type.startsWith("video/")) type = "video";
    socket.emit("message", { type, media: reader.result, mediaName: file.name });
  };
  reader.readAsDataURL(file);
  e.target.value = "";
});

// ====================== ЭМОДЗИ-ПИКЕР ======================
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
  input.focus();
  input.selectionStart = input.selectionEnd = s + em.length;
}
$("emojiBtn").onclick = (e) => { e.stopPropagation(); picker.classList.toggle("hidden"); };
document.addEventListener("click", (e) => { if (!picker.contains(e.target) && e.target !== $("emojiBtn")) picker.classList.add("hidden"); });
buildPicker();

// ====================== ГРУППОВЫЕ ЗВОНКИ (mesh WebRTC) ======================
const call = {
  active: false, localStream: null, screenStream: null,
  sharing: false, micOn: true, camOn: false,
  pcs: new Map(), // peerId -> { pc, name, makingOffer, ignoreOffer, polite, gain, vol, muted, screenSender }
};

async function getLocalStream() {
  if (call.localStream) return call.localStream;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const err = new Error("INSECURE"); err.name = "InsecureContext"; throw err;
  }
  try {
    call.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (e) {
    try { call.localStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { throw e; }
  }
  call.localStream.getVideoTracks().forEach((tr) => (tr.enabled = false)); // камера off по умолчанию
  call.camOn = false;
  addTile("me", myName + " " + t("you_suffix"), call.localStream, true);
  setTileAvatar("me", true);
  return call.localStream;
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
  st = { pc, name: peerName || peers.get(peerId) || "Peer", makingOffer: false, ignoreOffer: false, polite: socket.id < peerId, vol: 1, muted: false };
  call.pcs.set(peerId, st);

  if (call.localStream) call.localStream.getTracks().forEach((tr) => pc.addTrack(tr, call.localStream));

  pc.onnegotiationneeded = async () => {
    try { st.makingOffer = true; await pc.setLocalDescription(); socket.emit("signal", { to: peerId, kind: "desc", data: pc.localDescription }); }
    catch (e) { console.error("negotiation", e); } finally { st.makingOffer = false; }
  };
  pc.onicecandidate = (e) => { if (e.candidate) socket.emit("signal", { to: peerId, kind: "ice", data: e.candidate }); };
  pc.ontrack = (e) => {
    addTile(peerId, st.name, e.streams[0], false);
    if (e.track.kind === "video") setupVideoDetect(peerId, e.track);
    else if (e.track.kind === "audio") setupAudioGain(peerId, e.streams[0]);
  };
  pc.onconnectionstatechange = () => { if (["failed", "closed", "disconnected"].includes(pc.connectionState)) removePeerConn(peerId); };
  updateCallCount();
  return st;
}
function removePeerConn(peerId) {
  const st = call.pcs.get(peerId);
  if (st) { try { st.pc.close(); } catch {} try { st.audioSrc?.disconnect(); st.gain?.disconnect(); } catch {} call.pcs.delete(peerId); }
  removeTile(peerId);
  updateCallCount();
}

$("startCallBtn").onclick = () => { call.active ? endCall() : joinCall(); };

async function joinCall() {
  ensureAudioCtx();
  try { await getLocalStream(); }
  catch (e) { if (!confirm(mediaErrorMessage(e) + t("viewer_join"))) return; }
  call.active = true;
  $("callOverlay").classList.remove("hidden");
  setCallBtn(true);
  hideToast();
  updateCallCount();
  $("toggleCam").classList.toggle("off", !call.camOn);
  $("toggleMic").classList.toggle("off", !call.micOn);
  socket.emit("call-invite");
}
function endCall() {
  for (const id of [...call.pcs.keys()]) removePeerConn(id);
  if (call.localStream) { call.localStream.getTracks().forEach((tr) => tr.stop()); call.localStream = null; }
  if (call.screenStream) { call.screenStream.getTracks().forEach((tr) => tr.stop()); call.screenStream = null; }
  $("videoGrid").innerHTML = "";
  $("callOverlay").classList.add("hidden");
  $("callOverlay").classList.remove("windowed");
  $("callOverlay").style.cssText = "";
  setCallBtn(false);
  Object.assign(call, { active: false, sharing: false, micOn: true, camOn: false });
  $("toggleMic").classList.remove("off");
  $("toggleCam").classList.remove("off");
  $("shareScreen").classList.remove("active");
}
$("hangUp").onclick = endCall;

function setCallBtn(inCall) {
  $("startCallBtn").classList.toggle("in-call", inCall);
  const span = $("startCallBtn").querySelector("span");
  if (span) span.textContent = t(inCall ? "leave_btn" : "call_btn");
}

socket.on("call-invite", ({ from, name }) => {
  if (call.active) ensurePeer(from, name);
  else { showToast(from, name); sfx.call(); }
});

socket.on("signal", async ({ from, name, kind, data }) => {
  if (!call.active) return;
  const st = ensurePeer(from, name);
  const pc = st.pc;
  try {
    if (kind === "desc") {
      const offerCollision = data.type === "offer" && (st.makingOffer || pc.signalingState !== "stable");
      st.ignoreOffer = !st.polite && offerCollision;
      if (st.ignoreOffer) return;
      await pc.setRemoteDescription(data);
      if (data.type === "offer") { await pc.setLocalDescription(); socket.emit("signal", { to: from, kind: "desc", data: pc.localDescription }); }
    } else if (kind === "ice") {
      try { await pc.addIceCandidate(data); } catch (e) { if (!st.ignoreOffer) throw e; }
    }
  } catch (e) { console.error("signal", e); }
});

// --- Тайлы видео (Discord-стиль: аватар при выкл. камере + громкость/мьют) ---
function addTile(id, name, stream, isMe) {
  let tile = $("tile-" + id);
  if (!tile) {
    tile = document.createElement("div");
    tile.id = "tile-" + id;
    tile.className = "tile show-avatar" + (isMe ? " me" : "");
    tile.innerHTML =
      `<video autoplay playsinline ${isMe ? "muted" : ""}></video>` +
      `<div class="tile-avatar">${initials(name)}</div>` +
      `<div class="tile-name">${escapeHtml(name)}</div>` +
      (isMe ? "" :
        `<div class="tile-ctrl">
           <button class="tctrl-mute" title="${t("mute_user")}">🔊</button>
           <input class="tctrl-vol" type="range" min="0" max="2" step="0.05" value="1" title="${t("volume")}">
         </div>`);
    $("videoGrid").appendChild(tile);
    if (!isMe) wireTileControls(tile, id);
  }
  tile.querySelector("video").srcObject = stream;
  updateCallCount();
  return tile;
}
function removeTile(id) { const tile = $("tile-" + id); if (tile) tile.remove(); }
function setTileAvatar(id, show) { const tile = $("tile-" + id); if (tile) tile.classList.toggle("show-avatar", show); }
function setupVideoDetect(peerId, track) {
  const apply = () => setTileAvatar(peerId, track.muted);
  track.onmute = apply; track.onunmute = apply; apply();
}
function setupAudioGain(peerId, stream) {
  const st = call.pcs.get(peerId);
  if (!st || st.gain) return;
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  try {
    const src = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = st.muted ? 0 : st.vol;
    src.connect(gain); gain.connect(ctx.destination);
    st.gain = gain; st.audioSrc = src;
    const tile = $("tile-" + peerId);
    if (tile) tile.querySelector("video").muted = true; // звук идёт через WebAudio
  } catch (e) { console.error("audio gain", e); }
}
function wireTileControls(tile, peerId) {
  const muteBtn = tile.querySelector(".tctrl-mute");
  const vol = tile.querySelector(".tctrl-vol");
  const applyVol = () => {
    const st = call.pcs.get(peerId); if (!st) return;
    const v = st.muted ? 0 : st.vol;
    if (st.gain) st.gain.gain.value = v;
    else { const vid = tile.querySelector("video"); vid.muted = st.muted; vid.volume = Math.min(1, st.vol); }
  };
  vol.oninput = () => {
    const st = call.pcs.get(peerId); if (!st) return;
    st.vol = parseFloat(vol.value);
    if (st.muted) { st.muted = false; muteBtn.textContent = "🔊"; muteBtn.classList.remove("muted"); }
    applyVol();
  };
  muteBtn.onclick = () => {
    const st = call.pcs.get(peerId); if (!st) return;
    st.muted = !st.muted;
    muteBtn.textContent = st.muted ? "🔇" : "🔊";
    muteBtn.classList.toggle("muted", st.muted);
    applyVol();
  };
}
function updateCallCount() { $("callCount").textContent = (call.active ? 1 : 0) + call.pcs.size; }

// Микрофон / камера
$("toggleMic").onclick = () => {
  if (!call.localStream) return;
  call.micOn = !call.micOn;
  call.localStream.getAudioTracks().forEach((tr) => (tr.enabled = call.micOn));
  $("toggleMic").classList.toggle("off", !call.micOn);
};
$("toggleCam").onclick = () => {
  if (!call.localStream) return;
  call.camOn = !call.camOn;
  call.localStream.getVideoTracks().forEach((tr) => (tr.enabled = call.camOn));
  $("toggleCam").classList.toggle("off", !call.camOn);
  if (!call.sharing) setTileAvatar("me", !call.camOn);
};

// Демонстрация экрана
$("shareScreen").onclick = async () => {
  if (!call.active) return;
  if (call.sharing) { await stopShare(); return; }
  try { call.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }); } catch { return; }
  const track = call.screenStream.getVideoTracks()[0];
  for (const st of call.pcs.values()) {
    const sender = st.pc.getSenders().find((s) => s.track && s.track.kind === "video");
    if (sender) await sender.replaceTrack(track);
    else st.screenSender = st.pc.addTrack(track, call.screenStream);
  }
  addTile("me", myName + " " + t("you_suffix"), call.screenStream, true);
  setTileAvatar("me", false);
  call.sharing = true;
  $("shareScreen").classList.add("active");
  track.onended = () => stopShare();
};
async function stopShare() {
  if (call.screenStream) { call.screenStream.getTracks().forEach((tr) => tr.stop()); call.screenStream = null; }
  const camTrack = call.localStream?.getVideoTracks()[0];
  for (const st of call.pcs.values()) {
    if (st.screenSender) { try { st.pc.removeTrack(st.screenSender); } catch {} st.screenSender = null; }
    else { const sender = st.pc.getSenders().find((s) => s.track && s.track.kind === "video"); if (sender && camTrack) await sender.replaceTrack(camTrack); }
  }
  if (call.localStream) { addTile("me", myName + " " + t("you_suffix"), call.localStream, true); setTileAvatar("me", !call.camOn); }
  else removeTile("me");
  call.sharing = false;
  $("shareScreen").classList.remove("active");
}

// --- Окно звонка: режим окна + перетаскивание (ПК) ---
$("windowToggle").onclick = () => {
  const o = $("callOverlay");
  const win = o.classList.toggle("windowed");
  if (win) { o.style.left = ""; o.style.top = ""; o.style.right = "24px"; o.style.bottom = "24px"; }
  else { o.style.left = o.style.top = o.style.right = o.style.bottom = o.style.width = o.style.height = ""; }
};
let dragState = null;
$("callTopbar").addEventListener("pointerdown", (e) => {
  const o = $("callOverlay");
  if (!o.classList.contains("windowed") || e.target.closest("button")) return;
  const r = o.getBoundingClientRect();
  dragState = { dx: e.clientX - r.left, dy: e.clientY - r.top };
  $("callTopbar").setPointerCapture(e.pointerId);
});
$("callTopbar").addEventListener("pointermove", (e) => {
  if (!dragState) return;
  const o = $("callOverlay");
  let x = Math.max(0, Math.min(window.innerWidth - o.offsetWidth, e.clientX - dragState.dx));
  let y = Math.max(0, Math.min(window.innerHeight - o.offsetHeight, e.clientY - dragState.dy));
  o.style.left = x + "px"; o.style.top = y + "px"; o.style.right = "auto"; o.style.bottom = "auto";
});
$("callTopbar").addEventListener("pointerup", () => (dragState = null));

// --- Тост о звонке ---
function showToast(from, name) {
  $("toastName").textContent = name;
  $("toastAvatar").textContent = initials(name);
  $("callToast").classList.remove("hidden");
}
function hideToast() { $("callToast").classList.add("hidden"); }
$("toastJoin").onclick = () => joinCall();
$("toastClose").onclick = hideToast;

// ====================== УТИЛИТЫ ======================
function scrollDown() { messagesEl.scrollTop = messagesEl.scrollHeight; }
function fmtTime(ts) { return new Date(ts).toLocaleTimeString(window.getLang() === "ru" ? "ru-RU" : "en-GB", { hour: "2-digit", minute: "2-digit" }); }
function escapeHtml(s) { return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function linkify(s) { return s.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color:#7dffaf">$1</a>'); }

// ====================== СТАРТ ======================
initLang();
checkSession();
