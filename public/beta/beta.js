/* Dialog 1.1.0 (beta) — new stack. Talks to the SAME backend as the classic app. */
(function () {
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  let token = localStorage.getItem("dialog_token") || null;
  let me = null, socket = null;
  const chats = new Map();          // key -> {key,type,login,id,name,last,ts,unread}
  const presence = new Map();       // login -> status
  let active = null, filter = "all", localId = 0;
  const pendingFiles = [];
  const MAX_FILES = 5, MAX_TOTAL = 75 * 1024 * 1024;

  const api = async (path, body, method) => {
    const r = await fetch(path, {
      method: method || (body ? "POST" : "GET"),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const initials = (n) => (n || "?").trim().slice(0, 2).toUpperCase();
  const avaUrl = (l) => "/api/avatar/" + encodeURIComponent(l || "");
  const dmKey = (l) => "@dm:" + [me.login, l].sort().join("~");
  const fmtTime = (ts) => ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const fmtSize = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.ceil(b / 1024) + " KB";
  function toast(text) {
    const box = $("#toasts"); const el = document.createElement("div");
    el.className = "alert alert-info"; el.innerHTML = "<span>" + esc(text) + "</span>";
    box.appendChild(el); setTimeout(() => el.remove(), 3200);
  }
  function avaHTML(login, name, cls) {
    return `<div class="avatar ${cls || ""}" data-login="${esc(login)}"><img src="${avaUrl(login)}" onerror="this.remove()">${esc(initials(name))}</div>`;
  }

  /* ---------- auth ---------- */
  applyIcons();
  $("#li-eye").onclick = () => { const i = $("#li-pass"); i.type = i.type === "password" ? "text" : "password"; };
  $("#li-go").onclick = login;
  $("#li-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
  async function login() {
    const l = $("#li-login").value.trim(), p = $("#li-pass").value;
    if (!l || !p) return;
    const { ok, data } = await api("/api/login", { login: l, password: p });
    if (!ok) { $("#li-err").textContent = data.error === "bad_credentials" ? "Wrong login or password" : (data.error || "Login failed"); return; }
    token = data.token; localStorage.setItem("dialog_token", token); boot();
  }
  if (token) boot(); else show("login");

  function show(which) { $("#login").classList.toggle("hidden", which !== "login"); $("#app").classList.toggle("hidden", which !== "app"); }

  /* ---------- boot ---------- */
  async function boot() {
    const { ok, data } = await api("/api/me");
    if (!ok) { localStorage.removeItem("dialog_token"); token = null; show("login"); return; }
    me = data.profile; show("app"); applyIcons();
    const ava = $("#me-ava"); ava.innerHTML = `<img src="${avaUrl(me.login)}" onerror="this.remove()">${esc(initials(me.name))}`;
    connect();
    const [dms, grps] = await Promise.all([api("/api/dms"), api("/api/groups")]);
    if (dms.ok && Array.isArray(dms.data)) dms.data.forEach((c) => chats.set(c.key, c));
    if (grps.ok && grps.data.groups) grps.data.groups.forEach((g) => chats.set("@grp:" + g.id, { key: "@grp:" + g.id, type: "group", id: g.id, name: g.name, last: "", ts: 0, unread: 0 }));
    refreshPresence(); renderList();
  }
  function connect() {
    socket = io();
    socket.on("connect", () => socket.emit("identify", { token }));
    socket.on("auth-error", () => { localStorage.removeItem("dialog_token"); location.reload(); });
    socket.on("presence", ({ login, status }) => { presence.set(login, status); updateDots(); });
    socket.on("history", (list) => renderHistory(list));
    socket.on("message", (m) => onMessage(m));
    socket.on("msg-ack", ({ localId: lid, id }) => { const el = $(`.m[data-local="${lid}"]`); if (el) el.dataset.id = id; });
  }
  async function refreshPresence() {
    const logins = [...chats.values()].filter((c) => c.type === "dm").map((c) => c.login);
    if (!logins.length) return;
    const { ok, data } = await api("/api/presence", { logins });
    if (ok) { Object.entries(data).forEach(([l, s]) => presence.set(l, s)); updateDots(); }
  }
  function updateDots() {
    $$(".row[data-login]").forEach((r) => { const d = r.querySelector(".dot"); if (d) d.className = "dot " + (presence.get(r.dataset.login) || "offline"); });
  }

  /* ---------- contact list ---------- */
  function renderList() {
    const q = $("#q").value.trim().toLowerCase();
    const ul = $("#chats"); ul.innerHTML = "";
    const list = [...chats.values()].filter((c) => {
      if (q && !(c.name || "").toLowerCase().includes(q) && !(c.login || "").toLowerCase().includes(q)) return false;
      if (filter === "dm") return c.type === "dm";
      if (filter === "group") return c.type === "group";
      if (filter === "online") return c.type === "dm" && ["online", "dnd"].includes(presence.get(c.login));
      return true;
    }).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    for (const c of list) {
      const li = document.createElement("li");
      li.className = "row" + (c.key === active ? " active" : ""); li.dataset.key = c.key;
      if (c.type === "dm") li.dataset.login = c.login;
      const st = c.type === "dm" ? `<span class="dot ${presence.get(c.login) || "offline"}" style="right:-2px;bottom:-2px"></span>` : "";
      li.innerHTML = `<div class="av-wrap">${avaHTML(c.login, c.name)}${st}</div>
        <div class="r-mid"><div class="r-name">${esc(c.name)}</div><div class="r-last">${esc(c.last || (c.type === "group" ? "Group" : ""))}</div></div>
        <div class="r-right">${c.ts ? `<span class="r-time">${fmtTime(c.ts)}</span>` : ""}${c.unread ? `<span class="badge badge-primary badge-sm">${c.unread}</span>` : ""}</div>`;
      li.onclick = () => openChat(c);
      ul.appendChild(li);
    }
    suggestFromSearch(q);
  }
  // Practical search: a full username/login that isn't in the list surfaces the user to DM / add.
  let suggestT;
  function suggestFromSearch(q) {
    const box = $("#suggest"); box.classList.add("hidden"); box.innerHTML = "";
    if (!q || q.length < 3) return;
    const known = [...chats.values()].some((c) => (c.login || "").toLowerCase() === q || (c.name || "").toLowerCase() === q);
    if (known) return;
    clearTimeout(suggestT);
    suggestT = setTimeout(async () => {
      const { ok, data } = await api("/api/profile/" + encodeURIComponent(q));
      if (!ok || !data || !data.login) return;
      box.classList.remove("hidden");
      box.innerHTML = `<div class="row"><div class="av-wrap">${avaHTML(data.login, data.name)}</div>
        <div class="r-mid"><div class="r-name">${esc(data.name)}</div><div class="r-last muted">@${esc(data.login)}</div></div>
        <div class="r-right" style="flex-direction:row;gap:6px">
          <button class="btn btn-xs btn-ghost" id="sg-dm">Message</button>
          <button class="btn btn-xs btn-primary" id="sg-add">Add</button></div></div>`;
      $("#sg-dm").onclick = () => openDM(data.login, data.name);
      $("#sg-add").onclick = async () => { await api("/api/friend", { target: data.login, action: "request" }); toast("Friend request sent"); };
    }, 280);
  }
  $("#q").oninput = renderList;
  $$("#filters .chip").forEach((b) => b.onclick = () => { $$("#filters .chip").forEach((x) => x.classList.toggle("active", x === b)); filter = b.dataset.f; renderList(); });

  /* ---------- open + chat ---------- */
  async function openDM(login, name) {
    const key = dmKey(login);
    if (!chats.has(key)) chats.set(key, { key, type: "dm", login, name: name || login, last: "", ts: Date.now(), unread: 0 });
    $("#q").value = ""; renderList(); openChat(chats.get(key));
  }
  function openChat(c) {
    active = c.key; c.unread = 0;
    socket.emit("join", { token, room: c.key });
    $("#empty").classList.add("hidden"); $("#conv").classList.remove("hidden");
    $("#c-name").textContent = c.name;
    $("#c-sub").textContent = c.type === "group" ? "Group" : (presence.get(c.login) || "offline");
    $("#c-ava").innerHTML = `<img src="${avaUrl(c.login)}" onerror="this.remove()">${esc(initials(c.name))}`;
    $("#msgs").innerHTML = '<div class="skeleton" style="height:40px;border-radius:12px;margin:8px 0"></div>';
    $("#app").classList.add("in-chat");
    renderList();
  }
  $("#c-back").onclick = () => { $("#app").classList.remove("in-chat"); active = null; };
  $("#c-call") && ($("#c-call").onclick = () => toast("Calls come in the next beta drop"));

  function renderHistory(list) {
    const box = $("#msgs"); box.innerHTML = "";
    if (!list.length) { box.innerHTML = '<div class="empty muted" style="flex:1">No messages yet — say hi 👋</div>'; return; }
    list.forEach((m) => addMsg(m, false));
    box.scrollTop = box.scrollHeight;
    const c = chats.get(active); const last = list[list.length - 1];
    if (c && last) { c.last = preview(last); c.ts = last.ts; renderList(); }
  }
  function onMessage(m) {
    if (active) addMsg(m, true);
    const room = m.room || active;
    const c = chats.get(room);
    if (c) { c.last = preview(m); c.ts = m.ts || Date.now(); if (room !== active) c.unread = (c.unread || 0) + 1; renderList(); }
  }
  function preview(m) { return m.type === "text" ? m.text : m.type === "image" || m.type === "gif" ? "🖼 Photo" : m.type === "video" ? "🎬 Video" : m.type === "audio" ? "🎤 Voice" : "📎 " + (m.mediaName || "File"); }
  function bodyHTML(m) {
    if (m.type === "text") return `<div class="bub">${esc(m.text)}</div>`;
    if (m.type === "image" || m.type === "gif") return `<div class="bub"><img src="${m.media}" alt=""></div>`;
    if (m.type === "video") return `<div class="bub"><video src="${m.media}" controls></video></div>`;
    if (m.type === "audio") return `<div class="bub m-file">🎤 <audio controls src="${m.media}"></audio></div>`;
    return `<a class="bub m-file" href="${m.media}" download="${esc(m.mediaName || "file")}"><span data-ic="clip"></span>${esc(m.mediaName || "file")}</a>`;
  }
  function addMsg(m, animate) {
    const mine = me && m.fromLogin === me.login;
    const el = document.createElement("div");
    el.className = "m" + (mine ? " me" : ""); if (m.localId != null) el.dataset.local = m.localId; if (m.id != null) el.dataset.id = m.id;
    if (!animate) el.style.animation = "none";
    const who = (!mine && chats.get(active)?.type === "group") ? `<div class="who">${esc(m.name)}</div>` : "";
    el.innerHTML = (mine ? "" : avaHTML(m.fromLogin, m.name)) + `<div>${who}${bodyHTML(m)}<div class="m-time">${fmtTime(m.ts)}</div></div>`;
    const box = $("#msgs"); const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    box.appendChild(el); applyIcons(el);
    if (atBottom || mine) box.scrollTop = box.scrollHeight;
  }

  /* ---------- send ---------- */
  function sendText() {
    const inp = $("#c-input"); const text = inp.value.trim();
    if (!text || !active) return;
    const lid = ++localId;
    addMsg({ localId: lid, fromLogin: me.login, name: me.name, ts: Date.now(), type: "text", text }, true);
    socket.emit("message", { type: "text", text, localId: lid });
    inp.value = "";
  }
  $("#c-send").onclick = sendText;
  $("#c-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendText(); } });

  /* ---------- file tray (preview + stack up to 5 / 75 MB total) ---------- */
  $("#c-attach").onclick = () => $("#filepick").click();
  $("#filepick").onchange = (e) => { [...e.target.files].forEach(addFile); e.target.value = ""; };
  function addFile(f) {
    if (pendingFiles.length >= MAX_FILES) return toast("Up to 5 files at once");
    pendingFiles.push(f); renderTray();
  }
  function trayTotal() { return pendingFiles.reduce((s, f) => s + f.size, 0); }
  function renderTray() {
    const tray = $("#tray");
    if (!pendingFiles.length) { tray.classList.add("hidden"); tray.innerHTML = ""; return; }
    tray.classList.remove("hidden");
    const total = trayTotal(); const over = total > MAX_TOTAL;
    tray.innerHTML = pendingFiles.map((f, i) => {
      const isImg = f.type.startsWith("image/");
      const thumb = isImg ? `<img src="${URL.createObjectURL(f)}">` : `<span data-ic="clip"></span>`;
      return `<div class="ft-item"><button class="ft-x" data-i="${i}" data-ic="x"></button>
        <div class="ft-thumb">${thumb}</div><div class="ft-size">${fmtSize(f.size)}</div></div>`;
    }).join("") + `<div class="ft-bar"><span class="ft-total ${over ? "over" : ""}">${fmtSize(total)} / 75 MB${over ? " — too big" : ""}</span>
      <button class="btn btn-primary btn-sm" id="ft-send" ${over ? "disabled" : ""}>Send ${pendingFiles.length}</button></div>`;
    applyIcons(tray);
    $$(".ft-x", tray).forEach((b) => b.onclick = () => { pendingFiles.splice(+b.dataset.i, 1); renderTray(); });
    $("#ft-send").onclick = sendTray;
  }
  function sendTray() {
    if (!active || trayTotal() > MAX_TOTAL) return;
    pendingFiles.forEach((f) => {
      const type = f.type.startsWith("image/") ? "image" : f.type.startsWith("video/") ? "video" : f.type.startsWith("audio/") ? "audio" : "file";
      const r = new FileReader();
      r.onload = () => socket.emit("message", { type, media: r.result, mediaName: f.name, localId: ++localId });
      r.readAsDataURL(f);
    });
    pendingFiles.length = 0; renderTray();
  }

  /* ---------- nav (rail + dock) ---------- */
  $$("[data-nav]").forEach((b) => b.onclick = () => {
    const n = b.dataset.nav;
    $$(".rail-btn, .dock-btn").forEach((x) => x.classList.toggle("active", x.dataset.nav === n));
    if (n === "settings" || n === "theme") toast(n === "theme" ? "Theme builder — next beta drop" : "Settings — next beta drop");
    if (n === "contacts") { filter = "dm"; $$("#filters .chip").forEach((x) => x.classList.toggle("active", x.dataset.f === "dm")); renderList(); }
  });
})();
