// Central catalogue of Dialog app downloads, shared by the landing + download
// pages. Bump VERSION here when you publish a new release. Installers are
// hosted as GitHub Releases on the public Dialog repo, so links hit GitHub's
// CDN directly.
(function () {
  const VERSION = "1.1.6";
  // Android and desktop ship together again from 1.1.6 (terminal boot screen on both), so the
  // APK link points at the same release tag.
  const ANDROID_VERSION = VERSION;
  const BASE =
    "https://github.com/VanylixCODER/Dialog/releases/download/v" +
    VERSION +
    "/";
  const ANDROID_BASE =
    "https://github.com/VanylixCODER/Dialog/releases/download/v" +
    ANDROID_VERSION +
    "/";

  // Each platform lists one or more downloadable installers.
  const PLATFORMS = {
    windows: {
      label: "Windows",
      icon: "windows",
      note: "Windows 10/11 · 64-bit",
      installers: [
        { kind: "Installer (.exe)", file: "Dialog-Setup-" + VERSION + ".exe", primary: true },
        // Portable: runs straight from the file, no install and no admin rights.
        // It cannot auto-update — the updater is disabled in that build.
        { kind: "Portable (.exe)", file: "Dialog-Portable-" + VERSION + ".exe" }
      ]
    },
    mac: {
      label: "macOS",
      icon: "apple",
      note: "macOS 11+ · Apple Silicon & Intel",
      installers: [
        { kind: "Disk image (.dmg)", file: "Dialog-" + VERSION + ".dmg", primary: true },
        { kind: "Zip (.zip)", file: "Dialog-" + VERSION + "-mac.zip" }
      ]
    },
    linux: {
      label: "Linux",
      icon: "linux",
      note: "Most distros · 64-bit",
      installers: [
        { kind: "AppImage (universal)", file: "Dialog-" + VERSION + ".AppImage", primary: true },
        { kind: "Debian / Ubuntu (.deb)", file: "dialog-desktop_" + VERSION + "_amd64.deb" },
        { kind: "Arch (.pacman)", file: "dialog-desktop-" + VERSION + ".pacman" },
        // Sandboxed. Install with: flatpak install --user Dialog-<version>.flatpak
        { kind: "Flatpak (.flatpak)", file: "Dialog-" + VERSION + ".flatpak" }
      ]
    },
    android: {
      label: "Android",
      icon: "android",
      note: "Android 7.0+ · v" + ANDROID_VERSION,
      installers: [
        { kind: "APK", file: ANDROID_BASE + "Dialog-" + ANDROID_VERSION + ".apk", primary: true }
      ]
    }
  };

  // Detect the visitor's OS to recommend the right installer.
  function detectOS() {
    const ua = (navigator.userAgent || "").toLowerCase();
    const plat = (navigator.platform || "").toLowerCase();
    const uaData = navigator.userAgentData;
    if (uaData && uaData.platform) {
      const p = uaData.platform.toLowerCase();
      if (p.includes("win")) return "windows";
      if (p.includes("mac")) return "mac";
      if (p.includes("android")) return "android";
      if (p.includes("linux")) return "linux";
    }
    if (/android/.test(ua)) return "android";
    if (/iphone|ipad|ipod/.test(ua)) return "ios";
    if (/win/.test(ua) || /win/.test(plat)) return "windows";
    if (/mac/.test(ua) || /mac/.test(plat)) {
      // iPads on iPadOS report as Mac; treat touch Macs as iOS.
      if (navigator.maxTouchPoints > 1) return "ios";
      return "mac";
    }
    if (/linux/.test(ua) || /linux/.test(plat)) return "linux";
    return "unknown";
  }

  window.DialogDownloads = {
    VERSION: VERSION,
    BASE: BASE,
    PLATFORMS: PLATFORMS,
    detectOS: detectOS,
    url: function (file) {
      return /^https?:\/\//.test(file) ? file : BASE + file;
    }
  };
})();
