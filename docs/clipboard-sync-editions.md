# Editions

Clipboard sync lives in `desktop/` and `src/`. The public electron-builder file set already includes `desktop/**/*` and the built renderer in `dist/**/*`, so ShelfDock packages pick the feature up without a new dependency or a changed app id.

The personal edition repository `outputs/lex-drift-personal` is a separate checkout. This branch does not modify it and does not copy its machine preset. LexBridge gets the same behavior only when this branch is applied there. Both editions keep the `lex-drift` user-data directory and the `com.lexilominite.lex-drift` app id.

Sync stays off until Clipboard tools are enabled and a device is paired. A personal preset import does not turn sync on.
