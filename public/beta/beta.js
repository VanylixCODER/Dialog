/* Dialog 1.1.0 (beta) — new stack, talks to the SAME backend as the classic app. */
(function () {
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  let token = localStorage.getItem("dialog_token") || null;
  let me = null, socket = null;
  const chats = new Map(), presence = new Map();
  let active = null, filter = "all", localId = 0, typingT = 0;
  const pendingFiles = []; const MAX_FILES = 5, MAX_TOTAL = 75 * 1024 * 1024;
  const CHUNK = 25; // must equal server HISTORY_LIMIT
  const REACT_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🔥", "🎉", "👎"];
  const watermarks = new Map(); // login -> { delivered, seen } for the active room
  let oldestId = 0, reachedTop = false, loadingMore = false, wmApplied = false, relationsLoaded = false;
  let relations = { friends: [], incoming: [], sent: [], blocked: [], blockedBy: [] };
  let listMode = "chats"; const pins = new Set();

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
  const DEFCUSTOM = { primary: "#00e0ff", bg: "#070a12", text: "#e8f6ff", secondary: "#7a5cff", blur: 0, glow: 40 };
  const hx = (h) => { h = String(h).replace("#", ""); if (h.length === 3) h = h.split("").map((c) => c + c).join(""); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const shade = (h, p) => { const [r, g, b] = hx(h), f = p / 100, a = (c) => Math.max(0, Math.min(255, Math.round(f < 0 ? c * (1 + f) : c + (255 - c) * f))); return `rgb(${a(r)},${a(g)},${a(b)})`; };
  function getCustom() { try { return { ...DEFCUSTOM, ...JSON.parse(localStorage.getItem("dialog_beta_custom") || "{}") }; } catch { return { ...DEFCUSTOM }; } }
  const R = document.documentElement.style;
  function applyCustom(tk) {
    document.documentElement.dataset.theme = "custom"; stopMatrix();
    R.setProperty("--color-primary", tk.primary); R.setProperty("--color-primary-content", "#04140a");
    R.setProperty("--color-accent", tk.primary); R.setProperty("--color-secondary", tk.secondary);
    R.setProperty("--color-base-100", tk.bg); R.setProperty("--color-base-200", shade(tk.bg, 8)); R.setProperty("--color-base-300", shade(tk.bg, 16));
    R.setProperty("--color-base-content", tk.text); R.setProperty("--g", hx(tk.primary).join(","));
    document.body.classList.toggle("glass", +tk.blur > 0); R.setProperty("--cblur", (+tk.blur || 0) + "px");
    R.setProperty("--cglow", ((+tk.glow || 0) / 100).toFixed(2));
  }
  function applyTheme(k) {
    localStorage.setItem("dialog_beta_theme", k);
    if (k === "custom") { applyCustom(getCustom()); return; }
    ["--color-primary", "--color-primary-content", "--color-accent", "--color-secondary", "--color-base-100", "--color-base-200", "--color-base-300", "--color-base-content", "--g"].forEach((v) => R.removeProperty(v));
    document.body.classList.remove("glass");
    document.documentElement.dataset.theme = k; if (k === "matrix") startMatrix(); else stopMatrix();
  }
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

  // registration
  $("#to-reg").onclick = () => { $("#li-form").classList.add("hidden"); $("#rg-form").classList.remove("hidden"); };
  $("#to-li").onclick = () => { $("#rg-form").classList.add("hidden"); $("#li-form").classList.remove("hidden"); };
  $("#rg-go").onclick = register;
  $("#rg-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") register(); });
  async function register() {
    const login = $("#rg-login").value.trim().toLowerCase(), name = $("#rg-name").value.trim(), email = $("#rg-email").value.trim(), password = $("#rg-pass").value;
    if (!login || !name || !email || !password) { $("#rg-err").textContent = "Fill in all fields"; return; }
    const { ok, data } = await api("/api/register", { login, name, password, email });
    if (!ok) { $("#rg-err").textContent = (data.error || "Registration failed").replace(/_/g, " "); return; }
    token = data.token; localStorage.setItem("dialog_token", token); boot();
  }

  async function boot() {
    const { ok, data } = await api("/api/me");
    if (!ok) { localStorage.removeItem("dialog_token"); token = null; show("login"); return; }
    me = data.profile; show("app"); applyIcons();
    $("#me-ava").innerHTML = `<img src="${avaUrl(me.login)}" onerror="this.remove()">${esc(initials(me.name))}`;
    connect();
    const [dms, grps] = await Promise.all([api("/api/dms"), api("/api/groups")]);
    if (dms.ok && Array.isArray(dms.data)) dms.data.forEach((c) => chats.set(c.key, c));
    if (grps.ok && grps.data.groups) grps.data.groups.forEach((g) => chats.set("@grp:" + g.id, { key: "@grp:" + g.id, type: "group", id: g.id, name: g.name, last: "", ts: 0, unread: 0 }));
    await loadPins(); refreshPresence(); renderList(); loadRelations();
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
    socket.on("more-messages", onMoreMessages);
    socket.on("msg-deleted", ({ id }) => { const el = $(`.m[data-id="${id}"]`); if (el) el.remove(); });
    socket.on("msg-edited", ({ id, text }) => { const el = $(`.m[data-id="${id}"]`); if (!el) return; const b = el.querySelector(".bub"); if (b) b.textContent = text; if (!el.querySelector(".edited-tag")) { const t = el.querySelector(".m-time"); if (t) t.insertAdjacentHTML("afterbegin", '<span class="edited-tag">edited</span> '); } });
    socket.on("msg-reaction", ({ id, reactions }) => { const el = $(`.m[data-id="${id}"]`); if (el) renderReactions(el, reactions); });
    socket.on("watermark", ({ updates }) => applyWatermark(updates || []));
    socket.on("rate-limited", ({ reason }) => toast(reason === "flood" ? "Slow down a bit" : "Message not sent (" + (reason || "rate limited") + ")"));
    socket.on("dm-blocked", (p) => { toast(p.status === "request" || p.status === "pending" ? "Not friends yet — request sent" : "You can't message this user"); });
    socket.on("file-rejected", ({ reason, maxMb }) => toast(reason === "file_too_big" ? "File too big (max " + (maxMb || 75) + " MB)" : "Upload failed"));
    socket.on("banned", (p) => { alert("You have been banned" + (p && p.reason ? ": " + p.reason : "")); localStorage.removeItem("dialog_token"); location.reload(); });
    socket.on("force-logout", () => { localStorage.removeItem("dialog_token"); location.reload(); });
    socket.on("call-replaced", () => { if (call.active) endCall(); toast("Call taken over on another device"); });
    socket.on("call-auto-end", ({ reason } = {}) => { if (call.active) endCall(); toast(reason === "no_answer" ? "No answer" : "Call ended"); });
    socket.on("dm-ping", onDmPing);
    socket.on("relations-changed", () => { if (relationsLoaded) loadRelations(); refreshBadges(); });
    socket.on("group-updated", () => refreshGroups());
    socket.on("profile-updated", ({ login, name, avatarChanged }) => onProfileUpdated(login, name, avatarChanged));
  }
  function onDmPing({ room }) {
    const c = chats.get(room); if (!c) { refreshGroups(); return; }
    if (room !== active) { c.unread = (c.unread || 0) + 1; c.ts = Date.now(); renderList(); }
  }
  async function refreshGroups() {
    const grps = await api("/api/groups");
    if (grps.ok && grps.data.groups) { grps.data.groups.forEach((g) => { const key = "@grp:" + g.id; if (!chats.has(key)) chats.set(key, { key, type: "group", id: g.id, name: g.name, last: "", ts: 0, unread: 0 }); else chats.get(key).name = g.name; }); renderList(); }
  }
  function onProfileUpdated(login, name, avatarChanged) {
    const dm = chats.get(dmKey(login)); if (dm && name) dm.name = name;
    if (avatarChanged) $$(`.avatar[data-login="${login}"] img, .t-ava[data-login="${login}"] img`).forEach((img) => { img.src = avaUrl(login) + "?t=" + Date.now(); });
    renderList();
  }
  function refreshBadges() {
    const n = relations.incoming.length;
    $$('[data-nav="contacts"]').forEach((btn) => {
      let b = btn.querySelector(".nav-badge");
      if (n) { if (!b) { b = document.createElement("span"); b.className = "nav-badge"; btn.style.position = "relative"; btn.appendChild(b); } b.textContent = n > 9 ? "9+" : n; b.style.display = ""; }
      else if (b) b.style.display = "none";
    });
  }
  async function loadRelations() {
    const { ok, data } = await api("/api/relations"); if (!ok) return;
    relations = { friends: data.friends || [], incoming: data.incoming || [], sent: data.sent || [], blocked: data.blocked || [], blockedBy: data.blockedBy || [] };
    relationsLoaded = true; refreshBadges(); if (listMode === "people") renderPeople();
  }

  /* ---------- generic popup menu ---------- */
  function popMenu(e, items) {
    e.preventDefault(); e.stopPropagation(); const menu = $("#ctx-menu");
    menu.innerHTML = items.map((it, i) => `<button class="mm-item ${it.danger ? "danger" : ""}" data-i="${i}">${it.ic ? `<span data-ic="${it.ic}"></span>` : ""}${esc(it.label)}</button>`).join("");
    applyIcons(menu);
    $$(".mm-item", menu).forEach((b) => b.onclick = () => { menu.classList.add("hidden"); items[+b.dataset.i].fn(); });
    menu.classList.remove("hidden");
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    const x = e.touches ? e.touches[0].clientX : e.clientX, y = e.touches ? e.touches[0].clientY : e.clientY;
    menu.style.left = Math.max(8, Math.min(x, innerWidth - mw - 8)) + "px";
    menu.style.top = Math.max(8, Math.min(y, innerHeight - mh - 8)) + "px";
  }
  document.addEventListener("click", (e) => { if (!$("#ctx-menu").contains(e.target)) $("#ctx-menu").classList.add("hidden"); });

  /* ---------- contacts / people ---------- */
  function setListMode(mode) {
    listMode = mode;
    $("#chats").classList.toggle("hidden", mode !== "chats");
    $("#filters").classList.toggle("hidden", mode !== "chats");
    $("#people").classList.toggle("hidden", mode !== "people");
    if (mode === "people") { renderPeople(); loadRelations(); } else renderList();
  }
  function renderPeople() {
    const box = $("#people"); const sec = (t) => `<div class="set-sec">${esc(t)}</div>`;
    const frow = (login, acts) => `<div class="row" data-login="${esc(login)}"><div class="av-wrap">${avaHTML(login, login)}</div><div class="r-mid"><div class="r-name">@${esc(login)}</div></div><div class="r-right prow-acts">${acts}</div></div>`;
    let html = `<button class="btn btn-primary btn-sm gnew-cta" id="ppl-newgroup"><span data-ic="plus"></span> New group</button>`;
    if (relations.incoming.length) { html += sec("Friend requests (" + relations.incoming.length + ")"); relations.incoming.forEach((l) => html += frow(l, `<button class="btn btn-xs btn-primary" data-acc="${esc(l)}">Accept</button><button class="btn btn-xs btn-ghost" data-dec="${esc(l)}">Decline</button>`)); }
    html += sec("Friends (" + relations.friends.length + ")");
    if (!relations.friends.length) html += `<div class="muted sm" style="padding:6px 12px">No friends yet — search people above and hit Add.</div>`;
    relations.friends.forEach((l) => html += frow(l, `<button class="icon-btn sm-ib" data-msg="${esc(l)}" data-ic="chat" data-tip="Message"></button><button class="icon-btn sm-ib" data-grp="${esc(l)}" data-ic="plus" data-tip="New group"></button><button class="icon-btn sm-ib" data-more="${esc(l)}" data-ic="dots"></button>`));
    if (relations.sent.length) { html += sec("Sent requests"); relations.sent.forEach((l) => html += frow(l, `<button class="btn btn-xs btn-ghost" data-cancel="${esc(l)}">Cancel</button>`)); }
    if (relations.blocked.length) { html += sec("Blocked"); relations.blocked.forEach((l) => html += frow(l, `<button class="btn btn-xs btn-ghost" data-unblock="${esc(l)}">Unblock</button>`)); }
    box.innerHTML = html; applyIcons(box);
    $("#ppl-newgroup").onclick = () => openGroupNew(null);
    const rel = async (target, action, ep) => { await api(ep || "/api/friend", { target, action }); loadRelations(); };
    $$("[data-acc]", box).forEach((b) => b.onclick = () => rel(b.dataset.acc, "accept"));
    $$("[data-dec]", box).forEach((b) => b.onclick = () => rel(b.dataset.dec, "decline"));
    $$("[data-cancel]", box).forEach((b) => b.onclick = () => rel(b.dataset.cancel, "remove"));
    $$("[data-unblock]", box).forEach((b) => b.onclick = () => rel(b.dataset.unblock, "unblock", "/api/relations"));
    $$("[data-msg]", box).forEach((b) => b.onclick = () => openDM(b.dataset.msg));
    $$("[data-grp]", box).forEach((b) => b.onclick = (e) => openGroupNew(b.dataset.grp));
    $$("[data-more]", box).forEach((b) => b.onclick = (e) => popMenu(e, [
      { label: "Remove friend", ic: "x", danger: true, fn: () => rel(b.dataset.more, "remove") },
      { label: "Block", ic: "lock2", danger: true, fn: () => rel(b.dataset.more, "block", "/api/relations") },
    ]));
    $$(".row", box).forEach((r) => r.addEventListener("click", (e) => { if (e.target.closest("button")) return; openMP(r.dataset.login); }));
  }

  /* ---------- group creation from a contact ---------- */
  async function openGroupNew(seed) {
    if (!relationsLoaded) await loadRelations();
    const picks = seed ? [seed] : [];
    $("#gnew-body").innerHTML = `<input id="gnew-name" class="set-input" placeholder="Group name" maxlength="64">
      <div class="set-sec">Add members</div>
      <div class="gnew-list">${relations.friends.length ? relations.friends.map((l) => `<label class="gnew-item"><input type="checkbox" data-l="${esc(l)}" ${picks.includes(l) ? "checked" : ""}><span class="av-wrap">${avaHTML(l, l)}</span><span>@${esc(l)}</span></label>`).join("") : '<div class="muted sm">Add some friends first to invite them.</div>'}</div>
      <button class="btn btn-primary btn-sm" id="gnew-create" style="align-self:flex-start">Create group</button>`;
    applyIcons($("#gnew-body"));
    $("#gnew-create").onclick = async () => {
      const name = $("#gnew-name").value.trim(); if (!name) return toast("Enter a group name");
      const members = $$("#gnew-body input[type=checkbox]:checked").map((c) => c.dataset.l);
      const { ok, data } = await api("/api/groups", { name, members: members.join(",") });
      if (ok && data.id) { const key = "@grp:" + data.id; chats.set(key, { key, type: "group", id: data.id, name, last: "", ts: Date.now(), unread: 0 }); $("#gnew").classList.add("hidden"); setListMode("chats"); openChat(chats.get(key)); toast("Group created"); }
      else toast(data.error ? data.error.replace(/_/g, " ") : "Couldn't create group");
    };
    $("#gnew").classList.remove("hidden");
  }
  $("#gnew-close").onclick = () => $("#gnew").classList.add("hidden");
  $("#gnew").onclick = (e) => { if (e.target.id === "gnew") $("#gnew").classList.add("hidden"); };

  /* ---------- pins ---------- */
  async function loadPins() { const { ok, data } = await api("/api/pins"); if (ok && Array.isArray(data)) { pins.clear(); data.forEach((k) => pins.add(k)); } }
  const savePins = () => api("/api/pins", { keys: [...pins] });
  function openRowMenu(e, c) {
    const pinned = pins.has(c.key);
    popMenu(e, [
      { label: pinned ? "Unpin" : "Pin to top", ic: "check", fn: () => { pinned ? pins.delete(c.key) : pins.add(c.key); savePins(); renderList(); } },
      { label: "Mark as read", ic: "check", fn: () => { c.unread = 0; renderList(); } },
    ]);
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
    }).sort((a, b) => (pins.has(b.key) - pins.has(a.key)) || ((b.ts || 0) - (a.ts || 0)));
    for (const c of list) {
      const li = document.createElement("li"); li.className = "row" + (c.key === active ? " active" : ""); li.dataset.key = c.key;
      if (c.type === "dm") li.dataset.login = c.login;
      const ava = c.type === "group" ? `<div class="avatar" data-gid="${c.id}"><img src="/api/group-avatar/${c.id}" onerror="this.remove()">${esc(initials(c.name))}</div>` : avaHTML(c.login, c.name);
      const st = c.type === "dm" ? `<span class="dot ${presence.get(c.login) || "offline"}" style="right:-2px;bottom:-2px"></span>` : "";
      const pin = pins.has(c.key) ? '<span class="pin-ic" data-ic="check"></span>' : "";
      li.innerHTML = `<div class="av-wrap">${ava}${st}</div>
        <div class="r-mid"><div class="r-name">${esc(c.name)}${c._call ? ' <span class="badge badge-success badge-xs">call</span>' : ""}</div><div class="r-last">${esc(c.last || (c.type === "group" ? "Group" : ""))}</div></div>
        <div class="r-right">${pin}${c.ts ? `<span class="r-time">${fmtTime(c.ts)}</span>` : ""}${c.unread ? `<span class="badge badge-primary badge-sm">${c.unread}</span>` : ""}</div>`;
      li.onclick = () => openChat(c);
      li.addEventListener("contextmenu", (e) => openRowMenu(e, c));
      let lp; li.addEventListener("touchstart", (e) => { lp = setTimeout(() => openRowMenu(e, c), 500); }, { passive: true });
      ["touchend", "touchmove", "touchcancel"].forEach((ev) => li.addEventListener(ev, () => clearTimeout(lp)));
      li.querySelector(".avatar").onclick = (e) => { if (c.type === "dm") { e.stopPropagation(); openMP(c.login); } };
      ul.appendChild(li);
    }
    if (listMode === "chats") applyIcons(ul);
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
    active = c.key; c.unread = 0; oldestId = 0; reachedTop = false; loadingMore = false; wmApplied = false; watermarks.clear();
    socket.emit("join", { token, room: c.key });
    $("#empty").classList.add("hidden"); $("#conv").classList.remove("hidden");
    $("#c-name").textContent = c.name; $("#c-sub").textContent = c.type === "group" ? "Group" : (presence.get(c.login) || "offline");
    $("#c-ava").innerHTML = `<img src="${avaUrl(c.login)}" onerror="this.remove()">${esc(initials(c.name))}`;
    $("#c-ava").onclick = () => { if (c.type === "dm") openMP(c.login); };
    $("#c-call").style.display = $("#c-video").style.display = ""; // (group calls allowed too)
    $("#msgs").innerHTML = '<div class="skeleton" style="height:40px;border-radius:12px;margin:8px 0"></div>';
    $("#app").classList.add("in-chat"); renderList();
  }
  $("#c-back").onclick = () => { $("#app").classList.remove("in-chat"); active = null; };

  const SYS = ["call_started", "call_ended", "call_missed", "join", "leave"];
  const sysText = (m) => ({ call_started: "📞 Call started", call_ended: "📞 Call ended" + (m.text ? " · " + m.text : ""), call_missed: "📞 Missed call" + (m.text ? " · " + m.text : ""), join: (m.name || "Someone") + " joined", leave: (m.name || "Someone") + " left" }[m.type] || m.type);
  const preview = (m) => SYS.includes(m.type) ? sysText(m) : m.type === "text" ? m.text : m.type === "image" || m.type === "gif" ? "🖼 Photo" : m.type === "video" ? "🎬 Video" : m.type === "audio" ? "🎤 Voice" : "📎 " + (m.mediaName || "File");
  const URL_RE = /(https?:\/\/[^\s]+)/i;
  const textHTML = (t) => esc(t).replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer" class="in-link">${u}</a>`);
  function bodyHTML(m) {
    if (m.type === "text") return `<div class="bub">${textHTML(m.text)}</div>`;
    if (m.type === "image" || m.type === "gif") return `<div class="bub bub-media"><img src="${m.media}" alt="" loading="lazy"></div>`;
    if (m.type === "video") return `<div class="bub bub-media"><video src="${m.media}" controls></video></div>`;
    if (m.type === "audio") return `<div class="bub m-file"><span data-ic="mic"></span><audio controls src="${m.media}"></audio></div>`;
    return `<a class="bub m-file" href="${m.media}" download="${esc(m.mediaName || "file")}"><span data-ic="clip"></span>${esc(m.mediaName || "file")}</a>`;
  }
  function buildMsg(m) {
    const el = document.createElement("div");
    if (SYS.includes(m.type)) { el.className = "sys-line"; if (m.id != null) el.dataset.id = m.id; el.innerHTML = `<span>${esc(sysText(m))}</span>`; return el; }
    const mine = me && m.fromLogin === me.login;
    el.className = "m" + (mine ? " me" : ""); el.dataset.type = m.type;
    if (m.localId != null) el.dataset.local = m.localId; if (m.id != null) el.dataset.id = m.id;
    const who = (!mine && chats.get(active)?.type === "group") ? `<div class="who">${esc(m.name)}</div>` : "";
    const tick = mine ? '<span class="m-ticks" data-st="sent">✓</span>' : "";
    const editTag = m.edited ? '<span class="edited-tag">edited</span> ' : "";
    el.innerHTML = (mine ? "" : avaHTML(m.fromLogin, m.name)) + `<div class="m-body">${who}${bodyHTML(m)}<div class="reactions"></div><div class="m-time">${editTag}${fmtTime(m.ts)}${tick}</div></div>`;
    applyIcons(el);
    if (m.reactions) renderReactions(el, m.reactions);
    if (m.type === "text" && URL_RE.test(m.text)) maybeLinkPreview(el, m.text);
    el.addEventListener("contextmenu", (e) => openMsgMenu(e, el));
    let lp; el.addEventListener("touchstart", (e) => { lp = setTimeout(() => openMsgMenu(e, el), 450); }, { passive: true });
    ["touchend", "touchmove", "touchcancel"].forEach((ev) => el.addEventListener(ev, () => clearTimeout(lp)));
    return el;
  }
  function addMsg(m, animate) {
    const box = $("#msgs"), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    const el = buildMsg(m); if (!animate) el.style.animation = "none";
    box.appendChild(el); const mine = me && m.fromLogin === me.login; if (atBottom || mine) box.scrollTop = box.scrollHeight;
    return el;
  }
  function renderHistory(list) {
    const box = $("#msgs"); box.innerHTML = "";
    reachedTop = list.length < CHUNK;
    if (!list.length) { box.innerHTML = '<div class="empty muted" style="flex:1">No messages yet — say hi 👋</div>'; return; }
    oldestId = list[0].id || 0;
    list.forEach((m) => addMsg(m, false)); box.scrollTop = box.scrollHeight;
    refreshOutgoingStatuses();
    const c = chats.get(active), last = list[list.length - 1]; if (c && last) { c.last = preview(last); c.ts = last.ts; renderList(); }
    ackReceipts(list);
  }
  function onMoreMessages({ msgs, before }) {
    loadingMore = false; const box = $("#msgs");
    if (!msgs || !msgs.length) { reachedTop = true; return; }
    if (msgs.length < CHUNK) reachedTop = true;
    oldestId = msgs[0].id || oldestId;
    const prevH = box.scrollHeight, anchor = box.firstChild;
    msgs.forEach((m) => box.insertBefore(buildMsg(m), anchor));
    box.scrollTop += box.scrollHeight - prevH;
    refreshOutgoingStatuses();
  }
  $("#msgs").addEventListener("scroll", () => {
    const box = $("#msgs");
    if (box.scrollTop < 60 && !reachedTop && !loadingMore && oldestId) { loadingMore = true; socket.emit("load-more", { before: oldestId }); }
  });
  function onMessage(m) {
    const room = m.room || active, c = chats.get(room);
    if (room === active || !m.room) { addMsg(m, true); refreshOutgoingStatuses(); ackReceipts([m]); }
    if (c) { c.last = preview(m); c.ts = m.ts || Date.now(); if (room !== active) c.unread = (c.unread || 0) + 1; renderList(); }
  }
  function sendText() {
    const inp = $("#c-input"), text = inp.value.trim(); if (!text || !active) return;
    const lid = ++localId; addMsg({ localId: lid, fromLogin: me.login, name: me.name, ts: Date.now(), type: "text", text }, true);
    socket.emit("message", { type: "text", text, localId: lid }); inp.value = ""; socket.emit("typing", false);
  }

  /* ---------- reactions ---------- */
  function renderReactions(el, reactions) {
    const bar = el.querySelector(".reactions"); if (!bar) return; bar.innerHTML = "";
    for (const [emoji, logins] of Object.entries(reactions || {})) {
      if (!logins || !logins.length) continue;
      const mineR = me && logins.includes(me.login);
      const chip = document.createElement("button"); chip.className = "reaction" + (mineR ? " mine" : "");
      chip.textContent = emoji + " " + logins.length;
      chip.onclick = () => socket.emit("msg-react", { id: +el.dataset.id, emoji });
      bar.appendChild(chip);
    }
  }

  /* ---------- read receipts (ticks + watermark) ---------- */
  function ackReceipts(list) {
    const ids = list.map((m) => +m.id).filter(Boolean); if (!ids.length) return;
    const maxId = Math.max(...ids);
    socket.emit("delivery", { maxId });
    if (document.visibilityState === "visible" && active && me && me.prefReadReceipts !== false) socket.emit("seen", { maxId });
  }
  function sendSeen() {
    if (document.visibilityState !== "visible" || !active || !me || me.prefReadReceipts === false) return;
    const ids = $$("#msgs .m[data-id]").map((e) => +e.dataset.id).filter(Boolean); if (ids.length) socket.emit("seen", { maxId: Math.max(...ids) });
  }
  document.addEventListener("visibilitychange", sendSeen); addEventListener("focus", sendSeen);
  function applyWatermark(updates) {
    let advanced = !wmApplied;
    updates.forEach((u) => { if (u.login === me.login) return; const cur = watermarks.get(u.login) || { delivered: 0, seen: 0 }; const nd = Math.max(cur.delivered, +u.delivered || 0), ns = Math.max(cur.seen, +u.seen || 0); if (nd > cur.delivered || ns > cur.seen) advanced = true; watermarks.set(u.login, { delivered: nd, seen: ns }); });
    wmApplied = true; if (advanced) refreshOutgoingStatuses();
  }
  function refreshOutgoingStatuses() {
    if (!watermarks.size) return;
    let minD = Infinity, minS = Infinity;
    watermarks.forEach((w) => { if (w.delivered < minD) minD = w.delivered; if (w.seen < minS) minS = w.seen; });
    if (minD === Infinity) { minD = 0; minS = 0; }
    $$("#msgs .m.me[data-id]").forEach((el) => {
      const id = +el.dataset.id, t = el.querySelector(".m-ticks"); if (!t) return;
      const st = minS >= id ? "read" : minD >= id ? "delivered" : "sent";
      t.dataset.st = st; t.textContent = st === "sent" ? "✓" : "✓✓";
    });
  }

  /* ---------- message context menu ---------- */
  function openMsgMenu(e, el) {
    e.preventDefault();
    const menu = $("#msg-menu"), mine = el.classList.contains("me"), id = el.dataset.id, type = el.dataset.type;
    menu._el = el;
    const showOwn = mine && id;
    menu.querySelector('[data-act="edit"]').style.display = showOwn && type === "text" ? "" : "none";
    menu.querySelector('[data-act="delete"]').style.display = showOwn ? "" : "none";
    menu.querySelector('[data-act="copy"]').style.display = type === "text" ? "" : "none";
    const rr = $("#react-row"); rr.innerHTML = REACT_EMOJIS.map((em) => `<button data-em="${em}">${em}</button>`).join("");
    $$("#react-row button").forEach((b) => b.onclick = () => { if (id) socket.emit("msg-react", { id: +id, emoji: b.dataset.em }); closeMsgMenu(); });
    menu.classList.remove("hidden");
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let x = e.touches ? e.touches[0].clientX : e.clientX, y = e.touches ? e.touches[0].clientY : e.clientY;
    menu.style.left = Math.max(8, Math.min(x, innerWidth - mw - 8)) + "px";
    menu.style.top = Math.max(8, Math.min(y, innerHeight - mh - 8)) + "px";
  }
  function closeMsgMenu() { $("#msg-menu").classList.add("hidden"); }
  $$("#msg-menu .mm-item").forEach((b) => b.onclick = () => {
    const menu = $("#msg-menu"), el = menu._el; if (!el) return; const id = el.dataset.id, act = b.dataset.act;
    if (act === "copy") { navigator.clipboard && navigator.clipboard.writeText(el.querySelector(".bub")?.textContent || ""); toast("Copied"); }
    else if (act === "edit") { const cur = el.querySelector(".bub")?.textContent || ""; const nt = prompt("Edit message", cur); if (nt != null && nt.trim() && id) socket.emit("msg-edit", { id: +id, text: nt.trim() }); }
    else if (act === "delete") { if (id && confirm("Delete this message?")) socket.emit("msg-delete", { id: +id }); }
    closeMsgMenu();
  });
  document.addEventListener("click", (e) => { if (!$("#msg-menu").contains(e.target)) closeMsgMenu(); });
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

  /* ---------- link previews ---------- */
  function maybeLinkPreview(el, text) {
    const m = text && text.match(URL_RE); if (!m) return; const url = m[1];
    api("/api/link-preview?url=" + encodeURIComponent(url)).then(({ ok, data }) => {
      if (!ok || !data || (!data.title && !data.image)) return;
      const body = el.querySelector(".m-body"); if (!body || body.querySelector(".link-preview")) return;
      const a = document.createElement("a"); a.className = "link-preview"; a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.innerHTML = `${data.image ? `<img src="${esc(data.image)}" onerror="this.remove()">` : ""}<div class="lp-meta"><div class="lp-site muted">${esc(data.site || "")}</div><div class="lp-title">${esc(data.title || "")}</div><div class="lp-desc muted">${esc(data.description || "")}</div></div>`;
      body.insertBefore(a, body.querySelector(".reactions"));
    });
  }

  /* ---------- emoji · GIF · voice ---------- */
  const EMOJI = "😀 😁 😂 🤣 😊 😍 😘 😎 🤗 🤔 😐 😴 😭 😡 🥺 😅 😬 🤯 🥳 😇 🤩 😤 👍 👎 👏 🙏 💪 🔥 ✨ 🎉 ❤️ 🧡 💛 💚 💙 💜 💔 ⭐ ✅ ❌ ⚡ 👀 💯 🙌 🤝 🎁 📌 ☕ 🍕 🚀".split(" ");
  function positionPop(p, anchor) {
    p.classList.remove("hidden"); const ar = anchor.getBoundingClientRect(), pw = p.offsetWidth, ph = p.offsetHeight;
    let left = Math.max(8, Math.min(ar.left, innerWidth - pw - 8)), top = ar.top - ph - 8; if (top < 8) top = ar.bottom + 8;
    p.style.left = left + "px"; p.style.top = top + "px";
  }
  function insertAtCaret(inp, txt) {
    const s = inp.selectionStart ?? inp.value.length, e = inp.selectionEnd ?? inp.value.length;
    inp.value = inp.value.slice(0, s) + txt + inp.value.slice(e); inp.selectionStart = inp.selectionEnd = s + txt.length; inp.focus();
  }
  $("#c-emoji").onclick = (ev) => {
    ev.stopPropagation(); const p = $("#emoji-pop"); if (!p.classList.contains("hidden")) return p.classList.add("hidden");
    $("#gif-pop").classList.add("hidden");
    p.innerHTML = EMOJI.map((e) => `<button type="button">${e}</button>`).join("");
    $$("#emoji-pop button").forEach((b) => b.onclick = () => insertAtCaret($("#c-input"), b.textContent));
    positionPop(p, $("#c-emoji"));
  };
  let gifT;
  $("#c-gif").onclick = (ev) => {
    ev.stopPropagation(); const p = $("#gif-pop"); if (!p.classList.contains("hidden")) return p.classList.add("hidden");
    $("#emoji-pop").classList.add("hidden"); positionPop(p, $("#c-gif")); $("#gif-q").value = ""; loadGifs(""); setTimeout(() => $("#gif-q").focus(), 30);
  };
  $("#gif-q").oninput = (e) => { clearTimeout(gifT); const q = e.target.value; gifT = setTimeout(() => loadGifs(q), 300); };
  $("#gif-q").onclick = (e) => e.stopPropagation();
  async function loadGifs(q) {
    const grid = $("#gif-grid"); grid.innerHTML = '<div class="muted sm" style="padding:8px">Loading…</div>';
    const { ok, data } = await api("/api/gif?q=" + encodeURIComponent(q));
    if (!ok) return (grid.innerHTML = '<div class="muted sm" style="padding:8px">Failed to load</div>');
    if (data.nokey) return (grid.innerHTML = '<div class="muted sm" style="padding:8px">GIFs aren\'t configured on this server</div>');
    const res = data.results || [];
    grid.innerHTML = res.length ? res.map((g) => `<img src="${esc(g.preview)}" data-url="${esc(g.url)}" loading="lazy">`).join("") : '<div class="muted sm" style="padding:8px">No results</div>';
    $$("#gif-grid img").forEach((im) => im.onclick = () => sendGif(im.dataset.url));
  }
  function sendGif(url) {
    if (!active) return; const lid = ++localId;
    addMsg({ localId: lid, fromLogin: me.login, name: me.name, ts: Date.now(), type: "gif", media: url }, true);
    socket.emit("message", { type: "gif", media: url, localId: lid }); $("#gif-pop").classList.add("hidden");
  }
  document.addEventListener("click", (e) => {
    if (!$("#emoji-pop").contains(e.target) && e.target !== $("#c-emoji") && !$("#c-emoji").contains(e.target)) $("#emoji-pop").classList.add("hidden");
    if (!$("#gif-pop").contains(e.target) && e.target !== $("#c-gif") && !$("#c-gif").contains(e.target)) $("#gif-pop").classList.add("hidden");
  });

  let rec = null, recChunks = [];
  $("#c-mic").onclick = async () => {
    if (rec) { rec.stop(); return; }
    if (!active) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) return toast("Voice not supported here");
    let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return toast("Microphone blocked"); }
    recChunks = []; rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop()); $("#c-mic").classList.remove("recording");
      const blob = new Blob(recChunks, { type: (rec && rec.mimeType) || "audio/webm" }); rec = null;
      if (!blob.size) return;
      if (blob.size > MAX_TOTAL) return toast("Recording too large");
      const r = new FileReader(); r.onload = () => { const lid = ++localId; addMsg({ localId: lid, fromLogin: me.login, name: me.name, ts: Date.now(), type: "audio", media: r.result, mediaName: "voice message" }, true); socket.emit("message", { type: "audio", media: r.result, mediaName: "voice message", localId: lid }); }; r.readAsDataURL(blob);
    };
    rec.start(); $("#c-mic").classList.add("recording"); toast("Recording… tap the mic again to send");
  };

  /* ---------- mini-profile (right-mirrored) + group-from-contact ---------- */
  async function openMP(login) {
    if (!login || login === me.login) return;
    const { ok, data } = await api("/api/profile/" + encodeURIComponent(login)); if (!ok) return;
    $("#mp-ava").innerHTML = `<img src="${avaUrl(login)}" onerror="this.remove()">${esc(initials(data.name))}`;
    $("#mp-name").textContent = data.name; $("#mp-tag").textContent = "@" + data.login;
    const st = presence.get(login) || data.status || "offline"; $("#mp-status").innerHTML = `<span class="dot ${st}" style="position:static;display:inline-block;margin-right:6px"></span>${st}`;
    $("#mp-desc").textContent = data.description || "No description."; $("#mp-joined").textContent = data.created_at ? "Joined " + new Date(data.created_at).toLocaleDateString() : "";
    $("#mp-msg").onclick = () => { $("#mp").classList.add("hidden"); openDM(login, data.name); };
    const add = $("#mp-add"); add.disabled = false; add.onclick = null;
    const done = (msg) => { loadRelations(); toast(msg); $("#mp").classList.add("hidden"); };
    if (relations.friends.includes(login)) { add.textContent = "Friends ✓"; add.disabled = true; }
    else if (relations.incoming.includes(login)) { add.textContent = "Accept request"; add.onclick = async () => { await api("/api/friend", { target: login, action: "accept" }); done("You're now friends"); }; }
    else if (relations.sent.includes(login)) { add.textContent = "Requested"; add.disabled = true; }
    else { add.textContent = "Add friend"; add.onclick = async () => { const { ok, data: d } = await api("/api/friend", { target: login, action: "request" }); ok ? done("Friend request sent") : toast(d.error === "req_blocked" ? "They don't accept requests" : "Couldn't send request"); }; }
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
    const cur = localStorage.getItem("dialog_beta_theme") || "dialog"; const tk = getCustom();
    $("#set-body").innerHTML = `<div class="theme-grid">${THEMES.map(([k, name, sw]) => `<div class="theme-card ${cur === k ? "active" : ""}" data-t="${k}"><div class="theme-sw">${sw.map((c) => `<i style="background:${c}"></i>`).join("")}</div><b>${name}${k === "matrix" ? " ⛶" : ""}</b></div>`).join("")}
        <div class="theme-card ${cur === "custom" ? "active" : ""}" data-t="custom"><div class="theme-sw"><i style="background:${tk.primary}"></i><i style="background:${tk.bg}"></i><i style="background:${tk.secondary}"></i></div><b>Custom ✎</b></div></div>
      <div class="set-sec">Theme builder</div>
      <div class="set-row"><div class="lbl"><b>Primary</b></div><input type="color" id="b-primary" value="${tk.primary}"></div>
      <div class="set-row"><div class="lbl"><b>Secondary</b></div><input type="color" id="b-secondary" value="${tk.secondary}"></div>
      <div class="set-row"><div class="lbl"><b>Background</b></div><input type="color" id="b-bg" value="${tk.bg}"></div>
      <div class="set-row"><div class="lbl"><b>Text</b></div><input type="color" id="b-text" value="${tk.text}"></div>
      <div class="set-row"><div class="lbl"><b>Transparency / blur</b></div><input type="range" class="rng" id="b-blur" min="0" max="24" value="${tk.blur}"></div>
      <div class="set-row"><div class="lbl"><b>Glow</b></div><input type="range" class="rng" id="b-glow" min="0" max="100" value="${tk.glow}"></div>
      <button class="btn btn-primary btn-sm" id="b-apply" style="align-self:flex-start">Apply custom theme</button>`;
    $$(".theme-card").forEach((c) => c.onclick = () => { applyTheme(c.dataset.t); $$(".theme-card").forEach((x) => x.classList.toggle("active", x === c)); });
    const readB = () => ({ primary: $("#b-primary").value, secondary: $("#b-secondary").value, bg: $("#b-bg").value, text: $("#b-text").value, blur: +$("#b-blur").value, glow: +$("#b-glow").value });
    const liveB = () => { const t = readB(); localStorage.setItem("dialog_beta_custom", JSON.stringify(t)); applyCustom(t); $$(".theme-card").forEach((x) => x.classList.toggle("active", x.dataset.t === "custom")); };
    ["b-primary", "b-secondary", "b-bg", "b-text", "b-blur", "b-glow"].forEach((id) => $("#" + id).addEventListener("input", liveB));
    $("#b-apply").onclick = () => { liveB(); localStorage.setItem("dialog_beta_theme", "custom"); toast("Custom theme applied"); };
    $("#settings").classList.remove("hidden");
  }
  $("#set-close").onclick = () => $("#settings").classList.add("hidden");
  $("#settings").onclick = (e) => { if (e.target.id === "settings") $("#settings").classList.add("hidden"); };
  function closeSheets() { $("#settings").classList.add("hidden"); $("#mp").classList.add("hidden"); $("#gnew").classList.add("hidden"); }

  /* ---------- nav ---------- */
  $$("[data-nav]").forEach((b) => b.onclick = () => {
    const n = b.dataset.nav; $$(".rail-btn, .dock-btn").forEach((x) => x.classList.toggle("active", x.dataset.nav === n && (n === "chats" || n === "contacts")));
    if (n === "settings") openSettings(); else if (n === "theme") openThemes();
    else if (n === "contacts") setListMode("people");
    else if (n === "chats") { filter = "all"; $$("#filters .chip").forEach((x) => x.classList.toggle("active", x.dataset.f === "all")); setListMode("chats"); }
  });

  /* ================= CALLS (LiveKit) ================= */
  const call = { room: null, active: false, key: null, micOn: true, camOn: false, screenOn: false, deaf: false, t0: 0, timer: 0 };
  const tiles = new Map();
  const lkTileId = (id) => (id === me.login ? "me" : id);
  const setIc = (btn, name) => { if (window.BIC && window.BIC[name]) { btn.innerHTML = window.BIC[name]; btn.dataset.ic = name; btn.dataset.icDone = "1"; } };
  const SCREEN = "screen_share";
  const isScreen = (pub, track) => (pub && pub.source === SCREEN) || (track && track.source === SCREEN);
  function ensureTile(id, name, isMe, screen) {
    const tid = (isMe ? "me" : id) + (screen ? "-screen" : ""); if (tiles.has(tid)) return tiles.get(tid);
    const el = document.createElement("div"); el.className = "tile" + (isMe ? " me" : "") + (screen ? " screen" : ""); el.id = "tile-" + tid;
    el.innerHTML = `<div class="avatar t-ava" data-login="${esc(id)}"><img src="${avaUrl(id)}" onerror="this.remove()">${esc(initials(name))}</div><div class="t-name">${esc(name)}${isMe ? " (you)" : ""}${screen ? " · screen" : ""}</div>`;
    $("#tiles").appendChild(el); tiles.set(tid, el); return el;
  }
  function attachTrack(track, pub, p) {
    if (track.kind === "audio") { const a = track.attach(); a.autoplay = true; a.muted = call.deaf; a.style.display = "none"; a.dataset.remoteAudio = "1"; document.body.appendChild(a); return; }
    const screen = isScreen(pub, track);
    const tile = ensureTile(p.identity, p.name || p.identity, p.isLocal, screen);
    const v = track.attach(); v.playsInline = true; if (p.isLocal) v.muted = true; tile.appendChild(v);
    const av = tile.querySelector(".t-ava"); if (av) av.style.display = "none";
  }
  function detachTrack(track) { track.detach().forEach((el) => el.remove()); cleanupTiles(); }
  function cleanupTiles() {
    $$("#tiles .tile").forEach((t) => {
      if (t.querySelector("video")) return;
      if (t.id.endsWith("-screen")) { tiles.delete(t.id.replace("tile-", "")); t.remove(); }
      else { const av = t.querySelector(".t-ava"); if (av) av.style.display = ""; }
    });
  }
  async function startCall(video) {
    if (!active) return; const c = chats.get(active); if (call.active) endCall();
    const LK = window.LivekitClient; if (!LK) return toast("Call library not loaded");
    const { ok, data } = await api("/api/livekit/token?room=" + encodeURIComponent(active), null, "GET");
    if (!ok || !data.enabled) return toast("Calls are not configured");
    const room = new LK.Room({ adaptiveStream: true, dynacast: true });
    call.room = room; call.active = true; call.key = active; call.micOn = true; call.camOn = !!video; call.screenOn = false; call.deaf = false;
    const E = LK.RoomEvent;
    room.on(E.TrackSubscribed, attachTrack).on(E.TrackUnsubscribed, detachTrack)
      .on(E.ParticipantConnected, (p) => ensureTile(p.identity, p.name || p.identity, false))
      .on(E.ParticipantDisconnected, (p) => { ["", "-screen"].forEach((suf) => { const el = tiles.get(p.identity + suf); if (el) el.remove(); tiles.delete(p.identity + suf); }); })
      .on(E.ActiveSpeakersChanged, (sp) => { const ids = new Set(sp.map((s) => s.isLocal ? "me" : s.identity)); $$("#tiles .tile").forEach((t) => t.classList.toggle("speaking", ids.has(t.id.replace("tile-", "")))); })
      .on(E.LocalTrackPublished, (pub) => { if (pub.track && pub.track.kind === "video") { const screen = isScreen(pub, pub.track); const tile = ensureTile(me.login, me.name, true, screen); const v = pub.track.attach(); v.playsInline = true; v.muted = true; tile.appendChild(v); const av = tile.querySelector(".t-ava"); if (av) av.style.display = "none"; } })
      .on(E.LocalTrackUnpublished, (pub) => { if (pub.track) pub.track.detach().forEach((el) => el.remove()); cleanupTiles(); })
      .on(E.Disconnected, () => { if (call.active) endCall(); });
    $("#call-title").textContent = c.name; $("#tiles").innerHTML = ""; tiles.clear(); ensureTile(me.login, me.name, true);
    $("#call").classList.remove("hidden"); updateCallBtns();
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
    clearInterval(call.timer); call.active = false; call.room = null; call.screenOn = false; call.deaf = false; tiles.clear();
    $("#call").classList.remove("big"); $("#call").classList.add("hidden"); $("#tiles").innerHTML = ""; $("#call-timer").textContent = "00:00";
    $$("audio[data-remote-audio]").forEach((a) => a.remove());
  }
  function updateCallBtns() {
    const mic = $("#cb-mic"); mic.classList.toggle("off", !call.micOn); setIc(mic, call.micOn ? "mic" : "micOff");
    const cam = $("#cb-cam"); cam.classList.toggle("off", !call.camOn); setIc(cam, "video");
    const sc = $("#cb-screen"); sc.classList.toggle("active", !!call.screenOn); setIc(sc, call.screenOn ? "screenOff" : "screen");
    const df = $("#cb-deaf"); df.classList.toggle("off", !!call.deaf); setIc(df, call.deaf ? "headphonesOff" : "headphones");
  }
  $("#c-call").onclick = () => startCall(false);
  $("#c-video").onclick = () => startCall(true);
  $("#call-fs").onclick = () => $("#call").classList.toggle("big"); // side-dock ⇄ big screen
  $("#cb-hang").onclick = endCall;
  $("#cb-mic").onclick = async () => { if (!call.room) return; call.micOn = !call.micOn; await call.room.localParticipant.setMicrophoneEnabled(call.micOn); updateCallBtns(); };
  $("#cb-cam").onclick = async () => { if (!call.room) return; call.camOn = !call.camOn; await call.room.localParticipant.setCameraEnabled(call.camOn); if (!call.camOn) { const tile = tiles.get("me"); if (tile) { tile.querySelectorAll("video").forEach((v) => v.remove()); const av = tile.querySelector(".t-ava"); if (av) av.style.display = ""; } } updateCallBtns(); };
  $("#cb-screen").onclick = async () => {
    if (!call.room) return;
    try { call.screenOn = !call.screenOn; await call.room.localParticipant.setScreenShareEnabled(call.screenOn); }
    catch (e) { call.screenOn = false; toast("Screen share cancelled"); cleanupTiles(); }
    updateCallBtns();
  };
  $("#cb-deaf").onclick = async () => {
    if (!call.room) return; call.deaf = !call.deaf;
    $$("audio[data-remote-audio]").forEach((a) => a.muted = call.deaf);
    if (call.deaf && call.micOn) { call.micOn = false; try { await call.room.localParticipant.setMicrophoneEnabled(false); } catch {} }
    updateCallBtns();
  };

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
  $("#inc-dnd").onclick = () => { hideIncoming(); me.status = "dnd"; socket.emit("set-status", "dnd"); api("/api/profile", { status: "dnd" }); toast("Declined · set to Do Not Disturb"); };
})();
