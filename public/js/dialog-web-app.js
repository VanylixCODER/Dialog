/*!
 * Dialog Web App SDK — Telegram-WebApp-style bridge for Dialog Mini Apps.
 * Include this on your Mini App page:
 *   <script src="https://dialogmsg.xyz/js/dialog-web-app.js"></script>
 * Then use window.DialogWebApp: .ready(), .close(), .sendData(str), .openLink(url),
 * .initDataUnsafe.user ({login,name}), .themeParams, .onEvent('ready'|'themeChanged', cb).
 */
(function () {
  var listeners = {};
  function post(msg) { msg.__dialogapp = 1; try { parent.postMessage(msg, "*"); } catch (e) {} }
  function emit(ev, payload) { (listeners[ev] || []).forEach(function (cb) { try { cb(payload); } catch (e) {} }); }

  function applyTheme(theme) {
    if (!theme) return;
    var root = document.documentElement.style;
    for (var k in theme) if (Object.prototype.hasOwnProperty.call(theme, k)) {
      root.setProperty("--dialog-" + k.replace(/_/g, "-"), theme[k]);
    }
  }

  var app = {
    platform: "dialog",
    version: "1.0",
    initData: "",
    initDataUnsafe: { user: null },
    themeParams: {},
    isExpanded: true,
    ready: function () { post({ type: "ready" }); },
    expand: function () { post({ type: "expand" }); },
    close: function () { post({ type: "close" }); },
    sendData: function (data) { post({ type: "sendData", data: String(data == null ? "" : data) }); },
    openLink: function (url) { post({ type: "openLink", url: String(url || "") }); },
    onEvent: function (ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); },
    offEvent: function (ev, cb) { if (listeners[ev]) listeners[ev] = listeners[ev].filter(function (f) { return f !== cb; }); },
  };

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.__dialogapp !== 1) return;
    if (d.type === "init") {
      app.initDataUnsafe = { user: d.user || null };
      app.initData = "user=" + encodeURIComponent(JSON.stringify(d.user || {}));
      app.themeParams = d.theme || {};
      applyTheme(d.theme);
      emit("themeChanged");
      emit("ready", app.initDataUnsafe);
    }
  });

  window.DialogWebApp = app;
  window.Dialog = window.Dialog || {};
  window.Dialog.WebApp = app;

  // In case the host pushed init before this script attached its listener, ask again.
  post({ type: "requestInit" });
})();
