# ShelfDock / LexBridge 0.7.1

## Your own devices through existing SSH keys

Clipboard Settings now uses Machine, Direction, and Connect device. There is no Allow pairing button or code entry. Connecting explicitly authenticates with the saved SSH key route, obtains a fresh private application capability from that OS user's standard profile, and links the running app. The receiver must also have Clipboard tools and sync enabled and resumed. Selecting a machine, updating the app, and turning on Clipboard tools never enable sync by themselves.

The capability is 256-bit, short-lived, private to the OS user, bound to the receiver's device ID, and consumed before pairing is persisted. Existing device tokens stay encrypted. SSH host trust remains strict and the connection permits public-key authentication only. Ordinary Settings editing can authorize a connection while clipboard content capture and delivery remain blocked. Sensitive editing and authentication/setup activity also block authorization. Pause, disable, revoke, and concurrent connection requests preserve the existing cancellation and storage boundaries.

New owner connections require 0.7.1 on both computers. Previously linked 0.6/0.7 devices continue using the existing version-1 hello/item protocol. Sync defaults off and incoming items default to history instead of replacing the system clipboard.

## A Spotlight and menu-bar popover appearance on Mac

macOS 26 and newer use Apple's native NSGlassEffectView around the Electron content view. The renderer canvas is transparent, with lighter lavender-tinted surfaces, a smaller header, soft corners and a quiet floating edge. Editable fields and primary actions retain stronger backing for legibility. The material uses a light appearance consistent with the existing palette.

Older macOS keeps native vibrancy. Windows and Linux retain their existing appearance. Reduce Transparency restores a solid surface and responds to native accessibility notifications; Reduce Motion does not turn off static glass. The implementation preserves focus, hit targets, resizing, gestures, close-to-hide and the single-worker rule.

The small native module uses public AppKit APIs and the stable Node C API. Build it with `node scripts/build-native-glass.cjs` on a Mac with Xcode command-line tools and Node C API headers. Mac packages include only the compiled native extra resource; other targets exclude native Mac binaries and build sources.

## Verification and limits

The complete source suite passed 426 tests. The eleven existing headless UI suites and the additional glass regression passed. A fixture using the real OpenSSH client, genuine keys and pinned trust connected through owner bootstrap without a code and exchanged synthetic text and PNG both ways. Independent review fixed Settings authorization blocking, an asynchronous IPC lock race, cancellation during capability publication/persistence, and ambiguous same-name device feedback.

Invisible AppKit and Electron fixtures verified a real NSGlassEffectView, original content ownership, focus and button input, a 900-by-700 resize, removal/reapply and cleanup. Browser previews simulate material backing and must not be described as native screenshots.

Native Windows PowerShell and private-DACL execution, and two physical computers' system clipboard copy/delivery/paste, remain unverified. macOS ad-hoc bundle signing is local integrity validation; Apple Developer signing and notarization remain pending. Existing VNC/installer/platform qualification limits from 0.7.0 remain unchanged. Retain the previous application and a private profile snapshot before installing.
