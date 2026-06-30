"use strict";

// Auto-update via electron-updater against GitHub Releases (configured in
// package.json "build.publish"). Safe no-op in dev / when not packaged.

let autoUpdater = null;
let getMainWindow = () => null;

function load() {
  if (autoUpdater) return autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (_) {
    autoUpdater = null;
  }
  return autoUpdater;
}

function send(channel, payload) {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function setupAutoUpdate(ctx) {
  getMainWindow = ctx.getMainWindow || getMainWindow;
  const u = load();
  if (!u) return;

  u.autoDownload = true;
  u.autoInstallOnAppQuit = true;

  u.on("checking-for-update", () => send("update-status", { state: "checking" }));
  u.on("update-available", (info) =>
    send("update-status", { state: "available", version: info.version })
  );
  u.on("update-not-available", () =>
    send("update-status", { state: "none" })
  );
  u.on("download-progress", (p) =>
    send("update-status", { state: "downloading", percent: p.percent })
  );
  u.on("update-downloaded", (info) =>
    send("update-status", { state: "ready", version: info.version })
  );
  u.on("error", (err) =>
    send("update-status", { state: "error", message: String(err) })
  );

  // Check shortly after launch, then every 6 hours.
  setTimeout(checkNow, 8000);
  setInterval(checkNow, 6 * 60 * 60 * 1000);
}

function checkNow() {
  const u = load();
  if (!u) return;
  try {
    u.checkForUpdatesAndNotify();
  } catch (_) {}
}

module.exports = { setupAutoUpdate, checkNow };
