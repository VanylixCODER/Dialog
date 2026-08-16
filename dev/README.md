# `dev/` — never ships

Everything in here is for building Dialog, not for running it. It is excluded from the
production image (`.dockerignore`) and from every installer, so nothing here can reach a user.

| Path | What it is |
|---|---|
| `dev/design/` | Design handoffs and visual references. Prototype code to read, not to import — recreate the design in the real codebase instead of porting the prototype. |
| `dev/design/terminal-loading/` | Handoff for the terminal boot screen (shipped in 1.1.6 as `desktop/src/loader/` and the Android `BootLoader`). |
| `dev/scratch/` | Untracked scratch space (gitignored). Put throwaway experiments here rather than in the repo root. |

**Rule of thumb:** if a file is not needed to serve dialogmsg.xyz or to build a client, it
belongs in `dev/` — not in the root.
