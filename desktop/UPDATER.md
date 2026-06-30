# Auto-Update Guide

The desktop app uses `electron-updater` to check GitHub Releases for updates.

## Steps to publish an update

**1. Bump version**

```bash
# edit package.json — change "version" from 1.0.0 to 1.0.1 (or whatever)
```

**2. Rebuild all targets**

```bash
npm run dist
```

This produces:
- `dist/Dialog-1.0.1.AppImage`
- `dist/dialog-desktop_1.0.1_amd64.deb`
- `dist/dialog-desktop-1.0.1.pacman`
- `dist/Dialog-1.0.1-x86_64.flatpak`
- `dist/latest-linux.yml` ← **this file is critical** (electron-updater reads it)
- `dist/Dialog Setup 1.0.1.exe`
- `dist/latest.yml` ← **critical for Windows**

**3. Rebuild the flatpak bundle**

```bash
cp -a dist/linux-unpacked flatpak/
cd flatpak
# edit xyz.dialogmsg.app.local.yml to point at the new version if needed
flatpak run org.flatpak.Builder ... (same build as before)
flatpak build-bundle ... dist/Dialog-1.0.1-x86_64.flatpak
```

**4. Create a GitHub Release**

```bash
# Create a tag
git tag v1.0.1
git push origin v1.0.1

# Go to https://github.com/VanylixCODER/Dialog/releases/new
# Tag: v1.0.1
# Upload these files:
```

**You MUST upload ALL of these to the release:**

| File | Needed for |
|------|-----------|
| `dist/Dialog-1.0.1.AppImage` | Linux (direct download) |
| `dist/dialog-desktop_1.0.1_amd64.deb` | Linux (Debian/Ubuntu) |
| `dist/dialog-desktop-1.0.1.pacman` | Linux (Arch) |
| `dist/Dialog-1.0.1-x86_64.flatpak` | Linux (Flatpak) |
| `dist/latest-linux.yml` | **Auto-update metadata (Linux)** |
| `dist/Dialog Setup 1.0.1.exe` | Windows |
| `dist/latest.yml` | **Auto-update metadata (Windows)** |

The `latest-linux.yml` and `latest.yml` files are what `electron-updater` downloads to check for new versions. **Without them, auto-update won't work.**

**5. That's it**

After uploading, existing desktop clients will:
- Detect the new version within 6 hours (or on next restart)
- Automatically download the update in the background
- Install it when the user quits the app

## How the updater works

- Checks for updates 8 seconds after launch, then every 6 hours
- Auto-downloads when available
- Installs on app quit (`autoInstallOnAppQuit: true`)
- Config is in `package.json` → `"build"."publish"` → GitHub provider
