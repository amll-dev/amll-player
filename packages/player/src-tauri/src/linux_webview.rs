use std::{
    collections::HashSet,
    env, fs,
    fs::{File, OpenOptions},
    ops::{Deref, DerefMut},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::OnceLock,
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow, bail};
use x11rb::{
    connection::Connection,
    protocol::{
        randr::{ConnectionExt as _, Mode, ModeFlag, ModeInfo, Output, Rotation, SetConfig},
        xproto::{
            Atom, AtomEnum, ClientMessageEvent, ConfigureWindowAux, ConnectionExt as _, EventMask,
            PropMode, Window,
        },
    },
    rust_connection::RustConnection,
    wrapper::ConnectionExt as _,
};

const BACKEND_ENV: &str = "AMLL_LINUX_WEBVIEW_BACKEND";
const XEPHYR_FRAME_RATE_ENV: &str = "AMLL_XEPHYR_FPS";
const DMABUF_ENV: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
const WRAPPER_CHILD_ENV: &str = "AMLL_OPENBOX_WRAPPER_CHILD";
const HOST_DISPLAY_ENV: &str = "AMLL_OPENBOX_HOST_DISPLAY";
const HOST_WINDOW_ENV: &str = "AMLL_OPENBOX_HOST_WINDOW";
const DISPLAY_START: u16 = 100;
const DISPLAY_END: u16 = 199;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);
const POLL_INTERVAL: Duration = Duration::from_millis(50);
const FALLBACK_FRAME_RATE: u16 = 60;
const INITIAL_WIDTH: u16 = 1280;
const INITIAL_HEIGHT: u16 = 800;

#[derive(Clone, Copy, Debug)]
struct HostDisplayMode {
    width: u16,
    height: u16,
    frame_rate: u16,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LinuxWebviewBackend {
    System,
    Openbox,
    X11,
    Wayland,
    WaylandSoftware,
}

impl LinuxWebviewBackend {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Openbox => "openbox",
            Self::X11 => "x11",
            Self::Wayland => "wayland",
            Self::WaylandSoftware => "wayland-software",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BackendPreference {
    Auto,
    System,
    Openbox,
    X11,
    Wayland,
    WaylandSoftware,
}

#[derive(Clone, Copy, Debug)]
struct LinuxDisplayContext {
    wayland_session: bool,
    nvidia_gpu: bool,
    x11_available: bool,
    openbox_available: bool,
    configured_gdk_backend: Option<ConfiguredGdkBackend>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ConfiguredGdkBackend {
    Wayland,
    Other,
}

static SELECTED_BACKEND: OnceLock<LinuxWebviewBackend> = OnceLock::new();

/// Configures the current process, or supervises a nested Openbox child and returns its exit code.
pub(crate) fn prepare() -> Option<i32> {
    if env::var_os(WRAPPER_CHILD_ENV).is_some() {
        apply_backend(LinuxWebviewBackend::Openbox);
        return None;
    }

    let preference = env::var(BACKEND_ENV)
        .ok()
        .and_then(|value| match parse_preference(&value) {
            Some(preference) => Some(preference),
            None => {
                eprintln!(
                    "Ignoring invalid {BACKEND_ENV}={value:?}; expected auto, system, openbox, x11, wayland, or wayland-software"
                );
                None
            }
        })
        .unwrap_or(BackendPreference::Auto);

    let context = LinuxDisplayContext {
        wayland_session: is_wayland_session(),
        nvidia_gpu: has_nvidia_gpu(),
        x11_available: x11_display_available(),
        openbox_available: command_available("Xephyr") && command_available("openbox"),
        configured_gdk_backend: configured_gdk_backend(),
    };
    let mut backend = select_backend(preference, context);

    if backend == LinuxWebviewBackend::Openbox {
        match supervise_openbox() {
            Ok(exit_code) => return Some(exit_code),
            Err(error) => {
                backend = fallback_backend(context);
                eprintln!(
                    "Openbox wrapper unavailable ({error:#}); falling back to {}",
                    backend.as_str()
                );
            }
        }
    }

    apply_backend(backend);
    None
}

pub(crate) fn selected_backend() -> LinuxWebviewBackend {
    SELECTED_BACKEND
        .get()
        .copied()
        .unwrap_or(LinuxWebviewBackend::System)
}

pub(crate) fn is_openbox_wrapper() -> bool {
    env::var_os(WRAPPER_CHILD_ENV).is_some()
}

pub(crate) fn toggle_openbox_fullscreen() -> Result<Option<bool>, String> {
    if !is_openbox_wrapper() {
        return Ok(None);
    }

    toggle_host_fullscreen()
        .map(Some)
        .map_err(|error| error.to_string())
}

pub(crate) fn is_openbox_maximized() -> Result<Option<bool>, String> {
    if !is_openbox_wrapper() {
        return Ok(None);
    }

    host_is_maximized()
        .map(Some)
        .map_err(|error| error.to_string())
}

pub(crate) fn toggle_openbox_maximize() -> Result<Option<bool>, String> {
    if !is_openbox_wrapper() {
        return Ok(None);
    }

    toggle_host_maximize()
        .map(Some)
        .map_err(|error| error.to_string())
}

pub(crate) fn minimize_openbox_wrapper() -> Result<bool, String> {
    if !is_openbox_wrapper() {
        return Ok(false);
    }

    minimize_host()
        .map(|()| true)
        .map_err(|error| error.to_string())
}

pub(crate) fn start_openbox_drag() -> Result<bool, String> {
    if !is_openbox_wrapper() {
        return Ok(false);
    }

    start_host_drag()
        .map(|()| true)
        .map_err(|error| error.to_string())
}

pub(crate) fn start_openbox_resize(direction: &str) -> Result<bool, String> {
    if !is_openbox_wrapper() {
        return Ok(false);
    }

    let direction = match direction {
        "top-left" => 0,
        "top" => 1,
        "top-right" => 2,
        "right" => 3,
        "bottom-right" => 4,
        "bottom" => 5,
        "bottom-left" => 6,
        "left" => 7,
        _ => return Err(format!("invalid resize direction: {direction}")),
    };
    start_host_manual_resize(direction)
        .map(|()| true)
        .map_err(|error| error.to_string())
}

fn apply_backend(backend: LinuxWebviewBackend) {
    // SAFETY: run() calls prepare() before Tauri initializes GTK/WebKit or starts worker threads.
    unsafe {
        match backend {
            LinuxWebviewBackend::System => {}
            LinuxWebviewBackend::Openbox | LinuxWebviewBackend::X11 => {
                env::set_var("GDK_BACKEND", "x11");
            }
            LinuxWebviewBackend::Wayland => env::set_var("GDK_BACKEND", "wayland"),
            LinuxWebviewBackend::WaylandSoftware => {
                env::set_var("GDK_BACKEND", "wayland");
                if env::var_os(DMABUF_ENV).is_none() {
                    env::set_var(DMABUF_ENV, "1");
                }
            }
        }
    }

    let _ = SELECTED_BACKEND.set(backend);
}

fn parse_preference(value: &str) -> Option<BackendPreference> {
    match value.trim().to_ascii_lowercase().as_str() {
        "auto" => Some(BackendPreference::Auto),
        "system" => Some(BackendPreference::System),
        "openbox" => Some(BackendPreference::Openbox),
        "x11" => Some(BackendPreference::X11),
        "wayland" => Some(BackendPreference::Wayland),
        "wayland-software" => Some(BackendPreference::WaylandSoftware),
        _ => None,
    }
}

fn select_backend(
    preference: BackendPreference,
    context: LinuxDisplayContext,
) -> LinuxWebviewBackend {
    if !context.wayland_session || preference == BackendPreference::System {
        return LinuxWebviewBackend::System;
    }

    if preference == BackendPreference::Auto
        && context.configured_gdk_backend == Some(ConfiguredGdkBackend::Other)
    {
        return LinuxWebviewBackend::System;
    }

    match preference {
        BackendPreference::Auto if !context.nvidia_gpu => LinuxWebviewBackend::System,
        BackendPreference::Auto | BackendPreference::Openbox
            if context.x11_available && context.openbox_available =>
        {
            LinuxWebviewBackend::Openbox
        }
        BackendPreference::Auto | BackendPreference::Openbox | BackendPreference::X11
            if context.x11_available =>
        {
            LinuxWebviewBackend::X11
        }
        BackendPreference::Auto | BackendPreference::Openbox | BackendPreference::X11 => {
            LinuxWebviewBackend::WaylandSoftware
        }
        BackendPreference::System => LinuxWebviewBackend::System,
        BackendPreference::Wayland => LinuxWebviewBackend::Wayland,
        BackendPreference::WaylandSoftware => LinuxWebviewBackend::WaylandSoftware,
    }
}

fn fallback_backend(context: LinuxDisplayContext) -> LinuxWebviewBackend {
    if context.x11_available {
        LinuxWebviewBackend::X11
    } else {
        LinuxWebviewBackend::WaylandSoftware
    }
}

fn supervise_openbox() -> Result<i32> {
    let host_display = env::var("DISPLAY").context("DISPLAY is not configured")?;
    let host_windows = client_windows(&host_display).unwrap_or_default();
    let display = DisplayReservation::acquire()?;
    let nested_display = format!(":{}", display.number);
    let config_dir = tempfile::tempdir().context("failed to create Openbox config directory")?;
    let config_path = config_dir.path().join("rc.xml");
    fs::write(&config_path, OPENBOX_CONFIG).context("failed to write Openbox configuration")?;
    let host_mode = host_display_mode(&host_display).unwrap_or(HostDisplayMode {
        width: 1920,
        height: 1200,
        frame_rate: FALLBACK_FRAME_RATE,
    });
    let frame_rate = xephyr_frame_rate(
        env::var(XEPHYR_FRAME_RATE_ENV).ok().as_deref(),
        host_mode.frame_rate,
    );
    let frame_rate_arg = frame_rate.to_string();
    let screen_arg = format!(
        "{}x{}",
        host_mode.width.max(INITIAL_WIDTH),
        host_mode.height.max(INITIAL_HEIGHT)
    );

    eprintln!(
        "Starting AMLL Player in Xephyr + Openbox on {nested_display} with a {frame_rate} Hz Xephyr mode"
    );
    let mut xephyr_command = child_command("Xephyr");
    let mut xephyr = ManagedChild::new(
        xephyr_command
            .args([
                nested_display.as_str(),
                "-screen",
                screen_arg.as_str(),
                "-resizeable",
                "-fakescreenfps",
                frame_rate_arg.as_str(),
                "-title",
                "AMLL Player",
                "-name",
                "amll-player",
                "-nolisten",
                "tcp",
                "-noreset",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .context("failed to start Xephyr")?,
    );

    wait_for_display(&nested_display, &mut xephyr)?;
    if let Err(error) = configure_nested_display_mode(
        &nested_display,
        host_mode.width.max(INITIAL_WIDTH),
        host_mode.height.max(INITIAL_HEIGHT),
        frame_rate,
    ) {
        eprintln!(
            "Failed to reserve the host-sized RandR mode in Xephyr ({error:#}); large-window input may be limited"
        );
    }
    let host_window = wait_for_host_window(&host_display, &host_windows, &mut xephyr)?;
    configure_host_window(&host_display, host_window, std::process::id());
    resize_host_window(&host_display, host_window, INITIAL_WIDTH, INITIAL_HEIGHT)?;
    wait_for_root_size(
        &nested_display,
        (INITIAL_WIDTH, INITIAL_HEIGHT),
        &mut xephyr,
    )?;
    if let Err(error) =
        configure_nested_display_mode(&nested_display, INITIAL_WIDTH, INITIAL_HEIGHT, frame_rate)
    {
        eprintln!(
            "Failed to configure initial {frame_rate} Hz RandR mode in Xephyr ({error:#}); continuing with its default mode"
        );
    }

    let mut openbox_command = child_command("openbox");
    let mut openbox = ManagedChild::new(
        openbox_command
            .arg("--config-file")
            .arg(&config_path)
            .env("DISPLAY", &nested_display)
            .env_remove("WAYLAND_DISPLAY")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .context("failed to start Openbox")?,
    );

    wait_for_window_manager(&nested_display, &mut openbox)?;
    let current_exe = env::current_exe().context("failed to locate the AMLL executable")?;
    let mut app_command = child_command(current_exe);
    let mut app = ManagedChild::new(
        app_command
            .args(env::args_os().skip(1))
            .env(WRAPPER_CHILD_ENV, "1")
            .env(HOST_DISPLAY_ENV, &host_display)
            .env(HOST_WINDOW_ENV, host_window.to_string())
            .env("DISPLAY", &nested_display)
            .env("GDK_BACKEND", "x11")
            .env("XDG_SESSION_TYPE", "x11")
            .env_remove("WAYLAND_DISPLAY")
            .stdin(Stdio::null())
            .spawn()
            .context("failed to start AMLL inside Openbox")?,
    );

    configure_host_window(&host_display, host_window, app.id());

    let mut nested_window = None;
    let mut last_root_size = None;
    let mut last_dynamic_mode = None;
    loop {
        if let Some(status) = app.try_wait().context("failed to inspect AMLL process")? {
            terminate(&mut openbox);
            terminate(&mut xephyr);
            return Ok(status.code().unwrap_or(1));
        }

        if let Some(status) = xephyr.try_wait().context("failed to inspect Xephyr")? {
            terminate(&mut app);
            terminate(&mut openbox);
            if status.success() {
                return Ok(0);
            }
            bail!("Xephyr exited unexpectedly with {status}");
        }

        if let Some(status) = openbox.try_wait().context("failed to inspect Openbox")? {
            terminate(&mut app);
            terminate(&mut xephyr);
            bail!("Openbox exited unexpectedly with {status}");
        }

        if let Err(error) = sync_nested_main_window(
            &nested_display,
            &mut nested_window,
            &mut last_root_size,
            &mut last_dynamic_mode,
            frame_rate,
        ) {
            eprintln!("Openbox window synchronization failed: {error:#}");
        }
        thread::sleep(POLL_INTERVAL);
    }
}

fn wait_for_display(display: &str, child: &mut Child) -> Result<()> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if x11rb::connect(Some(display)).is_ok() {
            return Ok(());
        }
        if let Some(status) = child.try_wait()? {
            bail!("Xephyr exited during startup with {status}");
        }
        thread::sleep(POLL_INTERVAL);
    }
    terminate(child);
    bail!("timed out waiting for Xephyr display {display}")
}

fn wait_for_root_size(display: &str, expected: (u16, u16), child: &mut Child) -> Result<()> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        let (conn, screen_num) = x11rb::connect(Some(display))?;
        let root = conn.setup().roots[screen_num].root;
        let geometry = conn.get_geometry(root)?.reply()?;
        if (geometry.width, geometry.height) == expected {
            return Ok(());
        }
        if let Some(status) = child.try_wait()? {
            bail!("Xephyr exited while resizing its host window with {status}");
        }
        thread::sleep(POLL_INTERVAL);
    }
    bail!(
        "timed out waiting for Xephyr root size {}x{}",
        expected.0,
        expected.1
    )
}

fn wait_for_host_window(
    display: &str,
    previous_windows: &HashSet<Window>,
    child: &mut Child,
) -> Result<Window> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        let (conn, screen_num) = x11rb::connect(Some(display))?;
        for window in client_windows_with_connection(&conn, screen_num)? {
            if !previous_windows.contains(&window) && is_xephyr_window(&conn, window)? {
                return Ok(window);
            }
        }
        if let Some(status) = child.try_wait()? {
            bail!("Xephyr exited before creating its host window with {status}");
        }
        thread::sleep(POLL_INTERVAL);
    }
    bail!("timed out waiting for the Xephyr host window")
}

fn wait_for_window_manager(display: &str, child: &mut Child) -> Result<()> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if window_manager_ready(display).unwrap_or(false) {
            return Ok(());
        }
        if let Some(status) = child.try_wait()? {
            bail!("Openbox exited during startup with {status}");
        }
        thread::sleep(POLL_INTERVAL);
    }
    terminate(child);
    bail!("timed out waiting for Openbox")
}

fn window_manager_ready(display: &str) -> Result<bool> {
    let (conn, screen_num) = x11rb::connect(Some(display))?;
    let root = conn.setup().roots[screen_num].root;
    let atom = intern_atom(&conn, b"_NET_SUPPORTING_WM_CHECK")?;
    let reply = conn
        .get_property(false, root, atom, AtomEnum::WINDOW, 0, 1)?
        .reply()?;
    Ok(reply.value_len > 0)
}

fn client_windows(display: &str) -> Result<HashSet<Window>> {
    let (conn, screen_num) = x11rb::connect(Some(display))?;
    client_windows_with_connection(&conn, screen_num)
}

fn host_display_mode(display: &str) -> Result<HostDisplayMode> {
    let (conn, screen_num) = x11rb::connect(Some(display))?;
    let root = conn.setup().roots[screen_num].root;
    let resources = conn.randr_get_screen_resources_current(root)?.reply()?;
    let primary = conn.randr_get_output_primary(root)?.reply()?.output;
    let output = if primary != 0 {
        primary
    } else {
        *resources
            .outputs
            .first()
            .context("XRandR reported no outputs")?
    };
    let output_info = conn
        .randr_get_output_info(output, resources.config_timestamp)?
        .reply()?;
    if output_info.crtc == 0 {
        bail!("primary XRandR output has no active CRTC");
    }
    let crtc = conn
        .randr_get_crtc_info(output_info.crtc, resources.config_timestamp)?
        .reply()?;
    let mode = resources
        .modes
        .iter()
        .find(|mode| mode.id == crtc.mode)
        .context("active XRandR mode was not found")?;
    if mode.dot_clock == 0 || mode.htotal == 0 || mode.vtotal == 0 {
        bail!("active XRandR mode has no refresh timing");
    }

    let mut frame_rate =
        f64::from(mode.dot_clock) / (f64::from(mode.htotal) * f64::from(mode.vtotal));
    let flags = u32::from(mode.mode_flags);
    if flags & u32::from(ModeFlag::INTERLACE) != 0 {
        frame_rate *= 2.0;
    }
    if flags & u32::from(ModeFlag::DOUBLE_SCAN) != 0 {
        frame_rate /= 2.0;
    }
    let (width, height) = resources
        .crtcs
        .iter()
        .filter_map(|crtc| {
            conn.randr_get_crtc_info(*crtc, resources.config_timestamp)
                .ok()?
                .reply()
                .ok()
                .map(|info| (info.width, info.height))
        })
        .fold((crtc.width, crtc.height), |largest, current| {
            (largest.0.max(current.0), largest.1.max(current.1))
        });
    Ok(HostDisplayMode {
        width,
        height,
        frame_rate: frame_rate.round().clamp(30.0, 1000.0) as u16,
    })
}

fn xephyr_frame_rate(requested: Option<&str>, host_frame_rate: u16) -> u16 {
    let host_frame_rate = host_frame_rate.clamp(30, 1000);
    let default_frame_rate = FALLBACK_FRAME_RATE.min(host_frame_rate);
    requested
        .and_then(|value| value.trim().parse::<u16>().ok())
        .filter(|frame_rate| (30..=host_frame_rate).contains(frame_rate))
        .unwrap_or(default_frame_rate)
}

fn configure_nested_display_mode(
    display: &str,
    width: u16,
    height: u16,
    frame_rate: u16,
) -> Result<()> {
    let (conn, screen_num) = x11rb::connect(Some(display))?;
    let root = conn.setup().roots[screen_num].root;
    configure_nested_display_mode_with_connection(&conn, root, width, height, frame_rate)
        .map(|_| ())
}

fn configure_nested_display_mode_with_connection(
    conn: &RustConnection,
    root: Window,
    width: u16,
    height: u16,
    frame_rate: u16,
) -> Result<(Output, Mode, bool)> {
    let resources = conn.randr_get_screen_resources(root)?.reply()?;
    let output = *resources
        .outputs
        .first()
        .context("Xephyr XRandR reported no outputs")?;
    let output_info = conn
        .randr_get_output_info(output, resources.config_timestamp)?
        .reply()?;
    let crtc = output_info.crtc;
    if crtc == 0 {
        bail!("Xephyr XRandR output has no active CRTC");
    }

    let horizontal_blank = 160;
    let hsync_start = width
        .checked_add(48)
        .context("requested Xephyr horizontal timing is too large")?;
    let hsync_end = width
        .checked_add(80)
        .context("requested Xephyr horizontal timing is too large")?;
    let htotal = width
        .checked_add(horizontal_blank)
        .context("requested Xephyr horizontal timing is too large")?;
    let vertical_blank = 30;
    let vsync_start = height
        .checked_add(3)
        .context("requested Xephyr vertical timing is too large")?;
    let vsync_end = height
        .checked_add(9)
        .context("requested Xephyr vertical timing is too large")?;
    let vtotal = height
        .checked_add(vertical_blank)
        .context("requested Xephyr vertical timing is too large")?;
    let frame_pixels = u32::from(htotal) * u32::from(vtotal);
    let maximum_frame_rate = (u32::MAX / frame_pixels).max(1).min(u32::from(u16::MAX)) as u16;
    let mode_frame_rate = frame_rate.min(maximum_frame_rate);
    let dot_clock = frame_pixels * u32::from(mode_frame_rate);
    let (mode, created) = if let Some(mode) = resources.modes.iter().find(|mode| {
        mode.width == width
            && mode.height == height
            && mode.dot_clock == dot_clock
            && mode.htotal == htotal
            && mode.vtotal == vtotal
    }) {
        (mode.id, false)
    } else {
        let name = format!("{width}x{height}_{mode_frame_rate}.00");
        let mode = conn
            .randr_create_mode(
                root,
                ModeInfo {
                    id: 0,
                    width,
                    height,
                    dot_clock,
                    hsync_start,
                    hsync_end,
                    htotal,
                    hskew: 0,
                    vsync_start,
                    vsync_end,
                    vtotal,
                    name_len: name
                        .len()
                        .try_into()
                        .context("RandR mode name is too long")?,
                    mode_flags: ModeFlag::HSYNC_NEGATIVE | ModeFlag::VSYNC_POSITIVE,
                },
                name.as_bytes(),
            )?
            .reply()?
            .mode;
        conn.randr_add_output_mode(output, mode)?.check()?;
        (mode, true)
    };
    let result = conn
        .randr_set_crtc_config(
            crtc,
            0,
            resources.config_timestamp,
            0,
            0,
            mode,
            Rotation::ROTATE0,
            &[output],
        )?
        .reply()?;
    if result.status != SetConfig::SUCCESS {
        bail!(
            "Xephyr rejected the RandR mode with status {}",
            u8::from(result.status)
        );
    }
    conn.flush()?;
    Ok((output, mode, created))
}

fn destroy_nested_display_mode(conn: &RustConnection, output: Output, mode: Mode) -> Result<()> {
    conn.randr_delete_output_mode(output, mode)?.check()?;
    conn.randr_destroy_mode(mode)?.check()?;
    conn.flush()?;
    Ok(())
}

fn resize_host_window(display: &str, window: Window, width: u16, height: u16) -> Result<()> {
    let (conn, _) = x11rb::connect(Some(display))?;
    conn.configure_window(
        window,
        &ConfigureWindowAux::new()
            .width(u32::from(width))
            .height(u32::from(height)),
    )?
    .check()?;
    conn.flush()?;
    Ok(())
}

fn client_windows_with_connection(
    conn: &RustConnection,
    screen_num: usize,
) -> Result<HashSet<Window>> {
    let root = conn.setup().roots[screen_num].root;
    let atom = intern_atom(&conn, b"_NET_CLIENT_LIST")?;
    let reply = conn
        .get_property(false, root, atom, AtomEnum::WINDOW, 0, u32::MAX)?
        .reply()?;
    Ok(reply.value32().into_iter().flatten().collect())
}

fn is_xephyr_window(conn: &RustConnection, window: Window) -> Result<bool> {
    let reply = conn
        .get_property(false, window, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, 1024)?
        .reply()?;
    let classes = reply
        .value
        .split(|byte| *byte == 0)
        .filter_map(|value| std::str::from_utf8(value).ok());
    Ok(classes.into_iter().any(|class| class == "Xephyr"))
}

fn configure_host_window(display: &str, window: Window, app_pid: u32) {
    let result = (|| -> Result<()> {
        let (conn, _) = x11rb::connect(Some(display))?;
        conn.change_property8(
            PropMode::REPLACE,
            window,
            AtomEnum::WM_CLASS,
            AtomEnum::STRING,
            b"amll-player\0Amll-player\0",
        )?
        .check()?;
        let pid_atom = intern_atom(&conn, b"_NET_WM_PID")?;
        conn.change_property32(
            PropMode::REPLACE,
            window,
            pid_atom,
            AtomEnum::CARDINAL,
            &[app_pid],
        )?
        .check()?;
        let window_type_atom = intern_atom(&conn, b"_NET_WM_WINDOW_TYPE")?;
        let normal_atom = intern_atom(&conn, b"_NET_WM_WINDOW_TYPE_NORMAL")?;
        conn.change_property32(
            PropMode::REPLACE,
            window,
            window_type_atom,
            AtomEnum::ATOM,
            &[normal_atom],
        )?
        .check()?;
        let motif_hints_atom = intern_atom(&conn, b"_MOTIF_WM_HINTS")?;
        conn.change_property32(
            PropMode::REPLACE,
            window,
            motif_hints_atom,
            motif_hints_atom,
            // KWin treats partial Motif decorations as a full frame, so disable them entirely.
            &[2, 0, 0, 0, 0],
        )?
        .check()?;
        conn.flush()?;
        Ok(())
    })();

    if let Err(error) = result {
        eprintln!("Failed to configure Xephyr host window: {error:#}");
    }
}

fn sync_nested_main_window(
    display: &str,
    cached_window: &mut Option<Window>,
    last_root_size: &mut Option<(u16, u16)>,
    last_dynamic_mode: &mut Option<(Output, Mode)>,
    frame_rate: u16,
) -> Result<()> {
    let (conn, screen_num) = x11rb::connect(Some(display))?;
    let root = conn.setup().roots[screen_num].root;
    let root_geometry = conn.get_geometry(root)?.reply()?;
    let root_size = (root_geometry.width, root_geometry.height);

    if *last_root_size != Some(root_size) {
        match configure_nested_display_mode_with_connection(
            &conn,
            root,
            root_size.0,
            root_size.1,
            frame_rate,
        ) {
            Ok((output, mode, created)) => {
                if let Some((previous_output, previous_mode)) = last_dynamic_mode.take()
                    && previous_mode != mode
                    && let Err(error) =
                        destroy_nested_display_mode(&conn, previous_output, previous_mode)
                {
                    eprintln!("Failed to remove stale Xephyr RandR mode: {error:#}");
                }
                if created {
                    *last_dynamic_mode = Some((output, mode));
                }
            }
            Err(error) => {
                eprintln!(
                    "Failed to update the Xephyr RandR mode for {}x{} ({error:#}); continuing with window synchronization",
                    root_size.0, root_size.1
                );
            }
        }
    }

    let current_window = find_window_by_title(&conn, root, "AMLL Player")?;
    if *cached_window != current_window {
        *cached_window = current_window;
        *last_root_size = None;
    }
    let Some(window) = *cached_window else {
        return Ok(());
    };

    let geometry = conn.get_geometry(window)?.reply()?;
    let coordinates = conn.translate_coordinates(window, root, 0, 0)?.reply()?;
    let state_atom = intern_atom(&conn, b"_NET_WM_STATE")?;
    let max_vert = intern_atom(&conn, b"_NET_WM_STATE_MAXIMIZED_VERT")?;
    let max_horz = intern_atom(&conn, b"_NET_WM_STATE_MAXIMIZED_HORZ")?;
    let inner_maximized = window_has_state(&conn, window, state_atom, max_vert)?
        || window_has_state(&conn, window, state_atom, max_horz)?;
    let geometry_matches = coordinates.dst_x == 0
        && coordinates.dst_y == 0
        && geometry.width == root_size.0
        && geometry.height == root_size.1;

    if *last_root_size == Some(root_size) && geometry_matches && !inner_maximized {
        return Ok(());
    }

    remove_inner_maximize(&conn, root, window)?;
    conn.configure_window(
        window,
        &ConfigureWindowAux::new()
            .x(0)
            .y(0)
            .width(u32::from(root_size.0))
            .height(u32::from(root_size.1)),
    )?
    .check()?;
    conn.flush()?;
    *last_root_size = Some(root_size);
    Ok(())
}

fn find_window_by_title(
    conn: &RustConnection,
    root: Window,
    expected_title: &str,
) -> Result<Option<Window>> {
    let clients_atom = intern_atom(conn, b"_NET_CLIENT_LIST")?;
    let name_atom = intern_atom(conn, b"_NET_WM_NAME")?;
    let utf8_atom = intern_atom(conn, b"UTF8_STRING")?;
    let clients = conn
        .get_property(false, root, clients_atom, AtomEnum::WINDOW, 0, u32::MAX)?
        .reply()?;

    for window in clients.value32().into_iter().flatten() {
        let title = conn
            .get_property(false, window, name_atom, utf8_atom, 0, 1024)?
            .reply()?;
        if title.value == expected_title.as_bytes() {
            return Ok(Some(window));
        }
    }
    Ok(None)
}

fn remove_inner_maximize(conn: &RustConnection, root: Window, window: Window) -> Result<()> {
    let state_atom = intern_atom(conn, b"_NET_WM_STATE")?;
    let max_vert = intern_atom(conn, b"_NET_WM_STATE_MAXIMIZED_VERT")?;
    let max_horz = intern_atom(conn, b"_NET_WM_STATE_MAXIMIZED_HORZ")?;
    send_wm_state(conn, root, window, state_atom, 0, max_vert, max_horz)
}

fn toggle_host_fullscreen() -> Result<bool> {
    let (conn, root, window) = connect_to_host()?;
    let state_atom = intern_atom(&conn, b"_NET_WM_STATE")?;
    let fullscreen_atom = intern_atom(&conn, b"_NET_WM_STATE_FULLSCREEN")?;
    let fullscreen = window_has_state(&conn, window, state_atom, fullscreen_atom)?;
    let next = !fullscreen;
    send_wm_state(
        &conn,
        root,
        window,
        state_atom,
        u32::from(next),
        fullscreen_atom,
        0,
    )?;
    Ok(next)
}

fn host_is_maximized() -> Result<bool> {
    let (conn, _, window) = connect_to_host()?;
    let state_atom = intern_atom(&conn, b"_NET_WM_STATE")?;
    let max_vert = intern_atom(&conn, b"_NET_WM_STATE_MAXIMIZED_VERT")?;
    let max_horz = intern_atom(&conn, b"_NET_WM_STATE_MAXIMIZED_HORZ")?;
    Ok(window_has_state(&conn, window, state_atom, max_vert)?
        && window_has_state(&conn, window, state_atom, max_horz)?)
}

fn toggle_host_maximize() -> Result<bool> {
    let (conn, root, window) = connect_to_host()?;
    let state_atom = intern_atom(&conn, b"_NET_WM_STATE")?;
    let max_vert = intern_atom(&conn, b"_NET_WM_STATE_MAXIMIZED_VERT")?;
    let max_horz = intern_atom(&conn, b"_NET_WM_STATE_MAXIMIZED_HORZ")?;
    let next = !(window_has_state(&conn, window, state_atom, max_vert)?
        && window_has_state(&conn, window, state_atom, max_horz)?);
    send_wm_state(
        &conn,
        root,
        window,
        state_atom,
        u32::from(next),
        max_vert,
        max_horz,
    )?;
    Ok(next)
}

fn minimize_host() -> Result<()> {
    let (conn, root, window) = connect_to_host()?;
    let change_state_atom = intern_atom(&conn, b"WM_CHANGE_STATE")?;
    let event = ClientMessageEvent::new(32, window, change_state_atom, [3, 0, 0, 0, 0]);
    conn.send_event(
        false,
        root,
        EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
        event,
    )?
    .check()?;
    conn.flush()?;
    Ok(())
}

fn start_host_drag() -> Result<()> {
    start_host_move_resize(8)
}

fn start_host_manual_resize(direction: u32) -> Result<()> {
    // The outer Xephyr window is managed by KWin. Let the window manager own
    // the interactive resize instead of sending client-side ConfigureWindow
    // requests that KWin may ignore or constrain.
    start_host_move_resize(direction)
}

fn start_host_move_resize(direction: u32) -> Result<()> {
    let (conn, root, window) = connect_to_host()?;
    let pointer = conn.query_pointer(root)?.reply()?;
    let move_resize_atom = intern_atom(&conn, b"_NET_WM_MOVERESIZE")?;
    let event = ClientMessageEvent::new(
        32,
        window,
        move_resize_atom,
        [
            i32::from(pointer.root_x) as u32,
            i32::from(pointer.root_y) as u32,
            direction,
            1,
            1,
        ],
    );
    conn.send_event(
        false,
        root,
        EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
        event,
    )?
    .check()?;
    conn.flush()?;
    Ok(())
}

fn connect_to_host() -> Result<(RustConnection, Window, Window)> {
    let display = env::var(HOST_DISPLAY_ENV).context("missing Openbox host display")?;
    let window = env::var(HOST_WINDOW_ENV)
        .context("missing Openbox host window")?
        .parse::<Window>()
        .context("invalid Openbox host window")?;
    let (conn, screen_num) = x11rb::connect(Some(&display))?;
    let root = conn.setup().roots[screen_num].root;
    Ok((conn, root, window))
}

fn window_has_state(
    conn: &RustConnection,
    window: Window,
    state_atom: Atom,
    expected_state: Atom,
) -> Result<bool> {
    let states = conn
        .get_property(false, window, state_atom, AtomEnum::ATOM, 0, u32::MAX)?
        .reply()?;
    Ok(states
        .value32()
        .is_some_and(|mut states| states.any(|state| state == expected_state)))
}

fn send_wm_state(
    conn: &RustConnection,
    root: Window,
    window: Window,
    state_atom: Atom,
    action: u32,
    first: Atom,
    second: Atom,
) -> Result<()> {
    let event = ClientMessageEvent::new(32, window, state_atom, [action, first, second, 1, 0]);
    conn.send_event(
        false,
        root,
        EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
        event,
    )?
    .check()?;
    conn.flush()?;
    Ok(())
}

fn intern_atom(conn: &RustConnection, name: &[u8]) -> Result<Atom> {
    Ok(conn.intern_atom(false, name)?.reply()?.atom)
}

fn terminate(child: &mut Child) {
    if child.try_wait().ok().flatten().is_none() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

struct ManagedChild(Child);

impl ManagedChild {
    fn new(child: Child) -> Self {
        Self(child)
    }
}

impl Deref for ManagedChild {
    type Target = Child;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl DerefMut for ManagedChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        terminate(&mut self.0);
    }
}

fn child_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    let parent_pid = std::process::id() as libc::pid_t;
    // SAFETY: pre_exec only calls async-signal-safe libc functions before exec.
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::getppid() != parent_pid {
                libc::raise(libc::SIGTERM);
            }
            Ok(())
        });
    }
    command
}

struct DisplayReservation {
    number: u16,
    _lock_file: File,
}

impl DisplayReservation {
    fn acquire() -> Result<Self> {
        for number in DISPLAY_START..=DISPLAY_END {
            let socket_path = Path::new("/tmp/.X11-unix").join(format!("X{number}"));
            let lock_path = PathBuf::from(format!("/tmp/amll-player-openbox-{number}.lock"));
            if socket_path.exists() {
                continue;
            }
            let lock_file = OpenOptions::new()
                .write(true)
                .create(true)
                .open(&lock_path)?;
            match lock_file.try_lock() {
                Ok(()) => {
                    return Ok(Self {
                        number,
                        _lock_file: lock_file,
                    });
                }
                Err(std::fs::TryLockError::WouldBlock) => continue,
                Err(std::fs::TryLockError::Error(error)) => return Err(error.into()),
            }
        }
        Err(anyhow!(
            "no free nested X11 display between :{DISPLAY_START} and :{DISPLAY_END}"
        ))
    }
}

impl Drop for DisplayReservation {
    fn drop(&mut self) {
        let _ = self._lock_file.unlock();
    }
}

fn configured_gdk_backend() -> Option<ConfiguredGdkBackend> {
    env::var("GDK_BACKEND").ok().map(|value| {
        if value
            .split(',')
            .next()
            .is_some_and(|backend| backend.trim().eq_ignore_ascii_case("wayland"))
        {
            ConfiguredGdkBackend::Wayland
        } else {
            ConfiguredGdkBackend::Other
        }
    })
}

fn is_wayland_session() -> bool {
    env::var_os("WAYLAND_DISPLAY").is_some()
        || env::var("XDG_SESSION_TYPE").is_ok_and(|value| value.eq_ignore_ascii_case("wayland"))
}

fn has_nvidia_gpu() -> bool {
    if Path::new("/proc/driver/nvidia/version").exists()
        || Path::new("/sys/module/nvidia_drm").exists()
    {
        return true;
    }

    fs::read_dir("/sys/class/drm")
        .map(|entries| {
            entries.flatten().any(|entry| {
                fs::read_to_string(entry.path().join("device/vendor"))
                    .is_ok_and(|vendor| vendor.trim().eq_ignore_ascii_case("0x10de"))
            })
        })
        .unwrap_or(false)
}

fn x11_display_available() -> bool {
    let Ok(display) = env::var("DISPLAY") else {
        return false;
    };
    if display.is_empty() {
        return false;
    }

    let local_display = display
        .strip_prefix(':')
        .or_else(|| display.strip_prefix("unix:"));
    let Some(local_display) = local_display else {
        return true;
    };
    let display_number = local_display.split('.').next().unwrap_or_default();
    if display_number.is_empty() || !display_number.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }

    Path::new("/tmp/.X11-unix")
        .join(format!("X{display_number}"))
        .exists()
}

fn command_available(command: &str) -> bool {
    env::var_os("PATH").is_some_and(|paths| {
        env::split_paths(&paths).any(|path| {
            let candidate = path.join(command);
            candidate.is_file()
        })
    })
}

const OPENBOX_CONFIG: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <focus>
    <focusNew>yes</focusNew>
    <followMouse>no</followMouse>
    <raiseOnFocus>yes</raiseOnFocus>
  </focus>
  <placement>
    <policy>Smart</policy>
    <center>yes</center>
  </placement>
  <desktops>
    <number>1</number>
  </desktops>
  <applications>
    <application class="Amll-player" title="AMLL Player">
      <decor>no</decor>
      <position force="yes"><x>0</x><y>0</y></position>
      <size><width>100%</width><height>100%</height></size>
    </application>
  </applications>
</openbox_config>
"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn context(
        nvidia_gpu: bool,
        x11_available: bool,
        openbox_available: bool,
    ) -> LinuxDisplayContext {
        LinuxDisplayContext {
            wayland_session: true,
            nvidia_gpu,
            x11_available,
            openbox_available,
            configured_gdk_backend: None,
        }
    }

    #[test]
    fn auto_prefers_openbox_for_nvidia_wayland() {
        assert_eq!(
            select_backend(BackendPreference::Auto, context(true, true, true)),
            LinuxWebviewBackend::Openbox
        );
    }

    #[test]
    fn auto_falls_back_to_x11_without_wrapper_dependencies() {
        assert_eq!(
            select_backend(BackendPreference::Auto, context(true, true, false)),
            LinuxWebviewBackend::X11
        );
    }

    #[test]
    fn auto_falls_back_to_software_wayland_without_x11() {
        assert_eq!(
            select_backend(BackendPreference::Auto, context(true, false, true)),
            LinuxWebviewBackend::WaylandSoftware
        );
    }

    #[test]
    fn auto_keeps_native_backend_for_other_gpus() {
        assert_eq!(
            select_backend(BackendPreference::Auto, context(false, true, true)),
            LinuxWebviewBackend::System
        );
    }

    #[test]
    fn explicit_openbox_has_safe_fallbacks() {
        assert_eq!(
            select_backend(BackendPreference::Openbox, context(false, true, false)),
            LinuxWebviewBackend::X11
        );
        assert_eq!(
            select_backend(BackendPreference::Openbox, context(false, false, false)),
            LinuxWebviewBackend::WaylandSoftware
        );
    }

    #[test]
    fn explicit_wayland_modes_are_preserved() {
        assert_eq!(
            select_backend(BackendPreference::Wayland, context(true, true, true)),
            LinuxWebviewBackend::Wayland
        );
        assert_eq!(
            select_backend(
                BackendPreference::WaylandSoftware,
                context(true, true, true)
            ),
            LinuxWebviewBackend::WaylandSoftware
        );
    }

    #[test]
    fn auto_overrides_wayland_gdk_for_nvidia() {
        let mut display = context(true, true, true);
        display.configured_gdk_backend = Some(ConfiguredGdkBackend::Wayland);
        assert_eq!(
            select_backend(BackendPreference::Auto, display),
            LinuxWebviewBackend::Openbox
        );
    }

    #[test]
    fn auto_respects_other_gdk_backends() {
        let mut display = context(true, true, true);
        display.configured_gdk_backend = Some(ConfiguredGdkBackend::Other);
        assert_eq!(
            select_backend(BackendPreference::Auto, display),
            LinuxWebviewBackend::System
        );
    }

    #[test]
    fn system_preference_restores_original_behavior() {
        assert_eq!(
            select_backend(BackendPreference::System, context(true, true, true)),
            LinuxWebviewBackend::System
        );
    }

    #[test]
    fn parser_accepts_openbox_override() {
        assert_eq!(
            parse_preference("OPENBOX"),
            Some(BackendPreference::Openbox)
        );
    }

    #[test]
    fn xephyr_defaults_to_sixty_hz() {
        assert_eq!(xephyr_frame_rate(None, 260), 60);
    }

    #[test]
    fn xephyr_accepts_a_high_refresh_override_within_host_limit() {
        assert_eq!(xephyr_frame_rate(Some("120"), 260), 120);
        assert_eq!(xephyr_frame_rate(Some("300"), 260), 60);
    }
}
