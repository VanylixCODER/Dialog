const { app, BrowserWindow, shell, session, dialog, Tray, Menu, nativeImage } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { autoUpdater } = require("electron-updater");

let mainWindow = null;
let serverProcess = null;
let tray = null;
let isQuitting = false;
const PORT = process.env.PORT || 3000;
const SERVER_URL = `http://localhost:${PORT}`;

// Locate server.js and its working directory.
// In a packaged build the app can either be packed into app.asar (with selected files
// unpacked to app.asar.unpacked) or unpacked entirely (asar:false). Both layouts must work.
// Critically, when asar is in use, Electron's Node hooks transparently read .js files
// from inside the asar — but ONLY when the spawned child runs as Node, not as Electron's
// GUI main process. Hence ELECTRON_RUN_AS_NODE=1 below.
//
// asarUnpack for server.js put the real file at app.asar.unpacked/server.js next to
// app.asar. For relative imports (./db.js, ./cache.js, ./auth.js) and dotenv's lookup
// of .env by CWD, the spawn must use the unpacked directory as both script dir and
// cwd — otherwise Node tries to require() through the asar fs hook which works for
// pure JS but NOT for native modules (.node binaries) that live only in the unpacked
// tree.
function resolveServerPaths() {
  if (!app.isPackaged) {
    return {
      script: path.join(__dirname, "..", "server.js"),
      cwd: path.join(__dirname, ".."),
    };
  }
  const appPath = app.getAppPath();
  const isAsar = appPath.endsWith(".asar") || appPath.endsWith(".asar/");
  const realDir = isAsar ? appPath.replace(/\.asar\/?$/, ".asar.unpacked") : appPath;
  return {
    script: path.join(realDir, "server.js"),
    cwd: realDir,
  };
}

/* ── Server lifecycle ────────────────────────────────────────────── */
function startServer() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settleResolve = () => { if (!settled) { settled = true; resolve(); } };
    const settleReject = (e) => { if (!settled) { settled = true; reject(e); } };

    const { script, cwd } = resolveServerPaths();
    // Sanity-check the script exists so we fail fast with a useful error instead of a
    // cryptic spawn ENOENT (e.g. user is on a fresh checkout without built artifacts).
    if (!fs.existsSync(script)) {
      return settleReject(new Error(
        `server.js not found at ${script}. Run \`npm run build\` for packaged, or \`npm start\` for dev.`
      ));
    }

    // CRITICAL: ELECTRON_RUN_AS_NODE=1 makes the spawned binary act as plain Node.
    // Without it, the spawn launches a SECOND Electron GUI instance whose main entry
    // is package.json's "main" (= server.js). That GUI child loads server.js → db.js,
    // which throws on missing DB_HOST, killing the child before any HTTP listener binds.
    // Symptoms: AppImage/.deb appear to do nothing on launch; the same applies to the
    // .exe on Windows when run from a non-interactive shell.

    // Resolve the .env path to pass to server.js via DOTENV_CONFIG_PATH so db.js's
    // `if (!process.env.DB_HOST)` check sees user-supplied config from the location
    // they actually drop a .env file (next to the binary they double-clicked).
    //
    // Why APPIMAGE for AppImage: process.execPath there points inside the read-only
    // squashfs mount temp dir (e.g. /tmp/.mount_xxx/AppRun) — useless for finding
    // `.env` on the user's filesystem. APPIMAGE env (set by the AppImage runtime at
    // launch) is the actual file path the user clicked (e.g. /home/me/Downloads/...),
    // so .env sitting next to it gets picked up.
    //
    // Skipped in dev because server's cwd there IS the project root and dotenv's
    // default cwd lookup already finds .env. Skipped when the user already set
    // DOTENV_CONFIG_PATH in their shell — don't clobber an explicit override.
    const dotEnvPath = (process.env.DOTENV_CONFIG_PATH || !app.isPackaged)
      ? null
      : path.join(
          process.env.APPIMAGE ? path.dirname(process.env.APPIMAGE) : path.dirname(process.execPath),
          ".env"
        );

    serverProcess = spawn(process.execPath, [script], {
      cwd,
      env: {
        ...process.env,
        PORT: String(PORT),
        ELECTRON_RUN_AS_NODE: "1",
        ...(dotEnvPath ? { DOTENV_CONFIG_PATH: dotEnvPath } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Forward both streams so errors appear in the system terminal / Chromium logs.
    serverProcess.stdout.on("data", (d) => process.stdout.write(d));
    serverProcess.stderr.on("data", (d) => process.stderr.write(d));
    serverProcess.on("error", (err) => settleReject(err));
    serverProcess.on("exit", (code) => {
      if (settled) {
        // Crashed AFTER becoming ready — surface but don't tear down the window.
        console.error(`Dialog server exited unexpectedly with code ${code}. Reload the window to restart it.`);
        return;
      }
      settleReject(new Error(
        `server.js exited with code ${code} before becoming ready. ` +
        `Common cause: missing DB_HOST / DB_PORT / DB_USER / DB_PASS / DB_NAME env vars in .env. ` +
        `See server.js header for setup.`
      ));
    });

    // Poll the server with HTTP requests until it responds
    const maxAttempts = 60;
    let attempt = 0;
    const poll = () => {
      if (settled) return;
      if (attempt++ > maxAttempts) {
        return settleReject(new Error("Server failed to start within timeout (30s)."));
      }
      const req = http.get(SERVER_URL, (res) => {
        if (settled) return;
        res.resume();
        settleResolve();
      });
      req.on("error", () => { if (!settled) setTimeout(poll, 500); });
      req.setTimeout(2000, () => {
        if (!settled) { req.destroy(); setTimeout(poll, 500); }
      });
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
    // Surface the failure to the user instead of silently exiting — otherwise AppImage
    // and .deb installs look like they "didn't open", and Windows users see only a
    // vanishing splash. The detail gives them the exact .env variable to set.
    dialog.showErrorBox(
      "Dialog could not start",
      `The bundled server failed to start.\n\n${err.message}\n\n` +
      `If this is a fresh install, copy .env.example to .env (in the same folder as the app) ` +
      `and fill in your DB_* values, then relaunch.`
    );
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
