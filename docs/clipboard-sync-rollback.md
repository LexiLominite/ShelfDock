# Rollback

- Baseline commit: `cb47a6d` (`main`, ShelfDock 0.5.0 public launch).
- Feature branch: `feat/clipboard-sync`.
- Worktree: `outputs/work/clipboard-sync`. The primary `outputs/Drift` checkout stays on `main`.
- Code rollback: leave this worktree, check out `main`, and do not merge the branch. No release is published by this work.
- Data: new files are only inside the app user-data directory under `clipboard-sync/`. They are additive. A previous version does not read them. Deleting that directory forgets pairings and does not delete `clipboard-history/`.
- Immediate user stop: pause sync, revoke a device, or turn off Clipboard tools. Each stops network sync and keeps local history.
- Production app at `~/Applications/LexBridge.app` and `~/Library/Application Support/lex-drift` must not be replaced or used as a test profile.
