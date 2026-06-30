"use strict";

const {
  app,
  BrowserWindow,
  session,
  desktopCapturer,
  ipcMain,
  net,
  nativeImage,
  shell
} = require("electron");
const path = require("path");
const config = require("./config");
const { createTray, updateTrayState } = require("./tray");
const { setupAutoUpdate } = require("./updater");

const isDev = process.argv.includes("--dev");

let loaderWin = null;
let mainWin = null;
let appReady = false; // page finished loading + reported ready
let connectivityTimer = null;
let lastStatus = null;

// ---------------------------------------------------------------------------
// Chromium switches: enable PipeWire screen capture on Wayland (Linux) so that
// getDisplayMedia works on modern desktops, and keep WebRTC happy.
// ---------------------------------------------------------------------------
app.commandLine.appendSwitch(
  "enable-features",
  "WebRTCPipeWireCapturer,WebRTCPipeWireCamera"
);
// Autoplay audio (call ringtones / beeps) without a user gesture.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// Single-instance lock — focus the existing window on a second launch.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });
}

if (process.platform === "win32") {
  app.setAppUserModelId(config.APP_USER_MODEL_ID);
}

// ---------------------------------------------------------------------------
// Status reporting helper — pushes a status to the loader window.
// states: "offline" | "connecting" | "authenticating" | "online"
// ---------------------------------------------------------------------------
function setStatus(state, detail) {
  lastStatus = state;
  if (loaderWin && !loaderWin.isDestroyed()) {
    loaderWin.webContents.send("status", { state, detail });
  }
  updateTrayState({ connectivity: state });
}

// ---------------------------------------------------------------------------
// Loader window (frameless, 3:4)
// ---------------------------------------------------------------------------
function createLoader() {
  loaderWin = new BrowserWindow({
    width: config.LOADER.width,
    height: config.LOADER.height,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    center: true,
    backgroundColor: "#000700",
    show: false,
    skipTaskbar: false,
    title: "Dialog",
    webPreferences: {
      preload: path.join(__dirname, "loader", "loader-preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  loaderWin.loadFile(path.join(__dirname, "loader", "loader.html"));
  loaderWin.once("ready-to-show", () => loaderWin.show());
  loaderWin.on("closed", () => {
    loaderWin = null;
  });
}

// ---------------------------------------------------------------------------
// Main app window — created hidden, revealed once the page is ready.
// ---------------------------------------------------------------------------
function createMainWindow() {
  mainWin = new BrowserWindow({
    width: config.WINDOW.width,
    height: config.WINDOW.height,
    minWidth: config.WINDOW.minWidth,
    minHeight: config.WINDOW.minHeight,
    show: false,
    backgroundColor: "#000700",
    title: "Dialog",
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Permissions are granted at the session level (below). This still
      // needs to be allowed for media to be usable.
      spellcheck: true
    }
  });

  const wc = mainWin.webContents;

  wc.on("did-start-loading", () => {
    appReady = false;
    if (lastStatus !== "offline") setStatus("connecting");
  });

  wc.on("did-finish-load", () => {
    // Page HTML is loaded; wait for the in-page "ready" ping (socket up) before
    // hiding the loader. If the page never pings, reveal after a short grace.
    setStatus("authenticating");
    setTimeout(() => {
      if (!appReady) revealApp();
    }, 6000);
  });

  wc.on("did-fail-load", (_e, errorCode, errorDesc, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    // -3 == ERR_ABORTED (e.g. redirect); ignore.
    if (errorCode === -3) return;
    setStatus("offline", errorDesc);
    scheduleReload();
  });

  // Keep external links (http/https to other origins) in the system browser.
  wc.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.origin !== config.APP_ORIGIN) {
        shell.openExternal(url);
        return { action: "deny" };
      }
    } catch (_) {}
    return { action: "allow" };
  });

  wc.on("will-navigate", (e, url) => {
    try {
      const u = new URL(url);
      if (u.origin !== config.APP_ORIGIN) {
        e.preventDefault();
        shell.openExternal(url);
      }
    } catch (_) {}
  });

  mainWin.on("close", (e) => {
    // Hide to tray instead of quitting, unless a real quit was requested.
    if (!app.isQuitting) {
      e.preventDefault();
      mainWin.hide();
    }
  });

  mainWin.on("closed", () => {
    mainWin = null;
  });

  loadAppWhenOnline();
}

let reloadTimer = null;
function scheduleReload() {
  if (reloadTimer) return;
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    loadAppWhenOnline();
  }, 3000);
}

// Probe connectivity before loading; hold on the loader if offline.
async function loadAppWhenOnline() {
  const online = await probeConnectivity();
  if (!online) {
    setStatus("offline", "No Internet Access");
    scheduleReload();
    return;
  }
  setStatus("connecting");
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.loadURL(config.APP_URL);
  }
}

function probeConnectivity() {
  return new Promise((resolve) => {
    if (!net.isOnline()) return resolve(false);
    const request = net.request({ method: "HEAD", url: config.PROBE_URL });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    request.on("response", () => done(true));
    request.on("error", () => done(false));
    request.setHeader("cache-control", "no-cache");
    request.end();
    setTimeout(() => done(false), 5000);
  });
}

// Continuous connectivity watch — flips the loader/tray to offline if the
// network drops while we're still on the loader.
function startConnectivityWatch() {
  if (connectivityTimer) clearInterval(connectivityTimer);
  connectivityTimer = setInterval(async () => {
    if (appReady) return; // once revealed, the page handles its own reconnect
    const online = await probeConnectivity();
    if (!online) setStatus("offline", "No Internet Access");
  }, 4000);
}

// Reveal the main window and fade out the loader.
function revealApp() {
  if (appReady) return;
  appReady = true;
  setStatus("online");
  if (loaderWin && !loaderWin.isDestroyed()) {
    loaderWin.webContents.send("status", { state: "online" });
    // Give the loader a beat to play its "online" flourish, then close it.
    setTimeout(() => {
      if (loaderWin && !loaderWin.isDestroyed()) loaderWin.close();
    }, 900);
  }
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.show();
    mainWin.focus();
  }
}

function showMainWindow() {
  if (mainWin && !mainWin.isDestroyed()) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  } else if (appReady) {
    createMainWindow();
  }
}

// ---------------------------------------------------------------------------
// Permission auto-grant — eliminates the in-app web permission prompts for
// mic, camera, screenshare, notifications, etc.
// ---------------------------------------------------------------------------
function setupPermissions() {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(true);
  });

  ses.setPermissionCheckHandler(() => true);

  // getDisplayMedia (screen share). Electron does not fulfill this
  // automatically — we must supply a source. Auto-select the primary screen.
  ses.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ["screen"]
        });
        if (sources && sources.length) {
          callback({ video: sources[0], audio: "loopback" });
        } else {
          callback({});
        }
      } catch (_) {
        callback({});
      }
    },
    { useSystemPicker: true }
  );
}

// ---------------------------------------------------------------------------
// IPC from the page (via preload) — status pings, unread count, user status.
// ---------------------------------------------------------------------------
function setupIpc() {
  // Page reports it is interactive (socket connected / UI ready).
  ipcMain.on("app-ready", () => revealApp());

  // Page reports unread message count → tray badge.
  ipcMain.on("unread", (_e, count) => {
    updateTrayState({ unread: Number(count) || 0 });
    if (process.platform === "darwin") {
      app.dock.setBadge(count > 0 ? String(count) : "");
    }
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.setOverlayIcon(
        count > 0 ? badgeOverlay(count) : null,
        count > 0 ? `${count} unread` : ""
      );
    }
  });

  // Page reports presence status → tray.
  ipcMain.on("presence", (_e, status) => {
    updateTrayState({ presence: status });
  });

  // Notification clicked in renderer → focus + navigate.
  ipcMain.on("notification-click", (_e, chatId) => {
    showMainWindow();
    if (mainWin && chatId) {
      mainWin.webContents.send("navigate-chat", chatId);
    }
  });
}

function badgeOverlay(count) {
  // Minimal red badge for the Windows taskbar overlay.
  const size = 32;
  const label = count > 9 ? "9+" : String(count);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <circle cx="16" cy="16" r="15" fill="#ff2d4b"/>
    <text x="16" y="22" font-size="18" font-family="Arial" font-weight="bold"
      fill="#fff" text-anchor="middle">${label}</text></svg>`;
  return nativeImage.createFromDataURL(
    "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64")
  );
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  setupPermissions();
  setupIpc();
  createLoader();
  createMainWindow();
  startConnectivityWatch();

  createTray({
    onOpen: showMainWindow,
    onQuit: () => {
      app.isQuitting = true;
      app.quit();
    },
    getMainWindow: () => mainWin
  });

  if (!isDev) {
    setupAutoUpdate({ getMainWindow: () => mainWin });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else showMainWindow();
  });
});

app.on("before-quit", () => {
  app.isQuitting = true;
});

app.on("window-all-closed", () => {
  // Stay alive in the tray; only quit explicitly.
  if (app.isQuitting) app.quit();
});
