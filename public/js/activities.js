// ============================================================================
// Activities — things a call does together: Watch Together, and games.
//
// Shape: whoever starts an activity is the HOST. The host's client owns the rules and
// publishes state ("activity-state"); everyone else renders it. Anyone can send input
// ("activity-msg"), which the server stamps with the real login + display name — so a
// player's name in a game is the same identity as in the call, and can't be spoofed.
//
// Loaded after app.js and leans on its globals: $, t, socket, profile, myName, call,
// notify, escapeHtml. Keeping it out of app.js because it's a self-contained subsystem,
// not another branch of the chat.
// ============================================================================
(function () {
  const ACT = { kind: null, host: null, hostName: "", state: null, mod: null };
  const isHost = () => !!(ACT.kind && profile && ACT.host === profile.login);

  // ---- Who's in the lobby: exactly the people in the call, by display name ----
  function lobby() {
    const out = [];
    if (profile) out.push({ login: profile.login, name: (typeof myName === "string" && myName) || profile.name, me: true });
    if (call && call.peers) for (const [login, m] of call.peers) out.push({ login, name: m.name || login, me: false });
    return out;
  }

  // ---- Panel plumbing ----
  function panel() { return $("activityPanel"); }
  function body() { return $("actBody"); }
  function setTitle(txt) { const e = $("actTitle"); if (e) e.textContent = txt; }
  function show(on) {
    const p = panel(); if (!p) return;
    p.classList.toggle("hidden", !on);
    document.getElementById("callStage")?.classList.toggle("has-activity", !!on);
  }
  function send(msg) { socket.emit("activity-msg", msg); }
  function pushState(state) {          // host only — guests render what arrives
    if (!isHost()) return;
    ACT.state = state;
    socket.emit("activity-state", state);
    // The host is a player too: its own view has to follow the state it just published,
    // otherwise the person running the game is the only one looking at a stale screen.
    if (ACT.mod && ACT.mod.render) ACT.mod.render(state);
  }

  const KINDS = {
    watch: { label: () => t("act_watch"), icon: "▶" },
    gartic: { label: () => t("act_gartic"), icon: "✎" },
    golf: { label: () => t("act_golf"), icon: "⛳" },
    uno: { label: () => t("act_uno"), icon: "🃏" },
    poker: { label: () => t("act_poker"), icon: "♠" },
    race: { label: () => t("act_race"), icon: "🏁" },
  };

  function start(kind) {
    if (!call || !call.active) { notify(t("act_need_call")); return; }
    socket.emit("activity-start", { kind });
  }
  function stop() { socket.emit("activity-stop"); }

  function mount(kind) {
    unmount();
    const mod = { watch: Watch, gartic: Gartic, golf: Golf, uno: Uno, poker: Poker, race: Race }[kind] || null;
    ACT.mod = mod;
    setTitle(KINDS[kind] ? KINDS[kind].label() : "");
    $("actStop") && $("actStop").classList.toggle("hidden", !isHost());
    show(true);
    applySavedSize();
    if (mod) mod.mount(body());
    if (isHost() && mod && mod.hostInit) pushState(mod.hostInit());
    else if (ACT.state && mod && mod.render) mod.render(ACT.state);
  }
  function unmount() {
    if (ACT.mod && ACT.mod.unmount) { try { ACT.mod.unmount(); } catch {} }
    ACT.mod = null;
    const b = body(); if (b) b.innerHTML = "";
  }

  // ---- Wire the socket ----
  socket.on("activity", (a) => {
    if (!a) {
      const had = ACT.kind;
      ACT.kind = ACT.host = null; ACT.state = null;
      unmount(); show(false);
      panel() && panel().classList.remove("max", "fs");
      reparent(false);
      if (had) notify(t("act_ended"));
      return;
    }
    ACT.kind = a.kind; ACT.host = a.host; ACT.hostName = a.hostName || a.host; ACT.state = a.state || null;
    mount(a.kind);
  });
  socket.on("activity-state", (state) => {
    ACT.state = state;
    if (ACT.mod && ACT.mod.render) ACT.mod.render(state);
  });
  socket.on("activity-msg", (msg) => { if (ACT.mod && ACT.mod.onMsg) ACT.mod.onMsg(msg); });
  socket.on("activity-busy", ({ hostName }) => notify(t("act_busy", { name: hostName || "" })));

  // ---- Launcher ----
  function openLauncher(anchor) {
    let menu = $("actMenu");
    if (!menu) { menu = document.createElement("div"); menu.id = "actMenu"; menu.className = "chat-menu hidden"; document.body.appendChild(menu); }
    menu.innerHTML = "";
    for (const [kind, meta] of Object.entries(KINDS)) {
      const b = document.createElement("button");
      b.innerHTML = `<span class="act-ico">${meta.icon}</span><span>${meta.label()}</span>`;
      b.onclick = () => { menu.classList.add("hidden"); start(kind); };
      menu.appendChild(b);
    }
    menu.classList.remove("hidden");
    menu._openedAt = Date.now();
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth || 200;
    menu.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + "px";
    menu.style.top = Math.max(8, r.top - (menu.offsetHeight || 150) - 8) + "px";
  }
  document.addEventListener("click", (e) => {
    const m = $("actMenu"); if (!m || m.classList.contains("hidden")) return;
    if (Date.now() - (m._openedAt || 0) < 250) return;
    if (!e.target.closest("#actMenu") && !e.target.closest("#activityBtn")) m.classList.add("hidden");
  });
  $("activityBtn") && ($("activityBtn").onclick = (e) => { e.stopPropagation(); openLauncher($("activityBtn")); });
  $("actStop") && ($("actStop").onclick = stop);
  $("actMin") && ($("actMin").onclick = () => panel().classList.toggle("min"));

  // ---- Size: drag the corner, maximize inside the call, or go real fullscreen ----
  const SIZE_KEY = "dialog_act_size";
  function applySavedSize() {
    const p = panel(); if (!p) return;
    try {
      const s = JSON.parse(localStorage.getItem(SIZE_KEY) || "null");
      if (s && s.w) { p.style.width = s.w + "px"; p.style.height = s.h + "px"; }
    } catch {}
  }
  function saveSize() {
    const p = panel(); if (!p) return;
    try { localStorage.setItem(SIZE_KEY, JSON.stringify({ w: p.offsetWidth, h: p.offsetHeight })); } catch {}
  }
  (function initGrip() {
    const grip = $("actGrip"); if (!grip) return;
    let start = null;
    const down = (e) => {
      const p = panel(); if (!p) return;
      e.preventDefault();
      const pt = e.touches ? e.touches[0] : e;
      start = { x: pt.clientX, y: pt.clientY, w: p.offsetWidth, h: p.offsetHeight };
      document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
      document.addEventListener("touchmove", move, { passive: false }); document.addEventListener("touchend", up);
    };
    const move = (e) => {
      if (!start) return;
      e.preventDefault();
      const pt = e.touches ? e.touches[0] : e;
      const p = panel();
      // Grip is on the left edge of a centre-anchored panel, so horizontal drag counts double.
      p.style.width = Math.max(320, Math.min(start.w + (start.x - pt.clientX) * 2, innerWidth - 24)) + "px";
      p.style.height = Math.max(220, Math.min(start.h + (pt.clientY - start.y), innerHeight - 120)) + "px";
    };
    const up = () => {
      start = null; saveSize();
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      document.removeEventListener("touchmove", move); document.removeEventListener("touchend", up);
      if (ACT.mod && ACT.mod.resized) ACT.mod.resized();
    };
    grip.addEventListener("mousedown", down);
    grip.addEventListener("touchstart", down, { passive: false });
  })();
  // #callStage keeps a transform (its open animation fills forwards), and a transform makes
  // an ancestor the containing block for position:fixed — so a maximized panel would be
  // trapped inside the stage and clipped by it. Move it to <body> while it's big, exactly
  // like fsReparent does for modals during a fullscreen call.
  function reparent(big) {
    const p = panel(); if (!p) return;
    const stage = document.getElementById("callStage");
    if (big) { if (p.parentElement !== document.body) { p._home = p.parentElement; document.body.appendChild(p); } }
    else if (p._home && p.parentElement !== p._home) { p._home.appendChild(p); }
  }
  $("actMax") && ($("actMax").onclick = () => {
    const p = panel(); if (!p) return;
    const on = !p.classList.contains("max");
    reparent(on);
    p.classList.toggle("max", on);
    p.classList.remove("min");
    if (ACT.mod && ACT.mod.resized) setTimeout(() => ACT.mod.resized(), 60);
  });
  // Real fullscreen — what Watch Together actually wants. iOS Safari has no element API, so
  // it falls back to the maximize class.
  $("actFull") && ($("actFull").onclick = () => {
    const p = panel(); if (!p) return;
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    reparent(true);
    if (p.requestFullscreen) p.requestFullscreen().catch(() => p.classList.add("max"));
    else p.classList.add("max");
  });
  document.addEventListener("fullscreenchange", () => {
    const p = panel(); if (!p) return;
    const on = document.fullscreenElement === p;
    p.classList.toggle("fs", on);
    if (!on && !p.classList.contains("max")) reparent(false);
    if (ACT.mod && ACT.mod.resized) setTimeout(() => ACT.mod.resized(), 60);
  });

  // ==========================================================================
  // Watch Together — YouTube, host-authoritative.
  // The host's player is the clock: it publishes {videoId, playing, time, at} and guests
  // correct drift against it. Guests' own controls stay off; scrubbing is the host's job.
  // ==========================================================================
  const Watch = (function () {
    let player = null, ready = false, pollT = 0, guard = false;
    function ytId(url) {
      const m = String(url || "").match(/(?:youtu\.be\/|v=|embed\/|shorts\/)([A-Za-z0-9_-]{11})/);
      return m ? m[1] : (/^[A-Za-z0-9_-]{11}$/.test(String(url).trim()) ? String(url).trim() : null);
    }
    function loadApi() {
      return new Promise((res) => {
        if (window.YT && window.YT.Player) return res();
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => { if (prev) try { prev(); } catch {} res(); };
        if (!document.getElementById("yt-api")) {
          const s = document.createElement("script");
          s.id = "yt-api"; s.src = "https://www.youtube.com/iframe_api";
          document.head.appendChild(s);
        }
      });
    }
    function mount(root) {
      root.innerHTML =
        `<div class="wt-bar">
           <input id="wtUrl" class="field" placeholder="https://youtube.com/watch?v=…" ${isHost() ? "" : "disabled"} />
           <button id="wtLoad" class="btn-primary btn-sm" ${isHost() ? "" : "disabled"}>${t("act_watch_load")}</button>
         </div>
         <div class="wt-stage"><div id="wtPlayer"></div></div>
         <div class="wt-note">${isHost() ? t("act_watch_host") : t("act_watch_guest", { name: ACT.hostName })}</div>`;
      if (isHost()) {
        $("wtLoad").onclick = () => {
          const id = ytId($("wtUrl").value);
          if (!id) { notify(t("act_watch_badurl")); return; }
          pushState({ videoId: id, playing: true, time: 0, at: Date.now() });
          load(id, 0, true);
        };
      }
      loadApi().then(() => { ready = true; if (ACT.state && ACT.state.videoId) render(ACT.state); });
    }
    function load(videoId, time, playing) {
      if (!ready || !window.YT) return;
      if (player && player.loadVideoById) {
        guard = true;
        player.loadVideoById({ videoId, startSeconds: time || 0 });
        setTimeout(() => { guard = false; }, 600);
        return;
      }
      player = new YT.Player("wtPlayer", {
        videoId, playerVars: { autoplay: 1, controls: isHost() ? 1 : 0, rel: 0, modestbranding: 1, playsinline: 1 },
        events: {
          onReady: () => { if (!playing) player.pauseVideo(); if (isHost()) startPolling(); },
          // The host's own play/pause/seek is what everyone else follows.
          onStateChange: (e) => {
            if (!isHost() || guard) return;
            if (e.data === YT.PlayerState.PLAYING || e.data === YT.PlayerState.PAUSED) publish();
          },
        },
      });
    }
    function publish() {
      if (!player || !player.getCurrentTime) return;
      pushState({
        videoId: (ACT.state && ACT.state.videoId) || null,
        playing: player.getPlayerState() === YT.PlayerState.PLAYING,
        time: player.getCurrentTime(),
        at: Date.now(),
      });
    }
    function startPolling() { clearInterval(pollT); pollT = setInterval(publish, 4000); }  // drift beacon
    function render(state) {
      if (!state || !state.videoId || !ready) return;
      if (!player) { load(state.videoId, expected(state), state.playing); return; }
      if (isHost()) return;                                   // the host IS the clock
      if (player.getVideoData && player.getVideoData().video_id !== state.videoId) { load(state.videoId, expected(state), state.playing); return; }
      const want = expected(state), have = player.getCurrentTime ? player.getCurrentTime() : 0;
      guard = true;
      if (Math.abs(want - have) > 1.5) player.seekTo(want, true);   // only correct real drift
      if (state.playing && player.getPlayerState() !== YT.PlayerState.PLAYING) player.playVideo();
      if (!state.playing && player.getPlayerState() === YT.PlayerState.PLAYING) player.pauseVideo();
      setTimeout(() => { guard = false; }, 400);
    }
    // Where the video should be NOW, given when the host last spoke.
    function expected(state) { return (state.time || 0) + (state.playing ? (Date.now() - (state.at || Date.now())) / 1000 : 0); }
    function unmount() { clearInterval(pollT); pollT = 0; try { player && player.destroy && player.destroy(); } catch {} player = null; ready = false; }
    return { mount, render, unmount, hostInit: () => ({ videoId: null, playing: false, time: 0, at: Date.now() }) };
  })();

  // ==========================================================================
  // Gartic-style telephone: write → draw → describe → …, then the books are revealed.
  // Everyone works on a different book each round, so nobody waits on a chain.
  // ==========================================================================
  const Gartic = (function () {
    const WORDS = [
      "a cat running a bank", "the last slice of pizza", "a robot learning to dance",
      "a duck in a submarine", "grandma hacking the mainframe", "a haunted vending machine",
      "two knights arguing about soup", "a cactus on holiday", "the moon calling in sick",
    ];
    let drawing = null, ctx = null, painting = false, last = null;
    const S = () => ACT.state || {};
    function hostInit() {
      const players = lobby().map((p) => ({ login: p.login, name: p.name }));
      return {
        phase: "play", round: 0, rounds: Math.max(2, Math.min(6, players.length)),
        players, books: players.map((p, i) => ({ owner: p.login, entries: [] })),
        submitted: {}, seeds: players.map(() => WORDS[Math.floor(Math.random() * WORDS.length)]),
      };
    }
    // Which book you work on this round — rotate so nobody ever gets their own back-to-back.
    function bookFor(state, login) {
      const idx = state.players.findIndex((p) => p.login === login);
      if (idx < 0) return -1;
      return (idx + state.round) % state.players.length;
    }
    function mount(root) {
      root.innerHTML = `<div class="ga-wrap"><div class="ga-head" id="gaHead"></div><div class="ga-stage" id="gaStage"></div><div class="ga-foot" id="gaFoot"></div></div>`;
      render(ACT.state);
    }
    function render(state) {
      if (!state) return;
      const head = $("gaHead"), stage = $("gaStage"), foot = $("gaFoot");
      if (!head || !stage || !foot) return;
      if (state.phase === "done") return renderReveal(state, head, stage, foot);
      const me = profile.login;
      const bi = bookFor(state, me);
      const book = state.books[bi];
      const done = !!(state.submitted || {})[me];
      const waiting = Object.keys(state.submitted || {}).length;
      head.innerHTML = `<b>${t("act_ga_round", { n: state.round + 1, of: state.rounds })}</b>` +
        `<span class="ga-count">${waiting}/${state.players.length}</span>`;
      if (done) { stage.innerHTML = `<div class="ga-wait">${t("act_ga_waiting")}</div>`; foot.innerHTML = ""; return; }
      // Even rounds write, odd rounds draw — round 0 writes from the seed prompt.
      const writeTurn = state.round % 2 === 0;
      const prev = book && book.entries.length ? book.entries[book.entries.length - 1] : null;
      if (writeTurn) {
        const promptImg = prev && prev.type === "draw" ? `<img class="ga-prev" src="${prev.value}" alt="">` : "";
        const seed = !prev ? `<div class="ga-seed">${escapeHtml(state.seeds[bi] || "")}</div>` : "";
        stage.innerHTML = promptImg + seed;
        foot.innerHTML = `<input id="gaText" class="field" maxlength="120" placeholder="${prev ? t("act_ga_describe") : t("act_ga_write")}"><button id="gaSend" class="btn-primary btn-sm">${t("act_ga_submit")}</button>`;
        $("gaSend").onclick = () => {
          const v = $("gaText").value.trim(); if (!v) return;
          send({ ga: "submit", type: "text", value: v.slice(0, 120), book: bi });
          stage.innerHTML = `<div class="ga-wait">${t("act_ga_waiting")}</div>`; foot.innerHTML = "";
        };
      } else {
        stage.innerHTML = `<div class="ga-prompt">${escapeHtml(prev ? prev.value : state.seeds[bi] || "")}</div><canvas id="gaCanvas" width="520" height="320"></canvas>`;
        foot.innerHTML = `<div class="ga-tools"><input type="color" id="gaColor" value="#00ff5a"><button id="gaClear" class="btn-ghost btn-sm">${t("act_ga_clear")}</button></div><button id="gaSend" class="btn-primary btn-sm">${t("act_ga_submit")}</button>`;
        setupCanvas();
        $("gaClear").onclick = () => { ctx.fillStyle = "#0b0f0d"; ctx.fillRect(0, 0, drawing.width, drawing.height); };
        $("gaSend").onclick = () => {
          send({ ga: "submit", type: "draw", value: drawing.toDataURL("image/webp", 0.6), book: bi });
          stage.innerHTML = `<div class="ga-wait">${t("act_ga_waiting")}</div>`; foot.innerHTML = "";
        };
      }
    }
    function setupCanvas() {
      drawing = $("gaCanvas"); if (!drawing) return;
      ctx = drawing.getContext("2d");
      ctx.fillStyle = "#0b0f0d"; ctx.fillRect(0, 0, drawing.width, drawing.height);
      ctx.lineWidth = 3; ctx.lineCap = "round"; ctx.lineJoin = "round";
      const pos = (e) => {
        const r = drawing.getBoundingClientRect();
        const p = e.touches ? e.touches[0] : e;
        return { x: (p.clientX - r.left) * (drawing.width / r.width), y: (p.clientY - r.top) * (drawing.height / r.height) };
      };
      const down = (e) => { e.preventDefault(); painting = true; last = pos(e); };
      const move = (e) => {
        if (!painting) return; e.preventDefault();
        const p = pos(e);
        ctx.strokeStyle = ($("gaColor") && $("gaColor").value) || "#00ff5a";
        ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
        last = p;
      };
      const up = () => { painting = false; };
      drawing.addEventListener("mousedown", down); drawing.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      drawing.addEventListener("touchstart", down, { passive: false });
      drawing.addEventListener("touchmove", move, { passive: false });
      drawing.addEventListener("touchend", up);
    }
    function renderReveal(state, head, stage, foot) {
      head.innerHTML = `<b>${t("act_ga_reveal")}</b>`;
      const b = state.books[state.showBook || 0] || { entries: [] };
      const owner = (state.players.find((p) => p.login === b.owner) || {}).name || "";
      stage.innerHTML = `<div class="ga-book"><div class="ga-book-owner">${escapeHtml(owner)}</div>` +
        b.entries.map((e2) => {
          const who = escapeHtml((state.players.find((p) => p.login === e2.by) || {}).name || "");
          return e2.type === "draw"
            ? `<figure><img class="ga-prev" src="${e2.value}" alt=""><figcaption>${who}</figcaption></figure>`
            : `<div class="ga-line"><span>${escapeHtml(e2.value)}</span><small>${who}</small></div>`;
        }).join("") + `</div>`;
      foot.innerHTML = isHost() && (state.showBook || 0) < state.books.length - 1
        ? `<button id="gaNext" class="btn-primary btn-sm">${t("act_ga_next_book")}</button>` : "";
      if ($("gaNext")) $("gaNext").onclick = () => pushState({ ...state, showBook: (state.showBook || 0) + 1 });
    }
    // Host-only: collect submissions, advance when everyone has answered.
    function onMsg(msg) {
      if (!isHost() || !msg || msg.ga !== "submit") return;
      const st = { ...(ACT.state || {}) };
      if (!st.books) return;
      const bi = Number(msg.book);
      if (!(bi >= 0 && bi < st.books.length)) return;
      st.submitted = { ...(st.submitted || {}) };
      if (st.submitted[msg.from]) return;
      st.submitted[msg.from] = true;
      st.books = st.books.map((b, i) => (i === bi ? { ...b, entries: [...b.entries, { type: msg.type, value: msg.value, by: msg.from }] } : b));
      if (Object.keys(st.submitted).length >= st.players.length) {
        st.round += 1; st.submitted = {};
        if (st.round >= st.rounds) { st.phase = "done"; st.showBook = 0; }
      }
      pushState(st);
    }
    function unmount() { drawing = null; ctx = null; painting = false; }
    return { mount, render, onMsg, unmount, hostInit };
  })();

  // ==========================================================================
  // Mini golf — turn-based, top-down. Drag from your ball to aim, release to putt.
  // The player taking the shot simulates it and streams the ball position; everyone else
  // just renders. Turn order and scores are the host's state.
  // ==========================================================================
  const Golf = (function () {
    const W = 560, H = 360;
    // Courses are walls (x1,y1,x2,y2) + a cup. Deliberately hand-placed: three short holes
    // that fit the panel and read at a glance.
    // Six courses. Each is a rectangle with interior walls; the tee is deliberately NOT
    // enclosed by them — the old hole 3 boxed the ball in on all four sides and could never
    // be finished. `open` in the comments is the gap the ball leaves through.
    const BOX = [[20, 20, 540, 20], [540, 20, 540, 340], [540, 340, 20, 340], [20, 340, 20, 20]];
    const COURSES = [
      // 1 — a straight dogleg round two staggered fins.
      { par: 2, tee: [70, 300], cup: [480, 70], walls: [...BOX, [180, 20, 180, 240], [380, 120, 380, 340]] },
      // 2 — a corridor you enter from the left and leave at the bottom right.
      { par: 3, tee: [70, 70], cup: [480, 300], walls: [...BOX, [140, 90, 420, 90], [140, 270, 420, 270], [420, 90, 420, 180]] },
      // 3 — three-sided pen, open at the TOP so the ball can reach the cup above it.
      { par: 3, tee: [280, 300], cup: [280, 70], walls: [...BOX, [180, 200, 180, 340], [380, 200, 380, 340], [180, 200, 240, 200], [320, 200, 380, 200]] },
      // 4 — bank shot: a diagonal wall you play off to reach the far corner.
      { par: 3, tee: [80, 290], cup: [470, 90], walls: [...BOX, [160, 340, 340, 150], [400, 20, 400, 160]] },
      // 5 — a spine down the middle with gaps at both ends.
      { par: 4, tee: [70, 180], cup: [490, 180], walls: [...BOX, [280, 20, 280, 130], [280, 230, 280, 340], [180, 100, 180, 260]] },
      // 6 — chicane: two offset baffles, cup tucked behind the second.
      { par: 4, tee: [70, 300], cup: [470, 300], walls: [...BOX, [170, 20, 170, 230], [290, 120, 290, 340], [410, 20, 410, 230]] },
    ];
    let cv = null, cx = null, raf = 0, ball = null, aim = null, remote = new Map(), stopped = true;
    const S = () => ACT.state || {};
    function hostInit() {
      const players = lobby().map((p) => ({ login: p.login, name: p.name, strokes: 0, total: 0, sunk: false }));
      return { hole: 0, players, turn: 0, phase: "play" };
    }
    function mount(root) {
      root.innerHTML = `<div class="gf-wrap"><div class="gf-head" id="gfHead"></div><canvas id="gfCanvas" width="${W}" height="${H}"></canvas><div class="gf-score" id="gfScore"></div></div>`;
      cv = $("gfCanvas"); cx = cv.getContext("2d");
      resetBall();
      cv.addEventListener("mousedown", onDown); cv.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      cv.addEventListener("touchstart", onDown, { passive: false });
      cv.addEventListener("touchmove", onMove, { passive: false });
      cv.addEventListener("touchend", onUp);
      loop();
      render(ACT.state);
    }
    function course() { return COURSES[Math.min((S().hole || 0), COURSES.length - 1)]; }
    function resetBall() { const c = course(); ball = { x: c.tee[0], y: c.tee[1], vx: 0, vy: 0, sunk: false }; }
    function myTurn() {
      const st = S(); if (!st.players) return false;
      const p = st.players[st.turn % st.players.length];
      return !!(p && profile && p.login === profile.login);
    }
    function pos(e) {
      const r = cv.getBoundingClientRect(); const p = e.touches ? e.touches[0] : e;
      return { x: (p.clientX - r.left) * (W / r.width), y: (p.clientY - r.top) * (H / r.height) };
    }
    function onDown(e) {
      if (!myTurn() || ball.sunk || moving()) return;
      e.preventDefault(); aim = pos(e);
    }
    function onMove(e) { if (aim) { e.preventDefault(); aim = pos(e); } }
    function onUp() {
      if (!aim || !myTurn()) { aim = null; return; }
      // Drag AWAY from the ball to set direction and power (slingshot, like the real thing).
      const dx = ball.x - aim.x, dy = ball.y - aim.y;
      const power = Math.min(Math.hypot(dx, dy), 140) / 140;
      aim = null;
      if (power < 0.05) return;
      const ang = Math.atan2(dy, dx);
      ball.vx = Math.cos(ang) * power * 13; ball.vy = Math.sin(ang) * power * 13;
      send({ gf: "stroke" });
    }
    function moving() { return Math.hypot(ball.vx, ball.vy) > 0.05; }
    function step() {
      if (!moving()) return;
      const c = course();
      ball.x += ball.vx; ball.y += ball.vy;
      ball.vx *= 0.985; ball.vy *= 0.985;                      // friction
      for (const w of c.walls) bounce(w);
      const d = Math.hypot(ball.x - c.cup[0], ball.y - c.cup[1]);
      if (d < 11 && Math.hypot(ball.vx, ball.vy) < 6) {        // too fast → lips out
        ball.sunk = true; ball.vx = ball.vy = 0;
        send({ gf: "sunk" });
      }
      if (Math.hypot(ball.vx, ball.vy) <= 0.05) { ball.vx = ball.vy = 0; send({ gf: "stopped" }); }
      send({ gf: "pos", x: Math.round(ball.x), y: Math.round(ball.y) });
    }
    // Reflect off a segment when the ball crosses within its band.
    function bounce(w) {
      const [x1, y1, x2, y2] = w;
      const dx = x2 - x1, dy = y2 - y1;
      const len2 = dx * dx + dy * dy; if (!len2) return;
      let tt = ((ball.x - x1) * dx + (ball.y - y1) * dy) / len2;
      tt = Math.max(0, Math.min(1, tt));
      const px = x1 + tt * dx, py = y1 + tt * dy;
      const nx = ball.x - px, ny = ball.y - py;
      const dist = Math.hypot(nx, ny);
      if (dist > 7 || dist === 0) return;
      const ux = nx / dist, uy = ny / dist;
      const dot = ball.vx * ux + ball.vy * uy;
      ball.vx = (ball.vx - 2 * dot * ux) * 0.86;               // energy loss on the bank
      ball.vy = (ball.vy - 2 * dot * uy) * 0.86;
      ball.x = px + ux * 7.5; ball.y = py + uy * 7.5;
    }
    function loop() {
      if (stopped && !cv) return;
      step(); draw();
      raf = requestAnimationFrame(loop);
    }
    function draw() {
      if (!cx) return;
      const c = course();
      cx.fillStyle = "#0a1a10"; cx.fillRect(0, 0, W, H);
      cx.strokeStyle = "rgba(255,255,255,.18)"; cx.lineWidth = 5;
      for (const w of c.walls) { cx.beginPath(); cx.moveTo(w[0], w[1]); cx.lineTo(w[2], w[3]); cx.stroke(); }
      cx.fillStyle = "#000"; cx.beginPath(); cx.arc(c.cup[0], c.cup[1], 10, 0, 7); cx.fill();
      cx.strokeStyle = "#00ff5a"; cx.lineWidth = 2; cx.beginPath(); cx.arc(c.cup[0], c.cup[1], 10, 0, 7); cx.stroke();
      for (const [login, r] of remote) {
        cx.fillStyle = "rgba(255,255,255,.45)"; cx.beginPath(); cx.arc(r.x, r.y, 6, 0, 7); cx.fill();
        cx.fillStyle = "rgba(255,255,255,.6)"; cx.font = "10px system-ui"; cx.fillText(r.name || login, r.x + 9, r.y + 3);
      }
      if (!ball.sunk) {
        cx.fillStyle = "#fff"; cx.beginPath(); cx.arc(ball.x, ball.y, 6.5, 0, 7); cx.fill();
        if (aim) {
          cx.strokeStyle = "rgba(0,255,90,.7)"; cx.lineWidth = 2;
          cx.beginPath(); cx.moveTo(ball.x, ball.y); cx.lineTo(aim.x, aim.y); cx.stroke();
        }
      }
    }
    function render(state) {
      if (!state || !state.players) return;
      const head = $("gfHead"), sc = $("gfScore");
      const cur = state.players[state.turn % state.players.length];
      if (head) head.innerHTML = `<b>${t("act_gf_hole", { n: (state.hole || 0) + 1, par: course().par })}</b>` +
        `<span class="gf-turn">${myTurn() ? t("act_gf_your_turn") : t("act_gf_turn", { name: (cur && cur.name) || "" })}</span>`;
      if (sc) sc.innerHTML = state.players.map((p) =>
        `<span class="gf-p${p.login === (cur && cur.login) ? " on" : ""}">${escapeHtml(p.name)} <b>${p.total}</b></span>`).join("");
      if (state._resetAt && state._resetAt !== render._seen) { render._seen = state._resetAt; resetBall(); remote.clear(); }
    }
    function onMsg(msg) {
      if (!msg || !msg.gf) return;
      if (msg.from !== (profile && profile.login)) {
        if (msg.gf === "pos") {
          const p = (S().players || []).find((x) => x.login === msg.from);
          remote.set(msg.from, { x: msg.x, y: msg.y, name: (p && p.name) || msg.fromName });
        }
      }
      if (!isHost()) return;
      const st = { ...(ACT.state || {}) };
      if (!st.players) return;
      const idx = st.players.findIndex((p) => p.login === msg.from);
      if (idx < 0) return;
      if (msg.gf === "stroke") { st.players = st.players.map((p, i) => (i === idx ? { ...p, strokes: p.strokes + 1, total: p.total + 1 } : p)); pushState(st); }
      else if (msg.gf === "sunk" || msg.gf === "stopped") {
        if (msg.gf === "sunk") st.players = st.players.map((p, i) => (i === idx ? { ...p, sunk: true } : p));
        // Everyone holed out → next hole; otherwise pass the putter along.
        if (st.players.every((p) => p.sunk)) {
          st.hole = (st.hole || 0) + 1;
          if (st.hole >= COURSES.length) { st.phase = "done"; }
          else { st.players = st.players.map((p) => ({ ...p, sunk: false, strokes: 0 })); st.turn = 0; st._resetAt = Date.now(); }
        } else {
          let next = st.turn;
          do { next = (next + 1) % st.players.length; } while (st.players[next].sunk && next !== st.turn);
          st.turn = next;
        }
        pushState(st);
      }
    }
    function unmount() {
      cancelAnimationFrame(raf); raf = 0; stopped = true;
      window.removeEventListener("mouseup", onUp);
      cv = null; cx = null; remote.clear();
    }
    return { mount, render, onMsg, unmount, hostInit };
  })();

  // ==========================================================================
  // Uno. Hands are dealt PRIVATELY (activity-msg with a `to`), so the shared state carries
  // only what everyone may see: the top card, whose turn it is, and how many cards each
  // player is holding.
  // ==========================================================================
  const Uno = (function () {
    const COLORS = ["r", "g", "b", "y"];
    const HEX = { r: "#ef4444", g: "#22c55e", b: "#3b82f6", y: "#eab308", w: "#111827" };
    let myHand = [];
    const S = () => ACT.state || {};
    function buildDeck() {
      const d = [];
      for (const c of COLORS) {
        d.push({ c, v: "0" });
        for (let n = 1; n <= 9; n++) { d.push({ c, v: String(n) }); d.push({ c, v: String(n) }); }
        for (const v of ["skip", "rev", "+2"]) { d.push({ c, v }); d.push({ c, v }); }
      }
      for (let i = 0; i < 4; i++) { d.push({ c: "w", v: "wild" }); d.push({ c: "w", v: "+4" }); }
      for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
      return d;
    }
    let deck = [];   // host only
    const hands = new Map();   // host only: login -> cards
    function hostInit() {
      const players = lobby().map((p) => ({ login: p.login, name: p.name }));
      deck = buildDeck(); hands.clear();
      for (const p of players) hands.set(p.login, deck.splice(0, 7));
      let top = deck.shift();
      while (top.c === "w") { deck.push(top); top = deck.shift(); }     // don't start on a wild
      for (const p of players) send({ to: p.login, uno: "hand", cards: hands.get(p.login) });
      return { players: players.map((p) => ({ ...p, n: 7 })), turn: 0, dir: 1, top, color: top.c, drawn: 0, winner: null };
    }
    const cur = (st) => st.players[st.turn % st.players.length];
    const playable = (card, st) => card.c === "w" || card.c === st.color || card.v === st.top.v;
    function mount(root) {
      root.innerHTML = `<div class="uno-wrap"><div class="uno-head" id="unoHead"></div>
        <div class="uno-table"><div class="uno-pile" id="unoPile"></div><button class="btn-ghost btn-sm" id="unoDraw">${t("uno_draw")}</button></div>
        <div class="uno-hand" id="unoHand"></div></div>`;
      $("unoDraw").onclick = () => send({ uno: "draw" });
      render(ACT.state);
    }
    function cardHtml(card, extra) {
      const label = card.v === "rev" ? "⇄" : card.v === "skip" ? "⊘" : card.v === "wild" ? "★" : card.v;
      return `<span class="uno-card ${extra || ""}" style="background:${HEX[card.c]}">${escapeHtml(label)}</span>`;
    }
    function render(st) {
      if (!st || !st.players) return;
      const head = $("unoHead"), pile = $("unoPile"), hand = $("unoHand");
      if (!head) return;
      const me = profile.login;
      const turnOf = cur(st);
      head.innerHTML = st.winner
        ? `<b>${escapeHtml(t("uno_won", { name: (st.players.find((p) => p.login === st.winner) || {}).name || st.winner }))}</b>`
        : `<b>${escapeHtml(turnOf.login === me ? t("uno_your_turn") : t("uno_turn", { name: turnOf.name }))}</b>` +
          `<span class="uno-players">` + st.players.map((p) =>
            `<span class="${p.login === turnOf.login ? "on" : ""}">${escapeHtml(p.name)} ${p.n}</span>`).join("") + `</span>`;
      if (pile) pile.innerHTML = cardHtml(st.top) + `<span class="uno-color" style="background:${HEX[st.color]}"></span>`;
      if (hand) {
        hand.innerHTML = "";
        for (const card of myHand) {
          const el = document.createElement("span");
          el.innerHTML = cardHtml(card, playable(card, st) && turnOf.login === me ? "ok" : "no");
          el.firstChild.onclick = () => {
            if (turnOf.login !== me || !playable(card, st)) return;
            // A wild needs a colour: show four swatches instead of a blocking dialog.
            if (card.c === "w") { pendingWild = card; renderWildPicker(); return; }
            send({ uno: "play", card, color: null });
          };
          hand.appendChild(el.firstChild);
        }
      }
      $("unoDraw") && ($("unoDraw").disabled = st.winner || turnOf.login !== me);
    }
    let pendingWild = null;
    function renderWildPicker() {
      const hand = $("unoHand"); if (!hand) return;
      const bar = document.createElement("div");
      bar.className = "uno-pick";
      bar.innerHTML = `<span class="uno-pick-l">${escapeHtml(t("uno_pick_color"))}</span>` +
        COLORS.map((c) => `<button class="uno-sw" data-c="${c}" style="background:${HEX[c]}"></button>`).join("");
      bar.querySelectorAll("[data-c]").forEach((b) => (b.onclick = () => {
        const card = pendingWild; pendingWild = null;
        bar.remove();
        if (card) send({ uno: "play", card, color: b.dataset.c });
      }));
      hand.prepend(bar);
    }
    function onMsg(msg) {
      if (!msg) return;
      if (msg.uno === "hand" && msg.from === ACT.host) { myHand = msg.cards || []; render(ACT.state); return; }
      if (!isHost()) return;
      const st = { ...(ACT.state || {}) };
      if (!st.players || st.winner) return;
      const idx = st.players.findIndex((p) => p.login === msg.from);
      if (idx < 0 || idx !== st.turn % st.players.length) return;      // not their turn
      const hand = hands.get(msg.from) || [];
      if (msg.uno === "draw") {
        if (!deck.length) deck = buildDeck();
        hand.push(deck.shift());
        hands.set(msg.from, hand);
        send({ to: msg.from, uno: "hand", cards: hand });
        st.players = st.players.map((p, i) => (i === idx ? { ...p, n: hand.length } : p));
        st.turn = nextTurn(st, 1);
        pushState(st);
        return;
      }
      if (msg.uno !== "play" || !msg.card) return;
      const ci = hand.findIndex((c) => c.c === msg.card.c && c.v === msg.card.v);
      if (ci < 0) return;
      const card = hand[ci];
      if (!(card.c === "w" || card.c === st.color || card.v === st.top.v)) return;
      hand.splice(ci, 1);
      hands.set(msg.from, hand);
      send({ to: msg.from, uno: "hand", cards: hand });
      st.top = card;
      st.color = card.c === "w" ? (COLORS.includes(msg.color) ? msg.color : COLORS[Math.floor(Math.random() * 4)]) : card.c;
      st.players = st.players.map((p, i) => (i === idx ? { ...p, n: hand.length } : p));
      if (!hand.length) { st.winner = msg.from; pushState(st); return; }
      let step = 1;
      if (card.v === "rev") { st.dir *= -1; if (st.players.length === 2) step = 2; }
      if (card.v === "skip") step = 2;
      if (card.v === "+2" || card.v === "+4") {
        const victim = st.players[nextTurn(st, 1) % st.players.length];
        const vh = hands.get(victim.login) || [];
        const take = card.v === "+2" ? 2 : 4;
        for (let i = 0; i < take; i++) { if (!deck.length) deck = buildDeck(); vh.push(deck.shift()); }
        hands.set(victim.login, vh);
        send({ to: victim.login, uno: "hand", cards: vh });
        st.players = st.players.map((p) => (p.login === victim.login ? { ...p, n: vh.length } : p));
        step = 2;
      }
      st.turn = nextTurn(st, step);
      pushState(st);
    }
    function nextTurn(st, step) {
      const n = st.players.length;
      return ((st.turn + st.dir * step) % n + n) % n;
    }
    function unmount() { myHand = []; hands.clear(); deck = []; pendingWild = null; }
    return { mount, render, onMsg, unmount, hostInit };
  })();

  // ==========================================================================
  // Texas Hold'em, trimmed to what a call actually plays: fixed blinds, one raise size,
  // fold / check / call / raise. Hole cards are private; the board and pot are shared.
  // ==========================================================================
  const Poker = (function () {
    const SUITS = ["♠", "♥", "♦", "♣"], RANKS = "23456789TJQKA";
    let myCards = [];
    let deck = [], holes = new Map();      // host only
    const S = () => ACT.state || {};
    function freshDeck() {
      const d = [];
      for (const s of SUITS) for (let i = 0; i < RANKS.length; i++) d.push({ r: i, s });
      for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
      return d;
    }
    function hostInit() {
      const players = lobby().map((p) => ({ login: p.login, name: p.name, chips: 500, bet: 0, folded: false }));
      return deal(players, 0);
    }
    function deal(players, dealerIdx) {
      deck = freshDeck(); holes.clear();
      const ps = players.map((p) => ({ ...p, bet: 0, folded: false }));
      for (const p of ps) holes.set(p.login, [deck.shift(), deck.shift()]);
      for (const p of ps) send({ to: p.login, pk: "hole", cards: holes.get(p.login) });
      // Blinds: 5 / 10, taken from the two seats after the dealer.
      const sb = (dealerIdx + 1) % ps.length, bb = (dealerIdx + 2) % ps.length;
      ps[sb].chips -= 5; ps[sb].bet = 5;
      ps[bb].chips -= 10; ps[bb].bet = 10;
      return {
        players: ps, dealer: dealerIdx, turn: (dealerIdx + 3) % ps.length,
        board: [], pot: 15, toCall: 10, street: 0, acted: 0, winner: null, showdown: null,
      };
    }
    function mount(root) {
      root.innerHTML = `<div class="pk-wrap"><div class="pk-head" id="pkHead"></div>
        <div class="pk-board" id="pkBoard"></div>
        <div class="pk-seats" id="pkSeats"></div>
        <div class="pk-mine" id="pkMine"></div>
        <div class="pk-acts">
          <button class="btn-ghost btn-sm" id="pkFold">${t("pk_fold")}</button>
          <button class="btn-ghost btn-sm" id="pkCall">${t("pk_call")}</button>
          <button class="btn-primary btn-sm" id="pkRaise">${t("pk_raise")}</button>
        </div></div>`;
      $("pkFold").onclick = () => send({ pk: "act", a: "fold" });
      $("pkCall").onclick = () => send({ pk: "act", a: "call" });
      $("pkRaise").onclick = () => send({ pk: "act", a: "raise" });
      render(ACT.state);
    }
    const cardHtml = (c) => c ? `<span class="pk-card ${c.s === "♥" || c.s === "♦" ? "red" : ""}">${RANKS[c.r]}${c.s}</span>` : `<span class="pk-card back"></span>`;
    function render(st) {
      if (!st || !st.players) return;
      const me = profile.login;
      const turnOf = st.players[st.turn % st.players.length];
      $("pkHead").innerHTML = st.winner
        ? `<b>${escapeHtml(t("pk_won", { name: (st.players.find((p) => p.login === st.winner) || {}).name || st.winner, n: st.pot }))}</b>`
        : `<b>${escapeHtml(turnOf.login === me ? t("pk_your_turn") : t("pk_turn", { name: turnOf.name }))}</b><span class="pk-pot">${t("pk_pot", { n: st.pot })}</span>`;
      $("pkBoard").innerHTML = st.board.map(cardHtml).join("") || `<span class="pk-note">${t("pk_preflop")}</span>`;
      $("pkSeats").innerHTML = st.players.map((p) =>
        `<span class="pk-seat${p.folded ? " out" : ""}${p.login === turnOf.login ? " on" : ""}">${escapeHtml(p.name)} <b>${p.chips}</b>${p.bet ? ` <i>+${p.bet}</i>` : ""}</span>`).join("");
      $("pkMine").innerHTML = myCards.map(cardHtml).join("") +
        (st.showdown ? `<span class="pk-note">${escapeHtml(st.showdown)}</span>` : "");
      const mine = st.players.find((p) => p.login === me);
      const active = !st.winner && turnOf.login === me && mine && !mine.folded;
      for (const id of ["pkFold", "pkCall", "pkRaise"]) { const b = $(id); if (b) b.disabled = !active; }
      const need = st.toCall - (mine ? mine.bet : 0);
      const cb = $("pkCall"); if (cb) cb.textContent = need > 0 ? t("pk_call_n", { n: need }) : t("pk_check");
    }
    // 7-card evaluation: score = category * 1e10 + tiebreak ranks. Enough to pick a winner.
    function best(cards) {
      const rc = {}, sc = {};
      for (const c of cards) { rc[c.r] = (rc[c.r] || 0) + 1; sc[c.s] = (sc[c.s] || 0) + 1; }
      const flushSuit = Object.keys(sc).find((s) => sc[s] >= 5);
      const ranks = [...new Set(cards.map((c) => c.r))].sort((a, b) => b - a);
      const straightTop = (rs) => {
        const set = new Set(rs);
        if (set.has(12)) set.add(-1);                       // wheel: A-2-3-4-5
        const all = [...set].sort((a, b) => b - a);
        for (const r of all) if ([1, 2, 3, 4].every((k) => set.has(r - k))) return r;
        return null;
      };
      const scoreOf = (cat, kick) => cat * 1e10 + kick.reduce((a, k, i) => a + k * Math.pow(15, 4 - i), 0);
      if (flushSuit) {
        const fr = cards.filter((c) => c.s === flushSuit).map((c) => c.r);
        const sf = straightTop(fr);
        if (sf !== null) return scoreOf(8, [sf]);
        return scoreOf(5, fr.sort((a, b) => b - a).slice(0, 5));
      }
      const st = straightTop(ranks);
      const groups = Object.entries(rc).map(([r, n]) => [Number(r), n]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
      if (groups[0][1] === 4) return scoreOf(7, [groups[0][0], groups[1][0]]);
      if (groups[0][1] === 3 && groups[1] && groups[1][1] >= 2) return scoreOf(6, [groups[0][0], groups[1][0]]);
      if (st !== null) return scoreOf(4, [st]);
      if (groups[0][1] === 3) return scoreOf(3, [groups[0][0], ...ranks.filter((r) => r !== groups[0][0]).slice(0, 2)]);
      if (groups[0][1] === 2 && groups[1] && groups[1][1] === 2) return scoreOf(2, [groups[0][0], groups[1][0], ranks.filter((r) => r !== groups[0][0] && r !== groups[1][0])[0]]);
      if (groups[0][1] === 2) return scoreOf(1, [groups[0][0], ...ranks.filter((r) => r !== groups[0][0]).slice(0, 3)]);
      return scoreOf(0, ranks.slice(0, 5));
    }
    function onMsg(msg) {
      if (!msg) return;
      if (msg.pk === "hole" && msg.from === ACT.host) { myCards = msg.cards || []; render(ACT.state); return; }
      if (!isHost() || msg.pk !== "act") return;
      let st = { ...(ACT.state || {}) };
      if (!st.players || st.winner) return;
      const idx = st.players.findIndex((p) => p.login === msg.from);
      if (idx < 0 || idx !== st.turn % st.players.length || st.players[idx].folded) return;
      const ps = st.players.map((p) => ({ ...p }));
      const p = ps[idx];
      if (msg.a === "fold") p.folded = true;
      else if (msg.a === "call") { const need = Math.min(st.toCall - p.bet, p.chips); p.chips -= need; p.bet += need; st.pot += need; }
      else if (msg.a === "raise") {
        const need = Math.min(st.toCall - p.bet + 20, p.chips);
        p.chips -= need; p.bet += need; st.pot += need;
        st.toCall = Math.max(st.toCall, p.bet);
        st.acted = 0;                                        // a raise reopens the betting
      }
      st.players = ps;
      st.acted = (st.acted || 0) + 1;
      const live = ps.filter((x) => !x.folded);
      if (live.length === 1) return finish(st, live[0].login, null);
      // Street ends when everyone live has matched the bet and had a turn.
      const settled = live.every((x) => x.bet === st.toCall) && st.acted >= live.length;
      if (settled) {
        st.acted = 0;
        st.players = ps.map((x) => ({ ...x, bet: 0 }));
        st.toCall = 0;
        st.street = (st.street || 0) + 1;
        if (st.street === 1) st.board = [deck.shift(), deck.shift(), deck.shift()];
        else if (st.street === 2 || st.street === 3) st.board = [...st.board, deck.shift()];
        else {
          let bestLogin = null, bestScore = -1, label = "";
          for (const x of live) {
            const sc = best([...(holes.get(x.login) || []), ...st.board]);
            if (sc > bestScore) { bestScore = sc; bestLogin = x.login; }
          }
          return finish(st, bestLogin, label);
        }
        st.turn = (st.dealer + 1) % ps.length;
        while (st.players[st.turn].folded) st.turn = (st.turn + 1) % ps.length;
        pushState(st);
        return;
      }
      do { st.turn = (st.turn + 1) % ps.length; } while (st.players[st.turn].folded);
      pushState(st);
    }
    function finish(st, winner, label) {
      const ps = st.players.map((x) => (x.login === winner ? { ...x, chips: x.chips + st.pot } : x));
      pushState({ ...st, players: ps, winner, showdown: label || null });
      // Next hand after a beat, so the result is readable.
      setTimeout(() => { if (isHost() && ACT.kind === "poker") pushState(deal(ps, (st.dealer + 1) % ps.length)); }, 4500);
    }
    function unmount() { myCards = []; holes.clear(); deck = []; }
    return { mount, render, onMsg, unmount, hostInit };
  })();

  // ==========================================================================
  // Car race. Three tracks, 1–5 laps. Everyone drives their own car and streams its
  // position; the host owns lap counting and the finishing order.
  // ==========================================================================
  const Race = (function () {
    const W = 600, H = 380;
    // A track is a closed centre-line; the road is everything within `w/2` of it.
    const TRACKS = [
      { name: "Oval", w: 74, pts: [[140, 90], [460, 90], [520, 190], [460, 290], [140, 290], [80, 190]] },
      { name: "Figure 8", w: 66, pts: [[120, 90], [300, 190], [480, 90], [540, 190], [480, 290], [300, 190], [120, 290], [60, 190]] },
      { name: "Snake", w: 62, pts: [[80, 90], [230, 90], [280, 160], [230, 230], [80, 230], [80, 320], [520, 320], [520, 230], [370, 230], [320, 160], [370, 90], [520, 90], [520, 40], [80, 40]] },
    ];
    let cv = null, cx = null, raf = 0, me = null, others = new Map(), keys = {};
    const S = () => ACT.state || {};
    const track = () => TRACKS[Math.min(S().track || 0, TRACKS.length - 1)];
    function hostInit() {
      const players = lobby().map((p) => ({ login: p.login, name: p.name, lap: 0, cp: 0, done: false }));
      return { track: 0, laps: 3, running: false, players, order: [] };
    }
    function reset() {
      const tr = track();
      const [x, y] = tr.pts[0];
      const [nx, ny] = tr.pts[1];
      me = { x, y, a: Math.atan2(ny - y, nx - x), v: 0, lap: 0, cp: 0 };
    }
    function mount(root) {
      root.innerHTML = `<div class="rc-wrap">
        <div class="rc-head" id="rcHead"></div>
        <canvas id="rcCanvas" width="${W}" height="${H}"></canvas>
        <div class="rc-foot" id="rcFoot"></div></div>`;
      cv = $("rcCanvas"); cx = cv.getContext("2d");
      reset();
      window.addEventListener("keydown", kd); window.addEventListener("keyup", ku);
      // Touch: left/right halves steer, bottom accelerates.
      cv.addEventListener("touchstart", touch, { passive: false });
      cv.addEventListener("touchmove", touch, { passive: false });
      cv.addEventListener("touchend", () => { keys = {}; });
      loop();
      render(ACT.state);
    }
    const kd = (e) => { if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) { e.preventDefault(); keys[e.key] = 1; } };
    const ku = (e) => { keys[e.key] = 0; };
    function touch(e) {
      e.preventDefault();
      const r = cv.getBoundingClientRect(); keys = {};
      for (const p of e.touches) {
        const x = (p.clientX - r.left) / r.width, y = (p.clientY - r.top) / r.height;
        if (y > 0.55) keys.ArrowUp = 1;
        if (x < 0.4) keys.ArrowLeft = 1; else if (x > 0.6) keys.ArrowRight = 1;
      }
    }
    // Distance to the road's centre line, and which segment we're nearest — that segment
    // index doubles as the checkpoint, which is what makes lap counting cheat-resistant.
    function nearest(x, y) {
      const tr = track(); let bd = 1e9, bi = 0;
      for (let i = 0; i < tr.pts.length; i++) {
        const [x1, y1] = tr.pts[i], [x2, y2] = tr.pts[(i + 1) % tr.pts.length];
        const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy;
        const t = L ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / L)) : 0;
        const d = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
        if (d < bd) { bd = d; bi = i; }
      }
      return { d: bd, i: bi };
    }
    let sendT = 0;
    function step() {
      const st = S();
      if (!me || !st.running) return;
      const tr = track();
      const onRoad = nearest(me.x, me.y).d < tr.w / 2;
      const accel = keys.ArrowUp ? (onRoad ? 0.24 : 0.09) : keys.ArrowDown ? -0.16 : 0;
      me.v = Math.max(-1.6, Math.min(onRoad ? 4.4 : 1.8, me.v + accel));
      me.v *= 0.985;
      if (keys.ArrowLeft) me.a -= 0.055 * Math.min(1, Math.abs(me.v) / 1.6);
      if (keys.ArrowRight) me.a += 0.055 * Math.min(1, Math.abs(me.v) / 1.6);
      me.x = Math.max(8, Math.min(W - 8, me.x + Math.cos(me.a) * me.v));
      me.y = Math.max(8, Math.min(H - 8, me.y + Math.sin(me.a) * me.v));
      // Checkpoints in order; crossing back onto segment 0 completes a lap.
      const { i } = nearest(me.x, me.y);
      const n = tr.pts.length;
      if (i === (me.cp + 1) % n) me.cp = i;
      if (me.cp === n - 1 && i === 0) { me.cp = 0; me.lap++; send({ rc: "lap", lap: me.lap }); }
      if (Date.now() - sendT > 70) { sendT = Date.now(); send({ rc: "pos", x: Math.round(me.x), y: Math.round(me.y), a: Math.round(me.a * 100) / 100 }); }
    }
    function draw() {
      if (!cx) return;
      const tr = track();
      cx.fillStyle = "#07120c"; cx.fillRect(0, 0, W, H);
      // Road: a thick stroke along the centre line, with a dashed racing line on top.
      cx.strokeStyle = "#1f2937"; cx.lineWidth = tr.w; cx.lineJoin = "round"; cx.lineCap = "round";
      cx.beginPath(); tr.pts.forEach(([x, y], i) => (i ? cx.lineTo(x, y) : cx.moveTo(x, y))); cx.closePath(); cx.stroke();
      cx.strokeStyle = "rgba(255,255,255,.18)"; cx.lineWidth = 2; cx.setLineDash([10, 12]);
      cx.beginPath(); tr.pts.forEach(([x, y], i) => (i ? cx.lineTo(x, y) : cx.moveTo(x, y))); cx.closePath(); cx.stroke();
      cx.setLineDash([]);
      // Start/finish line across the first segment.
      const [sx, sy] = tr.pts[0], [ex, ey] = tr.pts[1];
      const ang = Math.atan2(ey - sy, ex - sx) + Math.PI / 2;
      cx.strokeStyle = "#e5e7eb"; cx.lineWidth = 4;
      cx.beginPath();
      cx.moveTo(sx + Math.cos(ang) * tr.w / 2, sy + Math.sin(ang) * tr.w / 2);
      cx.lineTo(sx - Math.cos(ang) * tr.w / 2, sy - Math.sin(ang) * tr.w / 2);
      cx.stroke();
      for (const [login, o] of others) car(o.x, o.y, o.a, "#94a3b8", o.name);
      if (me) car(me.x, me.y, me.a, "#00ff5a", null);
    }
    function car(x, y, a, color, label) {
      cx.save(); cx.translate(x, y); cx.rotate(a);
      cx.fillStyle = color; cx.fillRect(-8, -5, 16, 10);
      cx.fillStyle = "rgba(0,0,0,.45)"; cx.fillRect(1, -4, 5, 8);
      cx.restore();
      if (label) { cx.fillStyle = "rgba(255,255,255,.65)"; cx.font = "10px system-ui"; cx.fillText(label, x + 11, y + 3); }
    }
    function loop() { step(); draw(); raf = requestAnimationFrame(loop); }
    function render(st) {
      if (!st || !$("rcHead")) return;
      const done = (st.order || []).length;
      $("rcHead").innerHTML = `<b>${escapeHtml(TRACKS[st.track || 0].name)}</b>` +
        `<span class="rc-lap">${escapeHtml(t("rc_lap", { n: Math.min((me ? me.lap : 0) + 1, st.laps), of: st.laps }))}</span>` +
        (done ? `<span class="rc-order">${(st.order || []).map((l, i) => `${i + 1}. ${escapeHtml((st.players.find((p) => p.login === l) || {}).name || l)}`).join(" · ")}</span>` : "");
      const foot = $("rcFoot");
      if (!foot) return;
      if (isHost() && !st.running) {
        foot.innerHTML = `<span class="rc-pick" id="rcTracks">` + TRACKS.map((tr, i) =>
          `<button class="rc-t${i === st.track ? " on" : ""}" data-tr="${i}">${escapeHtml(tr.name)}</button>`).join("") + `</span>` +
          `<span class="rc-pick" id="rcLaps">` + [1, 2, 3, 5].map((n) =>
          `<button class="rc-t${n === st.laps ? " on" : ""}" data-laps="${n}">${n}${escapeHtml(t("rc_laps_short"))}</button>`).join("") + `</span>` +
          `<button class="btn-primary btn-sm" id="rcGo">${escapeHtml(t("rc_start"))}</button>`;
        foot.querySelectorAll("[data-tr]").forEach((b) => (b.onclick = () => pushState({ ...S(), track: Number(b.dataset.tr) })));
        foot.querySelectorAll("[data-laps]").forEach((b) => (b.onclick = () => pushState({ ...S(), laps: Number(b.dataset.laps) })));
        $("rcGo").onclick = () => pushState({ ...S(), running: true, order: [], players: (S().players || []).map((p) => ({ ...p, lap: 0, done: false })) });
      } else foot.innerHTML = st.running ? `<span class="rc-note">${escapeHtml(t("rc_controls"))}</span>` : `<span class="rc-note">${escapeHtml(t("rc_waiting"))}</span>`;
      if (st.running && me && me.lap === 0 && !me._started) { me._started = true; reset(); me._started = true; }
    }
    function onMsg(msg) {
      if (!msg || !msg.rc) return;
      if (msg.from !== profile.login && msg.rc === "pos") {
        const p = (S().players || []).find((x) => x.login === msg.from);
        others.set(msg.from, { x: msg.x, y: msg.y, a: msg.a, name: (p && p.name) || msg.fromName });
      }
      if (!isHost() || msg.rc !== "lap") return;
      const st = { ...(ACT.state || {}) };
      if (!st.players || !st.running) return;
      st.players = st.players.map((p) => (p.login === msg.from ? { ...p, lap: Number(msg.lap) || 0 } : p));
      const fin = st.players.find((p) => p.login === msg.from);
      if (fin && fin.lap >= st.laps && !(st.order || []).includes(msg.from)) {
        st.order = [...(st.order || []), msg.from];
        if (st.order.length >= st.players.length) st.running = false;
      }
      pushState(st);
    }
    function resized() { /* canvas is CSS-scaled; nothing to recompute */ }
    function unmount() {
      cancelAnimationFrame(raf); raf = 0;
      window.removeEventListener("keydown", kd); window.removeEventListener("keyup", ku);
      cv = null; cx = null; others.clear(); me = null; keys = {};
    }
    return { mount, render, onMsg, unmount, hostInit, resized };
  })();

  // Leaving the call takes the panel with it.
  window.addEventListener("dialog-call-ended", () => { ACT.kind = null; unmount(); show(false); });
})();
