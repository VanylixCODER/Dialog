"use strict";

// Central configuration for the Dialog desktop shell.
// The shell is a thin wrapper that loads the hosted web app — change APP_URL
// here (or via the DIALOG_URL env var) before building if the domain changes.

// Load straight into the messenger (/login), never the marketing landing page.
const APP_BASE = process.env.DIALOG_URL || "https://dialogmsg.xyz";
const APP_URL = APP_BASE.replace(/\/+$/, "") + "/login";

module.exports = {
  APP_URL,
  // Origin used for connectivity probing and to restrict in-app navigation.
  APP_ORIGIN: new URL(APP_URL).origin,

  // Paths that belong to the public marketing site — the app must never land
  // on these; navigating to one bounces back to /login.
  MARKETING_PATHS: ["/", "/landing.html", "/download", "/downloads", "/download.html"],
  LOGIN_PATH: "/login",

  // Frameless "hacker boot" loader window — kept at a 3:4 portrait ratio.
  LOADER: {
    width: 360,
    height: 480
  },

  // Main app window.
  WINDOW: {
    width: 1280,
    height: 820,
    minWidth: 480,
    minHeight: 560
  },

  // Connectivity probe target (HEAD request). Defaults to the app origin.
  PROBE_URL: process.env.DIALOG_URL || "https://dialogmsg.xyz",

  // Windows AppUserModelID — makes native notifications show the Dialog
  // name/icon instead of being grouped under "electron.app".
  APP_USER_MODEL_ID: "xyz.dialogmsg.app"
};
