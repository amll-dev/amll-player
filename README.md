<div align=center>

![Apple Music-like Lyrics - A lyric page component library for Web](https://github.com/user-attachments/assets/48f77628-03db-4326-a2a5-c9e1b2a32e37)

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
