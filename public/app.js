const socket = io();

// --- State ---
let myName = "";
let myRoom = "";
const peers = new Map(); // id -> name (в комнате)
const $ = (id) => document.getElementById(id);

const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }] };

// ====================== АУТЕНТИФИКАЦИЯ ======================
let token = localStorage.getItem("dialog_token") || null;
let profile = null;

// Переключение вкладок Вход / Регистрация
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
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, data: await res.json() };
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const { ok, data } = await api("/api/login", { login: f.login.value, password: f.password.value });
  if (!ok) { $("loginError").textContent = data.error || "Ошибка входа"; return; }
  onAuthSuccess(data);
});

$("registerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.password.value !== f.password2.value) { $("registerError").textContent = "Пароли не совпадают"; return; }
  const { ok, data } = await api("/api/register", { name: f.name.value, login: f.login.value, password: f.password.value });
  if (!ok) { $("registerError").textContent = data.error || "Ошибка регистрации"; return; }
  onAuthSuccess(data);
});

function onAuthSuccess({ token: t, profile: p }) {
  token = t;
  profile = p;
  localStorage.setItem("dialog_token", t);
  showRoomStage();
}

function showRoomStage() {
  $("authStage").classList.add("hidden");
  $("roomStage").classList.remove("hidden");
  $("welcomeName").textContent = profile.name;
  $("roomInput").focus();
}

$("logoutBtn").onclick = () => {
  localStorage.removeItem("dialog_token");
  token = null;
  profile = null;
  $("roomStage").classList.add("hidden");
  $("authStage").classList.remove("hidden");
};

// Автологин по сохранённому токену
async function checkSession() {
  if (!token) return;
  try {
    const res = await fetch("/api/me", { headers: { Authorization: "Bearer " + token } });
    if (res.ok) { profile = (await res.json()).profile; showRoomStage(); }
    else localStorage.removeItem("dialog_token");
  } catch {}
}
checkSession();

// ====================== ВХОД В КОМНАТУ ======================
function tryJoin() {
  if (!token) return;
  const room = $("roomInput").value.trim() || "lobby";
  myName = profile.name;
  myRoom = room;
  socket.emit("join", { token, room });

  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("roomLabel").textContent = room;
  $("chatTitle").textContent = "# " + room;
  $("callRoomLabel").textContent = "Звонок · # " + room;
  $("myName").textContent = myName;
  $("myAvatar").textContent = initials(myName);
  $("msgInput").focus();
}
$("joinBtn").onclick = tryJoin;
$("roomInput").addEventListener("keydown", (e) => { if (e.key === "Enter") tryJoin(); });

socket.on("auth-error", (msg) => {
  alert(msg || "Ошибка авторизации");
  localStorage.removeItem("dialog_token");
  location.reload();
});

function initials(n) { return (n || "?").trim().charAt(0).toUpperCase(); }

// ====================== УЧАСТНИКИ ======================
function renderMembers() {
  const ul = $("members");
  ul.innerHTML = "";
  if (peers.size === 0) {
    ul.innerHTML = `<li class="member" style="opacity:.5"><span class="m-name">Пока вы один</span></li>`;
    return;
  }
  for (const [id, name] of peers) {
    const li = document.createElement("li");
    li.className = "member";
    li.innerHTML = `<span class="dot"></span><span class="avatar" style="width:28px;height:28px;font-size:13px">${initials(name)}</span>
      <span class="m-name">${escapeHtml(name)}</span>`;
    ul.appendChild(li);
  }
}

socket.on("peers", (list) => { list.forEach((p) => peers.set(p.id, p.name)); renderMembers(); });
socket.on("peer-joined", ({ id, name }) => {
  peers.set(id, name);
  renderMembers();
  // Если я в звонке, новый участник комнаты сам пришлёт invite, когда (и если) войдёт в звонок.
});
socket.on("peer-left", ({ id }) => {
  peers.delete(id);
  renderMembers();
  if (call.pcs.has(id)) removePeerConn(id);
});

// ====================== ИСТОРИЯ + ЧАТ ======================
const messagesEl = $("messages");

socket.on("history", (list) => {
  messagesEl.innerHTML = "";
  if (list.length) {
    const sep = document.createElement("div");
    sep.className = "system-msg";
    sep.textContent = "— предыдущие сообщения —";
    messagesEl.appendChild(sep);
  }
  list.forEach((m) => renderMessage(m, false));
  scrollDown();
});

socket.on("system", (text) => {
  const div = document.createElement("div");
  div.className = "system-msg";
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollDown();
});

socket.on("message", (m) => renderMessage(m));

function renderMessage(m, scroll = true) {
  const mine = profile && m.fromLogin === profile.login;
  const wrap = document.createElement("div");
  wrap.className = "msg" + (mine ? " me" : "");

  let inner = "";
  if (!mine) inner += `<div class="who">${escapeHtml(m.name)}</div>`;
  if (m.type === "text") {
    inner += `<div class="bubble">${linkify(escapeHtml(m.text))}</div>`;
  } else if (m.type === "image" || m.type === "gif") {
    inner += `<div class="bubble media"><img src="${m.media}" alt="${escapeHtml(m.mediaName)}" /></div>`;
  } else if (m.type === "video") {
    inner += `<div class="bubble media"><video src="${m.media}" controls></video></div>`;
  }
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
  input.value = "";
  input.style.height = "auto";
  socket.emit("typing", false);
}

$("sendBtn").onclick = sendText;
$("msgInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendText(); }
});

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
    ? (arr.length === 1 ? `${arr[0]} печатает…` : `${arr.join(", ")} печатают…`) : "";
});

// ====================== МЕДИА ======================
$("attachBtn").onclick = () => $("fileInput").click();
$("fileInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) { alert("Файл больше 20 МБ — слишком тяжёлый для отправки."); return; }
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
  const tabs = $("emojiTabs");
  const grid = $("emojiGrid");
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
    const seg = [...new Intl.Segmenter().segment(window.EMOJI[icon])]
      .map((s) => s.segment).filter((s) => /\p{Emoji}/u.test(s) && s.trim());
    seg.forEach((em) => {
      const btn = document.createElement("button");
      btn.textContent = em;
      btn.onclick = () => insertEmoji(em);
      grid.appendChild(btn);
    });
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
document.addEventListener("click", (e) => {
  if (!picker.contains(e.target) && e.target !== $("emojiBtn")) picker.classList.add("hidden");
});
buildPicker();

// ====================== ГРУППОВЫЕ ЗВОНКИ (mesh WebRTC) ======================
const call = {
  active: false,
  localStream: null,
  screenStream: null,
  sharing: false,
  micOn: true,
  camOn: true,
  pcs: new Map(), // peerId -> { pc, name, makingOffer, ignoreOffer, polite }
};

async function getLocalStream() {
  if (call.localStream) return call.localStream;
  call.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  addTile("me", myName + " (вы)", call.localStream, true);
  return call.localStream;
}

function ensurePeer(peerId, peerName) {
  let st = call.pcs.get(peerId);
  if (st) { if (peerName) st.name = peerName; return st; }

  const pc = new RTCPeerConnection(ICE);
  st = { pc, name: peerName || peers.get(peerId) || "Участник", makingOffer: false, ignoreOffer: false, polite: socket.id < peerId };
  call.pcs.set(peerId, st);

  // Свои дорожки в соединение
  if (call.localStream) call.localStream.getTracks().forEach((t) => pc.addTrack(t, call.localStream));

  pc.onnegotiationneeded = async () => {
    try {
      st.makingOffer = true;
      await pc.setLocalDescription();
      socket.emit("signal", { to: peerId, kind: "desc", data: pc.localDescription });
    } catch (e) { console.error("negotiation", e); }
    finally { st.makingOffer = false; }
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit("signal", { to: peerId, kind: "ice", data: e.candidate });
  };
  pc.ontrack = (e) => {
    addTile(peerId, st.name, e.streams[0], false);
  };
  pc.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) removePeerConn(peerId);
  };
  updateCallCount();
  return st;
}

function removePeerConn(peerId) {
  const st = call.pcs.get(peerId);
  if (st) { try { st.pc.close(); } catch {} call.pcs.delete(peerId); }
  removeTile(peerId);
  updateCallCount();
}

// Старт / выход из группового звонка
$("startCallBtn").onclick = () => { call.active ? endCall() : joinCall(); };

async function joinCall() {
  try { await getLocalStream(); }
  catch { alert("Нет доступа к камере/микрофону. На доступе по сети нужен HTTPS."); return; }
  call.active = true;
  $("callOverlay").classList.remove("hidden");
  $("startCallBtn").classList.add("in-call");
  $("startCallBtn").textContent = "✕ Выйти";
  hideToast();
  updateCallCount();
  // Сообщаем комнате — кто уже в звонке, тот установит соединение с нами.
  socket.emit("call-invite");
}

function endCall() {
  for (const id of [...call.pcs.keys()]) removePeerConn(id);
  if (call.localStream) { call.localStream.getTracks().forEach((t) => t.stop()); call.localStream = null; }
  if (call.screenStream) { call.screenStream.getTracks().forEach((t) => t.stop()); call.screenStream = null; }
  $("videoGrid").innerHTML = "";
  $("callOverlay").classList.add("hidden");
  $("startCallBtn").classList.remove("in-call");
  $("startCallBtn").textContent = "📹 Звонок";
  Object.assign(call, { active: false, sharing: false, micOn: true, camOn: true });
  $("toggleMic").classList.remove("off");
  $("toggleCam").classList.remove("off");
  $("shareScreen").classList.remove("active");
}
$("hangUp").onclick = endCall;

// Кто-то нажал «Звонок» в комнате
socket.on("call-invite", ({ from, name }) => {
  if (call.active) {
    // Я уже в звонке — устанавливаю соединение с пришедшим (я инициатор оффера).
    ensurePeer(from, name);
  } else {
    showToast(from, name);
  }
});

// Сигналинг (perfect negotiation)
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
      if (data.type === "offer") {
        await pc.setLocalDescription();
        socket.emit("signal", { to: from, kind: "desc", data: pc.localDescription });
      }
    } else if (kind === "ice") {
      try { await pc.addIceCandidate(data); } catch (e) { if (!st.ignoreOffer) throw e; }
    }
  } catch (e) { console.error("signal", e); }
});

// --- Тайлы видео ---
function addTile(id, name, stream, isMe) {
  let tile = document.getElementById("tile-" + id);
  if (!tile) {
    tile = document.createElement("div");
    tile.id = "tile-" + id;
    tile.className = "tile" + (isMe ? " me" : "");
    tile.innerHTML = `<video autoplay playsinline ${isMe ? "muted" : ""}></video><div class="tile-name">${escapeHtml(name)}</div>`;
    $("videoGrid").appendChild(tile);
  }
  tile.querySelector("video").srcObject = stream;
  updateCallCount();
}
function removeTile(id) {
  const tile = document.getElementById("tile-" + id);
  if (tile) tile.remove();
}
function updateCallCount() {
  $("callCount").textContent = (call.active ? 1 : 0) + call.pcs.size;
}

// Микрофон / камера
$("toggleMic").onclick = () => {
  if (!call.localStream) return;
  call.micOn = !call.micOn;
  call.localStream.getAudioTracks().forEach((t) => (t.enabled = call.micOn));
  $("toggleMic").classList.toggle("off", !call.micOn);
};
$("toggleCam").onclick = () => {
  if (!call.localStream) return;
  call.camOn = !call.camOn;
  call.localStream.getVideoTracks().forEach((t) => (t.enabled = call.camOn));
  $("toggleCam").classList.toggle("off", !call.camOn);
};

// Демонстрация экрана — подменяем видеодорожку у всех соединений
$("shareScreen").onclick = async () => {
  if (!call.active) return;
  if (call.sharing) { await stopShare(); return; }
  try { call.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }); }
  catch { return; }
  const track = call.screenStream.getVideoTracks()[0];
  for (const { pc } of call.pcs.values()) {
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
    if (sender) await sender.replaceTrack(track);
  }
  document.querySelector("#tile-me video").srcObject = call.screenStream;
  call.sharing = true;
  $("shareScreen").classList.add("active");
  track.onended = () => stopShare();
};
async function stopShare() {
  if (call.screenStream) { call.screenStream.getTracks().forEach((t) => t.stop()); call.screenStream = null; }
  const camTrack = call.localStream?.getVideoTracks()[0];
  for (const { pc } of call.pcs.values()) {
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
    if (sender && camTrack) await sender.replaceTrack(camTrack);
  }
  document.querySelector("#tile-me video").srcObject = call.localStream;
  call.sharing = false;
  $("shareScreen").classList.remove("active");
}

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
function fmtTime(ts) { return new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); }
function escapeHtml(s) { return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function linkify(s) { return s.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color:#9bb8ff">$1</a>'); }
