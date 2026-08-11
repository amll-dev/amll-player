<div align=center>

# AMLL Player

[English](./README.md) / 简体中文

一个通过 本地音乐文件/WebSocket Server 获取音频播放信息的独立歌词页面播放器。

</div>


## 功能/特性列表：

- 与任何实现 AMLL WS Protocol 的客户端进行通信，同步播放信息进度，并获取对应的歌词以进行播放展示
- 支持读取本地音频文件播放，或加载本地歌词文件
- 支持加载各种歌词格式
- 高性能 —— 不会因为某些软件自身问题导致歌词展示效果受到影响
- 预计支持播放状态传输协议：[SMTC (Windows)](https://learn.microsoft.com/en-us/uwp/api/windows.media.systemmediatransportcontrols?view=winrt-26100) / [MPRIS (Linux/XDG)](https://www.freedesktop.org/wiki/Specifications/mpris-spec/) / [MPNowPlayingInfoCenter (macOS)](https://developer.apple.com/documentation/mediaplayer/mpnowplayinginfocenter)

## 安装使用

由于播放器还在兼容状态，所以仅可通过 [Github Action](https://github.com/amll-dev/amll-player/actions/workflows/build-player.yaml) 下载开发构建，日后会推出正式版。

## 为什么会有这个？

歌词播放器相当于外挂字幕一样的软件，在独立于插件环境以外的环境播放歌词。

经过作者的性能测试，发现以插件形式嵌入到播放页面会因为插件运行环境自身浏览器框架问题导致掉帧和不定卡顿的问题。

故作者决定将播放页面分离到一个独立的桌面程序进行以提高播放性能和效果，而原插件则负责将播放的信息和状态传递给歌词播放器。

因此如果你也有少许卡顿现象，可以尝试使用这个歌词播放器，性能应该可以有所改善。

### 构建 AMLL Player 桌面端应用

```bash
cd packages/player
pnpm tauri build   # 发行构建
pnpm tauri dev     # 开发模式
```

### Linux 显示后端

首次在可使用包装层的 NVIDIA Wayland 会话中启动时，AMLL Player 会询问是否切换到嵌套的 `Xephyr + Openbox` WebView 会话。Xephyr 会作为普通应用窗口交给桌面环境管理，Openbox 则负责内层 X11 WebView，从而绕过 WebKitGTK 显式同步崩溃，并恢复宿主侧的缩放、最大化、全屏、聚焦和关闭行为。

在 Arch Linux 上安装包装层依赖：

```bash
sudo pacman -S openbox xorg-server-xephyr
```

如果缺少任一依赖或包装层启动失败，AMLL Player 会自动回退到现有的 XWayland 显示。Xephyr 不会向嵌套客户端提供 DRI3，因此包装层会增加一次 CPU 拷贝/合成；WebKitGTK 自身仍可使用 GPU 渲染。直接 `x11` 回退可避免这层嵌套服务器开销。

包装层默认让 Xephyr 使用 60 FPS，避免不必要的嵌套合成开销。需要高刷新率时可设置不高于宿主刷新率的 `AMLL_XEPHYR_FPS`，例如 `AMLL_XEPHYR_FPS=120`；WebKitGTK 在嵌套 X11 会话中仍可能把动画限制在约 60 FPS，因此不保证应用渲染帧率能够穿透。

可以通过 `AMLL_LINUX_WEBVIEW_BACKEND` 覆盖自动选择：

- `auto`：NVIDIA Wayland 环境依次尝试 Openbox 包装、直接 XWayland 和软件 Wayland
- `system`：保留桌面环境和 `GDK_BACKEND` 选择的后端
- `openbox`：请求 Xephyr + Openbox 包装，并保留相同的自动回退
- `x11`：优先使用 X11；没有可用 X 显示时回退到软件 Wayland
- `wayland`：强制使用原生 Wayland 渲染
- `wayland-software`：强制使用 Wayland，并禁用 WebKitGTK DMA-BUF 渲染器

首次选择会保存到 `~/.config/net.stevexmh.amllplayer/linux-webview.json`（或 `$XDG_CONFIG_HOME/net.stevexmh.amllplayer/linux-webview.json`）。可直接修改其中的 `backend` 为上述任一选项；`AMLL_LINUX_WEBVIEW_BACKEND` 的优先级高于该配置。在 `auto` 模式下，NVIDIA Wayland 会话可能覆盖 `GDK_BACKEND=wayland` 以绕过已知崩溃，其他显式配置的 GDK 后端仍会保留。

### 鸣谢

-   [woshizja/sound-processor](https://github.com/woshizja/sound-processor)
-   [FFmpeg](http://ffmpeg.org/)
-   还有很多被 AMLL 使用的框架和库，非常感谢！

### 特别鸣谢

<div align="center">
<image src="https://resources.jetbrains.com/storage/products/company/brand/logos/jb_beam.svg"></image>
<div>
感谢 <a href=https://jb.gg/OpenSourceSupport>JetBrains</a> 系列开发工具为 AMLL 项目提供的大力支持
</div>
</div>
