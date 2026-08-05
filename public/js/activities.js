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
  };

  function start(kind) {
    if (!call || !call.active) { notify(t("act_need_call")); return; }
    socket.emit("activity-start", { kind });
  }
  function stop() { socket.emit("activity-stop"); }

  function mount(kind) {
    unmount();
    const mod = kind === "watch" ? Watch : kind === "gartic" ? Gartic : kind === "golf" ? Golf : null;
    ACT.mod = mod;
    setTitle(KINDS[kind] ? KINDS[kind].label() : "");
    $("actStop") && $("actStop").classList.toggle("hidden", !isHost());
    show(true);
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
    const COURSES = [
      { par: 2, tee: [70, 300], cup: [480, 70], walls: [[20,20,540,20],[540,20,540,340],[540,340,20,340],[20,340,20,20],[180,20,180,240],[380,120,380,340]] },
      { par: 3, tee: [70, 70], cup: [480, 300], walls: [[20,20,540,20],[540,20,540,340],[540,340,20,340],[20,340,20,20],[140,90,420,90],[140,270,420,270],[420,90,420,180]] },
      { par: 3, tee: [280, 320], cup: [280, 60], walls: [[20,20,540,20],[540,20,540,340],[540,340,20,340],[20,340,20,20],[180,120,180,340],[380,120,380,340],[180,120,380,120]] },
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

  // Leaving the call takes the panel with it.
  window.addEventListener("dialog-call-ended", () => { ACT.kind = null; unmount(); show(false); });
})();
