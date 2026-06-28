const { app, BrowserWindow, shell, session, dialog, Tray, Menu, nativeImage } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const { autoUpdater } = require("electron-updater");

let mainWindow = null;
let serverProcess = null;
let tray = null;
let isQuitting = false;
const PORT = process.env.PORT || 3000;
const SERVER_URL = `http://localhost:${PORT}`;

/* ── Server lifecycle ────────────────────────────────────────────── */
function startServer() {
  return new Promise((resolve, reject) => {
    const serverScript = path.join(__dirname, "..", "server.js");
    serverProcess = spawn(process.execPath, [serverScript], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    serverProcess.stderr.on("data", (d) => process.stderr.write(d));
    serverProcess.on("error", reject);
    serverProcess.on("exit", (code) => {
      reject(new Error(`Server exited with code ${code}`));
    });

    // Poll the server with HTTP requests until it responds
    const maxAttempts = 60;
    let attempt = 0;
    const poll = () => {
      if (attempt++ > maxAttempts) {
        reject(new Error("Server failed to start within timeout"));
        return;
      }
      const req = http.get(SERVER_URL, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => setTimeout(poll, 500));
      req.setTimeout(2000, () => { req.destroy(); setTimeout(poll, 500); });
    };
    // Give the server a moment to bind
    setTimeout(poll, 1000);
  });
}

/* ── Window ──────────────────────────────────────────────────────── */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 480,
    minHeight: 360,
    title: "Dialog",
    backgroundColor: "#000700",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
    },
  });

  mainWindow.loadURL(SERVER_URL);

  // Open external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });

  // Minimize to tray on close instead of quitting (non-macOS)
  mainWindow.on("close", (e) => {
    if (!isQuitting && process.platform !== "darwin") {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

/* ── System tray ──────────────────────────────────────────────── */
function createTray() {
  // On macOS, use the template icon (automatically inverts for light/dark menu bar)
  const iconPath = path.join(__dirname, "..", "build", "tray-icon.png");
  let icon = nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 });
  if (process.platform === "darwin") icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Dialog");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show Dialog",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on("double-click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

/* ── Auto-update ───────────────────────────────────────────────── */
function setupAutoUpdater() {
  // Don't check for updates in dev mode
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    console.log("Checking for updates...");
  });

  autoUpdater.on("update-available", (info) => {
    console.log("Update available:", info.version);
  });

  autoUpdater.on("update-not-available", () => {
    console.log("App is up to date.");
  });

  autoUpdater.on("download-progress", (progress) => {
    if (mainWindow) {
      mainWindow.setProgressBar(progress.percent / 100);
    }
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log("Update downloaded:", info.version);
    if (mainWindow) mainWindow.setProgressBar(-1); // clear progress bar
    dialog
      .showMessageBox(mainWindow, {
        type: "info",
        title: "Update Available",
        message: `A new version (${info.version}) has been downloaded.`,
        detail: "Restart now to apply the update, or later at next launch.",
        buttons: ["Restart Now", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall(false, true);
        }
      });
  });

  autoUpdater.on("error", (err) => {
    console.error("Auto-updater error:", err.message);
  });

  // Check for updates 5 seconds after the window loads
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error("Failed to check for updates:", err.message);
    });
  }, 5000);
}

/* ── App lifecycle ──────────────────────────────────────────────── */
app.whenReady().then(async () => {
  // Content-Security-Policy: allow the local server + necessary inline resources.
  // We set it via session so every request from the renderer is covered.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://www.youtube.com https://*.livekit.io",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https:",
      "media-src 'self' data: blob:",
      "connect-src 'self' ws: wss: https:",
      "frame-src https://www.youtube.com https://*.livekit.io",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });

  try {
    await startServer();
  } catch (err) {
    console.error("Failed to start server:", err.message);
    app.quit();
    return;
  }
  createWindow();
  createTray();
  setupAutoUpdater();

  app.on("activate", () => {
    if (mainWindow) {
      mainWindow.show();
    } else {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill("SIGTERM");
  }
});

// Prevent navigation away from the app
app.on("web-contents-created", (_, contents) => {
  contents.on("will-navigate", (e, url) => {
    if (!url.startsWith(SERVER_URL)) e.preventDefault();
  });
});
