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
    // Pills scroll inside their own strip; "+" is pinned outside it so it can never be
    // pushed off the edge no matter how many servers you're in. (Browsing public servers
    // lives in Discover now — one place to find things.)
    rail.innerHTML = `<div class="srv-scroll" id="srvScroll"></div><button class="srv-pill srv-add" id="srvAddBtn" title="${escapeHtml(t("srv_new"))}">+</button>`;
    const scroll = $("srvScroll");
    for (const srv of S.list) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "srv-pill" + (S.cur === srv.id ? " on" : "");
      b.title = srv.name;
      b.setAttribute("aria-label", srv.name);
      b.innerHTML = `<img src="/api/server-icon/${srv.id}" onerror="this.remove()"><span>${escapeHtml((srv.name || "?").slice(0, 2).toUpperCase())}</span>`;
      b.onclick = () => openServer(srv.id);
      scroll.appendChild(b);
    }
    $("srvAddBtn").onclick = createServerFlow;
    rail.classList.toggle("empty", !S.list.length);
  }

  let newIcon = null;
  function createServerFlow() {
    newIcon = null;
    $("srvNewName").value = ""; $("srvNewTags").value = ""; $("srvNewAbout").value = "";
    $("srvNewPublic").checked = false;
    $("srvNewIconPrev").innerHTML = "";
    $("srvNewModal").classList.remove("hidden");
    setTimeout(() => $("srvNewName").focus(), 40);
  }
  $("srvNewIconBtn") && ($("srvNewIconBtn").onclick = () => $("srvNewIconFile").click());
  $("srvNewIconFile") && ($("srvNewIconFile").onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 3 * 1024 * 1024) { notify(t("err_avatar_too_big")); return; }
    const r = new FileReader();
    r.onload = () => { newIcon = r.result; $("srvNewIconPrev").innerHTML = `<img src="${newIcon}" alt="">`; };
    r.readAsDataURL(f);
  });
  $("srvNewCancel") && ($("srvNewCancel").onclick = () => $("srvNewModal").classList.add("hidden"));
  $("srvNewClose") && ($("srvNewClose").onclick = () => $("srvNewModal").classList.add("hidden"));
  $("srvNewModal") && $("srvNewModal").addEventListener("click", (e) => { if (e.target === $("srvNewModal")) $("srvNewModal").classList.add("hidden"); });
  $("srvNewCreate") && ($("srvNewCreate").onclick = async () => {
    const name = $("srvNewName").value.trim();
    if (!name) { $("srvNewName").focus(); return; }
    const body = {
      name,
      tags: $("srvNewTags").value.trim(),
      about: $("srvNewAbout").value.trim(),
      isPublic: $("srvNewPublic").checked,
    };
    if (newIcon) body.icon = newIcon;
    const { ok, data } = await api("/api/servers", body);
    if (!ok) { notify((data && data.error) ? t("err_generic") + " (" + data.error + ")" : t("err_generic")); return; }
    $("srvNewModal").classList.add("hidden");
    await loadServers();
    openServer(data.id);
  });

  // Discover asks for these; the rail no longer carries a browse button.
  async function publicServers() {
    const { ok, data } = await api("/api/servers/public", null, "GET");
    return (ok && data.servers) || [];
  }
  window.dialogPublicServers = publicServers;
  window.dialogJoinServer = async (id) => {
    const r = await api(`/api/servers/${id}/join`, {});
    if (!r.ok) { notify(t("srv_invite_only")); return false; }
    await loadServers(); openServer(id); return true;
  };
  async function browseServers() {
    const rows = await publicServers();
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
  const voiceUsers = new Map();   // channelId -> [{login,name}] pushed live by the server
  function chIcon(kind) { return kind === "voice" ? "🔊" : kind === "rules" ? "📜" : kind === "news" ? "📰" : "#"; }
  function renderChannels() {
    const panel = panelEl(); if (!panel || !S.data) return;
    const groups = { rules: [], news: [], text: [], voice: [] };
    for (const c of S.data.channels) (groups[c.kind] || groups.text).push(c);
    const manage = can(P.MANAGE_SERVER);
    const row = (c) => {
      const occ = voiceUsers.get(c.id) || (c.voice || []);
      const live = c.kind === "voice" && occ.length;
      return `<div class="ch-item${S.channel === c.id ? " on" : ""}${live ? " live" : ""}">` +
        `<button class="ch-row" data-ch="${c.id}">` +
          `<span class="ch-ico">${chIcon(c.kind)}</span>` +
          `<span class="ch-name">${escapeHtml(c.name)}</span>` +
          (c.restrictMode === "view" ? `<span class="ch-lock" title="${escapeHtml(t("srv_restrict_view"))}">🙈</span>` : "") +
          (c.restrictMode === "post" ? `<span class="ch-lock" title="${escapeHtml(t("srv_restrict_post"))}">🔒</span>` : "") +
          (c.autoOwner ? `<span class="ch-auto" title="${escapeHtml(t("srv_auto_voice"))}">⏳</span>` : "") +
          (live ? `<span class="ch-live" title="${escapeHtml(t("srv_in_call"))}">●<b>${occ.length}</b></span>` : "") +
        `</button>` +
        (manage || c.autoOwner === profile.login ? `<button class="ch-cog" data-chcog="${c.id}" title="${escapeHtml(t("srv_channel_tools"))}">⋯</button>` : "") +
        // Who's in the voice channel right now, by face — the point of a voice list.
        (live ? `<div class="ch-faces">` + occ.slice(0, 8).map((u) =>
            `<span class="avatar ch-face" data-login="${escapeHtml(u.login)}" title="${escapeHtml(u.name || u.login)}">` +
            `<img src="${avaUrl(u.login)}" onerror="this.remove()">${escapeHtml(initials(u.name || u.login))}</span>`).join("") +
          (occ.length > 8 ? `<span class="ch-face-more">+${occ.length - 8}</span>` : "") + `</div>` : "") +
        `</div>`;
    };
    const sec = (label, items, kind) => {
      const canAdd = kind === "voice" ? (can(P.CREATE_VOICE) || manage) : manage;
      if (!items.length && !canAdd) return "";
      return `<div class="ch-sec"><div class="ch-sec-h"><span>${label}</span>` +
        (kind === "voice" && can(P.CREATE_VOICE) ? `<button class="ch-add" data-mkvoice="1" title="${escapeHtml(t("srv_my_voice"))}">+</button>` : "") +
        (kind !== "voice" && manage ? `<button class="ch-add" data-mk="${kind}" title="${escapeHtml(t("srv_add_channel"))}">+</button>` : "") +
        `</div>` + items.map(row).join("") + `</div>`;
    };
    panel.innerHTML =
      `<div class="srv-head">
         <button class="srv-back" id="srvBack" title="${escapeHtml(t("back"))}">‹</button>
         <div class="srv-name" title="${escapeHtml(S.data.server.name)}">${escapeHtml(S.data.server.name)}</div>
         <button class="srv-gear" id="srvGear" title="${escapeHtml(t("srv_settings"))}">⚙</button>
       </div>
       <div class="ch-list">
         ${sec(t("srv_rules"), groups.rules, "rules")}
         ${sec(t("srv_text"), groups.text, "text")}
         ${sec(t("srv_news"), groups.news, "news")}
         ${sec(t("srv_voice"), groups.voice, "voice")}
       </div>
       <div class="srv-foot"><button class="btn-ghost btn-sm" id="srvMembers">${escapeHtml(t("srv_members", { n: S.data.members.length }))}</button></div>`;
    panel.querySelectorAll("[data-ch]").forEach((b) => (b.onclick = () => openChannel(Number(b.dataset.ch))));
    panel.querySelectorAll("[data-mk]").forEach((b) => (b.onclick = () => addChannel(b.dataset.mk)));
    panel.querySelectorAll("[data-mkvoice]").forEach((b) => (b.onclick = makeMyVoice));
    panel.querySelectorAll("[data-chcog]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); channelTools(Number(b.dataset.chcog), b); }));
    $("srvBack") && ($("srvBack").onclick = closeServer);
    $("srvGear") && ($("srvGear").onclick = openServerSettings);
    $("srvMembers") && ($("srvMembers").onclick = showMembers);
    panel.classList.remove("hidden");
  }

  // Moderator tools for one channel: rename, webhook, who-can-see/post, delete. Rules and
  // news channels are deletable like any other — that was the ask.
  function channelTools(id, anchor) {
    const ch = (S.data.channels || []).find((c) => c.id === id); if (!ch) return;
    let menu = $("chMenu");
    if (!menu) { menu = document.createElement("div"); menu.id = "chMenu"; menu.className = "chat-menu hidden"; document.body.appendChild(menu); }
    menu.innerHTML = "";
    const item = (label, fn, danger) => {
      const b = document.createElement("button");
      if (danger) b.className = "danger";
      b.innerHTML = `<span>${label}</span>`;
      b.onclick = () => { menu.classList.add("hidden"); fn(); };
      menu.appendChild(b);
    };
    item(t("srv_rename_channel"), async () => {
      const name = await askText(t("srv_add_channel_prompt"), ch.name);
      if (!name) return;
      await api("/api/channels/" + id, { name });
      refresh();
    });
    if (can(P.MANAGE_SERVER)) {
      if (ch.kind === "text") {
        item(ch.hook ? t("srv_hook_copy") : t("srv_hook_create"), async () => {
          if (ch.hook) { copyToClipboard(ch.hook); notify(t("copied")); return; }
          const { ok, data } = await api(`/api/channels/${id}/hook`, {});
          if (ok && data.hook) { copyToClipboard(data.hook); notify(t("srv_hook_created")); refresh(); }
        });
        if (ch.hook) item(t("srv_hook_revoke"), async () => { await api(`/api/channels/${id}/hook`, { off: true }); refresh(); }, true);
      }
      const modes = [["none", t("srv_restrict_none")], ["post", t("srv_restrict_post")], ["view", t("srv_restrict_view")]];
      for (const [mode, label] of modes) {
        if (mode === (ch.restrictMode || "none")) continue;
        item("→ " + label, async () => { await api(`/api/channels/${id}/restrict`, { mode }); refresh(); });
      }
      item(t("srv_delete_channel"), async () => {
        if (!confirm(t("srv_delete_channel_confirm", { name: ch.name }))) return;
        await api("/api/channels/" + id, null, "DELETE");
        if (S.channel === id) S.channel = null;
        refresh();
      }, true);
    } else if (ch.autoOwner === profile.login) {
      item(t("srv_delete_channel"), async () => { await api("/api/channels/" + id, null, "DELETE"); refresh(); }, true);
    }
    menu.classList.remove("hidden");
    menu._openedAt = Date.now();
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, innerWidth - (menu.offsetWidth || 200) - 8)) + "px";
    menu.style.top = Math.min(r.bottom + 4, innerHeight - (menu.offsetHeight || 200) - 8) + "px";
  }
  document.addEventListener("click", (e) => {
    const m = $("chMenu"); if (!m || m.classList.contains("hidden")) return;
    if (Date.now() - (m._openedAt || 0) < 250) return;
    if (!e.target.closest("#chMenu")) m.classList.add("hidden");
  });

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

  async function openChannel(id) {
    const ch = (S.data.channels || []).find((c) => c.id === id); if (!ch) return;
    // A voice channel means joining a call — say so before turning anyone's mic on.
    if (ch.kind === "voice" && !(call && call.active && call.roomKey === "@ch:" + id)) {
      if (!confirm(t("srv_voice_confirm", { name: ch.name }))) return;
    }
    S.channel = id;
    renderChannels();
    // A channel is just a room — hand it to the normal chat opener.
    openChat({ key: "@ch:" + id, type: "channel", id, name: ch.name, kind: ch.kind, last: "", ts: 0, unread: 0 });
    // The header reads "<server> · <kind>" — inside a server the useful context is which
    // server you're in, not a repeat of the section label.
    const sub = $("chatSub");
    if (sub) sub.textContent = S.data.server.name + " · " + (ch.kind === "voice" ? t("srv_voice") : ch.kind === "rules" ? t("srv_rules") : ch.kind === "news" ? t("srv_news") : t("srv_text"));
    const stage = document.getElementById("chatPane");
    stage && stage.classList.toggle("ch-readonly", !canPost(ch));
    if (ch.kind === "voice") {
      // Join for real once the room switch has settled (joinCall reads myRoom).
      setTimeout(() => { if (!call.active) $("startCallBtn") && $("startCallBtn").click(); }, 420);
    }
  }
  // Mirrors the server's rule so the composer isn't offered when posting would be refused.
  function canPost(ch) {
    if (!ch) return false;
    if (ch.kind === "rules") return !!S.data.staff;
    if (ch.kind === "news") return !!(S.data.staff || can(P.POST_NEWS));
    if (ch.restrictMode === "post" || ch.restrictMode === "view") return !!S.data.staff;
    return true;
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
    $("srvSetTags").value = S.data.server.tags || "";
    $("srvSetPublic").checked = !!S.data.server.isPublic;
    const manage = can(P.MANAGE_SERVER);
    ["srvSetName", "srvSetAbout", "srvSetTags", "srvSetPublic", "srvSetSave", "srvIconBtn"].forEach((id) => { const e = $(id); if (e) e.disabled = !manage; });
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
    await api("/api/servers/" + S.cur, { name: $("srvSetName").value.trim(), about: $("srvSetAbout").value.trim(), tags: $("srvSetTags").value.trim(), isPublic: $("srvSetPublic").checked });
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
  socket.on("server-voice", ({ channelId, users }) => {
    voiceUsers.set(Number(channelId), users || []);
    if (S.cur) renderChannels();
  });
  socket.on("servers-changed", () => { loadServers(); if (S.cur) refresh(); });

  // Boot once the session is up (app.js sets `profile` after checkSession).
  const boot = setInterval(() => { if (typeof profile !== "undefined" && profile) { clearInterval(boot); loadServers(); } }, 400);
})();
