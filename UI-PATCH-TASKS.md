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
- [x] §1 Composer input aligned on one line (min-height 40px + align-items center).
- [x] §2 `.msg-actions` outside the bubble on the inward side (own→left, others→right), centred, never off-canvas.
- [x] §6 Matrix rain fix (`matrixEffective()` treats unset theme as "matrix").
- [x] §5 Theme creator: auto-contrast text + fix hardcoded-dark surfaces for light themes; border token (built-ins = primary color, flashbang grey); transparency 25–100%; blur→toggle; live preview; glow + Appearances custom-border rows removed. [part-1 deployed]
- [x] §3 Universal send-preview tray (files+voice): image/video/audio/gif/file preview, multi-file, Send/Discard; file input + drag-drop routed through it; GIF picker instant.
- [x] §4 Voice tap-to-record (desktop+mobile), on stop → preview tray; Esc cancel, 60s cap.
- [~] Deploy + verify (part 1 live; part 2 = preview/voice pushing now).

## Notes
- Deploy = push `main` → webhook rebuilds `app` (~2–4 min). Rapid pushes can skip a build;
  re-trigger with an empty commit. Verify a new symbol is live before moving on.
