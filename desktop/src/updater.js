"use strict";

// Desktop auto-update via electron-updater against a generic feed
// (https://dialogmsg.xyz/dl — same place the installers live). The app reads
// latest-linux.yml / latest.yml / latest-mac.yml there.
//
// Two flows:
//   • Automatic  — checks on launch + every 6h, downloads in the background,
//                  prompts to restart when ready. Silent if already up to date.
//   • Manual     — tray "Check for updates": shows native dialogs for every
//                  outcome (checking / up to date / downloading / error).

const { dialog, app, BrowserWindow } = require("electron");

let autoUpdater = null;
let getMainWindow = () => null;
let listenersReady = false;
let manualCheck = false; // true when the current check came from the tray
let downloading = false;

// Two packagings cannot update themselves in place:
//
//   Flatpak  — /app is a read-only mount and Flathub rejects bundled updaters;
//              users get new versions through `flatpak update`. FLATPAK_ID is
//              exported into every Flatpak sandbox.
//   Portable — the .exe unpacks into a temp directory and runs from there, so
//              there is nothing stable to overwrite; replacing the file is the
//              user's job. electron-builder sets PORTABLE_EXECUTABLE_DIR.
//
// Left unguarded, both would download an update on every launch and fail at the
// install step.
const IN_FLATPAK = !!process.env.FLATPAK_ID;
const IN_PORTABLE = !!process.env.PORTABLE_EXECUTABLE_DIR;
const SELF_UPDATE_OFF = IN_FLATPAK || IN_PORTABLE;

function load() {
  if (autoUpdater) return autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (_) {
    autoUpdater = null;
  }
  return autoUpdater;
}

function win() {
  const w = getMainWindow();
  return w && !w.isDestroyed() ? w : BrowserWindow.getAllWindows()[0] || null;
}

function box(opts) {
  const w = win();
  return w
    ? dialog.showMessageBox(w, opts)
    : dialog.showMessageBox(opts);
}

function registerListeners(u) {
  if (listenersReady) return;
  listenersReady = true;

  u.autoDownload = true;
  u.autoInstallOnAppQuit = true;

  u.on("update-available", (info) => {
    downloading = true;
    if (manualCheck) {
      manualCheck = false;
      box({
        type: "info",
        title: "Update available",
        message: `Dialog ${info.version} is available.`,
        detail: "It's downloading in the background — you'll be prompted to restart when it's ready.",
        buttons: ["OK"]
      });
    }
  });

  u.on("update-not-available", () => {
    if (manualCheck) {
      manualCheck = false;
      box({
        type: "info",
        title: "You're up to date",
        message: `Dialog ${app.getVersion()} is the latest version.`,
        buttons: ["OK"]
      });
    }
  });

  u.on("update-downloaded", async (info) => {
    downloading = false;
    const { response } = await box({
      type: "info",
      title: "Update ready",
      message: `Dialog ${info.version} has been downloaded.`,
      detail: "Restart now to finish updating.",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1
    });
    if (response === 0) {
      app.isQuitting = true;
      setImmediate(() => u.quitAndInstall());
    }
  });

  u.on("error", (err) => {
    downloading = false;
    if (manualCheck) {
      manualCheck = false;
      box({
        type: "error",
        title: "Update check failed",
        message: "Couldn't check for updates.",
        detail: String((err && err.message) || err),
        buttons: ["OK"]
      });
    }
  });
}

// ctx.getMainWindow lets dialogs attach to the main window.
function setupAutoUpdate(ctx) {
  if (ctx && ctx.getMainWindow) getMainWindow = ctx.getMainWindow;
  if (SELF_UPDATE_OFF) return;
  const u = load();
  if (!u) return;
  registerListeners(u);

  // Automatic checks: shortly after launch, then every 6 hours.
  setTimeout(() => run(false), 8000);
  setInterval(() => run(false), 6 * 60 * 60 * 1000);
}

// Manual check from the tray.
function checkNow(ctx) {
  if (ctx && ctx.getMainWindow) getMainWindow = ctx.getMainWindow;
  run(true);
}

function run(manual) {
  if (SELF_UPDATE_OFF) {
    if (manual) {
      box({
        type: "info",
        title: "Updates",
        message: IN_FLATPAK ? "Dialog updates through Flatpak." : "This is the portable build.",
        detail: IN_FLATPAK
          ? "Run `flatpak update xyz.dialogmsg.app`, or let your software centre do it."
          : "Portable builds do not update themselves — download the latest .exe from dialogmsg.xyz/download and replace this one.",
        buttons: ["OK"]
      });
    }
    return;
  }

  const u = load();
  if (!u) {
    if (manual) {
      box({
        type: "info",
        title: "Updates",
        message: "Updater unavailable.",
        detail: "electron-updater is not installed in this build.",
        buttons: ["OK"]
      });
    }
    return;
  }
  registerListeners(u);

  // Not packaged (dev run) — electron-updater can't check.
  if (!app.isPackaged) {
    if (manual) {
      box({
        type: "info",
        title: "Updates",
        message: "Updates are only available in the installed app.",
        detail: "Run a packaged build to test auto-update.",
        buttons: ["OK"]
      });
    }
    return;
  }

  if (downloading) {
    if (manual) {
      box({
        type: "info",
        title: "Updates",
        message: "An update is already downloading…",
        buttons: ["OK"]
      });
    }
    return;
  }

  manualCheck = manual;
  u.checkForUpdates().catch((err) => {
    if (manual) {
      manualCheck = false;
      box({
        type: "error",
        title: "Update check failed",
        message: "Couldn't reach the update server.",
        detail: String((err && err.message) || err),
        buttons: ["OK"]
      });
    }
  });
}

module.exports = { setupAutoUpdate, checkNow };
