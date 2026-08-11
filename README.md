<div align=center>

# AMLL Player

English / [简体中文](./README-CN.md)

An independent lyrics page player that obtains audio playback information through local music files/WebSocket Server.

</div>

## List of functions/features：

- Communicate with any client that implements the AMLL WS Protocol, synchronize the progress of the playback information, and get the corresponding lyrics for playback display
- Support reading local audio files for playback, or loading local lyrics files
- Support loading various lyric formats
- High performance – no software issues that affect the display of lyrics
- Expected support for playback state transfer protocols：[SMTC (Windows)](https://learn.microsoft.com/en-us/uwp/api/windows.media.systemmediatransportcontrols?view=winrt-26100) / [MPRIS (Linux/XDG)](https://www.freedesktop.org/wiki/Specifications/mpris-spec/) / [MPNowPlayingInfoCenter (macOS)](https://developer.apple.com/documentation/mediaplayer/mpnowplayinginfocenter)

## Install and use

Since the player is still compatible, the development build can only be downloaded through [Github Action](https://github.com/amll-dev/amll-player/actions/workflows/build-player.yaml), and the official version will be released in the future.

## Why is there this？

The lyrics player is equivalent to software like external subtitles, and the lyrics are played in an environment independent of the plug-in environment.

After the author's performance test, it is found that embedding it in the form of a plug-in on the playback page will cause frame drops and uncertain stuttering due to the browser framework problems of the plug-in running environment.

Therefore, the author decided to separate the playback page into a separate desktop program to improve the playback performance and effect, while the original plug-in was responsible for transmitting the playback information and status to the lyric player.

So if you also have a little stuttering, you can try using this lyric player, and the performance should be improved.


### Building the AMLL Player desktop application

```bash
cd packages/player
pnpm tauri build          # Production build
pnpm tauri dev            # Development mode
```

### Linux display backend

On the first NVIDIA Wayland launch where the wrapper is available, AMLL Player asks before switching its webview to a nested `Xephyr + Openbox` session. Xephyr is exposed to the desktop as a normal application window while Openbox manages the inner X11 webview. This avoids the WebKitGTK explicit-sync crash and restores host-side resize, maximize, fullscreen, focus, and close behavior.

Install the wrapper dependencies on Arch Linux with:

```bash
sudo pacman -S openbox xorg-server-xephyr
```

If either dependency cannot be found or the wrapper fails during startup, AMLL Player automatically falls back to the existing XWayland display. Xephyr does not expose DRI3 to its nested clients, so the wrapper adds a CPU copy/compositing step; WebKitGTK can still use the GPU for its own rendering. The direct `x11` fallback avoids that nested-server overhead.

The wrapper defaults Xephyr to 60 FPS to avoid unnecessary nested compositing work. Set `AMLL_XEPHYR_FPS` to a rate no higher than the host refresh rate to opt into high refresh, for example `AMLL_XEPHYR_FPS=120`; WebKitGTK may still limit animation to about 60 FPS in a nested X11 session, so this does not guarantee rendering-rate passthrough.

Set `AMLL_LINUX_WEBVIEW_BACKEND` to override the automatic selection:

- `auto`: Openbox wrapper on NVIDIA Wayland, then direct XWayland, then software Wayland
- `system`: keep the backend selected by the desktop environment and `GDK_BACKEND`
- `openbox`: request the Xephyr + Openbox wrapper with the same automatic fallbacks
- `x11`: prefer X11, with a software Wayland fallback when no X display is available
- `wayland`: force native Wayland rendering
- `wayland-software`: force Wayland and disable the WebKitGTK DMA-BUF renderer

The first-run choice is stored in `~/.config/net.stevexmh.amllplayer/linux-webview.json` (or `$XDG_CONFIG_HOME/net.stevexmh.amllplayer/linux-webview.json`). Edit its `backend` value to any option above. `AMLL_LINUX_WEBVIEW_BACKEND` takes precedence over the saved value. In `auto` mode, an NVIDIA Wayland session may override `GDK_BACKEND=wayland` to avoid the known crash; other explicitly configured GDK backends are preserved.

### Acknowledgements

-   [woshizja/sound-processor](https://github.com/woshizja/sound-processor)
-   [FFmpeg](http://ffmpeg.org/)
-   And many other frameworks and libraries used by AMLL, thank you very much!

### Special Thanks

<div align="center">
<image src="https://resources.jetbrains.com/storage/products/company/brand/logos/jb_beam.svg"></image>
<div>
Thanks to <a href=https://jb.gg/OpenSourceSupport>JetBrains</a> for their development tools that provide great support to the AMLL project
</div>
</div>
