# Dialog — Flatpak / Flathub

This folder contains everything needed to ship Dialog as a Flatpak, both for
local installation and for publishing on [Flathub](https://flathub.org).

There are **two ways** to get a Flatpak, depending on your goal.

---

## A. Quick local Flatpak (via electron-builder)

Easiest for testing or self-hosted distribution. Requires `flatpak` +
`flatpak-builder` and the Electron base app:

```bash
flatpak install -y flathub org.freedesktop.Platform//24.08 \
  org.freedesktop.Sdk//24.08 org.electronjs.Electron2.BaseApp//24.08

cd desktop
npm install
npm run dist:flatpak        # produces dist/Dialog-1.0.0.flatpak
flatpak install --user dist/Dialog-1.0.0.flatpak
flatpak run xyz.dialogmsg.app
```

The Flatpak permissions (mic, camera, screen, audio, network, notifications,
tray) are defined under `build.flatpak.finishArgs` in `desktop/package.json`.

---

## B. Publishing on Flathub (the real "publish" path)

Flathub does **not** run electron-builder. It builds from a manifest in a
`flathub/xyz.dialogmsg.app` repository, in a **network-isolated** sandbox — so
we ship a prebuilt app tarball and the manifest just installs it.

Files here:

| File | Purpose |
|------|---------|
| `xyz.dialogmsg.app.yml` | The Flatpak manifest Flathub builds from |
| `xyz.dialogmsg.app.metainfo.xml` | AppStream metadata (required, validated by Flathub) |
| `xyz.dialogmsg.app.desktop` | Desktop entry |
| `icon_512.png` / `icon_256.png` / `icon_128.png` | App icons |

### Steps

1. **Build the app payload** and tar it:
   ```bash
   cd desktop
   npm run dist -- --linux dir
   tar czf dialog-desktop-1.0.0-linux-x64.tar.gz -C dist/linux-unpacked .
   sha256sum dialog-desktop-1.0.0-linux-x64.tar.gz
   ```

2. **Attach** `dialog-desktop-1.0.0-linux-x64.tar.gz` to the GitHub Release
   `v1.0.0` (https://github.com/VanylixCODER/Dialog/releases).

3. **Edit `xyz.dialogmsg.app.yml`** — replace `REPLACE_WITH_TARBALL_SHA256`
   with the sha256 from step 1 (and bump the URL/version for future releases).

4. **Add a real screenshot**: host one at the URL referenced in
   `xyz.dialogmsg.app.metainfo.xml` (`<screenshots>`), or update the URL.
   Flathub requires at least one reachable screenshot.

5. **Validate locally** before submitting:
   ```bash
   appstreamcli validate xyz.dialogmsg.app.metainfo.xml
   flatpak run org.flatpak.Builder --force-clean --sandbox --user \
     --install builddir xyz.dialogmsg.app.yml      # test build
   ```

6. **Submit**: fork https://github.com/flathub/flathub, create a branch named
   `xyz.dialogmsg.app`, add these files, and open a PR. Flathub's bot builds
   and reviews it. Once merged, the app is live on Flathub and updates whenever
   you bump the version + tarball in the manifest.

### Notes
- App ID `xyz.dialogmsg.app` is reverse-DNS of `dialogmsg.xyz`, which you own —
  required for Flathub.
- The launcher uses `zypak-wrapper` (from the Electron BaseApp) so Chromium's
  sandbox works inside Flatpak — no `--no-sandbox` needed.
- Screen sharing uses the xdg-desktop-portal ScreenCast portal automatically;
  PipeWire capture is already enabled in the app.
