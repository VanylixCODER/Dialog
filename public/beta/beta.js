/* Dialog 1.1.0 (beta) — new stack, talks to the SAME backend as the classic app. */
(function () {
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  let token = localStorage.getItem("dialog_token") || null;
  let me = null, socket = null;
  const chats = new Map(), presence = new Map();
  let active = null, filter = "all", localId = 0, typingT = 0;
  const pendingFiles = []; const MAX_FILES = 5, MAX_TOTAL = 75 * 1024 * 1024;

  const api = async (p, b, m) => {
    const r = await fetch(p, { method: m || (b ? "POST" : "GET"), headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: b ? JSON.stringify(b) : undefined });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const initials = (n) => (n || "?").trim().slice(0, 2).toUpperCase();
  const avaUrl = (l) => "/api/avatar/" + encodeURIComponent(l || "");
  const dmKey = (l) => "@dm:" + [me.login, l].sort().join("~");
  const partnerOf = (key) => key.slice(4).split("~").find((l) => l !== me.login);
  const fmtTime = (ts) => ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const fmtSize = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.ceil(b / 1024) + " KB";
  function toast(text) { const el = document.createElement("div"); el.className = "alert alert-info"; el.innerHTML = "<span>" + esc(text) + "</span>"; $("#toasts").appendChild(el); setTimeout(() => el.remove(), 3000); }
  const avaHTML = (login, name, cls) => `<div class="avatar ${cls || ""}" data-login="${esc(login)}"><img src="${avaUrl(login)}" onerror="this.remove()">${esc(initials(name))}</div>`;

  /* ---------- theme + appearance ---------- */
  const THEMES = [["dialog", "Dialog", ["#00ff5a", "#0a1211", "#12201b"]], ["matrix", "Matrix", ["#00ff66", "#010502", "#031a0c"]], ["dracula", "Dracula", ["#bd93f9", "#282a36", "#ff79c6"]], ["midnight", "Midnight", ["#5a8aff", "#0a0e1a", "#1a2140"]], ["mono", "Mono", ["#ffffff", "#000000", "#1a1a1a"]]];
  function applyTheme(k) { document.documentElement.dataset.theme = k; localStorage.setItem("dialog_beta_theme", k); if (k === "matrix") startMatrix(); else stopMatrix(); }
  function applyAppearance() {
    const r = document.documentElement, b = document.body;
    r.style.setProperty("--radius-scale", ((+localStorage.getItem("dialog_ap_radius") || 100) / 100).toFixed(2));
    r.style.setProperty("--ui-scale", localStorage.getItem("dialog_ap_scale") || "1");
    b.classList.toggle("dense", localStorage.getItem("dialog_ap_density") === "dense");
    b.classList.remove("motion-off", "motion-subtle"); const mo = localStorage.getItem("dialog_ap_motion"); if (mo === "off" || mo === "subtle") b.classList.add("motion-" + mo);
  }

  // Matrix rain on #matrix-bg (for the matrix theme)
  let mtx = null;
  function startMatrix() {
    const cv = $("#matrix-bg"); if (!cv) return; if (mtx) return;
    const ctx = cv.getContext("2d"); let cols, drops;
    const resize = () => { cv.width = innerWidth; cv.height = innerHeight; cols = Math.floor(cv.width / 14); drops = Array(cols).fill(1); };
    resize(); addEventListener("resize", resize);
    const glyph = "アカサタナ0123456789ABCDEFﾊﾋﾎﾃｦｯ";
    const draw = () => { ctx.fillStyle = "rgba(1,6,3,.08)"; ctx.fillRect(0, 0, cv.width, cv.height); ctx.fillStyle = "#00ff66"; ctx.font = "14px monospace";
      for (let i = 0; i < cols; i++) { ctx.fillText(glyph[Math.floor(Math.random() * glyph.length)], i * 14, drops[i] * 14); if (drops[i] * 14 > cv.height && Math.random() > .975) drops[i] = 0; drops[i]++; } };
    mtx = { raf: 0, resize, tick: () => { draw(); mtx.raf = requestAnimationFrame(mtx.tick); } }; mtx.tick();
  }
  function stopMatrix() { if (!mtx) return; cancelAnimationFrame(mtx.raf); removeEventListener("resize", mtx.resize); const cv = $("#matrix-bg"); if (cv) cv.getContext("2d").clearRect(0, 0, cv.width, cv.height); mtx = null; }
  applyTheme(localStorage.getItem("dialog_beta_theme") || "dialog"); applyAppearance();

  /* ---------- auth ---------- */
  applyIcons();
  $("#li-eye").onclick = () => { const i = $("#li-pass"); i.type = i.type === "password" ? "text" : "password"; };
  $("#li-go").onclick = login;
  $("#li-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
  async function login() {
    const l = $("#li-login").value.trim(), p = $("#li-pass").value; if (!l || !p) return;
    const { ok, data } = await api("/api/login", { login: l, password: p });
    if (!ok) { $("#li-err").textContent = data.error === "bad_credentials" ? "Wrong login or password" : (data.error || "Login failed"); return; }
    token = data.token; localStorage.setItem("dialog_token", token); boot();
  }
  if (token) boot(); else show("login");
  function show(which) { $("#login").classList.toggle("hidden", which !== "login"); $("#app").classList.toggle("hidden", which !== "app"); }

  async function boot() {
    const { ok, data } = await api("/api/me");
    if (!ok) { localStorage.removeItem("dialog_token"); token = null; show("login"); return; }
    me = data.profile; show("app"); applyIcons();
    $("#me-ava").innerHTML = `<img src="${avaUrl(me.login)}" onerror="this.remove()">${esc(initials(me.name))}`;
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
    socket.on("presence", ({ login, status }) => { presence.set(login, status); updateDots(); if (active && active.startsWith("@dm:") && partnerOf(active) === login) $("#c-sub").textContent = status; });
    socket.on("history", renderHistory);
    socket.on("message", onMessage);
    socket.on("msg-ack", ({ localId: lid, id }) => { const el = $(`.m[data-local="${lid}"]`); if (el) el.dataset.id = id; });
    socket.on("typing", ({ name, isTyping }) => { $("#typing").textContent = isTyping ? name + " is typing…" : ""; $("#typing").classList.toggle("hidden", !isTyping); });
    socket.on("call-ring", onIncoming);
    socket.on("call-cancelled", () => hideIncoming());
    socket.on("call-state", ({ room, count }) => { const c = chats.get(room); if (c) { c._call = count > 0; if (room !== active) renderList(); } });
  }
  async function refreshPresence() {
    const logins = [...chats.values()].filter((c) => c.type === "dm").map((c) => c.login); if (!logins.length) return;
    const { ok, data } = await api("/api/presence", { logins });
    if (ok) { Object.entries(data).forEach(([l, s]) => presence.set(l, s)); updateDots(); }
  }
  function updateDots() { $$(".row[data-login]").forEach((r) => { const d = r.querySelector(".dot"); if (d) d.className = "dot " + (presence.get(r.dataset.login) || "offline"); }); }

  /* ---------- contact list + search ---------- */
  function renderList() {
    const q = $("#q").value.trim().toLowerCase(); const ul = $("#chats"); ul.innerHTML = "";
    const list = [...chats.values()].filter((c) => {
      if (q && !(c.name || "").toLowerCase().includes(q) && !(c.login || "").toLowerCase().includes(q)) return false;
      if (filter === "dm") return c.type === "dm"; if (filter === "group") return c.type === "group";
      if (filter === "online") return c.type === "dm" && ["online", "dnd"].includes(presence.get(c.login)); return true;
    }).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    for (const c of list) {
      const li = document.createElement("li"); li.className = "row" + (c.key === active ? " active" : ""); li.dataset.key = c.key;
      if (c.type === "dm") li.dataset.login = c.login;
      const st = c.type === "dm" ? `<span class="dot ${presence.get(c.login) || "offline"}" style="right:-2px;bottom:-2px"></span>` : "";
      li.innerHTML = `<div class="av-wrap">${avaHTML(c.login, c.name)}${st}</div>
        <div class="r-mid"><div class="r-name">${esc(c.name)}${c._call ? ' <span class="badge badge-success badge-xs">call</span>' : ""}</div><div class="r-last">${esc(c.last || (c.type === "group" ? "Group" : ""))}</div></div>
        <div class="r-right">${c.ts ? `<span class="r-time">${fmtTime(c.ts)}</span>` : ""}${c.unread ? `<span class="badge badge-primary badge-sm">${c.unread}</span>` : ""}</div>`;
      li.onclick = () => openChat(c);
      li.querySelector(".avatar").onclick = (e) => { if (c.type === "dm") { e.stopPropagation(); openMP(c.login); } };
      ul.appendChild(li);
    }
    suggestFromSearch(q);
  }
  let suggestT;
  function suggestFromSearch(q) {
    const box = $("#suggest"); box.classList.add("hidden"); box.innerHTML = "";
    if (!q || q.length < 3) return;
    if ([...chats.values()].some((c) => (c.login || "").toLowerCase() === q || (c.name || "").toLowerCase() === q)) return;
    clearTimeout(suggestT);
    suggestT = setTimeout(async () => {
      const { ok, data } = await api("/api/profile/" + encodeURIComponent(q)); if (!ok || !data || !data.login) return;
      box.classList.remove("hidden");
      box.innerHTML = `<div class="set-sec">Found</div><div class="row"><div class="av-wrap">${avaHTML(data.login, data.name)}</div>
        <div class="r-mid"><div class="r-name">${esc(data.name)}</div><div class="r-last muted">@${esc(data.login)}</div></div>
        <div class="r-right" style="flex-direction:row;gap:6px"><button class="btn btn-xs btn-ghost" id="sg-dm">Message</button><button class="btn btn-xs btn-primary" id="sg-add">Add</button></div></div>`;
      $("#sg-dm").onclick = () => openDM(data.login, data.name);
      $("#sg-add").onclick = async () => { await api("/api/friend", { target: data.login, action: "request" }); toast("Friend request sent"); };
    }, 280);
  }
  $("#q").oninput = renderList;
  $$("#filters .chip").forEach((b) => b.onclick = () => { $$("#filters .chip").forEach((x) => x.classList.toggle("active", x === b)); filter = b.dataset.f; renderList(); });

  /* ---------- open + chat ---------- */
  async function openDM(login, name) { const key = dmKey(login); if (!chats.has(key)) chats.set(key, { key, type: "dm", login, name: name || login, last: "", ts: Date.now(), unread: 0 }); $("#q").value = ""; closeSheets(); renderList(); openChat(chats.get(key)); }
  function openChat(c) {
    active = c.key; c.unread = 0; socket.emit("join", { token, room: c.key });
    $("#empty").classList.add("hidden"); $("#conv").classList.remove("hidden");
    $("#c-name").textContent = c.name; $("#c-sub").textContent = c.type === "group" ? "Group" : (presence.get(c.login) || "offline");
    $("#c-ava").innerHTML = `<img src="${avaUrl(c.login)}" onerror="this.remove()">${esc(initials(c.name))}`;
    $("#c-ava").onclick = () => { if (c.type === "dm") openMP(c.login); };
    $("#msgs").innerHTML = '<div class="skeleton" style="height:40px;border-radius:12px;margin:8px 0"></div>';
    $("#app").classList.add("in-chat"); renderList();
  }
  $("#c-back").onclick = () => { $("#app").classList.remove("in-chat"); active = null; };
  function renderHistory(list) {
    const box = $("#msgs"); box.innerHTML = "";
    if (!list.length) { box.innerHTML = '<div class="empty muted" style="flex:1">No messages yet — say hi 👋</div>'; return; }
    list.forEach((m) => addMsg(m, false)); box.scrollTop = box.scrollHeight;
    const c = chats.get(active), last = list[list.length - 1]; if (c && last) { c.last = preview(last); c.ts = last.ts; renderList(); }
  }
  function onMessage(m) {
    if (active) addMsg(m, true);
    const room = m.room || active, c = chats.get(room);
    if (c) { c.last = preview(m); c.ts = m.ts || Date.now(); if (room !== active) c.unread = (c.unread || 0) + 1; renderList(); }
  }
  const preview = (m) => m.type === "text" ? m.text : m.type === "image" || m.type === "gif" ? "🖼 Photo" : m.type === "video" ? "🎬 Video" : m.type === "audio" ? "🎤 Voice" : "📎 " + (m.mediaName || "File");
  function bodyHTML(m) {
    if (m.type === "text") return `<div class="bub">${esc(m.text)}</div>`;
    if (m.type === "image" || m.type === "gif") return `<div class="bub"><img src="${m.media}" alt=""></div>`;
    if (m.type === "video") return `<div class="bub"><video src="${m.media}" controls></video></div>`;
    if (m.type === "audio") return `<div class="bub m-file">🎤 <audio controls src="${m.media}"></audio></div>`;
    return `<a class="bub m-file" href="${m.media}" download="${esc(m.mediaName || "file")}"><span data-ic="clip"></span>${esc(m.mediaName || "file")}</a>`;
  }
  function addMsg(m, animate) {
    const mine = me && m.fromLogin === me.login; const el = document.createElement("div");
    el.className = "m" + (mine ? " me" : ""); if (m.localId != null) el.dataset.local = m.localId; if (m.id != null) el.dataset.id = m.id;
    if (!animate) el.style.animation = "none";
    const who = (!mine && chats.get(active)?.type === "group") ? `<div class="who">${esc(m.name)}</div>` : "";
    el.innerHTML = (mine ? "" : avaHTML(m.fromLogin, m.name)) + `<div>${who}${bodyHTML(m)}<div class="m-time">${fmtTime(m.ts)}</div></div>`;
    const box = $("#msgs"), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    box.appendChild(el); applyIcons(el); if (atBottom || mine) box.scrollTop = box.scrollHeight;
  }
  function sendText() {
    const inp = $("#c-input"), text = inp.value.trim(); if (!text || !active) return;
    const lid = ++localId; addMsg({ localId: lid, fromLogin: me.login, name: me.name, ts: Date.now(), type: "text", text }, true);
    socket.emit("message", { type: "text", text, localId: lid }); inp.value = ""; socket.emit("typing", false);
  }
  $("#c-send").onclick = sendText;
  $("#c-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendText(); } });
  $("#c-input").addEventListener("input", () => { if (!active) return; socket.emit("typing", true); clearTimeout(typingT); typingT = setTimeout(() => socket.emit("typing", false), 2000); });

  /* ---------- files ---------- */
  $("#c-attach").onclick = () => $("#filepick").click();
  $("#filepick").onchange = (e) => { [...e.target.files].forEach((f) => { if (pendingFiles.length >= MAX_FILES) return toast("Up to 5 files"); pendingFiles.push(f); }); e.target.value = ""; renderTray(); };
  const trayTotal = () => pendingFiles.reduce((s, f) => s + f.size, 0);
  function renderTray() {
    const tray = $("#tray"); if (!pendingFiles.length) { tray.classList.add("hidden"); tray.innerHTML = ""; return; }
    tray.classList.remove("hidden"); const total = trayTotal(), over = total > MAX_TOTAL;
    tray.innerHTML = pendingFiles.map((f, i) => `<div class="ft-item"><button class="ft-x" data-i="${i}" data-ic="x"></button><div class="ft-thumb">${f.type.startsWith("image/") ? `<img src="${URL.createObjectURL(f)}">` : `<span data-ic="clip"></span>`}</div><div class="ft-size">${fmtSize(f.size)}</div></div>`).join("")
      + `<div class="ft-bar"><span class="ft-total ${over ? "over" : ""}">${fmtSize(total)} / 75 MB${over ? " — too big" : ""}</span><button class="btn btn-primary btn-sm" id="ft-send" ${over ? "disabled" : ""}>Send ${pendingFiles.length}</button></div>`;
    applyIcons(tray);
    $$(".ft-x", tray).forEach((b) => b.onclick = () => { pendingFiles.splice(+b.dataset.i, 1); renderTray(); });
    $("#ft-send").onclick = () => { if (trayTotal() > MAX_TOTAL || !active) return; pendingFiles.forEach((f) => { const type = f.type.startsWith("image/") ? "image" : f.type.startsWith("video/") ? "video" : f.type.startsWith("audio/") ? "audio" : "file"; const r = new FileReader(); r.onload = () => socket.emit("message", { type, media: r.result, mediaName: f.name, localId: ++localId }); r.readAsDataURL(f); }); pendingFiles.length = 0; renderTray(); };
  }

  /* ---------- mini-profile (right-mirrored) + group-from-contact ---------- */
  async function openMP(login) {
    if (!login || login === me.login) return;
    const { ok, data } = await api("/api/profile/" + encodeURIComponent(login)); if (!ok) return;
    $("#mp-ava").innerHTML = `<img src="${avaUrl(login)}" onerror="this.remove()">${esc(initials(data.name))}`;
    $("#mp-name").textContent = data.name; $("#mp-tag").textContent = "@" + data.login;
    const st = presence.get(login) || data.status || "offline"; $("#mp-status").innerHTML = `<span class="dot ${st}" style="position:static;display:inline-block;margin-right:6px"></span>${st}`;
    $("#mp-desc").textContent = data.description || "No description."; $("#mp-joined").textContent = data.created_at ? "Joined " + new Date(data.created_at).toLocaleDateString() : "";
    $("#mp-msg").onclick = () => openDM(login, data.name);
    $("#mp-add").onclick = async () => { await api("/api/friend", { target: login, action: "request" }); toast("Friend request sent"); };
    $("#mp").classList.remove("hidden");
  }
  $("#mp-close").onclick = () => $("#mp").classList.add("hidden");
  $("#mp").onclick = (e) => { if (e.target.id === "mp") $("#mp").classList.add("hidden"); };

  /* ---------- settings ---------- */
  function openSettings() {
    $("#set-title").textContent = "Settings";
    const st = me.status || "online";
    $("#set-body").innerHTML = `
      <div class="set-row"><div class="lbl"><b>${esc(me.name)}</b><small>@${esc(me.login)}</small></div>${avaHTML(me.login, me.name)}</div>
      <div class="set-sec">Profile</div>
      <input class="set-input" id="s-name" value="${esc(me.name)}" maxlength="32" placeholder="Display name" />
      <textarea class="set-input" id="s-desc" rows="2" placeholder="Description" style="height:auto;padding:10px 12px">${esc(me.description || "")}</textarea>
      <button class="btn btn-primary btn-sm" id="s-save" style="align-self:flex-start">Save profile</button>
      <div class="set-sec">Status</div>
      <div class="seg" id="s-status">${["online", "dnd", "invisible"].map((k) => `<button data-s="${k}" class="${st === k ? "active" : ""}">${k}</button>`).join("")}</div>
      <div class="set-sec">Appearance</div>
      <div class="set-row"><div class="lbl"><b>Roundness</b></div><input type="range" class="rng" id="s-radius" min="0" max="180" value="${+localStorage.getItem("dialog_ap_radius") || 100}"></div>
      <div class="set-row"><div class="lbl"><b>Density</b></div><div class="seg" id="s-density">${["comfortable", "dense"].map((k) => `<button data-d="${k}" class="${(localStorage.getItem("dialog_ap_density") || "comfortable") === k ? "active" : ""}">${k === "dense" ? "Compact" : "Comfortable"}</button>`).join("")}</div></div>
      <div class="set-row"><div class="lbl"><b>Animations</b></div><div class="seg" id="s-motion">${["full", "subtle", "off"].map((k) => `<button data-m="${k}" class="${(localStorage.getItem("dialog_ap_motion") || "full") === k ? "active" : ""}">${k}</button>`).join("")}</div></div>
      <div class="set-row"><div class="lbl"><b>Interface size</b></div><div class="seg" id="s-scale">${[["0.9", "S"], ["1", "M"], ["1.1", "L"]].map(([v, l]) => `<button data-sc="${v}" class="${(localStorage.getItem("dialog_ap_scale") || "1") === v ? "active" : ""}">${l}</button>`).join("")}</div></div>
      <div class="set-sec">Danger</div>
      <button class="btn btn-error btn-sm" id="s-logout" style="align-self:flex-start"><span data-ic="logout"></span> Log out</button>`;
    applyIcons($("#set-body"));
    $("#s-save").onclick = async () => { const name = $("#s-name").value.trim(), description = $("#s-desc").value.trim(); const { ok } = await api("/api/profile", { name, description }); if (ok) { me.name = name; me.description = description; $("#me-ava").innerHTML = `<img src="${avaUrl(me.login)}" onerror="this.remove()">${esc(initials(name))}`; toast("Saved"); } };
    $$("#s-status button").forEach((b) => b.onclick = () => { $$("#s-status button").forEach((x) => x.classList.toggle("active", x === b)); me.status = b.dataset.s; socket.emit("set-status", b.dataset.s); api("/api/profile", { status: b.dataset.s }); });
    $("#s-radius").oninput = (e) => { localStorage.setItem("dialog_ap_radius", e.target.value); applyAppearance(); };
    $$("#s-density button").forEach((b) => b.onclick = () => { $$("#s-density button").forEach((x) => x.classList.toggle("active", x === b)); localStorage.setItem("dialog_ap_density", b.dataset.d); applyAppearance(); });
    $$("#s-motion button").forEach((b) => b.onclick = () => { $$("#s-motion button").forEach((x) => x.classList.toggle("active", x === b)); localStorage.setItem("dialog_ap_motion", b.dataset.m); applyAppearance(); });
    $$("#s-scale button").forEach((b) => b.onclick = () => { $$("#s-scale button").forEach((x) => x.classList.toggle("active", x === b)); localStorage.setItem("dialog_ap_scale", b.dataset.sc); applyAppearance(); });
    $("#s-logout").onclick = async () => { await api("/api/logout"); localStorage.removeItem("dialog_token"); location.reload(); };
    $("#settings").classList.remove("hidden");
  }
  function openThemes() {
    $("#set-title").textContent = "Themes";
    const cur = document.documentElement.dataset.theme;
    $("#set-body").innerHTML = `<div class="theme-grid">${THEMES.map(([k, name, sw]) => `<div class="theme-card ${cur === k ? "active" : ""}" data-t="${k}"><div class="theme-sw">${sw.map((c) => `<i style="background:${c}"></i>`).join("")}</div><b>${name}${k === "matrix" ? " ⛶" : ""}</b></div>`).join("")}</div>
      <p class="muted sm" style="margin-top:10px">Full theme builder (blur · glow · animated background · fonts) lands in the next drop.</p>`;
    $$(".theme-card").forEach((c) => c.onclick = () => { applyTheme(c.dataset.t); $$(".theme-card").forEach((x) => x.classList.toggle("active", x === c)); });
    $("#settings").classList.remove("hidden");
  }
  $("#set-close").onclick = () => $("#settings").classList.add("hidden");
  $("#settings").onclick = (e) => { if (e.target.id === "settings") $("#settings").classList.add("hidden"); };
  function closeSheets() { $("#settings").classList.add("hidden"); $("#mp").classList.add("hidden"); }

  /* ---------- nav ---------- */
  $$("[data-nav]").forEach((b) => b.onclick = () => {
    const n = b.dataset.nav; $$(".rail-btn, .dock-btn").forEach((x) => x.classList.toggle("active", x.dataset.nav === n && (n === "chats" || n === "contacts")));
    if (n === "settings") openSettings(); else if (n === "theme") openThemes();
    else if (n === "contacts") { filter = "dm"; $$("#filters .chip").forEach((x) => x.classList.toggle("active", x.dataset.f === "dm")); renderList(); }
    else if (n === "chats") { filter = "all"; $$("#filters .chip").forEach((x) => x.classList.toggle("active", x.dataset.f === "all")); renderList(); }
  });

  /* ================= CALLS (LiveKit) ================= */
  const call = { room: null, active: false, key: null, micOn: true, camOn: false, t0: 0, timer: 0 };
  const tiles = new Map();
  const lkTileId = (id) => (id === me.login ? "me" : id);
  function ensureTile(id, name, isMe) {
    const tid = isMe ? "me" : id; if (tiles.has(tid)) return tiles.get(tid);
    const el = document.createElement("div"); el.className = "tile" + (isMe ? " me" : ""); el.id = "tile-" + tid;
    el.innerHTML = `<div class="avatar t-ava" data-login="${esc(id)}"><img src="${avaUrl(id)}" onerror="this.remove()">${esc(initials(name))}</div><div class="t-name">${esc(name)}${isMe ? " (you)" : ""}</div>`;
    $("#tiles").appendChild(el); tiles.set(tid, el); return el;
  }
  function attachTrack(track, pub, p) {
    const tid = p.isLocal ? "me" : p.identity;
    if (track.kind === "audio") { const a = track.attach(); a.autoplay = true; a.style.display = "none"; document.body.appendChild(a); return; }
    const tile = ensureTile(p.identity, p.name || p.identity, p.isLocal); const v = track.attach(); tile.appendChild(v); const av = tile.querySelector(".t-ava"); if (av) av.style.display = "none";
  }
  function detachTrack(track) { track.detach().forEach((el) => el.remove()); }
  async function startCall(video) {
    if (!active) return; const c = chats.get(active); if (call.active) endCall();
    const LK = window.LivekitClient; if (!LK) return toast("Call library not loaded");
    const { ok, data } = await api("/api/livekit/token?room=" + encodeURIComponent(active), null, "GET");
    if (!ok || !data.enabled) return toast("Calls are not configured");
    const room = new LK.Room({ adaptiveStream: true, dynacast: true });
    call.room = room; call.active = true; call.key = active; call.camOn = !!video;
    const E = LK.RoomEvent;
    room.on(E.TrackSubscribed, attachTrack).on(E.TrackUnsubscribed, detachTrack)
      .on(E.ParticipantConnected, (p) => ensureTile(p.identity, p.name || p.identity, false))
      .on(E.ParticipantDisconnected, (p) => { const el = tiles.get(p.identity); if (el) el.remove(); tiles.delete(p.identity); })
      .on(E.ActiveSpeakersChanged, (sp) => { const ids = new Set(sp.map((s) => s.isLocal ? "me" : s.identity)); $$("#tiles .tile").forEach((t) => t.classList.toggle("speaking", ids.has(t.id.replace("tile-", "")))); })
      .on(E.LocalTrackPublished, (pub) => { if (pub.track.kind === "video") { const tile = ensureTile(me.login, me.name, true); const v = pub.track.attach(); tile.appendChild(v); const av = tile.querySelector(".t-ava"); if (av) av.style.display = "none"; } })
      .on(E.Disconnected, () => { if (call.active) endCall(); });
    $("#call-title").textContent = c.name; $("#tiles").innerHTML = ""; tiles.clear(); ensureTile(me.login, me.name, true);
    $("#call").classList.remove("hidden");
    try {
      await room.connect(data.url, data.token);
      await room.localParticipant.setMicrophoneEnabled(true);
      if (video) await room.localParticipant.setCameraEnabled(true);
      socket.emit("call-join", { title: c.name });
      call.t0 = Date.now(); call.timer = setInterval(() => { const s = Math.floor((Date.now() - call.t0) / 1000); $("#call-timer").textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); }, 1000);
      updateCallBtns();
    } catch (e) { toast("Couldn't join call"); endCall(); }
  }
  function endCall() {
    if (call.room) { try { call.room.disconnect(); } catch {} }
    if (call.active) socket.emit("call-leave");
    clearInterval(call.timer); call.active = false; call.room = null; tiles.clear();
    $("#call").classList.add("hidden"); $("#tiles").innerHTML = ""; $("#call-timer").textContent = "00:00";
    $$("audio").forEach((a) => { if (!a.controls) a.remove(); });
  }
  function updateCallBtns() {
    $("#cb-mic").classList.toggle("off", !call.micOn); $("#cb-mic").dataset.ic = call.micOn ? "mic" : "mic";
    $("#cb-cam").classList.toggle("off", !call.camOn);
  }
  $("#c-call").onclick = () => startCall(false);
  $("#c-video").onclick = () => startCall(true);
  $("#cb-hang").onclick = endCall;
  $("#cb-mic").onclick = async () => { if (!call.room) return; call.micOn = !call.micOn; await call.room.localParticipant.setMicrophoneEnabled(call.micOn); updateCallBtns(); };
  $("#cb-cam").onclick = async () => { if (!call.room) return; call.camOn = !call.camOn; await call.room.localParticipant.setCameraEnabled(call.camOn); if (!call.camOn) { const tile = tiles.get("me"); if (tile) { tile.querySelectorAll("video").forEach((v) => v.remove()); const av = tile.querySelector(".t-ava"); if (av) av.style.display = ""; } } updateCallBtns(); };

  /* incoming */
  let incRoom = null;
  function onIncoming(p) {
    if (call.active) return; incRoom = p.room;
    $("#inc-ava").innerHTML = `<img src="${avaUrl(p.from)}" onerror="this.remove()">${esc(initials(p.name))}`;
    $("#inc-name").textContent = p.name || "Incoming call"; $("#inc-sub").textContent = (p.title || "") + " · ringing…";
    $("#incoming").classList.remove("hidden"); applyIcons($("#incoming"));
    try { navigator.vibrate && navigator.vibrate([300, 200, 300]); } catch {}
  }
  function hideIncoming() { $("#incoming").classList.add("hidden"); incRoom = null; }
  $("#inc-accept").onclick = () => { const r = incRoom; hideIncoming(); if (!r) return; const c = chats.get(r); if (c) { openChat(c); setTimeout(() => startCall(false), 400); } };
  $("#inc-decline").onclick = hideIncoming;
})();
