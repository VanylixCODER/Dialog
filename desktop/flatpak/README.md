# Dialog — Flatpak / Flathub

Everything needed to ship Dialog as a Flatpak, both for self-hosted
distribution and for publishing on [Flathub](https://flathub.org).

| File | Purpose |
|------|---------|
| `xyz.dialogmsg.app.yml` | The Flatpak manifest Flathub builds from |
| `xyz.dialogmsg.app.metainfo.xml` | AppStream metadata (required, validated by Flathub) |
| `xyz.dialogmsg.app.desktop` | Desktop entry |
| `icon_512.png` · `icon_256.png` · `icon_128.png` | App icons |
| `screenshot-*.png` | Screenshots referenced by the metainfo (uploaded to the GitHub Release) |

The app ID is `xyz.dialogmsg.app` — reverse-DNS of `dialogmsg.xyz`. It is also
the `appId` electron-builder uses for the Windows/macOS bundle identifiers and
the Linux desktop entry, so **do not change it**: it is the identity of every
already-installed copy.

---

## A. Quick local Flatpak (via electron-builder)

Easiest for testing or self-hosted distribution:

```bash
flatpak install -y flathub org.freedesktop.Platform//25.08 \
  org.freedesktop.Sdk//25.08 org.electronjs.Electron2.BaseApp//25.08

cd desktop
npm install
npm run dist:flatpak        # → dist/Dialog-<version>.flatpak
flatpak install --user dist/Dialog-<version>.flatpak
flatpak run xyz.dialogmsg.app
```

Permissions for this path live under `build.flatpak.finishArgs` in
`desktop/package.json`; the Flathub path uses `finish-args` in the manifest
here. **Keep the two in sync.**

---

## B. Publishing on Flathub

Flathub does not run electron-builder. It builds from this manifest in a
**network-isolated** sandbox, so we cannot `npm install` there — instead we
package the prebuilt app produced by `electron-builder --linux dir`, attach it
to a GitHub Release, and the manifest just extracts it into `/app` and launches
it through `zypak-wrapper` (from the Electron BaseApp) so Chromium's sandbox
works inside Flatpak.

### Per-release steps

```bash
cd desktop
V=$(node -p "require('./package.json').version")

# 1. Build the payload and tar it
env -u ELECTRON_RUN_AS_NODE CSC_IDENTITY_AUTO_DISCOVERY=false \
  ./node_modules/.bin/electron-builder --linux dir --publish never
tar czf dist/dialog-desktop-$V-linux-x64.tar.gz -C dist/linux-unpacked .
sha256sum dist/dialog-desktop-$V-linux-x64.tar.gz

# 2. Attach it (and any new screenshots) to the GitHub Release
gh release upload v$V dist/dialog-desktop-$V-linux-x64.tar.gz \
  flatpak/screenshot-*.png --repo VanylixCODER/Dialog --clobber

# 3. Update flatpak/xyz.dialogmsg.app.yml — the source `url` and `sha256`
# 4. Update flatpak/xyz.dialogmsg.app.metainfo.xml — add a <release> entry and
#    bump the screenshot URLs to the new tag
```

### Verify before submitting

```bash
cd desktop/flatpak
appstreamcli validate --pedantic xyz.dialogmsg.app.metainfo.xml
desktop-file-validate xyz.dialogmsg.app.desktop

# Full build + Flathub's own linter (the tool their CI runs).
# NB: the state dir must be on the same filesystem as the target, and the
# builder sandbox cannot see /tmp — build somewhere under the repo.
flatpak install -y flathub org.flatpak.Builder
B=../.fpbuild && rm -rf $B && mkdir -p $B
flatpak run org.flatpak.Builder --force-clean --user \
  --state-dir=$B/state --repo=$B/repo $B/build xyz.dialogmsg.app.yml
flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest xyz.dialogmsg.app.yml
flatpak run --command=flatpak-builder-lint org.flatpak.Builder repo $B/repo
rm -rf $B
```

`repo` will report `appstream-screenshots-not-mirrored-in-ostree` and
`appstream-external-screenshot-url` locally. Those are expected — Flathub
mirrors screenshots to `dl.flathub.org/media` during **their** build, which
cannot be reproduced here. Everything else must be clean.

### Submitting

Fork <https://github.com/flathub/flathub> and open a pull request adding
`xyz.dialogmsg.app.yml` plus the files it references — follow the current
[submission docs](https://docs.flathub.org/docs/for-app-authors/submission),
as the target branch has changed before. Their bot builds the PR and a reviewer
comments. On merge you get a `flathub/xyz.dialogmsg.app` repo, and every
subsequent release is a PR there bumping the tarball URL + sha256.

Afterwards, claim the app on flathub.org to get the verified badge — it checks
`.well-known` on dialogmsg.xyz or the GitHub org.

### Two things a reviewer will likely raise

- **`--device=all`** is broad. The camera needs it (`/dev/video*`) short of the
  camera portal, but expect to justify it.
- **Dialog desktop loads the hosted `https://dialogmsg.xyz`** rather than
  bundling `public/`. Flathub scrutinises thin web wrappers, because what
  actually runs is fetched at runtime and is not reviewable from the manifest.
  This is the main risk to acceptance; path A has none of it.

### Notes

- **Auto-update is disabled under Flatpak.** `/app` is read-only and Flathub
  rejects bundled updaters, so `src/updater.js` bails out when `FLATPAK_ID` is
  set and the tray's "Check for updates" explains that `flatpak update` is the
  route. Keep that guard in place.
- Screen sharing uses the xdg-desktop-portal ScreenCast portal automatically;
  PipeWire capture is already enabled in the app.
- Testing locally is awkward if a Dialog AppImage is already running — the
  single-instance lock hands off to it and the Flatpak exits immediately. Quit
  the other copy first.
