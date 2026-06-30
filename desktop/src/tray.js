"use strict";

const { Tray, Menu, app, nativeImage } = require("electron");
const path = require("path");

let tray = null;
let ctx = null;
let state = {
  connectivity: "connecting", // offline | connecting | authenticating | online
  presence: "online", // online | dnd | invisible
  unread: 0,
  muted: false
};

function iconPath(name) {
  return path.join(__dirname, "..", "assets", "tray", name);
}

// Pick a tray icon variant for the current state.
function currentIcon() {
  let file = "normal.png";
  if (state.connectivity === "offline") file = "offline.png";
  else if (state.presence === "dnd") file = "dnd.png";
  else if (state.unread > 0) file = "unread.png";

  const img = nativeImage.createFromPath(iconPath(file));
  if (img.isEmpty()) {
    // Fallback: app icon so the tray is never blank if variants are missing.
    return nativeImage.createFromPath(
      path.join(__dirname, "..", "assets", "icon.png")
    );
  }
  if (process.platform === "darwin") img.setTemplateImage(false);
  return img;
}

function buildMenu() {
  const win = ctx.getMainWindow && ctx.getMainWindow();
  const visible = !!(win && win.isVisible());

  return Menu.buildFromTemplate([
    {
      label: state.unread > 0 ? `Dialog — ${state.unread} unread` : "Dialog",
      enabled: false
    },
    { type: "separator" },
    {
      label: visible ? "Hide window" : "Open Dialog",
      click: () => {
        if (visible) win.hide();
        else ctx.onOpen();
      }
    },
    {
      label: "Status",
      submenu: [
        radio("Online", "online"),
        radio("Do Not Disturb", "dnd"),
        radio("Invisible", "invisible")
      ]
    },
    {
      label: "Mute notifications",
      type: "checkbox",
      checked: state.muted,
      click: (item) => {
        state.muted = item.checked;
        if (win) win.webContents.send("set-muted", state.muted);
      }
    },
    { type: "separator" },
    {
      label: "Start at login",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
      }
    },
    {
      label: "Check for updates",
      click: () => {
        try {
          require("./updater").checkNow({ getMainWindow: ctx.getMainWindow });
        } catch (_) {}
      }
    },
    { type: "separator" },
    { label: "Quit Dialog", click: () => ctx.onQuit() }
  ]);
}

function radio(label, value) {
  return {
    label,
    type: "radio",
    checked: state.presence === value,
    click: () => {
      state.presence = value;
      const win = ctx.getMainWindow && ctx.getMainWindow();
      if (win) win.webContents.send("set-presence", value);
      refresh();
    }
  };
}

function refresh() {
  if (!tray) return;
  tray.setImage(currentIcon());
  tray.setContextMenu(buildMenu());
  const label =
    state.connectivity === "offline"
      ? "Dialog — No Internet Access"
      : state.unread > 0
        ? `Dialog — ${state.unread} unread`
        : "Dialog";
  tray.setToolTip(label);
}

function createTray(context) {
  ctx = context;
  tray = new Tray(currentIcon());
  tray.setToolTip("Dialog");
  tray.setContextMenu(buildMenu());

  // Left-click toggles the window (no-op on platforms that only do menus).
  tray.on("click", () => {
    const win = ctx.getMainWindow && ctx.getMainWindow();
    if (win && win.isVisible()) win.hide();
    else ctx.onOpen();
  });

  return tray;
}

function updateTrayState(partial) {
  Object.assign(state, partial);
  refresh();
}

module.exports = { createTray, updateTrayState };
