# Local dependency fixes

These copies keep the versions already used by the player. They are selected by
the root Cargo patch entries; no registry cache files are modified.

- `tauri-runtime-wry` 2.11.2, crates.io checksum
  `b83849ee63ecb27a8e8d0fe51915ca215076914aca43f96db1179f0f415f6cd9`.
  Window/WebView creation now returns the event loop's actual result before Tauri
  registers its handle. Failed WebView construction releases its context reference.
  Upstream: https://github.com/tauri-apps/tauri. Original licenses are included.
- `taskbar-lyric` 0.1.0, upstream commit
  `bd7ee3a66d28af8a857d2ce2b26a3c78fa0058fa` from
  https://github.com/apoint123/taskbar-lyric.git.
  Stopping cancels queued HWND operations; `stop_and_join` lets the application
  wait off the UI thread before destroying or replacing the lyric window.
  This upstream revision includes no license file or Cargo license declaration;
  this copy preserves its source and does not add a license claim.

The patched dependencies are excluded from workspace membership so workspace
builds on other platforms do not directly select the Windows-only taskbar crate.
