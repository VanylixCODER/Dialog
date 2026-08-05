// ============================================================================
// Servers — spaces with their own channels, roles and members.
//
// Layout note: this is deliberately NOT Discord's furniture. The server rail is a
// HORIZONTAL strip across the top of the contact list (not a vertical bar on the far
// left), the channel list takes over the same column the chats normally live in, and
// members reuse the existing info panel on the right. Channels are ordinary rooms
// ("@ch:<id>"), so messages, calls, pins, search and activities all work in them
// without a second implementation.
//
// Loaded after app.js; uses its globals ($, t, api, socket, profile, notify, openChat,
// escapeHtml, initials, avaUrl, renderChatList).
// ============================================================================
(function () {
  const S = { list: [], cur: null, data: null, channel: null };
  const P = { MANAGE_SERVER: 1, MANAGE_ROLES: 2, KICK: 4, CREATE_VOICE: 8, POST_NEWS: 16 };
  const can = (bit) => !!(S.data && (S.data.owner || (S.data.perms & bit) === bit));

  const railEl = () => $("serverRail");
  const panelEl = () => $("serverPanel");

  // ---- Rail ----
  async function loadServers() {
    const { ok, data } = await api("/api/servers", null, "GET");
    S.list = ok ? (data.servers || []) : [];
    renderRail();
  }
  function renderRail() {
    const rail = railEl(); if (!rail) return;
    rail.innerHTML = "";
    for (const srv of S.list) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "srv-pill" + (S.cur === srv.id ? " on" : "");
      b.title = srv.name;
      b.innerHTML = `<img src="/api/server-icon/${srv.id}" onerror="this.remove()"><span>${escapeHtml((srv.name || "?").slice(0, 2).toUpperCase())}</span>`;
      b.onclick = () => openServer(srv.id);
      rail.appendChild(b);
    }
    const add = document.createElement("button");
    add.type = "button"; add.className = "srv-pill srv-add"; add.title = t("srv_new");
    add.textContent = "+";
    add.onclick = createServerFlow;
    rail.appendChild(add);
    const browse = document.createElement("button");
    browse.type = "button"; browse.className = "srv-pill srv-browse"; browse.title = t("srv_browse");
    browse.textContent = "◎";
    browse.onclick = browseServers;
    rail.appendChild(browse);
    rail.classList.toggle("hidden", false);
  }

  async function createServerFlow() {
    const name = await askText(t("srv_new_prompt"), "", t("srv_name_ph"));
    if (!name || !name.trim()) return;
    const { ok, data } = await api("/api/servers", { name: name.trim() });
    // Surface what actually went wrong instead of a blanket "error".
    if (!ok) { notify((data && data.error) ? t("err_generic") + " (" + data.error + ")" : t("err_generic")); return; }
    await loadServers();
    openServer(data.id);
  }
  async function browseServers() {
    const { ok, data } = await api("/api/servers/public", null, "GET");
    const rows = (ok && data.servers) || [];
    const box = $("srvBrowseList"); if (!box) return;
    box.innerHTML = rows.length ? "" : `<div class="dir-empty">${t("dir_empty")}</div>`;
    for (const srv of rows) {
      const row = document.createElement("button");
      row.type = "button"; row.className = "dir-row";
      row.innerHTML = `<div class="avatar grp" style="width:36px;height:36px"><img src="/api/server-icon/${srv.id}" onerror="this.remove()">${escapeHtml((srv.name || "?").slice(0, 2).toUpperCase())}</div>` +
        `<div class="dir-body"><div class="dir-name">${escapeHtml(srv.name)}</div><div class="dir-sub">${escapeHtml(srv.about || t("dir_members", { n: srv.members || 0 }))}</div></div>`;
      row.onclick = async () => {
        const r = await api(`/api/servers/${srv.id}/join`, {});
        if (!r.ok) { notify(t("srv_invite_only")); return; }
        $("srvBrowseModal").classList.add("hidden");
        await loadServers();
        openServer(srv.id);
      };
      box.appendChild(row);
    }
    $("srvBrowseModal").classList.remove("hidden");
  }

  // ---- Open / close a server ----
  async function openServer(id) {
    const { ok, data } = await api("/api/servers/" + id, null, "GET");
    if (!ok) { notify(t("err_generic")); return; }
    S.cur = id; S.data = data; S.channel = null;
    document.getElementById("app").classList.add("in-server");
    renderRail();
    renderChannels();
    // Land on the first text channel so a server never opens on a blank column.
    const first = (data.channels || []).find((c) => c.kind === "text") || (data.channels || [])[0];
    if (first) openChannel(first.id);
  }
  function closeServer() {
    S.cur = null; S.data = null; S.channel = null;
    document.getElementById("app").classList.remove("in-server");
    renderRail();
    renderChatList($("searchInput").value);
  }
  window.dialogCloseServer = closeServer;

  // ---- Channel column ----
  function renderChannels() {
    const panel = panelEl(); if (!panel || !S.data) return;
    const groups = { rules: [], news: [], text: [], voice: [] };
    for (const c of S.data.channels) (groups[c.kind] || groups.text).push(c);
    const sec = (label, items, kind) => {
      if (!items.length && !(kind === "voice" && can(P.CREATE_VOICE))) return "";
      return `<div class="ch-sec"><div class="ch-sec-h">${label}` +
        (kind === "voice" && can(P.CREATE_VOICE) ? `<button class="ch-add" data-mkvoice="1" title="${t("srv_my_voice")}">+</button>` : "") +
        (kind !== "voice" && can(P.MANAGE_SERVER) ? `<button class="ch-add" data-mk="${kind}" title="${t("srv_add_channel")}">+</button>` : "") +
        `</div>` +
        items.map((c) => `<button class="ch-row${S.channel === c.id ? " on" : ""}" data-ch="${c.id}">` +
          `<span class="ch-ico">${c.kind === "voice" ? "🔊" : c.kind === "rules" ? "📜" : c.kind === "news" ? "📰" : "#"}</span>` +
          `<span class="ch-name">${escapeHtml(c.name)}</span>` +
          (c.autoOwner ? `<span class="ch-auto" title="${t("srv_auto_voice")}">⏳</span>` : "") +
          `</button>`).join("") + `</div>`;
    };
    panel.innerHTML =
      `<div class="srv-head">
         <button class="srv-back" id="srvBack" title="${t("back")}">‹</button>
         <div class="srv-name" title="${escapeHtml(S.data.server.name)}">${escapeHtml(S.data.server.name)}</div>
         <button class="srv-gear" id="srvGear" title="${t("srv_settings")}">⚙</button>
       </div>
       <div class="ch-list">
         ${sec(t("srv_rules"), groups.rules, "rules")}
         ${sec(t("srv_text"), groups.text, "text")}
         ${sec(t("srv_news"), groups.news, "news")}
         ${sec(t("srv_voice"), groups.voice, "voice")}
       </div>
       <div class="srv-foot"><button class="btn-ghost btn-sm" id="srvMembers">${t("srv_members", { n: S.data.members.length })}</button></div>`;
    panel.querySelectorAll("[data-ch]").forEach((b) => (b.onclick = () => openChannel(Number(b.dataset.ch))));
    panel.querySelectorAll("[data-mk]").forEach((b) => (b.onclick = () => addChannel(b.dataset.mk)));
    panel.querySelectorAll("[data-mkvoice]").forEach((b) => (b.onclick = makeMyVoice));
    $("srvBack") && ($("srvBack").onclick = closeServer);
    $("srvGear") && ($("srvGear").onclick = openServerSettings);
    $("srvMembers") && ($("srvMembers").onclick = showMembers);
    panel.classList.remove("hidden");
  }

  async function addChannel(kind) {
    const name = await askText(t("srv_add_channel_prompt"), "", kind);
    if (!name || !name.trim()) return;
    const { ok, data } = await api(`/api/servers/${S.cur}/channels`, { name: name.trim(), kind });
    if (!ok) notify((data && data.error) ? t("err_generic") + " (" + data.error + ")" : t("err_generic")); else refresh();
  }
  // "1 voice channel per user" — the server hands back the existing one if you already have it.
  async function makeMyVoice() {
    const { ok, data } = await api(`/api/servers/${S.cur}/channels`, { kind: "voice", auto: true });
    if (!ok) { notify(data && data.error === "no_create_voice" ? t("srv_no_create_voice") : t("err_generic")); return; }
    await refresh();
    openChannel(data.id);
  }

  function openChannel(id) {
    const ch = (S.data.channels || []).find((c) => c.id === id); if (!ch) return;
    S.channel = id;
    renderChannels();
    // A channel is just a room — hand it to the normal chat opener.
    openChat({ key: "@ch:" + id, type: "channel", id, name: ch.name, kind: ch.kind, last: "", ts: 0, unread: 0 });
    // The header reads "<server> · <kind>" — inside a server the useful context is which
    // server you're in, not a repeat of the section label.
    const sub = $("chatSub");
    if (sub) sub.textContent = S.data.server.name + " · " + (ch.kind === "voice" ? t("srv_voice") : ch.kind === "rules" ? t("srv_rules") : ch.kind === "news" ? t("srv_news") : t("srv_text"));
    const stage = document.getElementById("chatPane");
    stage && stage.classList.toggle("ch-readonly", ch.kind === "rules" || (ch.kind === "news" && !can(P.POST_NEWS) && !S.data.owner));
    if (ch.kind === "voice") notify(t("srv_voice_hint"));
  }

  function showMembers() {
    const panel = $("infoPanel"), list = $("members"); if (!panel || !list) return;
    $("infoTitle").textContent = t("srv_members", { n: S.data.members.length });
    list.innerHTML = "";
    const roleById = new Map((S.data.roles || []).map((r) => [r.id, r]));
    for (const m of S.data.members) {
      const li = document.createElement("li"); li.className = "member";
      const tags = (m.roles || []).map((rid) => roleById.get(rid)).filter(Boolean)
        .map((r) => `<span class="role-tag" style="border-color:${escapeHtml(r.color)};color:${escapeHtml(r.color)}">${escapeHtml(r.name)}</span>`).join("");
      li.innerHTML = `<div class="avatar" data-login="${m.login}" style="width:30px;height:30px;font-size:12px"><img src="${avaUrl(m.login)}" onerror="this.remove()">${initials(m.name)}</div>` +
        `<span class="m-name">${escapeHtml(m.name)}${m.login === S.data.server.owner ? ` <span class="owner-tag">(${t("owner")})</span>` : ""}</span>${tags}`;
      if (can(P.KICK) && m.login !== S.data.server.owner && m.login !== profile.login) {
        const k = document.createElement("button"); k.className = "c-icon-btn danger"; k.title = t("adm_kick"); k.innerHTML = "✕";
        k.onclick = async () => { await api(`/api/servers/${S.cur}/kick`, { login: m.login }); refresh(); };
        li.appendChild(k);
      }
      list.appendChild(li);
    }
    panel.classList.remove("hidden");
  }

  // ---- Server settings (name, listing, roles) ----
  function openServerSettings() {
    const m = $("srvSettingsModal"); if (!m || !S.data) return;
    $("srvSetName").value = S.data.server.name || "";
    $("srvSetAbout").value = S.data.server.about || "";
    $("srvSetPublic").checked = !!S.data.server.isPublic;
    const manage = can(P.MANAGE_SERVER);
    ["srvSetName", "srvSetAbout", "srvSetPublic", "srvSetSave", "srvIconBtn"].forEach((id) => { const e = $(id); if (e) e.disabled = !manage; });
    renderRoles();
    $("srvDelete").classList.toggle("hidden", !S.data.owner);
    $("srvLeave").classList.toggle("hidden", !!S.data.owner);
    m.classList.remove("hidden");
  }
  function renderRoles() {
    const box = $("srvRoles"); if (!box) return;
    const roles = S.data.roles || [];
    const limit = S.data.roleLimit || 5;
    $("srvRoleCount").textContent = t("srv_role_count", { n: roles.length, max: limit });
    box.innerHTML = "";
    for (const r of roles) {
      const row = document.createElement("div"); row.className = "role-row";
      row.innerHTML = `<input class="field role-name" value="${escapeHtml(r.name)}" maxlength="32">` +
        `<input type="color" class="role-color" value="${escapeHtml(r.color)}">` +
        `<div class="role-perms">` +
        Object.entries(P).map(([k, bit]) =>
          `<label class="role-perm"><input type="checkbox" data-bit="${bit}" ${(r.perms & bit) === bit ? "checked" : ""}><span>${t("perm_" + k.toLowerCase())}</span></label>`).join("") +
        `</div>`;
      const save = document.createElement("button"); save.className = "btn-ghost btn-sm"; save.textContent = t("save");
      save.onclick = async () => {
        const perms = [...row.querySelectorAll("[data-bit]")].reduce((acc, cb) => acc | (cb.checked ? Number(cb.dataset.bit) : 0), 0);
        await api(`/api/servers/${S.cur}/roles/${r.id}`, { name: row.querySelector(".role-name").value, color: row.querySelector(".role-color").value, perms });
        refresh(true);
      };
      const del = document.createElement("button"); del.className = "btn-ghost btn-sm danger"; del.textContent = t("ts_delete");
      del.onclick = async () => { await api(`/api/servers/${S.cur}/roles/${r.id}`, null, "DELETE"); refresh(true); };
      const acts = document.createElement("div"); acts.className = "role-acts"; acts.appendChild(save); acts.appendChild(del);
      row.appendChild(acts);
      // Who has it — assignment lives with the role, not buried in a member menu.
      const who = document.createElement("div"); who.className = "role-who";
      for (const mem of S.data.members) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "fp-chip" + ((mem.roles || []).includes(r.id) ? " on" : "");
        chip.textContent = mem.name;
        chip.onclick = async () => {
          const on = !(mem.roles || []).includes(r.id);
          await api(`/api/servers/${S.cur}/roles/${r.id}`, { assign: on, login: mem.login });
          refresh(true);
        };
        who.appendChild(chip);
      }
      row.appendChild(who);
      box.appendChild(row);
    }
    $("srvRoleAdd").disabled = roles.length >= limit || !can(P.MANAGE_ROLES);
  }
  async function refresh(keepSettings) {
    if (!S.cur) return;
    const { ok, data } = await api("/api/servers/" + S.cur, null, "GET");
    if (!ok) { closeServer(); return; }
    S.data = data;
    renderChannels();
    if (keepSettings) renderRoles();
    if (!$("infoPanel").classList.contains("hidden")) showMembers();
  }

  $("srvRoleAdd") && ($("srvRoleAdd").onclick = async () => {
    const { ok, data } = await api(`/api/servers/${S.cur}/roles`, { name: t("srv_new_role"), color: "#00ff5a", perms: 0 });
    if (!ok) { notify(data && data.error === "role_limit" ? t("srv_role_limit", { n: data.limit }) : t("err_generic")); return; }
    refresh(true);
  });
  $("srvSetSave") && ($("srvSetSave").onclick = async () => {
    await api("/api/servers/" + S.cur, { name: $("srvSetName").value.trim(), about: $("srvSetAbout").value.trim(), isPublic: $("srvSetPublic").checked });
    notify(t("saved")); refresh(true); loadServers();
  });
  $("srvIconBtn") && ($("srvIconBtn").onclick = () => $("srvIconFile").click());
  $("srvIconFile") && ($("srvIconFile").onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 3 * 1024 * 1024) { notify(t("err_avatar_too_big")); return; }
    const r = new FileReader();
    r.onload = async () => { await api("/api/servers/" + S.cur, { icon: r.result }); notify(t("saved")); loadServers(); };
    r.readAsDataURL(f);
  });
  $("srvDelete") && ($("srvDelete").onclick = async () => {
    if (!confirm(t("srv_delete_confirm"))) return;
    await api("/api/servers/" + S.cur, null, "DELETE");
    $("srvSettingsModal").classList.add("hidden");
    closeServer(); loadServers();
  });
  $("srvLeave") && ($("srvLeave").onclick = async () => {
    if (!confirm(t("srv_leave_confirm"))) return;
    await api(`/api/servers/${S.cur}/leave`, {});
    $("srvSettingsModal").classList.add("hidden");
    closeServer(); loadServers();
  });
  $("srvSetClose") && ($("srvSetClose").onclick = () => $("srvSettingsModal").classList.add("hidden"));
  $("srvBrowseClose") && ($("srvBrowseClose").onclick = () => $("srvBrowseModal").classList.add("hidden"));
  [$("srvSettingsModal"), $("srvBrowseModal")].forEach((m) => m && m.addEventListener("click", (e) => { if (e.target === m) m.classList.add("hidden"); }));

  socket.on("server-updated", ({ id }) => { if (S.cur && Number(id) === Number(S.cur)) refresh(true); });
  socket.on("servers-changed", () => { loadServers(); if (S.cur) refresh(); });

  // Boot once the session is up (app.js sets `profile` after checkSession).
  const boot = setInterval(() => { if (typeof profile !== "undefined" && profile) { clearInterval(boot); loadServers(); } }, 400);
})();
