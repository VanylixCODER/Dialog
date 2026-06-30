"use strict";

// Fake "hacker boot" sequence + a live status line driven by the real
// connectivity/auth events forwarded from the main process.

const logEl = document.getElementById("log");
const barFill = document.getElementById("barFill");
const statusEl = document.getElementById("status");
const statusText = document.getElementById("statusText");

const STATUS_LABELS = {
  connecting: "Connecting…",
  authenticating: "Authenticating",
  online: "Online",
  offline: "No Internet Access"
};

let currentState = "connecting";

function setStatus(state, detail) {
  currentState = state;
  statusEl.className = "status status--" + state;
  statusText.textContent = detail || STATUS_LABELS[state] || state;
}

// Boot log lines. {t} text, {c} class, {d} delay(ms) before printing,
// {tag} optional trailing status tag printed after a short pause.
const SCRIPT = [
  { t: "[ DIALOG SECURE SHELL v1.0.0 ]", c: "hl", d: 120 },
  { t: "booting kernel modules", d: 220, tag: "OK" },
  { t: "mounting encrypted volume /dev/dlg0", d: 260, tag: "OK" },
  { t: "initializing crypto core (aes-256-gcm)", d: 240, tag: "OK" },
  { t: "loading certificate chain", d: 200, tag: "OK" },
  { t: "probing network interfaces", d: 220, tag: "OK" },
  { t: "resolving relay @ dialogmsg.xyz", d: 260, tag: "OK" },
  { t: "establishing relay tunnel", d: 300, tag: "OK" },
  { t: "performing TLS handshake", d: 280, tag: "OK" },
  { t: "negotiating realtime socket", d: 260, tag: "OK" },
  { t: "authenticating session token", d: 320, tag: "OK" },
  { t: "syncing presence + channels", d: 260, tag: "OK" },
  { t: "spawning interface", c: "hl", d: 220, tag: "READY" }
];

function line(text, cls) {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text + "\n";
  logEl.appendChild(span);
  // keep view pinned to bottom
  logEl.scrollTop = logEl.scrollHeight;
  // trim very old lines to avoid overflow
  while (logEl.childNodes.length > 60) logEl.removeChild(logEl.firstChild);
}

function tag(node, label) {
  const t = document.createElement("span");
  const cls = label === "OK" || label === "READY" ? "ok" : "warn";
  t.className = cls;
  t.textContent = "  [ " + label + " ]";
  node.appendChild(t);
}

let i = 0;
let progress = 0;
let booting = true;

function step() {
  if (!booting) return;
  if (i >= SCRIPT.length) {
    booting = false;
    return;
  }
  const item = SCRIPT[i];

  // If we've gone offline mid-boot, pause the sequence and surface it.
  if (currentState === "offline") {
    line("network unreachable — retrying", "err");
    setTimeout(step, 1400);
    return;
  }

  const span = document.createElement("span");
  if (item.c) span.className = item.c;
  span.textContent = item.t;
  logEl.appendChild(span);

  setTimeout(() => {
    if (item.tag) tag(span, item.tag);
    span.appendChild(document.createTextNode("\n"));
    logEl.scrollTop = logEl.scrollHeight;
    while (logEl.childNodes.length > 60) logEl.removeChild(logEl.firstChild);

    progress = Math.min(100, Math.round(((i + 1) / SCRIPT.length) * 100));
    barFill.style.width = progress + "%";
    i += 1;
    setTimeout(step, item.d || 220);
  }, 140);
}

// Kick off the boot animation.
setStatus("connecting");
setTimeout(step, 400);

// --- React to real status from main ---------------------------------------
if (window.loaderBridge) {
  window.loaderBridge.onStatus(({ state, detail }) => {
    setStatus(state, detail);

    if (state === "online") {
      // finish the bar and fade out
      barFill.style.width = "100%";
      line("interface ready — welcome to Dialog", "ok");
      setTimeout(() => document.body.classList.add("done"), 250);
    }
    if (state === "offline") {
      barFill.style.width = Math.max(progress, 8) + "%";
    }
  });
}
