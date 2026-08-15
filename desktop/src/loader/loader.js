"use strict";

// Terminal boot loader — one 42ms tick drives typing, then a jittered progress bar.
// The jitter is the point: even pacing reads as fake. Real status events from the main
// process replace the tail line so the screen still tells the truth about what's happening.

const CMD = "dialog --boot --profile=desktop";
const BOOT = [
  ["[  OK  ]", "mounted /dev/dialog"],
  ["[  OK  ]", "started session daemon"],
  ["[  OK  ]", "keyring unlocked"],
  ["[ INFO ]", "resolving relay endpoints"],
  ["[  OK  ]", "handshake tls1.3 · 41ms"],
  ["[ INFO ]", "syncing messages"],
  ["[  OK  ]", "cache warm"],
  ["[ INFO ]", "restoring threads"],
  ["[  OK  ]", "presence online"],
];
const TAILS = ["linking channels", "verifying signatures", "rebuilding index", "fetching avatars", "finalizing session"];
const CELLS = 22;

// Speed comes from the app (Appearance → Loading). 1 = the designed ~5s cinematic pace.
let speed = 1;
try {
  const q = new URLSearchParams(location.search).get("speed");
  if (q) speed = Math.max(0.25, Math.min(6, parseFloat(q) || 1));
} catch {}

const $ = (id) => document.getElementById(id);
let typed = 0, pct = 0, override = null;

function render() {
  $("cmd").textContent = CMD.slice(0, typed);
  const shown = Math.min(BOOT.length, Math.floor((pct / 100) * (BOOT.length + 0.6)));
  const lines = $("lines");
  while (lines.children.length > shown) lines.removeChild(lines.lastChild);
  for (let i = lines.children.length; i < shown; i++) {
    const [tag, text] = BOOT[i];
    const row = document.createElement("div");
    const t = document.createElement("span");
    t.className = tag.includes("OK") ? "tag-ok" : "tag-info";
    t.textContent = tag;
    const m = document.createElement("span");
    m.className = "msg";
    m.textContent = text;
    row.appendChild(t); row.appendChild(m);
    lines.appendChild(row);
  }
  const filled = Math.round((pct / 100) * CELLS);
  $("bar").textContent = "[" + "█".repeat(filled) + "░".repeat(CELLS - filled) + "]";
  const p = Math.floor(pct);
  $("statusline").textContent = p >= 100 ? "100%  ready — press any key" : String(p).padStart(3, " ") + "%  loading dialog";
  $("stripPct").textContent = Math.min(99, 84 + Math.floor(p / 8)) + "%";
  $("tail").textContent = override || (p >= 100 ? "session established" : TAILS[Math.min(TAILS.length - 1, Math.floor(p / 20))] + "…");
}

const tick = setInterval(() => {
  if (typed < CMD.length) { typed += 1; render(); return; }   // phase 1: type the command
  if (pct >= 100) { clearInterval(tick); return; }
  pct = Math.min(100, pct + speed * (0.55 + Math.random() * 1.1));  // phase 2: jittered progress
  render();
}, 42);
render();

// Real status from the shell wins the tail line — a stalled connection must not look like
// a healthy boot.
const LABELS = { connecting: "connecting to relay", authenticating: "authenticating session", online: "session established", offline: "no route to host — retrying" };
if (window.loaderBridge && window.loaderBridge.onStatus) {
  window.loaderBridge.onStatus((p) => {
    const state = (p && p.state) || p;
    override = (p && p.detail) || LABELS[state] || null;
    if (state === "offline") { document.body.style.color = "#ff6b6b"; }
    render();
  });
}
