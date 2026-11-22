use std::{env, path::Path};

/// Work around WebKitGTK graphics issues on Linux NVIDIA Wayland sessions
/// before GTK/WebKit initializes; existing user values always win.
///
/// - `__NV_DISABLE_EXPLICIT_SYNC=1`: NVIDIA's explicit-sync path can fail
///   when WebKitGTK creates a native Wayland surface.
/// - `WEBKIT_WEBGL_DISABLE_GBM=1`: WebKitGTK's GBM-backed WebGL buffer path
///   can flicker or turn black on NVIDIA Wayland when resizing or toggling
///   fullscreen, while keeping DMA-BUF compositing and GPU WebGL enabled.
pub(crate) fn configure_nvidia_wayland() {
    if env::var_os("WAYLAND_DISPLAY").is_none() || !Path::new("/dev/nvidiactl").exists() {
        return;
    }

    // SAFETY: called before Tauri initializes GTK or starts worker threads.
    if env::var_os("__NV_DISABLE_EXPLICIT_SYNC").is_none() {
        unsafe { env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1") };
    }

    if env::var_os("WEBKIT_WEBGL_DISABLE_GBM").is_none() {
        unsafe { env::set_var("WEBKIT_WEBGL_DISABLE_GBM", "1") };
    }
}
