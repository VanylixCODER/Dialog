"use strict";

// Preload for the MAIN app window. Runs with context isolation in the page's
// world boundary. It does two things:
//   1. Watches the page for signals that the app is "ready" (socket connected)
//      so the loader can be dismissed at the right moment.
//   2. Enhances the web Notification API so native notifications also update
//      the tray badge and focus the right chat when clicked.

const { contextIsolated } = process;
const { ipcRenderer, contextBridge } = require("electron");

// --- 1. Tell main when the app is interactive -----------------------------
function signalReady() {
  ipcRenderer.send("app-ready");
}

window.addEventListener("DOMContentLoaded", () => {
  // The SPA flips body/app classes once authenticated. Reveal as soon as the
  // main UI mounts; the 6s grace timer in main.js is the fallback.
  const tryReady = () => {
    const appRoot =
      document.querySelector("#app") ||
      document.querySelector(".app") ||
      document.querySelector("main.chat");
    if (appRoot) {
      signalReady();
      return true;
    }
    return false;
  };

  if (!tryReady()) {
    const obs = new MutationObserver(() => {
      if (tryReady()) obs.disconnect();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    // Hard fallback.
    setTimeout(signalReady, 5000);
  }
});

// --- 2. Wrap window.Notification to bridge clicks + unread ----------------
// Notifications themselves render natively via Chromium; we only piggy-back on
// them to drive the tray badge and chat navigation.
function installNotificationBridge() {
  const Native = window.Notification;
  if (!Native) return;

  let unread = 0;

  function Wrapped(title, options) {
    unread += 1;
    ipcRenderer.send("unread", unread);

    const n = new Native(title, options);
    const chatId = options && options.data && options.data.chatId;

    n.addEventListener("click", () => {
      ipcRenderer.send("notification-click", chatId || null);
      unread = 0;
      ipcRenderer.send("unread", 0);
    });
    return n;
  }

  Wrapped.requestPermission = Native.requestPermission
    ? Native.requestPermission.bind(Native)
    : () => Promise.resolve("granted");
  Object.defineProperty(Wrapped, "permission", {
    get: () => "granted"
  });
  Wrapped.maxActions = Native.maxActions;

  try {
    window.Notification = Wrapped;
  } catch (_) {
    /* some pages freeze Notification; ignore */
  }

  // Clear the badge when the window regains focus.
  window.addEventListener("focus", () => {
    unread = 0;
    ipcRenderer.send("unread", 0);
  });
}

window.addEventListener("DOMContentLoaded", installNotificationBridge);

// --- Expose a tiny API the web app MAY optionally use ---------------------
// (No-op if the page doesn't call it. Lets the SPA push explicit signals.)
const api = {
  ready: () => ipcRenderer.send("app-ready"),
  setUnread: (n) => ipcRenderer.send("unread", n),
  setPresence: (s) => ipcRenderer.send("presence", s),
  onNavigateChat: (cb) =>
    ipcRenderer.on("navigate-chat", (_e, chatId) => cb(chatId)),
  isDesktop: true
};

if (contextIsolated) {
  contextBridge.exposeInMainWorld("dialogDesktop", api);
} else {
  window.dialogDesktop = api;
}
