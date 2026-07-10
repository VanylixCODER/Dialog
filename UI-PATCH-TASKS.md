# Dialog — Classic UI patch tracker

Ship batch by batch; deploy + verify each. `[ ]` todo · `[~]` in progress · `[x]` done.

## Batches 1–6 — DONE (live)
- [x] 1 — uniform button-icon centering + label/bubble containment
- [x] 2 — flat minimalist themes + professional flashbang (green border removed, glow opt-in)
- [x] 3 — Settings → Appearances tab (subtabs, themes/favorites, glow slider, custom borders)
- [x] 4 — WhatsApp-style voice composer (mic on send button)
- [x] 5 — matrix-rain chat background (toggle + speed + color)
- [x] 6 — calls: flat incoming buttons + per-tile Cava voice visualizer

## Batch 7 — polish + theme creator  [~]
- [ ] §1 Composer: `#msgInput` min-height 40px, aligned on one line with the buttons.
- [ ] §2 `.msg-actions` outside the bubble on the inward side (own→left `right:100%`, others→right `left:100%`); clamp inside `.messages`; general label-overflow pass.
- [ ] §6 Fix matrix rain (doesn't appear): `matrixEffective()` treat unset theme as "matrix".
- [ ] §5 Theme creator: auto-contrast text (bg luminance) + fix hardcoded-dark surfaces; border token (built-ins = primary color, flashbang grey); transparency 25–100%; blur→toggle(~9px); live preview; REMOVE glow + Batch-3 Appearances custom-border rows.
- [ ] §3 Universal send-preview tray (files + voice): image/video/audio/file/text preview, multi-file, Send/Discard; GIF stays instant.
- [ ] §4 Voice: tap-to-record on all platforms (drop hold/swipe); on stop → preview tray.
- [ ] Deploy + verify each group.

## Notes
- Deploy = push `main` → webhook rebuilds `app` (~2–4 min). Rapid pushes can skip a build;
  re-trigger with an empty commit. Verify a new symbol is live before moving on.
