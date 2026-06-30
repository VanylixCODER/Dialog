"use strict";

// Preload for the MAIN app window (context-isolated).
//
// Why this exists: the Dialog web app shows notifications ONLY through Web Push
// (service worker `push` -> showNotification). Electron's Chromium has no push
// service backend, so those never fire — that's why no notifications appeared in
// the AppImage/Flatpak builds.
//
// Fix: inject a script into the page's MAIN world that taps the live Socket.IO
// stream and raises native notifications (which Electron renders on the OS)
// for incoming messages and calls — independent of Web Push. The web app files
// are not modified, so the browser build is unaffected.

const { ipcRenderer, webFrame, contextIsolated } = require("electron");

// --- 1. Tell main when the app is interactive (dismiss the boot loader) ----
function signalReady() {
  ipcRenderer.send("app-ready");
}

window.addEventListener("DOMContentLoaded", () => {
  const tryReady = () =>
    !!(
      document.querySelector("#app") ||
      document.querySelector(".app") ||
      document.querySelector("main.chat")
    ) && (signalReady(), true);

  if (!tryReady()) {
    const obs = new MutationObserver(() => {
      if (tryReady()) obs.disconnect();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(signalReady, 5000);
  }
});

// --- 2. Bridge events coming back from the injected main-world script ------
// (DOM/window events cross the isolated<->main world boundary; their detail is
// structured-cloned.)
window.addEventListener("dialog-unread", (e) => {
  ipcRenderer.send("unread", (e.detail && e.detail.count) || 0);
});
window.addEventListener("dialog-notif-click", (e) => {
  ipcRenderer.send("notification-click", (e.detail && e.detail.room) || null);
});

// --- 3. Inject the main-world notification tap ----------------------------
// Runs before the page's own scripts (socket.io.js, app.js) so it can wrap the
// global `io` factory and capture the socket instance.
function mainWorldInit() {
  if (window.__dialogNotifyInstalled) return;
  window.__dialogNotifyInstalled = true;

  var RealNotification = window.Notification;

  // Make the app's permission checks pass so it doesn't gate behaviour on the
  // (non-functional in Electron) Web Push path.
  try {
    function NotificationShim(title, opts) {
      return new RealNotification(title, opts);
    }
    NotificationShim.requestPermission = function (cb) {
      if (cb) cb("granted");
      return Promise.resolve("granted");
    };
    Object.defineProperty(NotificationShim, "permission", {
      get: function () {
        return "granted";
      }
    });
    NotificationShim.maxActions = RealNotification.maxActions || 2;
    window.Notification = NotificationShim;
  } catch (e) {}

  var unread = 0;
  var sentLocalIds = new Set();

  function bump() {
    unread += 1;
    window.dispatchEvent(
      new CustomEvent("dialog-unread", { detail: { count: unread } })
    );
  }
  window.addEventListener("focus", function () {
    unread = 0;
    window.dispatchEvent(
      new CustomEvent("dialog-unread", { detail: { count: 0 } })
    );
  });

  function bodyOf(m) {
    if (m && typeof m.text === "string" && m.text.trim()) return m.text.trim();
    switch (m && m.type) {
      case "image":
        return "📷 Photo";
      case "audio":
        return "🎤 Voice message";
      case "gif":
        return "GIF";
      case "video":
        return "🎬 Video";
      default:
        return m && m.media ? "📎 Attachment" : "New message";
    }
  }

  function fire(title, body, room) {
    try {
      var n = new RealNotification(title || "Dialog", {
        body: body || "",
        silent: false,
        tag: room || undefined
      });
      n.onclick = function () {
        window.focus();
        window.dispatchEvent(
          new CustomEvent("dialog-notif-click", { detail: { room: room } })
        );
      };
      bump();
    } catch (e) {}
  }

  function hook(socket) {
    if (!socket || socket.__dialogHooked) return socket;
    socket.__dialogHooked = true;

    // Track our own outgoing messages so their server round-trip never
    // notifies (covers the "sent then alt-tabbed" race).
    var realEmit = socket.emit;
    socket.emit = function (ev, payload) {
      if (ev === "message" && payload && payload.localId)
        sentLocalIds.add(payload.localId);
      return realEmit.apply(socket, arguments);
    };

    socket.on("message", function (m) {
      if (!m) return;
      if (m.localId && sentLocalIds.has(m.localId)) {
        sentLocalIds.delete(m.localId);
        return;
      }
      // Only notify when the window isn't the user's focus.
      if (document.hasFocus()) return;
      fire(m.fromName || m.fromLogin || "Dialog", bodyOf(m), m.room);
    });

    socket.on("call-ring", function (p) {
      if (!p) return;
      fire("📞 Incoming call", p.name || p.title || "Someone is calling", p.room);
    });

    socket.on("dm-ping", function (p) {
      if (!p || document.hasFocus()) return;
      fire(p.fromName || p.fromLogin || "Dialog", "wants to chat", p.room);
    });

    return socket;
  }

  // Wrap the global `io` factory so we capture the socket app.js creates.
  var _realIo;
  var _wrapped;
  function makeWrapper(real) {
    _realIo = real;
    var w = function () {
      var s = _realIo.apply(this, arguments);
      try {
        hook(s);
      } catch (e) {}
      return s;
    };
    // socket.io exposes helpers on `io` (io.Manager, io.connect, ...).
    try {
      for (var k in real) w[k] = real[k];
    } catch (e) {}
    return w;
  }

  if (window.io) {
    // socket.io already loaded.
    _wrapped = makeWrapper(window.io);
    try {
      Object.defineProperty(window, "io", {
        configurable: true,
        get: function () {
          return _wrapped;
        },
        set: function (v) {
          _wrapped = makeWrapper(v);
        }
      });
    } catch (e) {
      window.io = _wrapped;
    }
  } else {
    Object.defineProperty(window, "io", {
      configurable: true,
      get: function () {
        return _wrapped;
      },
      set: function (v) {
        _wrapped = makeWrapper(v);
      }
    });
  }
}

webFrame.executeJavaScript("(" + mainWorldInit.toString() + ")();");

// --- 4. Tiny optional API for the page (no-op if unused) ------------------
const api = {
  ready: () => ipcRenderer.send("app-ready"),
  isDesktop: true,
  onNavigateChat: (cb) =>
    ipcRenderer.on("navigate-chat", (_e, room) => cb(room))
};
if (contextIsolated) {
  require("electron").contextBridge.exposeInMainWorld("dialogDesktop", api);
} else {
  window.dialogDesktop = api;
}
