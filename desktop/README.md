# Dialog Desktop

Cross-platform desktop client (Linux · Windows · macOS) for **Dialog**. It is a
thin Electron shell that loads the hosted web app at **https://dialogmsg.xyz**
and adds native superpowers the browser can't:

- **No permission prompts** — microphone, camera, screen share and notifications
  are auto-granted (see caveats for macOS).
- **Native OS notifications** with tray badge + click-to-focus.
- **Custom system tray** — status (Online / DND / Invisible), mute, start-at-login,
  check-for-updates, show/hide, quit. Closing the window hides to tray.
- **Hacker-movie boot loader** — a frameless 3:4 window with a fake secure-shell
  boot sequence and a **live status line under the logo** (`Connecting…` →
  `Authenticating` → `Online`, or **`No Internet Access`** in red when offline).
- **Auto-update** via GitHub Releases (electron-updater).

## Run (dev)

```bash
cd desktop
npm install
npm start            # launches the loader, then the app
```

> The `electron` postinstall must be allowed to download the runtime. If
> `npm start` says Electron failed to install, run `npm install` again and allow
> the install script, or unzip the cached runtime into
> `node_modules/electron/dist`.

Point at a different backend without editing code:

```bash
DIALOG_URL=https://staging.dialogmsg.xyz npm start
```

## Build installers

```bash
npm run dist:linux   # AppImage + deb
npm run dist:win     # NSIS .exe
npm run dist:mac     # dmg + zip
npm run dist         # current platform
```

Output lands in `desktop/dist/`. Each OS must be built on (or cross-built for)
its own platform — notably macOS builds require macOS.

## Auto-update / release

`build.publish` in `package.json` points at the GitHub repo `Vanylix/Dialog`.
To cut a release:

```bash
GH_TOKEN=<token> npm run publish
```

This uploads installers + update metadata (`latest.yml`, etc.) to GitHub
Releases. Installed apps check on launch and every 6 hours, download in the
background, and install on quit.

## How it works

| File | Role |
|------|------|
| `src/main.js` | Windows, permission auto-grant, screenshare handler, connectivity, IPC, lifecycle |
| `src/preload.js` | Signals "app ready" to dismiss loader; bridges web Notifications → tray badge + click |
| `src/loader/` | Frameless 3:4 boot loader (`loader.html/.css/.js`) + its preload |
| `src/tray.js` | Tray icon variants + context menu |
| `src/updater.js` | electron-updater wiring |
| `src/config.js` | `APP_URL`, window sizes, IDs |
| `assets/` | App icons (`icon.png/.ico/.icns`) + tray variants |

Permissions are granted at the session level
(`setPermissionRequestHandler`, `setPermissionCheckHandler`) and screen sharing
is fulfilled via `setDisplayMediaRequestHandler` + `desktopCapturer` (auto-selects
the primary screen; a system picker is offered when available). PipeWire capture
is enabled for Wayland on Linux.

## Caveats

- **macOS**: the OS-level TCC prompts for mic/camera/screen recording are
  enforced by macOS and cannot be suppressed — they appear once and are then
  remembered. The in-app web prompts are gone. Usage descriptions are declared
  in the packaged `Info.plist`.
- **Code signing**: unsigned builds trigger SmartScreen (Windows) / Gatekeeper
  (macOS) warnings. Configure signing certs in `electron-builder` for store-grade
  distribution.
