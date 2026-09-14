#[cfg(target_os = "windows")]
use crate::tray_player_watcher::{self, ScreenRect};
#[cfg(target_os = "windows")]
use serde::{Deserialize, Serialize};
#[cfg(target_os = "windows")]
use std::{
    collections::HashMap,
    fs,
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
#[cfg(target_os = "windows")]
use tauri::{
    Emitter,
    image::Image,
    menu::{CheckMenuItem, IconMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
#[cfg(target_os = "windows")]
use tauri::{PhysicalPosition, Position, Rect};
#[cfg(desktop)]
use tauri::{PhysicalSize, Size, utils::config::WindowEffectsConfig, window::Effect};
#[cfg(target_os = "windows")]
use tauri_plugin_window_state::{AppHandleExt, StateFlags, WindowExt};
use tracing::*;
#[cfg(target_os = "windows")]
use windows::Win32::{
    Foundation::HWND,
    Graphics::{
        Dwm::{DWMWA_CLOAK, DwmFlush, DwmSetWindowAttribute},
        Gdi::{RDW_INTERNALPAINT, RDW_UPDATENOW, RedrawWindow},
    },
    UI::WindowsAndMessaging::{
        IsWindowVisible, SW_HIDE, SW_SHOWMAXIMIZED, SW_SHOWNOACTIVATE, ShowWindow,
    },
};
#[cfg(target_os = "windows")]
use windows::core::BOOL;

#[cfg(target_os = "windows")]
const LEGACY_MAXIMIZED_SIZE_TOLERANCE: u32 = 1;
#[cfg(target_os = "windows")]
const CLEARLY_OFFSCREEN_DISTANCE: i64 = 32;
#[cfg(target_os = "windows")]
const DEFAULT_RESTORE_LOGICAL_WIDTH: f64 = 800.0;
#[cfg(target_os = "windows")]
const DEFAULT_RESTORE_LOGICAL_HEIGHT: f64 = 600.0;
#[cfg(target_os = "windows")]
const RESTORE_BOUNDS_SETTLE_DELAY: Duration = Duration::from_millis(80);
#[cfg(target_os = "windows")]
const DWM_UNCLOAK_RETRY_DELAYS_MS: [u64; 5] = [0, 1, 2, 4, 8];
#[cfg(target_os = "windows")]
const BACKGROUND_TRAY_ID: &str = "amll-player-background-tray";
#[cfg(target_os = "windows")]
const BACKGROUND_TRAY_COMMAND_EVENT: &str = "amll-player://background-tray-command";
#[cfg(target_os = "windows")]
const BACKGROUND_TRAY_STATE_EVENT: &str = "amll-player://background-tray-state";
#[cfg(target_os = "windows")]
const BACKGROUND_TRAY_PLAYER_LABEL: &str = "tray-player";
#[cfg(target_os = "windows")]
const BACKGROUND_TRAY_PLAYER_WIDTH: f64 = 380.0;
#[cfg(target_os = "windows")]
const BACKGROUND_TRAY_PLAYER_HEIGHT: f64 = 192.0;
#[cfg(target_os = "windows")]
const BACKGROUND_TRAY_PLAYER_MARGIN: i32 = 8;
#[cfg(target_os = "windows")]
const BACKGROUND_TRAY_INFO_ID: &str = "amll-player-tray-info";
#[cfg(target_os = "windows")]
const BACKGROUND_TRAY_PREVIOUS_ID: &str = "amll-player-tray-previous";
#[cfg(target_os = "windows")]
const BACKGROUND_TRAY_TOGGLE_PLAYBACK_ID: &str = "amll-player-tray-toggle-playback";
#[cfg(target_os = "windows")]
const BACKGROUND_TRAY_NEXT_ID: &str = "amll-player-tray-next";
#[cfg(target_os = "windows")]
const BACKGROUND_TRAY_TASKBAR_LYRIC_ID: &str = "amll-player-tray-taskbar-lyric";
#[cfg(target_os = "windows")]
const BACKGROUND_TRAY_SHOW_ID: &str = "amll-player-tray-show";
#[cfg(target_os = "windows")]
const BACKGROUND_TRAY_EXIT_ID: &str = "amll-player-tray-exit";
#[cfg(target_os = "windows")]
static BACKGROUND_RESTORE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[cfg(target_os = "windows")]
static MAIN_WINDOW_HIDDEN_TO_BACKGROUND: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static BACKGROUND_TRAY_MENU_STATE: OnceLock<Mutex<BackgroundTrayMenuState>> = OnceLock::new();
#[cfg(target_os = "windows")]
static BACKGROUND_TRAY_PLAYER_READY: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static BACKGROUND_TRAY_PLAYER_CREATING: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static BACKGROUND_TRAY_PLAYER_CREATION_GENERATION: AtomicU64 = AtomicU64::new(0);
#[cfg(target_os = "windows")]
static BACKGROUND_TRAY_PLAYER_VISIBILITY_STATE: OnceLock<
    Mutex<BackgroundTrayPlayerVisibilityState>,
> = OnceLock::new();
#[cfg(target_os = "windows")]
static BACKGROUND_TRAY_PLAYER_RECONCILE_RUNNING: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static BACKGROUND_TRAY_RECONCILE_RUNNING: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static BACKGROUND_TRAY_RECONCILE_GENERATION: AtomicU64 = AtomicU64::new(0);
#[cfg(target_os = "windows")]
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundTrayCover {
    rgba: Vec<u8>,
    width: u32,
    height: u32,
}

#[cfg(target_os = "windows")]
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct BackgroundTrayMenuLabels {
    app_name: String,
    unknown_song: String,
    unknown_artist: String,
    no_lyrics: String,
    previous: String,
    play: String,
    pause: String,
    next: String,
    taskbar_lyric: String,
    show_window: String,
    exit: String,
}

#[cfg(target_os = "windows")]
impl Default for BackgroundTrayMenuLabels {
    fn default() -> Self {
        Self {
            app_name: "AMLL Player".into(),
            unknown_song: "Unknown track".into(),
            unknown_artist: "Unknown artist".into(),
            no_lyrics: "No lyrics".into(),
            previous: "Previous".into(),
            play: "Play".into(),
            pause: "Pause".into(),
            next: "Next".into(),
            taskbar_lyric: "Taskbar lyrics".into(),
            show_window: "Show window".into(),
            exit: "Exit".into(),
        }
    }
}

#[cfg(target_os = "windows")]
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct BackgroundTrayMenuState {
    always_tray: bool,
    music_name: String,
    artist: String,
    lyric: String,
    playing: bool,
    can_control: bool,
    taskbar_lyric_enabled: bool,
    cover: Option<BackgroundTrayCover>,
    display_cover: String,
    labels: BackgroundTrayMenuLabels,
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, Debug, Default)]
struct BackgroundTrayPlayerVisibilityState {
    generation: u64,
    desired_visible: bool,
    anchor_rect: Option<PhysicalWindowRect>,
}

#[cfg(target_os = "windows")]
impl BackgroundTrayPlayerVisibilityState {
    fn set_visibility(&mut self, desired_visible: bool, anchor_rect: Option<PhysicalWindowRect>) {
        self.generation = self.generation.wrapping_add(1);
        if self.generation == 0 {
            self.generation = 1;
        }
        self.desired_visible = desired_visible;
        if anchor_rect.is_some() {
            self.anchor_rect = anchor_rect;
        }
    }

    fn toggle(&mut self, anchor_rect: PhysicalWindowRect) {
        let desired_visible = !self.desired_visible;
        self.set_visibility(desired_visible, desired_visible.then_some(anchor_rect));
    }
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BackgroundTrayAction {
    Previous,
    TogglePlayback,
    Next,
    ToggleTaskbarLyric,
    Show,
    Exit,
    Hide,
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, Debug, Serialize)]
struct BackgroundTrayCommandPayload {
    command: &'static str,
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default)]
struct PersistedWindowPresentation {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    prev_x: i32,
    prev_y: i32,
    maximized: bool,
    fullscreen: bool,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Default)]
pub(crate) struct MainWindowPresentationState {
    maximize_on_reveal: AtomicBool,
    fullscreen_on_reveal: AtomicBool,
    revealed: AtomicBool,
    presenting: AtomicBool,
    restore_bounds_generation: AtomicU64,
    restore_bounds: Mutex<Option<PhysicalWindowRect>>,
    pending_restore_bounds: Mutex<Option<PhysicalWindowRect>>,
}

#[cfg(target_os = "windows")]
impl MainWindowPresentationState {
    fn prepare(&self, maximize_on_reveal: bool, fullscreen_on_reveal: bool) {
        self.maximize_on_reveal
            .store(maximize_on_reveal, Ordering::Release);
        self.fullscreen_on_reveal
            .store(fullscreen_on_reveal, Ordering::Release);
        self.revealed.store(false, Ordering::Release);
        self.presenting.store(false, Ordering::Release);
        self.restore_bounds_generation
            .fetch_add(1, Ordering::AcqRel);
        *self
            .restore_bounds
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        *self
            .pending_restore_bounds
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }

    fn set_restore_bounds(&self, bounds: PhysicalWindowRect) {
        *self
            .restore_bounds
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(bounds);
    }

    fn restore_bounds(&self) -> Option<PhysicalWindowRect> {
        let pending = *self
            .pending_restore_bounds
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        pending.or_else(|| {
            *self
                .restore_bounds
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
        })
    }

    fn set_pending_restore_bounds(&self, bounds: PhysicalWindowRect) {
        *self
            .pending_restore_bounds
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(bounds);
    }

    fn commit_restore_bounds(&self, bounds: PhysicalWindowRect) {
        *self
            .restore_bounds
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(bounds);
        let mut pending = self
            .pending_restore_bounds
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *pending == Some(bounds) {
            *pending = None;
        }
    }
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PhysicalWindowRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, Debug)]
struct RectEdges {
    left: i64,
    top: i64,
    right: i64,
    bottom: i64,
}

#[cfg(target_os = "windows")]
impl RectEdges {
    fn from_rect(rect: PhysicalWindowRect) -> Self {
        let left = i64::from(rect.x);
        let top = i64::from(rect.y);
        Self {
            left,
            top,
            right: left + i64::from(rect.width),
            bottom: top + i64::from(rect.height),
        }
    }
}

#[cfg(target_os = "windows")]
fn main_window_restore_flags() -> StateFlags {
    // Initial Moved/Resized events can replace the plugin's geometry cache even
    // when skip_initial_state is enabled. Restore geometry from disk instead.
    StateFlags::DECORATIONS
}

#[cfg(target_os = "windows")]
fn persisted_restore_bounds(persisted: PersistedWindowPresentation) -> Option<PhysicalWindowRect> {
    if persisted.width == 0 || persisted.height == 0 {
        return None;
    }
    Some(PhysicalWindowRect {
        x: if persisted.maximized {
            persisted.prev_x
        } else {
            persisted.x
        },
        y: if persisted.maximized {
            persisted.prev_y
        } else {
            persisted.y
        },
        width: persisted.width,
        height: persisted.height,
    })
}

#[cfg(target_os = "windows")]
fn fits_available_work_areas(
    bounds: PhysicalWindowRect,
    work_areas: &[PhysicalWindowRect],
) -> bool {
    let mut uncovered = vec![RectEdges::from_rect(bounds)];
    for work_area in work_areas.iter().copied().map(RectEdges::from_rect) {
        let mut next = Vec::new();
        for rect in uncovered {
            let left = rect.left.max(work_area.left);
            let top = rect.top.max(work_area.top);
            let right = rect.right.min(work_area.right);
            let bottom = rect.bottom.min(work_area.bottom);
            if left >= right || top >= bottom {
                next.push(rect);
                continue;
            }
            // Subtract this monitor's work area. This also preserves windows
            // spanning adjacent monitors without accepting gaps between them.
            for part in [
                RectEdges {
                    bottom: top,
                    ..rect
                },
                RectEdges {
                    top: bottom,
                    ..rect
                },
                RectEdges {
                    top,
                    bottom,
                    right: left,
                    ..rect
                },
                RectEdges {
                    top,
                    bottom,
                    left: right,
                    ..rect
                },
            ] {
                if part.left < part.right && part.top < part.bottom {
                    next.push(part);
                }
            }
        }
        uncovered = next;
        if uncovered.is_empty() {
            return true;
        }
    }
    false
}

#[cfg(target_os = "windows")]
fn visible_restore_bounds(
    bounds: PhysicalWindowRect,
    work_areas: &[PhysicalWindowRect],
) -> PhysicalWindowRect {
    let work_areas: Vec<_> = work_areas
        .iter()
        .copied()
        .filter(|area| area.width > 0 && area.height > 0)
        .collect();
    if work_areas.is_empty() || fits_available_work_areas(bounds, &work_areas) {
        return bounds;
    }
    let rect = RectEdges::from_rect(bounds);
    let target = work_areas
        .into_iter()
        .max_by_key(|area| {
            let area = RectEdges::from_rect(*area);
            let overlap =
                i128::from((rect.right.min(area.right) - rect.left.max(area.left)).max(0))
                    * i128::from((rect.bottom.min(area.bottom) - rect.top.max(area.top)).max(0));
            let dx = i128::from(rect.left + rect.right - area.left - area.right);
            let dy = i128::from(rect.top + rect.bottom - area.top - area.bottom);
            (overlap, -(dx * dx + dy * dy))
        })
        .expect("nonempty work areas");
    let width = bounds.width.min(target.width);
    let height = bounds.height.min(target.height);
    PhysicalWindowRect {
        x: bounds.x.clamp(
            target.x,
            target
                .x
                .saturating_add(i32::try_from(target.width - width).unwrap_or(i32::MAX)),
        ),
        y: bounds.y.clamp(
            target.y,
            target
                .y
                .saturating_add(i32::try_from(target.height - height).unwrap_or(i32::MAX)),
        ),
        width,
        height,
    }
}

#[cfg(target_os = "windows")]
fn constrain_main_window_restore_bounds(window: &tauri::WebviewWindow) -> Result<(), String> {
    let position = window.outer_position().map_err(|err| err.to_string())?;
    let size = window.outer_size().map_err(|err| err.to_string())?;
    let client_size = window.inner_size().map_err(|err| err.to_string())?;
    let bounds = PhysicalWindowRect {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    let work_areas: Vec<_> = window
        .available_monitors()
        .map_err(|err| err.to_string())?
        .iter()
        .map(|monitor| {
            let area = monitor.work_area();
            PhysicalWindowRect {
                x: area.position.x,
                y: area.position.y,
                width: area.size.width,
                height: area.size.height,
            }
        })
        .collect();
    let visible = visible_restore_bounds(bounds, &work_areas);
    if visible != bounds {
        info!(
            "Moving out-of-bounds main window into the available work area: {bounds:?} -> {visible:?}"
        );
        let frame_width = size.width.saturating_sub(client_size.width);
        let frame_height = size.height.saturating_sub(client_size.height);
        window
            .set_size(PhysicalSize::new(
                visible.width.saturating_sub(frame_width).max(1),
                visible.height.saturating_sub(frame_height).max(1),
            ))
            .map_err(|err| err.to_string())?;
        window
            .set_position(PhysicalPosition::new(visible.x, visible.y))
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn parse_persisted_window_presentation(
    json: &str,
    label: &str,
) -> Result<PersistedWindowPresentation, serde_json::Error> {
    let states: HashMap<String, PersistedWindowPresentation> = serde_json::from_str(json)?;
    Ok(states.get(label).copied().unwrap_or_default())
}

#[cfg(target_os = "windows")]
fn load_persisted_window_presentation(app: &AppHandle, label: &str) -> PersistedWindowPresentation {
    let Ok(config_dir) = app.path().app_config_dir() else {
        return PersistedWindowPresentation::default();
    };
    let path = config_dir.join(app.filename());
    let json = match fs::read_to_string(&path) {
        Ok(json) => json,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return PersistedWindowPresentation::default();
        }
        Err(err) => {
            warn!("Failed to read persisted window state from {path:?}: {err}");
            return PersistedWindowPresentation::default();
        }
    };
    match parse_persisted_window_presentation(&json, label) {
        Ok(presentation) => presentation,
        Err(err) => {
            warn!("Failed to parse persisted window state from {path:?}: {err}");
            PersistedWindowPresentation::default()
        }
    }
}

#[cfg(target_os = "windows")]
fn normalize_persisted_main_window_state(
    json: &str,
    restore_bounds: PhysicalWindowRect,
    presentation_override: Option<(bool, bool)>,
) -> Result<Option<Vec<u8>>, serde_json::Error> {
    let mut states: serde_json::Value = serde_json::from_str(json)?;
    let Some(main) = states
        .get_mut("main")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return Ok(None);
    };

    if let Some((maximized, fullscreen)) = presentation_override {
        main.insert("maximized".into(), maximized.into());
        main.insert("fullscreen".into(), fullscreen.into());
    }
    let maximized = main
        .get("maximized")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let fullscreen = main
        .get("fullscreen")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if !maximized && !fullscreen {
        return Ok(None);
    }

    for (key, value) in [
        ("width", u64::from(restore_bounds.width)),
        ("height", u64::from(restore_bounds.height)),
    ] {
        main.insert(key.into(), value.into());
    }
    for (key, value) in [
        ("x", i64::from(restore_bounds.x)),
        ("y", i64::from(restore_bounds.y)),
        ("prev_x", i64::from(restore_bounds.x)),
        ("prev_y", i64::from(restore_bounds.y)),
    ] {
        main.insert(key.into(), value.into());
    }

    serde_json::to_vec_pretty(&states).map(Some)
}

#[cfg(target_os = "windows")]
fn rewrite_persisted_main_window_state(
    app: &AppHandle,
    presentation_override: Option<(bool, bool)>,
) {
    let presentation = app.state::<MainWindowPresentationState>();
    let Some(restore_bounds) = presentation.restore_bounds() else {
        warn!("Skipping main window state normalization without stable restore bounds");
        return;
    };
    let Ok(config_dir) = app.path().app_config_dir() else {
        warn!("Failed to resolve app config directory while normalizing main window state");
        return;
    };
    let path = config_dir.join(app.filename());
    let json = match fs::read_to_string(&path) {
        Ok(json) => json,
        Err(err) => {
            warn!("Failed to read persisted window state from {path:?}: {err}");
            return;
        }
    };
    let normalized =
        match normalize_persisted_main_window_state(&json, restore_bounds, presentation_override) {
            Ok(Some(normalized)) => normalized,
            Ok(None) => return,
            Err(err) => {
                warn!("Failed to normalize persisted main window state from {path:?}: {err}");
                return;
            }
        };
    if normalized == json.as_bytes() {
        return;
    }
    if let Err(err) = fs::write(&path, normalized) {
        warn!("Failed to write normalized main window state to {path:?}: {err}");
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn sanitize_persisted_main_window_state(app: &AppHandle) {
    rewrite_persisted_main_window_state(app, None);
}

#[cfg(target_os = "windows")]
fn is_probable_presentation_transition_bounds(
    bounds: PhysicalWindowRect,
    work_area: PhysicalWindowRect,
    monitor: PhysicalWindowRect,
) -> bool {
    let x_offset = i64::from(bounds.x) - i64::from(work_area.x);
    let y_offset = i64::from(bounds.y) - i64::from(work_area.y);
    let at_maximized_shadow_edge = (-CLEARLY_OFFSCREEN_DISTANCE..0).contains(&x_offset)
        || (-CLEARLY_OFFSCREEN_DISTANCE..0).contains(&y_offset);
    let transition_tolerance = u32::try_from(CLEARLY_OFFSCREEN_DISTANCE).unwrap_or(u32::MAX);
    let fills_work_area = bounds.width.abs_diff(work_area.width) < transition_tolerance
        && bounds.height.abs_diff(work_area.height) < transition_tolerance;
    let fills_monitor = bounds.width.abs_diff(monitor.width) < transition_tolerance
        && bounds.height.abs_diff(monitor.height) < transition_tolerance;
    at_maximized_shadow_edge || fills_work_area || fills_monitor
}

#[cfg(target_os = "windows")]
fn current_normal_restore_bounds(window: &tauri::WebviewWindow) -> Option<PhysicalWindowRect> {
    if window.is_maximized().unwrap_or(true)
        || window.is_fullscreen().unwrap_or(true)
        || window.is_minimized().unwrap_or(true)
    {
        return None;
    }
    let (Ok(position), Ok(size), Ok(Some(monitor))) = (
        window.outer_position(),
        window.inner_size(),
        window.current_monitor(),
    ) else {
        return None;
    };
    if size.width == 0 || size.height == 0 {
        return None;
    }

    let monitor_rect = PhysicalWindowRect {
        x: monitor.position().x,
        y: monitor.position().y,
        width: monitor.size().width,
        height: monitor.size().height,
    };
    let work_area = monitor.work_area();
    let bounds = PhysicalWindowRect {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    let work_area = PhysicalWindowRect {
        x: work_area.position.x,
        y: work_area.position.y,
        width: work_area.size.width,
        height: work_area.size.height,
    };
    // WM_WINDOWPOSCHANGED may arrive before Tao updates is_maximized().
    // Reject the maximized shadow edge/full-work-area geometry during that gap.
    if is_probable_presentation_transition_bounds(bounds, work_area, monitor_rect) {
        return None;
    }

    Some(bounds)
}

#[cfg(target_os = "windows")]
pub(crate) fn track_main_window_restore_bounds(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "main"
        || !matches!(
            event,
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
        )
    {
        return;
    }

    let app = window.app_handle().clone();
    let presentation = app.state::<MainWindowPresentationState>();
    if !presentation.presenting.load(Ordering::Acquire)
        && let Some(window) = app.get_webview_window("main")
        && let Some(bounds) = current_normal_restore_bounds(&window)
    {
        // Preserve the latest valid candidate immediately. A maximize event can
        // cancel the delayed stable sample less than one frame later.
        presentation.set_pending_restore_bounds(bounds);
    }
    let generation = presentation
        .restore_bounds_generation
        .fetch_add(1, Ordering::AcqRel)
        + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(RESTORE_BOUNDS_SETTLE_DELAY).await;
        let presentation = app.state::<MainWindowPresentationState>();
        if presentation.presenting.load(Ordering::Acquire)
            || presentation
                .restore_bounds_generation
                .load(Ordering::Acquire)
                != generation
        {
            return;
        }
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        if let Some(bounds) = current_normal_restore_bounds(&window) {
            presentation.commit_restore_bounds(bounds);
        }
    });
}

#[cfg(target_os = "windows")]
fn set_dwm_cloaked(hwnd: HWND, cloaked: bool) -> windows::core::Result<()> {
    let value = BOOL::from(cloaked);
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_CLOAK,
            std::ptr::from_ref(&value).cast(),
            std::mem::size_of_val(&value) as u32,
        )
    }
}

#[cfg(target_os = "windows")]
fn redraw_main_window_surface(hwnd: HWND) {
    let redrawn =
        unsafe { RedrawWindow(Some(hwnd), None, None, RDW_INTERNALPAINT | RDW_UPDATENOW) };
    if !redrawn.as_bool() {
        warn!("Failed to synchronously redraw the main-window surface");
    }
}

#[cfg(target_os = "windows")]
fn run_window_state_task_on_main_thread(
    app: &AppHandle,
    task: impl FnOnce() -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let (result_tx, result_rx) = mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        if result_tx.send(task()).is_err() {
            warn!("Main-window presentation stopped before a window-state task completed");
        }
    })
    .map_err(|err| err.to_string())?;
    result_rx.recv().map_err(|err| err.to_string())?
}

#[cfg(target_os = "windows")]
fn uncloak_dwm_with_retry(hwnd: HWND) -> windows::core::Result<()> {
    let mut last_error = None;
    for delay_ms in DWM_UNCLOAK_RETRY_DELAYS_MS {
        if delay_ms > 0 {
            std::thread::sleep(Duration::from_millis(delay_ms));
        }
        match set_dwm_cloaked(hwnd, false) {
            Ok(()) => return Ok(()),
            Err(err) => {
                last_error = Some(err);
                let _ = unsafe { DwmFlush() };
            }
        }
    }
    Err(last_error.expect("uncloak retry loop must run at least once"))
}

#[cfg(target_os = "windows")]
struct DwmCloakGuard {
    hwnd: HWND,
    active: bool,
}

#[cfg(target_os = "windows")]
impl DwmCloakGuard {
    fn new(hwnd: HWND) -> Self {
        Self { hwnd, active: true }
    }

    fn release(&mut self) -> windows::core::Result<()> {
        uncloak_dwm_with_retry(self.hwnd)?;
        self.active = false;
        Ok(())
    }
}

#[cfg(target_os = "windows")]
impl Drop for DwmCloakGuard {
    fn drop(&mut self) {
        if self.active
            && let Err(err) = uncloak_dwm_with_retry(self.hwnd)
        {
            error!("Failed to release emergency DWM cloak guard: {err}");
        }
    }
}

#[cfg(target_os = "windows")]
fn virtual_desktop_bounds(monitors: &[PhysicalWindowRect]) -> Option<RectEdges> {
    let mut monitors = monitors.iter().copied();
    let mut bounds = RectEdges::from_rect(monitors.next()?);
    for monitor in monitors {
        let monitor = RectEdges::from_rect(monitor);
        bounds.left = bounds.left.min(monitor.left);
        bounds.top = bounds.top.min(monitor.top);
        bounds.right = bounds.right.max(monitor.right);
        bounds.bottom = bounds.bottom.max(monitor.bottom);
    }
    Some(bounds)
}

#[cfg(target_os = "windows")]
fn should_recover_legacy_maximized_state(
    is_maximized: bool,
    window: PhysicalWindowRect,
    current_monitor: PhysicalWindowRect,
    available_monitors: &[PhysicalWindowRect],
) -> bool {
    if is_maximized
        || available_monitors.is_empty()
        || window.width.abs_diff(current_monitor.width) > LEGACY_MAXIMIZED_SIZE_TOLERANCE
        || window.height.abs_diff(current_monitor.height) > LEGACY_MAXIMIZED_SIZE_TOLERANCE
    {
        return false;
    }

    let Some(virtual_desktop) = virtual_desktop_bounds(available_monitors) else {
        return false;
    };
    let window = RectEdges::from_rect(window);
    let tolerated_overflow = CLEARLY_OFFSCREEN_DISTANCE - 1;

    window.left < virtual_desktop.left - tolerated_overflow
        || window.top < virtual_desktop.top - tolerated_overflow
        || window.right > virtual_desktop.right + tolerated_overflow
        || window.bottom > virtual_desktop.bottom + tolerated_overflow
}

#[cfg(target_os = "windows")]
fn centered_restore_rect(monitor: PhysicalWindowRect, scale_factor: f64) -> PhysicalWindowRect {
    let scale_factor = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    let desired_width = (DEFAULT_RESTORE_LOGICAL_WIDTH * scale_factor)
        .round()
        .clamp(1.0, f64::from(u32::MAX)) as u32;
    let desired_height = (DEFAULT_RESTORE_LOGICAL_HEIGHT * scale_factor)
        .round()
        .clamp(1.0, f64::from(u32::MAX)) as u32;
    let width = desired_width.min(monitor.width);
    let height = desired_height.min(monitor.height);
    let x_offset = i32::try_from((monitor.width - width) / 2).unwrap_or(i32::MAX);
    let y_offset = i32::try_from((monitor.height - height) / 2).unwrap_or(i32::MAX);

    PhysicalWindowRect {
        x: monitor.x.saturating_add(x_offset),
        y: monitor.y.saturating_add(y_offset),
        width,
        height,
    }
}

#[cfg(target_os = "windows")]
fn centered_rect_with_size(
    monitor: PhysicalWindowRect,
    width: u32,
    height: u32,
) -> PhysicalWindowRect {
    let width = width.clamp(1, monitor.width);
    let height = height.clamp(1, monitor.height);
    let x_offset = i32::try_from((monitor.width - width) / 2).unwrap_or(i32::MAX);
    let y_offset = i32::try_from((monitor.height - height) / 2).unwrap_or(i32::MAX);
    PhysicalWindowRect {
        x: monitor.x.saturating_add(x_offset),
        y: monitor.y.saturating_add(y_offset),
        width,
        height,
    }
}

#[cfg(target_os = "windows")]
fn is_collapsed_maximized_restore_origin(
    persisted: PersistedWindowPresentation,
    work_area: PhysicalWindowRect,
) -> bool {
    if !persisted.maximized {
        return false;
    }
    let same_origin = persisted.x == persisted.prev_x && persisted.y == persisted.prev_y;
    let x_offset = i64::from(persisted.prev_x) - i64::from(work_area.x);
    let y_offset = i64::from(persisted.prev_y) - i64::from(work_area.y);
    let prev_is_maximized_shadow_edge = (-CLEARLY_OFFSCREEN_DISTANCE..0).contains(&x_offset)
        || (-CLEARLY_OFFSCREEN_DISTANCE..0).contains(&y_offset);
    let work_area = RectEdges::from_rect(work_area);
    let persisted_x = i64::from(persisted.x);
    let persisted_y = i64::from(persisted.y);
    let current_origin_is_normal = persisted_x >= work_area.left
        && persisted_x < work_area.right
        && persisted_y >= work_area.top
        && persisted_y < work_area.bottom;
    prev_is_maximized_shadow_edge
        && (same_origin || persisted.fullscreen || current_origin_is_normal)
}

#[cfg(target_os = "windows")]
fn repair_collapsed_maximized_restore_bounds<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    label: &str,
    persisted: PersistedWindowPresentation,
) -> bool {
    if label != "main" {
        return false;
    }
    let (Ok(window_size), Ok(Some(current_monitor))) =
        (window.inner_size(), window.current_monitor())
    else {
        return false;
    };
    let work_area = current_monitor.work_area();
    let work_area_rect = PhysicalWindowRect {
        x: work_area.position.x,
        y: work_area.position.y,
        width: work_area.size.width,
        height: work_area.size.height,
    };
    if !is_collapsed_maximized_restore_origin(persisted, work_area_rect) {
        return false;
    }
    let repaired = centered_rect_with_size(work_area_rect, window_size.width, window_size.height);
    info!(
        "Repairing collapsed maximized restore bounds for {label}: ({}, {}) -> {:?}",
        persisted.prev_x, persisted.prev_y, repaired
    );
    if let Err(err) = window.set_size(PhysicalSize::new(repaired.width, repaired.height)) {
        warn!("Failed to repair collapsed window size for {label}: {err}");
        return false;
    }
    if let Err(err) = window.set_position(PhysicalPosition::new(repaired.x, repaired.y)) {
        warn!("Failed to repair collapsed window position for {label}: {err}");
        return false;
    }
    true
}

#[cfg(target_os = "windows")]
fn recover_legacy_maximized_state<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    label: &str,
) -> bool {
    if label != "main" {
        return false;
    }

    let Ok(is_maximized) = window.is_maximized() else {
        return false;
    };
    let Ok(is_fullscreen) = window.is_fullscreen() else {
        return false;
    };
    if is_fullscreen {
        return false;
    }
    let (Ok(window_position), Ok(window_size), Ok(Some(current_monitor)), Ok(monitors)) = (
        window.outer_position(),
        window.inner_size(),
        window.current_monitor(),
        window.available_monitors(),
    ) else {
        return false;
    };

    let window_rect = PhysicalWindowRect {
        x: window_position.x,
        y: window_position.y,
        width: window_size.width,
        height: window_size.height,
    };
    let current_monitor_rect = PhysicalWindowRect {
        x: current_monitor.position().x,
        y: current_monitor.position().y,
        width: current_monitor.size().width,
        height: current_monitor.size().height,
    };
    let available_monitor_rects: Vec<_> = monitors
        .iter()
        .map(|monitor| PhysicalWindowRect {
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
        })
        .collect();
    let current_work_area = current_monitor.work_area();
    let current_work_area_rect = PhysicalWindowRect {
        x: current_work_area.position.x,
        y: current_work_area.position.y,
        width: current_work_area.size.width,
        height: current_work_area.size.height,
    };

    if !should_recover_legacy_maximized_state(
        is_maximized,
        window_rect,
        current_monitor_rect,
        &available_monitor_rects,
    ) {
        return false;
    }

    let restore_rect =
        centered_restore_rect(current_work_area_rect, current_monitor.scale_factor());
    info!(
        "Recovering legacy maximized window state for {}: {:?} -> {:?} on {:?}",
        label, window_rect, restore_rect, current_monitor_rect
    );

    if let Err(err) = window.set_size(PhysicalSize::new(restore_rect.width, restore_rect.height)) {
        warn!("Failed to restore normal window size for {label}: {err}");
        return false;
    }
    if let Err(err) = window.set_position(PhysicalPosition::new(restore_rect.x, restore_rect.y)) {
        warn!("Failed to restore normal window position for {label}: {err}");
        return false;
    }

    true
}

pub async fn create_common_win<'a>(
    app: &'a AppHandle,
    url: tauri::WebviewUrl,
    label: &str,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let win = WebviewWindowBuilder::new(app, label, url);
    #[cfg(target_os = "windows")]
    let win = win.transparent(true);
    #[cfg(not(desktop))]
    let win = win;

    #[cfg(desktop)]
    let win = win
        .center()
        .inner_size(800.0, 600.0)
        .effects(WindowEffectsConfig {
            effects: vec![Effect::Tabbed, Effect::Mica],
            ..Default::default()
        })
        .theme(None)
        .title({
            #[cfg(target_os = "macos")]
            {
                ""
            }
            #[cfg(not(target_os = "macos"))]
            {
                "AMLL Player"
            }
        })
        .visible({
            #[cfg(target_os = "macos")]
            {
                true
            }
            #[cfg(not(target_os = "macos"))]
            {
                false
            }
        })
        .decorations({
            #[cfg(target_os = "macos")]
            {
                true
            }
            #[cfg(not(target_os = "macos"))]
            {
                false
            }
        });

    #[cfg(target_os = "macos")]
    let win = win.title_bar_style(tauri::TitleBarStyle::Overlay);

    win
}

pub async fn recreate_window(app: &AppHandle, label: &str, path: Option<&str>) {
    info!("Recreating window: {}", label);
    if let Some(win) = app.get_webview_window(label) {
        #[cfg(desktop)]
        {
            let _ = win.show();
            let _ = win.set_focus();
        }
        #[cfg(not(desktop))]
        let _ = win;
        return;
    }
    #[cfg(debug_assertions)]
    let url = {
        tauri::WebviewUrl::External(
            app.config()
                .build
                .dev_url
                .clone()
                .unwrap()
                .join(path.unwrap_or(""))
                .expect("Failed to create external URL"),
        )
    };
    #[cfg(not(debug_assertions))]
    let url = tauri::WebviewUrl::App(path.unwrap_or("index.html").into());
    // Capture before build/on_window_ready can receive bootstrap geometry events.
    #[cfg(target_os = "windows")]
    let persisted_presentation = load_persisted_window_presentation(app, label);
    let win = create_common_win(app, url, label).await;

    let win = win.build().expect("can't show original window");

    #[cfg(desktop)]
    {
        #[cfg(target_os = "windows")]
        if label == "main" {
            let state_app = app.clone();
            let state_window = win.clone();
            if let Err(err) = run_window_state_task_on_main_thread(app, move || {
                state_window
                    .restore_state(main_window_restore_flags())
                    .map_err(|err| err.to_string())?;
                if let Some(bounds) = persisted_restore_bounds(persisted_presentation) {
                    state_window
                        .set_size(PhysicalSize::new(bounds.width, bounds.height))
                        .map_err(|err| err.to_string())?;
                    state_window
                        .set_position(PhysicalPosition::new(bounds.x, bounds.y))
                        .map_err(|err| err.to_string())?;
                }
                repair_collapsed_maximized_restore_bounds(
                    &state_window,
                    "main",
                    persisted_presentation,
                );
                let recovered_legacy_maximized_state =
                    recover_legacy_maximized_state(&state_window, "main");
                constrain_main_window_restore_bounds(&state_window)?;
                let presentation = state_app.state::<MainWindowPresentationState>();
                presentation.prepare(
                    persisted_presentation.maximized || recovered_legacy_maximized_state,
                    persisted_presentation.fullscreen,
                );
                let position = state_window
                    .outer_position()
                    .map_err(|err| err.to_string())?;
                let size = state_window.inner_size().map_err(|err| err.to_string())?;
                if size.width > 0 && size.height > 0 {
                    presentation.set_restore_bounds(PhysicalWindowRect {
                        x: position.x,
                        y: position.y,
                        width: size.width,
                        height: size.height,
                    });
                }
                Ok(())
            }) {
                warn!("Failed to restore hidden main window bounds from disk: {err}");
            }
        }

        // The Windows main window remains hidden until React has painted its
        // first frame. Focusing it here may implicitly expose the blank native
        // host, so the frontend shows and focuses it together when ready.
        #[cfg(target_os = "windows")]
        if label != "main" {
            let _ = win.set_focus();
        }
        #[cfg(not(target_os = "windows"))]
        let _ = win.set_focus();

        // The main WebView is calibrated after its final visible presentation.
        // Keep the historical hidden size refresh only for auxiliary windows.
        #[cfg(target_os = "windows")]
        let should_refresh_layout = label != "main" && matches!(win.is_maximized(), Ok(false));
        #[cfg(not(target_os = "windows"))]
        let should_refresh_layout = true;

        if should_refresh_layout {
            if let Ok(orig_size) = win.inner_size() {
                let _ = win.set_size(Size::Physical(PhysicalSize::new(0, 0)));
                let _ = win.set_size(orig_size);
            }
        }
    }
    #[cfg(not(desktop))]
    let _ = win;

    info!("Created window: {}", label);
}

#[tauri::command]
pub async fn open_screenshot_window(app: AppHandle) {
    recreate_window(&app, "screenshot", Some("screenshot.html")).await;
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn set_window_always_on_top(enabled: bool, app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.set_always_on_top(enabled).map_err(|e| e.to_string())
    } else {
        Err("Main window not found.".to_string())
    }
}

#[cfg(target_os = "windows")]
#[tauri::command(async)]
pub fn present_main_window(app: AppHandle) -> Result<(), String> {
    let presentation = app.state::<MainWindowPresentationState>();
    if presentation.revealed.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    presentation.presenting.store(true, Ordering::Release);

    let result = (|| {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "Main window not found.".to_string())?;
        let should_maximize = presentation.maximize_on_reveal.load(Ordering::Acquire);
        let should_fullscreen = presentation.fullscreen_on_reveal.load(Ordering::Acquire);

        // Refresh the cached normal bounds immediately before the native
        // presentation, then normalize the disk fallback independently of
        // the plugin's maximized Moved events.
        let state_app = app.clone();
        if let Err(err) = run_window_state_task_on_main_thread(&app, move || {
            state_app
                .save_window_state(StateFlags::SIZE | StateFlags::POSITION)
                .map_err(|err| err.to_string())
        }) {
            warn!("Failed to refresh normal bounds before presenting main window: {err}");
        }
        rewrite_persisted_main_window_state(&app, Some((should_maximize, should_fullscreen)));

        let raw_hwnd = window.hwnd().map_err(|err| err.to_string())?;
        let hwnd = HWND(raw_hwnd.0);
        let mut cloak_guard = match set_dwm_cloaked(hwnd, true) {
            Ok(()) => Some(DwmCloakGuard::new(hwnd)),
            Err(err) => {
                warn!("Failed to cloak main window during atomic presentation: {err}");
                None
            }
        };

        let configure_result: Result<(), String> = (|| {
            // Synchronize Tao's VISIBLE flag while DWM still withholds the
            // window. If cloaking was unavailable, this is the visible fallback.
            window.show().map_err(|err| err.to_string())?;
            if should_maximize {
                let state_window = window.clone();
                if let Err(err) = run_window_state_task_on_main_thread(&app, move || {
                    state_window
                        .restore_state(StateFlags::MAXIMIZED)
                        .map_err(|err| err.to_string())
                }) {
                    warn!("Failed to restore guarded maximized state: {err}");
                }
                if !window.is_maximized().map_err(|err| err.to_string())? {
                    warn!("Window-state cache did not contain maximized state; using raw fallback");
                    unsafe {
                        let _ = ShowWindow(hwnd, SW_SHOWMAXIMIZED);
                    }
                }
            }
            if should_fullscreen {
                // Reuse the plugin's restoring lock so its fullscreen move
                // cannot overwrite the normal prev_x/prev_y captured above.
                let state_window = window.clone();
                run_window_state_task_on_main_thread(&app, move || {
                    state_window
                        .restore_state(StateFlags::FULLSCREEN)
                        .map_err(|err| err.to_string())
                })?;
                if !window.is_fullscreen().map_err(|err| err.to_string())? {
                    warn!(
                        "Window-state cache did not contain fullscreen state; using direct fallback"
                    );
                    window.set_fullscreen(true).map_err(|err| err.to_string())?;
                }
            }

            let client_size = window.inner_size().map_err(|err| err.to_string())?;
            window
                .as_ref()
                .set_bounds(Rect {
                    position: Position::Physical(PhysicalPosition::new(0, 0)),
                    size: Size::Physical(client_size),
                })
                .map_err(|err| err.to_string())?;

            // This command runs outside Tao's UI callback. Reading the bounds
            // after setting them is a dispatcher barrier: the UI thread has
            // applied the final WebView size before RedrawWindow asks Tao to
            // rebuild its transparent softbuffer at that same client size.
            window.as_ref().bounds().map_err(|err| err.to_string())?;
            Ok(())
        })();

        if configure_result.is_ok() {
            // Force Tao's transparent host surface to resize and present while
            // DWM still cloaks the window. INTERNALPAINT does not explicitly
            // invalidate the frameless edge or erase the WebView children.
            redraw_main_window_surface(hwnd);
        }
        let uncloak_result = if let Some(guard) = cloak_guard.as_mut() {
            // Let WebView2 submit the final hidden surface before DWM exposes it.
            let _ = unsafe { DwmFlush() };
            let result = guard
                .release()
                .or_else(|first_err| {
                    warn!("First DWM uncloak retry cycle failed: {first_err}");
                    guard.release()
                })
                .map_err(|err| err.to_string());
            if result.is_ok() {
                let _ = unsafe { DwmFlush() };
            }
            result
        } else {
            Ok(())
        };
        configure_result?;
        uncloak_result?;
        window.set_focus().map_err(|err| err.to_string())
    })();

    presentation.presenting.store(false, Ordering::Release);
    if result.is_err() {
        presentation.revealed.store(false, Ordering::Release);
    }
    crate::window_activity::refresh_main_window_activity(&app);
    reconcile_background_restore_entry(&app);
    result
}

#[cfg(target_os = "windows")]
fn background_tray_menu_state() -> &'static Mutex<BackgroundTrayMenuState> {
    BACKGROUND_TRAY_MENU_STATE.get_or_init(|| Mutex::new(BackgroundTrayMenuState::default()))
}

#[cfg(target_os = "windows")]
fn current_background_tray_menu_state() -> BackgroundTrayMenuState {
    background_tray_menu_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

#[cfg(target_os = "windows")]
fn emit_background_tray_player_state(app: &AppHandle) -> Result<(), String> {
    if app
        .get_webview_window(BACKGROUND_TRAY_PLAYER_LABEL)
        .is_none()
    {
        return Ok(());
    }
    app.emit_to(
        BACKGROUND_TRAY_PLAYER_LABEL,
        BACKGROUND_TRAY_STATE_EVENT,
        current_background_tray_menu_state(),
    )
    .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn disable_background_tray_native_menu(app: &AppHandle) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(BACKGROUND_TRAY_ID) else {
        return Ok(());
    };
    tray.with_inner_tray_icon(|inner| {
        inner.set_show_menu_on_right_click(false);
    })
    .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn background_tray_player_visibility_state() -> &'static Mutex<BackgroundTrayPlayerVisibilityState>
{
    BACKGROUND_TRAY_PLAYER_VISIBILITY_STATE
        .get_or_init(|| Mutex::new(BackgroundTrayPlayerVisibilityState::default()))
}

#[cfg(target_os = "windows")]
fn current_background_tray_player_visibility_state() -> BackgroundTrayPlayerVisibilityState {
    *background_tray_player_visibility_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(target_os = "windows")]
fn set_background_tray_player_visibility(
    desired_visible: bool,
    anchor_rect: Option<PhysicalWindowRect>,
) {
    let mut state = background_tray_player_visibility_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.set_visibility(desired_visible, anchor_rect);
}

#[cfg(target_os = "windows")]
fn toggle_background_tray_player_visibility(
    anchor_rect: PhysicalWindowRect,
) -> BackgroundTrayPlayerVisibilityState {
    let mut state = background_tray_player_visibility_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.toggle(anchor_rect);
    *state
}

#[cfg(target_os = "windows")]
fn set_background_tray_player_native_visibility(
    window: &tauri::WebviewWindow,
    visible: bool,
) -> Result<(), String> {
    let raw_hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let popup_hwnd = raw_hwnd.0 as isize;
    let (result_tx, result_rx) = mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let popup_hwnd = HWND(popup_hwnd as _);
            unsafe {
                let _ = ShowWindow(
                    popup_hwnd,
                    if visible { SW_SHOWNOACTIVATE } else { SW_HIDE },
                );
            }
            let actual_visible = unsafe { IsWindowVisible(popup_hwnd).as_bool() };
            let _ = result_tx.send(actual_visible == visible);
        })
        .map_err(|error| error.to_string())?;
    if result_rx
        .recv_timeout(Duration::from_secs(1))
        .map_err(|error| format!("Timed out while changing tray-player visibility: {error}"))?
    {
        Ok(())
    } else {
        Err(format!(
            "The tray-player window did not become {}.",
            if visible { "visible" } else { "hidden" }
        ))
    }
}

#[cfg(target_os = "windows")]
fn hide_background_tray_player_window(app: &AppHandle) {
    tray_player_watcher::deactivate();
    if let Some(window) = app.get_webview_window(BACKGROUND_TRAY_PLAYER_LABEL)
        && let Err(error) = set_background_tray_player_native_visibility(&window, false)
    {
        warn!("Failed to hide the tray player: {error}");
    }
}

#[cfg(target_os = "windows")]
fn hide_background_tray_player(app: &AppHandle) {
    set_background_tray_player_visibility(false, None);
    reconcile_background_tray_player_visibility(app);
}

#[cfg(target_os = "windows")]
pub(crate) fn hide_background_tray_player_if_generation(app: &AppHandle, generation: u64) {
    let should_hide = {
        let mut state = background_tray_player_visibility_state()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !state.desired_visible || state.generation != generation {
            false
        } else {
            state.set_visibility(false, None);
            true
        }
    };
    if should_hide {
        reconcile_background_tray_player_visibility(app);
    }
}

#[cfg(target_os = "windows")]
fn tray_player_position(
    icon_rect: PhysicalWindowRect,
    popup_width: u32,
    popup_height: u32,
    work_area: PhysicalWindowRect,
    monitor_rect: PhysicalWindowRect,
    margin: i32,
) -> PhysicalPosition<i32> {
    let work_area = RectEdges::from_rect(work_area);
    let monitor_rect = RectEdges::from_rect(monitor_rect);
    let icon_rect = RectEdges::from_rect(icon_rect);
    let icon_center_x = icon_rect.left + (icon_rect.right - icon_rect.left) / 2;
    let icon_center_y = icon_rect.top + (icon_rect.bottom - icon_rect.top) / 2;
    let popup_width = i64::from(popup_width);
    let popup_height = i64::from(popup_height);
    let margin = i64::from(margin.max(0));

    let distances = [
        (icon_center_y - monitor_rect.top).abs(),
        (monitor_rect.bottom - icon_center_y).abs(),
        (icon_center_x - monitor_rect.left).abs(),
        (monitor_rect.right - icon_center_x).abs(),
    ];
    let nearest_edge = distances
        .iter()
        .enumerate()
        .min_by_key(|(_, distance)| **distance)
        .map(|(index, _)| index)
        .unwrap_or(1);

    let (mut x, mut y) = match nearest_edge {
        // Top taskbar.
        0 => (icon_center_x - popup_width / 2, icon_rect.bottom + margin),
        // Bottom taskbar.
        1 => (
            icon_center_x - popup_width / 2,
            icon_rect.top - popup_height - margin,
        ),
        // Left taskbar.
        2 => (icon_rect.right + margin, icon_center_y - popup_height / 2),
        // Right taskbar.
        _ => (
            icon_rect.left - popup_width - margin,
            icon_center_y - popup_height / 2,
        ),
    };

    let max_x = work_area.right - popup_width;
    let max_y = work_area.bottom - popup_height;
    x = if max_x >= work_area.left {
        x.clamp(work_area.left, max_x)
    } else {
        work_area.left
    };
    y = if max_y >= work_area.top {
        y.clamp(work_area.top, max_y)
    } else {
        work_area.top
    };

    PhysicalPosition::new(
        x.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        y.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
    )
}

#[cfg(target_os = "windows")]
fn physical_tray_icon_rect(rect: Rect) -> Option<PhysicalWindowRect> {
    match (rect.position, rect.size) {
        (Position::Physical(position), Size::Physical(size)) => Some(PhysicalWindowRect {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        }),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
fn tray_player_physical_dimension(logical: f64, scale_factor: f64) -> u32 {
    (logical * scale_factor)
        .round()
        .clamp(1.0, f64::from(u32::MAX)) as u32
}

#[cfg(target_os = "windows")]
fn position_background_tray_player(
    app: &AppHandle,
    icon_rect: PhysicalWindowRect,
) -> Result<(), String> {
    let window = app
        .get_webview_window(BACKGROUND_TRAY_PLAYER_LABEL)
        .ok_or_else(|| "Tray player window not found.".to_string())?;
    let icon_center_x = f64::from(icon_rect.x) + f64::from(icon_rect.width) / 2.0;
    let icon_center_y = f64::from(icon_rect.y) + f64::from(icon_rect.height) / 2.0;
    let monitor = window
        .monitor_from_point(icon_center_x, icon_center_y)
        .map_err(|error| error.to_string())?
        .or_else(|| window.current_monitor().ok().flatten())
        .ok_or_else(|| "No monitor is available for the tray player.".to_string())?;
    let work_area = monitor.work_area();
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let scale_factor = monitor.scale_factor();
    let popup_width = tray_player_physical_dimension(BACKGROUND_TRAY_PLAYER_WIDTH, scale_factor);
    let popup_height = tray_player_physical_dimension(BACKGROUND_TRAY_PLAYER_HEIGHT, scale_factor);
    let margin = (f64::from(BACKGROUND_TRAY_PLAYER_MARGIN) * scale_factor).round() as i32;
    let position = tray_player_position(
        icon_rect,
        popup_width,
        popup_height,
        PhysicalWindowRect {
            x: work_area.position.x,
            y: work_area.position.y,
            width: work_area.size.width,
            height: work_area.size.height,
        },
        PhysicalWindowRect {
            x: monitor_position.x,
            y: monitor_position.y,
            width: monitor_size.width,
            height: monitor_size.height,
        },
        margin,
    );
    window
        .set_position(position)
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn background_tray_player_generation_is_current(generation: u64) -> bool {
    current_background_tray_player_visibility_state().generation == generation
}

#[cfg(target_os = "windows")]
pub(crate) fn background_tray_player_activation_is_current(
    app: &AppHandle,
    generation: u64,
) -> bool {
    let state = current_background_tray_player_visibility_state();
    state.desired_visible
        && state.generation == generation
        && background_tray_is_required(app)
        && app
            .get_webview_window(BACKGROUND_TRAY_PLAYER_LABEL)
            .is_some()
}

#[cfg(target_os = "windows")]
fn harden_background_tray_player_noactivate(
    window: &tauri::WebviewWindow,
    popup_hwnd: HWND,
) -> Result<(), String> {
    let (result_tx, result_rx) = mpsc::sync_channel(1);
    let popup_hwnd = popup_hwnd.0 as isize;
    window
        .run_on_main_thread(move || {
            let _ = result_tx.send(tray_player_watcher::harden_webview_noactivate(HWND(
                popup_hwnd as _,
            )));
        })
        .map_err(|error| error.to_string())?;
    result_rx
        .recv_timeout(Duration::from_secs(1))
        .map_err(|error| format!("Timed out while hardening the tray-player WebView: {error}"))?
}

#[cfg(target_os = "windows")]
fn show_background_tray_player_noactivate(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    popup_hwnd: HWND,
    generation: u64,
) -> Result<bool, String> {
    let app = app.clone();
    let popup_hwnd = popup_hwnd.0 as isize;
    let (result_tx, result_rx) = mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let result = {
                let state = background_tray_player_visibility_state()
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if !state.desired_visible
                    || state.generation != generation
                    || !background_tray_is_required(&app)
                {
                    Ok(false)
                } else {
                    let popup_hwnd = HWND(popup_hwnd as _);
                    unsafe {
                        let _ = ShowWindow(popup_hwnd, SW_SHOWNOACTIVATE);
                    }
                    if unsafe { IsWindowVisible(popup_hwnd).as_bool() } {
                        Ok(true)
                    } else {
                        Err("The tray-player window did not become visible.".to_string())
                    }
                }
            };
            let _ = result_tx.send(result);
        })
        .map_err(|error| error.to_string())?;
    result_rx
        .recv_timeout(Duration::from_secs(1))
        .map_err(|error| format!("Timed out while showing the tray player: {error}"))?
}

#[cfg(target_os = "windows")]
fn apply_background_tray_player_visibility(
    app: &AppHandle,
    state: BackgroundTrayPlayerVisibilityState,
) -> Result<(), String> {
    if !background_tray_player_generation_is_current(state.generation) {
        return Ok(());
    }
    if !state.desired_visible || !background_tray_is_required(app) {
        hide_background_tray_player_window(app);
        return Ok(());
    }

    app.get_webview_window(BACKGROUND_TRAY_PLAYER_LABEL)
        .ok_or_else(|| "Tray player window not found.".to_string())?;
    emit_background_tray_player_state(app)?;
    if !background_tray_player_generation_is_current(state.generation) {
        return Ok(());
    }
    let icon_rect = state
        .anchor_rect
        .ok_or_else(|| "Tray icon rectangle is unavailable.".to_string())?;
    position_background_tray_player(app, icon_rect)?;
    if !background_tray_player_generation_is_current(state.generation) {
        return Ok(());
    }
    if !background_tray_is_required(app) {
        hide_background_tray_player_window(app);
        return Ok(());
    }

    let window = app
        .get_webview_window(BACKGROUND_TRAY_PLAYER_LABEL)
        .ok_or_else(|| "Tray player window not found.".to_string())?;
    let raw_hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let popup_hwnd = HWND(raw_hwnd.0);
    if let Err(error) = harden_background_tray_player_noactivate(&window, popup_hwnd) {
        // Keeping the custom player is the primary behavior. This hardening is
        // only a best-effort compatibility layer for Explorer's auto-hide UI.
        warn!("Failed to harden the tray-player WebView against activation: {error}");
    }
    if !background_tray_player_generation_is_current(state.generation) {
        return Ok(());
    }
    let tracking_started = tray_player_watcher::activate(
        app,
        popup_hwnd,
        state.generation,
        ScreenRect::from_xywh(icon_rect.x, icon_rect.y, icon_rect.width, icon_rect.height),
    )?;
    if !tracking_started {
        return Ok(());
    }
    if !show_background_tray_player_noactivate(app, &window, popup_hwnd, state.generation)? {
        tray_player_watcher::deactivate();
        return Ok(());
    }
    if !background_tray_player_activation_is_current(app, state.generation) {
        tray_player_watcher::deactivate();
        let _ = set_background_tray_player_native_visibility(&window, false);
        return Ok(());
    }
    if let Err(error) = tray_player_watcher::begin_menu_session(app, state.generation) {
        // The hidden HMENU is an experimental Explorer compatibility layer.
        // It must never replace or take down the custom WebView card.
        warn!("Failed to start the tray HMENU compatibility session: {error}");
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn reconcile_background_tray_player_visibility(app: &AppHandle) {
    if BACKGROUND_TRAY_PLAYER_RECONCILE_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let state = current_background_tray_player_visibility_state();
            if let Err(error) = apply_background_tray_player_visibility(&app, state) {
                let mut current = background_tray_player_visibility_state()
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let failed_current_generation = current.generation == state.generation;
                if failed_current_generation {
                    current.generation = current.generation.wrapping_add(1);
                    if current.generation == 0 {
                        current.generation = 1;
                    }
                    current.desired_visible = false;
                }
                drop(current);
                if failed_current_generation {
                    hide_background_tray_player_window(&app);
                    if app
                        .get_webview_window(BACKGROUND_TRAY_PLAYER_LABEL)
                        .is_none()
                    {
                        BACKGROUND_TRAY_PLAYER_READY.store(false, Ordering::Release);
                        prepare_background_tray_player(&app);
                    }
                }
                warn!("Failed to apply the custom tray-player visibility: {error}");
            }

            if state.generation != current_background_tray_player_visibility_state().generation {
                continue;
            }

            BACKGROUND_TRAY_PLAYER_RECONCILE_RUNNING.store(false, Ordering::SeqCst);
            if state.generation == current_background_tray_player_visibility_state().generation {
                break;
            }
            if BACKGROUND_TRAY_PLAYER_RECONCILE_RUNNING.swap(true, Ordering::SeqCst) {
                break;
            }
        }
    });
}

#[cfg(target_os = "windows")]
fn background_tray_player_url(app: &AppHandle) -> Result<WebviewUrl, String> {
    #[cfg(debug_assertions)]
    {
        let url = app
            .config()
            .build
            .dev_url
            .clone()
            .ok_or_else(|| "Development URL is unavailable.".to_string())?
            .join("tray-player.html")
            .map_err(|error| error.to_string())?;
        Ok(WebviewUrl::External(url))
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = app;
        Ok(WebviewUrl::App("tray-player.html".into()))
    }
}

#[cfg(target_os = "windows")]
fn background_tray_owner_hwnd(app: &AppHandle) -> Result<Option<isize>, String> {
    let Some(tray) = app.tray_by_id(BACKGROUND_TRAY_ID) else {
        return Ok(None);
    };
    let hwnd = tray
        .with_inner_tray_icon(|inner| inner.window_handle() as isize)
        .map_err(|error| error.to_string())?;
    if hwnd == 0 {
        return Err("Tray owner window handle is unavailable.".into());
    }
    Ok(Some(hwnd))
}

#[cfg(target_os = "windows")]
fn prepare_background_tray_player(app: &AppHandle) {
    if app
        .get_webview_window(BACKGROUND_TRAY_PLAYER_LABEL)
        .is_some()
        || BACKGROUND_TRAY_PLAYER_CREATING.swap(true, Ordering::AcqRel)
    {
        return;
    }

    let owner_hwnd = match background_tray_owner_hwnd(app) {
        Ok(Some(hwnd)) => hwnd,
        Ok(None) => {
            BACKGROUND_TRAY_PLAYER_CREATING.store(false, Ordering::Release);
            return;
        }
        Err(error) => {
            BACKGROUND_TRAY_PLAYER_CREATING.store(false, Ordering::Release);
            warn!("Failed to resolve the tray-player owner window: {error}");
            return;
        }
    };

    let generation = BACKGROUND_TRAY_PLAYER_CREATION_GENERATION
        .fetch_add(1, Ordering::AcqRel)
        .wrapping_add(1);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = (|| -> Result<(), String> {
            let url = background_tray_player_url(&app)?;
            let window = WebviewWindowBuilder::new(&app, BACKGROUND_TRAY_PLAYER_LABEL, url)
                .title("AMLL Player")
                .owner_raw(windows_061::Win32::Foundation::HWND(owner_hwnd as _))
                .inner_size(BACKGROUND_TRAY_PLAYER_WIDTH, BACKGROUND_TRAY_PLAYER_HEIGHT)
                .decorations(false)
                .shadow(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .focused(false)
                .focusable(false)
                .visible(false)
                .build()
                .map_err(|error| error.to_string())?;
            let is_current = BACKGROUND_TRAY_PLAYER_CREATION_GENERATION.load(Ordering::Acquire)
                == generation
                && app.get_webview_window("main").is_some();
            if !is_current {
                let _ = window.destroy();
                return Err("Discarded a stale tray player creation.".to_string());
            }
            Ok(())
        })();
        BACKGROUND_TRAY_PLAYER_CREATING.store(false, Ordering::Release);
        if let Err(error) = result {
            BACKGROUND_TRAY_PLAYER_READY.store(false, Ordering::Release);
            warn!("Failed to create the custom tray player: {error}");
        }
    });
}

#[cfg(target_os = "windows")]
pub(crate) fn handle_background_tray_player_window_event(
    window: &tauri::Window,
    event: &tauri::WindowEvent,
) {
    if window.label() != BACKGROUND_TRAY_PLAYER_LABEL {
        return;
    }
    match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            hide_background_tray_player(window.app_handle());
        }
        tauri::WindowEvent::Destroyed => {
            tray_player_watcher::deactivate();
            set_background_tray_player_visibility(false, None);
            BACKGROUND_TRAY_PLAYER_READY.store(false, Ordering::Release);
            BACKGROUND_TRAY_PLAYER_CREATING.store(false, Ordering::Release);
        }
        _ => {}
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn destroy_background_tray_player(app: &AppHandle) {
    tray_player_watcher::deactivate();
    BACKGROUND_TRAY_PLAYER_CREATION_GENERATION.fetch_add(1, Ordering::AcqRel);
    BACKGROUND_TRAY_PLAYER_READY.store(false, Ordering::Release);
    BACKGROUND_TRAY_PLAYER_CREATING.store(false, Ordering::Release);
    if let Some(window) = app.get_webview_window(BACKGROUND_TRAY_PLAYER_LABEL)
        && let Err(error) = window.destroy()
    {
        warn!("Failed to destroy the tray player: {error}");
    }
}

#[cfg(target_os = "windows")]
fn trim_tray_text(value: &str, max_chars: usize, escape_mnemonic: bool) -> String {
    let normalized = value.replace(['\r', '\n'], " ");
    let mut text = normalized.chars().take(max_chars).collect::<String>();
    if normalized.chars().count() > max_chars {
        text.push('…');
    }
    if escape_mnemonic {
        text.replace('&', "&&")
    } else {
        text
    }
}

#[cfg(target_os = "windows")]
fn background_tray_cover_image(state: &BackgroundTrayMenuState) -> Option<Image<'static>> {
    let cover = state.cover.as_ref()?;
    if cover.width == 0 || cover.height == 0 || cover.width > 128 || cover.height > 128 {
        return None;
    }
    let expected_len = cover.width.checked_mul(cover.height)?.checked_mul(4)? as usize;
    if cover.rgba.len() != expected_len {
        return None;
    }
    if !cover.rgba.chunks_exact(4).any(|pixel| pixel[3] != 0) {
        return None;
    }
    Some(Image::new_owned(
        cover.rgba.clone(),
        cover.width,
        cover.height,
    ))
}

#[cfg(target_os = "windows")]
fn background_tray_icon(app: &AppHandle) -> Result<Image<'static>, String> {
    let icon = app
        .default_window_icon()
        .ok_or_else(|| "Application icon is unavailable.".to_string())?;
    Ok(Image::new_owned(
        icon.rgba().to_vec(),
        icon.width(),
        icon.height(),
    ))
}

#[cfg(target_os = "windows")]
fn background_tray_metadata_text(state: &BackgroundTrayMenuState) -> String {
    let name = if state.can_control && !state.music_name.trim().is_empty() {
        state.music_name.trim()
    } else {
        state.labels.unknown_song.trim()
    };
    let metadata = if state.artist.trim().is_empty() {
        name.to_string()
    } else {
        format!("{} — {}", name, state.artist.trim())
    };
    trim_tray_text(&metadata, 80, true)
}

#[cfg(target_os = "windows")]
fn build_background_tray_menu(
    app: &AppHandle,
    state: &BackgroundTrayMenuState,
) -> Result<Menu<tauri::Wry>, String> {
    let metadata = IconMenuItem::with_id(
        app,
        BACKGROUND_TRAY_INFO_ID,
        background_tray_metadata_text(state),
        false,
        background_tray_cover_image(state).or_else(|| background_tray_icon(app).ok()),
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let first_separator = PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?;
    let previous = MenuItem::with_id(
        app,
        BACKGROUND_TRAY_PREVIOUS_ID,
        format!("⏮ {}", trim_tray_text(&state.labels.previous, 40, true)),
        state.can_control,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let playback_label = if state.playing {
        &state.labels.pause
    } else {
        &state.labels.play
    };
    let playback_symbol = if state.playing { "⏸" } else { "▶" };
    let toggle_playback = MenuItem::with_id(
        app,
        BACKGROUND_TRAY_TOGGLE_PLAYBACK_ID,
        format!(
            "{playback_symbol} {}",
            trim_tray_text(playback_label, 40, true)
        ),
        state.can_control,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let next = MenuItem::with_id(
        app,
        BACKGROUND_TRAY_NEXT_ID,
        format!("⏭ {}", trim_tray_text(&state.labels.next, 40, true)),
        state.can_control,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let second_separator = PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?;
    let taskbar_lyric = CheckMenuItem::with_id(
        app,
        BACKGROUND_TRAY_TASKBAR_LYRIC_ID,
        trim_tray_text(&state.labels.taskbar_lyric, 40, true),
        true,
        state.taskbar_lyric_enabled,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let show = MenuItem::with_id(
        app,
        BACKGROUND_TRAY_SHOW_ID,
        trim_tray_text(&state.labels.show_window, 40, true),
        true,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let third_separator = PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?;
    let exit = MenuItem::with_id(
        app,
        BACKGROUND_TRAY_EXIT_ID,
        trim_tray_text(&state.labels.exit, 40, true),
        true,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;

    Menu::with_items(
        app,
        &[
            &metadata,
            &first_separator,
            &previous,
            &toggle_playback,
            &next,
            &second_separator,
            &taskbar_lyric,
            &show,
            &third_separator,
            &exit,
        ],
    )
    .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn background_tray_tooltip(state: &BackgroundTrayMenuState) -> String {
    let metadata = if state.can_control {
        let name = if state.music_name.trim().is_empty() {
            state.labels.unknown_song.trim()
        } else {
            state.music_name.trim()
        };
        if state.artist.trim().is_empty() {
            name.to_string()
        } else {
            format!("{} — {}", name, state.artist.trim())
        }
    } else {
        state.labels.app_name.clone()
    };
    trim_tray_text(&metadata, 120, false)
}

#[cfg(target_os = "windows")]
fn refresh_background_tray_tooltip(app: &AppHandle) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(BACKGROUND_TRAY_ID) else {
        return Ok(());
    };
    let state = current_background_tray_menu_state();
    tray.set_tooltip(Some(background_tray_tooltip(&state)))
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn refresh_background_tray(app: &AppHandle) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(BACKGROUND_TRAY_ID) else {
        return Ok(());
    };
    // Never attach a native menu until automatic right-click display is
    // definitely disabled. If this fails, the tray remains menu-less and the
    // custom card stays the only visible right-click surface.
    disable_background_tray_native_menu(app)?;
    let state = current_background_tray_menu_state();
    tray.set_icon(Some(background_tray_icon(app)?))
        .map_err(|error| error.to_string())?;
    tray.set_tooltip(Some(background_tray_tooltip(&state)))
        .map_err(|error| error.to_string())?;
    tray.set_menu(Some(build_background_tray_menu(app, &state)?))
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn hide_background_tray(app: &AppHandle) {
    hide_background_tray_player(app);
    if let Some(tray) = app.tray_by_id(BACKGROUND_TRAY_ID)
        && let Err(error) = tray.set_visible(false)
    {
        warn!("Failed to hide the background tray: {error}");
    }
}

#[cfg(target_os = "windows")]
fn ensure_background_tray(app: &AppHandle) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id(BACKGROUND_TRAY_ID) {
        tray.set_visible(true).map_err(|error| error.to_string())?;
        disable_background_tray_native_menu(app)?;
        prepare_background_tray_player(app);
        return Ok(());
    }

    let state = current_background_tray_menu_state();
    let icon = background_tray_icon(app)?;
    TrayIconBuilder::with_id(BACKGROUND_TRAY_ID)
        .icon(icon)
        .tooltip(background_tray_tooltip(&state))
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => {
                let app = tray.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = show_main_window_from_background(app).await {
                        warn!("Failed to restore main window from the tray: {error}");
                    }
                });
            }
            TrayIconEvent::Click {
                rect,
                button: MouseButton::Right,
                button_state: MouseButtonState::Up,
                ..
            } => {
                let Some(icon_rect) = physical_tray_icon_rect(rect) else {
                    warn!("Tray icon rectangle did not use physical coordinates.");
                    return;
                };
                let app = tray.app_handle().clone();
                if BACKGROUND_TRAY_PLAYER_READY.load(Ordering::Acquire) {
                    let visibility = toggle_background_tray_player_visibility(icon_rect);
                    if !visibility.desired_visible {
                        tray_player_watcher::deactivate();
                    }
                    reconcile_background_tray_player_visibility(&app);
                } else {
                    set_background_tray_player_visibility(true, Some(icon_rect));
                    prepare_background_tray_player(&app);
                }
            }
            _ => {}
        })
        .build(app)
        .map_err(|error| error.to_string())?;
    refresh_background_tray(app)?;
    prepare_background_tray_player(app);
    Ok(())
}

#[cfg(target_os = "windows")]
fn should_keep_background_tray(always_tray: bool, hidden: bool, main_exists: bool) -> bool {
    (always_tray || hidden) && main_exists
}

#[cfg(target_os = "windows")]
fn background_tray_is_required(app: &AppHandle) -> bool {
    let always_tray = background_tray_menu_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .always_tray;
    should_keep_background_tray(
        always_tray,
        MAIN_WINDOW_HIDDEN_TO_BACKGROUND.load(Ordering::Acquire),
        app.get_webview_window("main").is_some(),
    )
}

#[cfg(target_os = "windows")]
fn apply_background_tray_requirement(app: &AppHandle, required: bool) {
    if required {
        if let Err(error) = ensure_background_tray(app) {
            warn!("Failed to create the background tray: {error}");
        }
    } else {
        hide_background_tray(app);
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn reconcile_background_restore_entry(app: &AppHandle) {
    // Restore availability is tracked in process state. Do not query a Tauri
    // window getter here: during Destroyed, a dispatcher can still be present
    // after its native window is gone and never answer a synchronous getter.
    BACKGROUND_TRAY_RECONCILE_GENERATION.fetch_add(1, Ordering::SeqCst);
    if BACKGROUND_TRAY_RECONCILE_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let generation = BACKGROUND_TRAY_RECONCILE_GENERATION.load(Ordering::SeqCst);
            let required = background_tray_is_required(&app);
            apply_background_tray_requirement(&app, required);

            if generation != BACKGROUND_TRAY_RECONCILE_GENERATION.load(Ordering::SeqCst) {
                continue;
            }

            BACKGROUND_TRAY_RECONCILE_RUNNING.store(false, Ordering::SeqCst);
            if generation == BACKGROUND_TRAY_RECONCILE_GENERATION.load(Ordering::SeqCst) {
                break;
            }
            if BACKGROUND_TRAY_RECONCILE_RUNNING.swap(true, Ordering::SeqCst) {
                break;
            }
        }
    });
}

#[cfg(target_os = "windows")]
pub(crate) fn try_clear_background_restore_entry(app: &AppHandle) {
    MAIN_WINDOW_HIDDEN_TO_BACKGROUND.store(false, Ordering::Release);
    // A destroyed main window must not leave a persistent restore icon behind.
    background_tray_menu_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .always_tray = false;
    hide_background_tray_player(app);
    reconcile_background_restore_entry(app);
}

#[cfg(target_os = "windows")]
fn background_tray_action_for_id(id: &str) -> Option<BackgroundTrayAction> {
    match id {
        BACKGROUND_TRAY_PREVIOUS_ID => Some(BackgroundTrayAction::Previous),
        BACKGROUND_TRAY_TOGGLE_PLAYBACK_ID => Some(BackgroundTrayAction::TogglePlayback),
        BACKGROUND_TRAY_NEXT_ID => Some(BackgroundTrayAction::Next),
        BACKGROUND_TRAY_TASKBAR_LYRIC_ID => Some(BackgroundTrayAction::ToggleTaskbarLyric),
        BACKGROUND_TRAY_SHOW_ID => Some(BackgroundTrayAction::Show),
        BACKGROUND_TRAY_EXIT_ID => Some(BackgroundTrayAction::Exit),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
fn background_tray_action_for_command(command: &str) -> Option<BackgroundTrayAction> {
    match command {
        "previous" => Some(BackgroundTrayAction::Previous),
        "toggle-playback" => Some(BackgroundTrayAction::TogglePlayback),
        "next" => Some(BackgroundTrayAction::Next),
        "toggle-taskbar-lyric" => Some(BackgroundTrayAction::ToggleTaskbarLyric),
        "show" => Some(BackgroundTrayAction::Show),
        "exit" => Some(BackgroundTrayAction::Exit),
        "hide" => Some(BackgroundTrayAction::Hide),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
fn dispatch_background_tray_action(app: &AppHandle, action: BackgroundTrayAction) {
    match action {
        BackgroundTrayAction::Show => {
            hide_background_tray_player(app);
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = show_main_window_from_background(app).await {
                    warn!("Failed to restore main window from the tray: {error}");
                }
            });
        }
        BackgroundTrayAction::Exit => app.exit(0),
        BackgroundTrayAction::Hide => hide_background_tray_player(app),
        BackgroundTrayAction::Previous
        | BackgroundTrayAction::TogglePlayback
        | BackgroundTrayAction::Next
        | BackgroundTrayAction::ToggleTaskbarLyric => {
            let command = match action {
                BackgroundTrayAction::Previous => "previous",
                BackgroundTrayAction::TogglePlayback => "toggle-playback",
                BackgroundTrayAction::Next => "next",
                BackgroundTrayAction::ToggleTaskbarLyric => "toggle-taskbar-lyric",
                BackgroundTrayAction::Show
                | BackgroundTrayAction::Exit
                | BackgroundTrayAction::Hide => unreachable!(),
            };
            if let Err(error) = app.emit_to(
                "main",
                BACKGROUND_TRAY_COMMAND_EVENT,
                BackgroundTrayCommandPayload { command },
            ) {
                warn!("Failed to dispatch background tray command {command}: {error}");
            }
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn handle_background_tray_menu_event(app: &AppHandle, id: &str) {
    let Some(action) = background_tray_action_for_id(id) else {
        return;
    };
    dispatch_background_tray_action(app, action);
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn update_background_tray_menu(
    app: AppHandle,
    state: BackgroundTrayMenuState,
) -> Result<(), String> {
    prepare_background_tray_player(&app);
    let (native_menu_changed, tooltip_changed, tray_policy_changed) = {
        let mut current = background_tray_menu_state()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let changed = current.music_name != state.music_name
            || current.artist != state.artist
            || current.playing != state.playing
            || current.can_control != state.can_control
            || current.taskbar_lyric_enabled != state.taskbar_lyric_enabled
            || current.cover != state.cover
            || current.labels != state.labels;
        let tooltip_changed =
            changed && background_tray_tooltip(&current) != background_tray_tooltip(&state);
        let tray_policy_changed = current.always_tray != state.always_tray;
        *current = state;
        (changed, tooltip_changed, tray_policy_changed)
    };
    if tray_policy_changed {
        reconcile_background_restore_entry(&app);
    }
    emit_background_tray_player_state(&app)?;
    if native_menu_changed && !BACKGROUND_TRAY_PLAYER_READY.load(Ordering::Acquire) {
        refresh_background_tray(&app)?;
    } else if tooltip_changed {
        // The native tooltip remains visible when the custom player owns the menu.
        refresh_background_tray_tooltip(&app)?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn background_tray_player_ready(app: AppHandle) -> Result<(), String> {
    if app
        .get_webview_window(BACKGROUND_TRAY_PLAYER_LABEL)
        .is_none()
    {
        return Err("Tray player window not found.".to_string());
    }
    BACKGROUND_TRAY_PLAYER_READY.store(true, Ordering::Release);
    emit_background_tray_player_state(&app)?;
    disable_background_tray_native_menu(&app)?;
    if current_background_tray_player_visibility_state().desired_visible {
        reconcile_background_tray_player_visibility(&app);
    }
    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn background_tray_player_action(app: AppHandle, action: String) -> Result<(), String> {
    let action = background_tray_action_for_command(&action)
        .ok_or_else(|| "Unknown tray player action.".to_string())?;
    dispatch_background_tray_action(&app, action);
    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn exit_application(app: AppHandle) {
    app.exit(0);
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn hide_main_window_to_background(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found.".to_string())?;
    {
        let _restore_guard = BACKGROUND_RESTORE_LOCK.lock().await;
        if let Err(error) = window.hide() {
            MAIN_WINDOW_HIDDEN_TO_BACKGROUND.store(false, Ordering::Release);
            reconcile_background_restore_entry(&app);
            return Err(error.to_string());
        }
        MAIN_WINDOW_HIDDEN_TO_BACKGROUND.store(true, Ordering::Release);
        crate::window_activity::refresh_main_window_activity(&app);
    }

    // Tray APIs synchronously cross the Windows UI thread. Reconcile them on a
    // coalesced worker after releasing the window transition lock, so an older
    // restore cannot hide the tray after a newer close has made it required.
    hide_background_tray_player(&app);
    reconcile_background_restore_entry(&app);
    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn show_main_window_from_background(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found.".to_string())?;
    hide_background_tray_player(&app);
    let was_minimized = window.is_minimized().map_err(|error| error.to_string())?;
    {
        let _restore_guard = BACKGROUND_RESTORE_LOCK.lock().await;
        if was_minimized {
            window.unminimize().map_err(|error| error.to_string())?;
        }
        window.show().map_err(|error| error.to_string())?;
        MAIN_WINDOW_HIDDEN_TO_BACKGROUND.store(false, Ordering::Release);
        crate::window_activity::refresh_main_window_activity(&app);
        if let Err(error) = window.set_focus() {
            warn!("Failed to focus the restored main window: {error}");
        }
    }

    // Coalescing makes the latest hidden/visible state authoritative even when
    // Explorer completes an older tray operation after this command returns.
    reconcile_background_restore_entry(&app);
    Ok(())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn persistent_tray_survives_restore_and_respects_main_window_teardown() {
        // Policy, hidden-to-background, main-exists, expected icon visibility.
        for (persistent, hidden, main_exists, expected) in [
            (true, false, true, true),
            (true, true, true, true),
            (false, false, true, false),
            (false, true, true, true),
            (true, false, false, false),
            (true, true, false, false),
            (false, false, false, false),
            (false, true, false, false),
        ] {
            assert_eq!(
                should_keep_background_tray(persistent, hidden, main_exists),
                expected
            );
        }
    }

    #[test]
    fn tray_state_accepts_persistent_mode_and_legacy_payloads() {
        let legacy: BackgroundTrayMenuState = serde_json::from_str("{}").unwrap();
        assert!(!legacy.always_tray);
        let persistent: BackgroundTrayMenuState =
            serde_json::from_str(r#"{"alwaysTray":true}"#).unwrap();
        assert!(persistent.always_tray);
        assert_eq!(
            serde_json::to_value(persistent).unwrap()["alwaysTray"],
            true
        );
    }

    const PRIMARY_MONITOR: PhysicalWindowRect = PhysicalWindowRect {
        x: 0,
        y: 0,
        width: 2560,
        height: 1600,
    };

    #[test]
    fn maps_background_tray_menu_ids_without_using_localized_labels() {
        assert_eq!(
            background_tray_action_for_id(BACKGROUND_TRAY_PREVIOUS_ID),
            Some(BackgroundTrayAction::Previous)
        );
        assert_eq!(
            background_tray_action_for_id(BACKGROUND_TRAY_TOGGLE_PLAYBACK_ID),
            Some(BackgroundTrayAction::TogglePlayback)
        );
        assert_eq!(
            background_tray_action_for_id(BACKGROUND_TRAY_NEXT_ID),
            Some(BackgroundTrayAction::Next)
        );
        assert_eq!(
            background_tray_action_for_id(BACKGROUND_TRAY_TASKBAR_LYRIC_ID),
            Some(BackgroundTrayAction::ToggleTaskbarLyric)
        );
        assert_eq!(
            background_tray_action_for_id(BACKGROUND_TRAY_SHOW_ID),
            Some(BackgroundTrayAction::Show)
        );
        assert_eq!(
            background_tray_action_for_id(BACKGROUND_TRAY_EXIT_ID),
            Some(BackgroundTrayAction::Exit)
        );
        assert_eq!(background_tray_action_for_id("unknown"), None);
        assert_eq!(background_tray_action_for_id(BACKGROUND_TRAY_INFO_ID), None);
    }

    #[test]
    fn maps_custom_tray_player_actions() {
        assert_eq!(
            background_tray_action_for_command("previous"),
            Some(BackgroundTrayAction::Previous)
        );
        assert_eq!(
            background_tray_action_for_command("toggle-playback"),
            Some(BackgroundTrayAction::TogglePlayback)
        );
        assert_eq!(
            background_tray_action_for_command("next"),
            Some(BackgroundTrayAction::Next)
        );
        assert_eq!(
            background_tray_action_for_command("toggle-taskbar-lyric"),
            Some(BackgroundTrayAction::ToggleTaskbarLyric)
        );
        assert_eq!(
            background_tray_action_for_command("show"),
            Some(BackgroundTrayAction::Show)
        );
        assert_eq!(
            background_tray_action_for_command("exit"),
            Some(BackgroundTrayAction::Exit)
        );
        assert_eq!(
            background_tray_action_for_command("hide"),
            Some(BackgroundTrayAction::Hide)
        );
        assert_eq!(background_tray_action_for_command("unknown"), None);
    }

    #[test]
    fn tray_player_visibility_mailbox_preserves_rapid_toggle_and_latest_anchor() {
        let mut state = BackgroundTrayPlayerVisibilityState::default();
        let first_anchor = PhysicalWindowRect {
            x: 100,
            y: 200,
            width: 24,
            height: 24,
        };
        let second_anchor = PhysicalWindowRect {
            x: 300,
            y: 400,
            width: 32,
            height: 32,
        };

        state.toggle(first_anchor);
        assert!(state.desired_visible);
        assert_eq!(state.anchor_rect, Some(first_anchor));
        let first_generation = state.generation;

        state.toggle(second_anchor);
        assert!(!state.desired_visible);
        assert_eq!(state.anchor_rect, Some(first_anchor));
        assert_eq!(state.generation, first_generation.wrapping_add(1));

        state.toggle(second_anchor);
        assert!(state.desired_visible);
        assert_eq!(state.anchor_rect, Some(second_anchor));

        state.set_visibility(false, None);
        assert!(!state.desired_visible);
        assert_eq!(state.anchor_rect, Some(second_anchor));
    }

    #[test]
    fn positions_tray_player_inside_each_monitor_edge() {
        let monitor_rect = PhysicalWindowRect {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let top = tray_player_position(
            PhysicalWindowRect {
                x: -1020,
                y: 0,
                width: 40,
                height: 40,
            },
            380,
            192,
            PhysicalWindowRect {
                y: 40,
                height: 1040,
                ..monitor_rect
            },
            monitor_rect,
            8,
        );
        assert_eq!((top.x, top.y), (-1190, 48));
        let bottom = tray_player_position(
            PhysicalWindowRect {
                x: -1020,
                y: 1040,
                width: 40,
                height: 40,
            },
            380,
            192,
            PhysicalWindowRect {
                height: 1040,
                ..monitor_rect
            },
            monitor_rect,
            8,
        );
        assert_eq!((bottom.x, bottom.y), (-1190, 840));
        let left = tray_player_position(
            PhysicalWindowRect {
                x: -1920,
                y: 480,
                width: 40,
                height: 40,
            },
            380,
            192,
            PhysicalWindowRect {
                x: -1880,
                width: 1880,
                ..monitor_rect
            },
            monitor_rect,
            8,
        );
        assert_eq!((left.x, left.y), (-1872, 404));
        let right = tray_player_position(
            PhysicalWindowRect {
                x: -40,
                y: 480,
                width: 40,
                height: 40,
            },
            380,
            192,
            PhysicalWindowRect {
                width: 1880,
                ..monitor_rect
            },
            monitor_rect,
            8,
        );
        assert_eq!((right.x, right.y), (-428, 404));

        let tiny = tray_player_position(
            PhysicalWindowRect {
                x: 50,
                y: 75,
                width: 1,
                height: 1,
            },
            380,
            192,
            PhysicalWindowRect {
                x: 0,
                y: 0,
                width: 100,
                height: 80,
            },
            PhysicalWindowRect {
                x: 0,
                y: 0,
                width: 100,
                height: 80,
            },
            8,
        );
        assert_eq!((tiny.x, tiny.y), (0, 0));

        let negative_tiny = tray_player_position(
            PhysicalWindowRect {
                x: -1870,
                y: -1010,
                width: 1,
                height: 1,
            },
            380,
            192,
            PhysicalWindowRect {
                x: -1920,
                y: -1080,
                width: 100,
                height: 80,
            },
            PhysicalWindowRect {
                x: -1920,
                y: -1080,
                width: 100,
                height: 80,
            },
            8,
        );
        assert_eq!((negative_tiny.x, negative_tiny.y), (-1920, -1080));

        let clamped_to_work_area = tray_player_position(
            PhysicalWindowRect {
                x: -1920,
                y: 0,
                width: 40,
                height: 40,
            },
            380,
            192,
            PhysicalWindowRect {
                x: -1880,
                y: 40,
                width: 1880,
                height: 1040,
            },
            monitor_rect,
            8,
        );
        assert_eq!(
            (clamped_to_work_area.x, clamped_to_work_area.y),
            (-1880, 48)
        );
    }

    #[test]
    fn extracts_the_physical_tray_icon_rectangle() {
        let rect = Rect {
            position: Position::Physical(PhysicalPosition::new(-32, 1040)),
            size: Size::Physical(PhysicalSize::new(24, 24)),
        };

        assert_eq!(
            physical_tray_icon_rect(rect),
            Some(PhysicalWindowRect {
                x: -32,
                y: 1040,
                width: 24,
                height: 24,
            })
        );

        assert!(
            physical_tray_icon_rect(Rect {
                position: Position::Logical(tauri::LogicalPosition::new(-32.0, 1040.0)),
                size: Size::Physical(PhysicalSize::new(24, 24)),
            })
            .is_none()
        );
        assert!(
            physical_tray_icon_rect(Rect {
                position: Position::Physical(PhysicalPosition::new(-32, 1040)),
                size: Size::Logical(tauri::LogicalSize::new(24.0, 24.0)),
            })
            .is_none()
        );
    }

    #[test]
    fn scales_tray_player_dimensions_for_the_target_monitor() {
        assert_eq!(
            tray_player_physical_dimension(BACKGROUND_TRAY_PLAYER_WIDTH, 1.0),
            380
        );
        assert_eq!(
            tray_player_physical_dimension(BACKGROUND_TRAY_PLAYER_WIDTH, 1.5),
            570
        );
        assert_eq!(
            tray_player_physical_dimension(BACKGROUND_TRAY_PLAYER_HEIGHT, 2.0),
            384
        );
    }

    #[test]
    fn validates_background_tray_cover_payload_before_native_menu_use() {
        let mut state = BackgroundTrayMenuState {
            cover: Some(BackgroundTrayCover {
                rgba: vec![10, 20, 30, 255],
                width: 1,
                height: 1,
            }),
            ..BackgroundTrayMenuState::default()
        };
        let image = background_tray_cover_image(&state).expect("valid cover");
        assert_eq!(image.width(), 1);
        assert_eq!(image.height(), 1);

        state.cover = Some(BackgroundTrayCover {
            rgba: vec![10, 20, 30, 255],
            width: 0,
            height: 1,
        });
        assert!(background_tray_cover_image(&state).is_none());

        state.cover = Some(BackgroundTrayCover {
            rgba: vec![10, 20, 30],
            width: 1,
            height: 1,
        });
        assert!(background_tray_cover_image(&state).is_none());

        state.cover = Some(BackgroundTrayCover {
            rgba: vec![10, 20, 30, 0],
            width: 1,
            height: 1,
        });
        assert!(background_tray_cover_image(&state).is_none());
    }

    #[test]
    fn hidden_restore_excludes_visibility_and_maximization() {
        let flags = main_window_restore_flags();

        assert!(!flags.contains(StateFlags::SIZE));
        assert!(!flags.contains(StateFlags::POSITION));
        assert!(flags.contains(StateFlags::DECORATIONS));
        assert!(!flags.contains(StateFlags::FULLSCREEN));
        assert!(!flags.contains(StateFlags::MAXIMIZED));
        assert!(!flags.contains(StateFlags::VISIBLE));
    }

    #[test]
    fn normal_restore_uses_saved_geometry_instead_of_previous_or_bootstrap_position() {
        let persisted = PersistedWindowPresentation {
            x: 360,
            y: 180,
            width: 1630,
            height: 1195,
            prev_x: 658,
            prev_y: 801,
            ..PersistedWindowPresentation::default()
        };
        assert_eq!(
            persisted_restore_bounds(persisted),
            Some(PhysicalWindowRect {
                x: 360,
                y: 180,
                width: 1630,
                height: 1195,
            })
        );
        assert_eq!(
            persisted_restore_bounds(PersistedWindowPresentation {
                maximized: true,
                ..persisted
            }),
            Some(PhysicalWindowRect {
                x: 658,
                y: 801,
                width: 1630,
                height: 1195,
            })
        );
        assert!(persisted_restore_bounds(PersistedWindowPresentation::default()).is_none());
    }

    #[test]
    fn repairs_reported_bottom_overflow_without_resetting_size_or_horizontal_position() {
        let bounds = PhysicalWindowRect {
            x: 658,
            y: 801,
            width: 1630,
            height: 1195,
        };
        let work_area = PhysicalWindowRect {
            height: 1530,
            ..PRIMARY_MONITOR
        };
        assert_eq!(
            visible_restore_bounds(bounds, &[work_area]),
            PhysicalWindowRect { y: 335, ..bounds }
        );
    }

    #[test]
    fn preserves_valid_saved_positions_and_negative_monitor_coordinates() {
        let bounds = PhysicalWindowRect {
            x: 360,
            y: 180,
            width: 1630,
            height: 1195,
        };
        assert_eq!(visible_restore_bounds(bounds, &[PRIMARY_MONITOR]), bounds);
        let left_monitor = PhysicalWindowRect {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let left_bounds = PhysicalWindowRect {
            x: -1800,
            y: 100,
            width: 1200,
            height: 800,
        };
        assert_eq!(
            visible_restore_bounds(left_bounds, &[left_monitor, PRIMARY_MONITOR]),
            left_bounds
        );
    }

    #[test]
    fn preserves_windows_spanning_adjacent_work_areas_but_not_monitor_gaps() {
        let left_monitor = PhysicalWindowRect {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1600,
        };
        let spanning = PhysicalWindowRect {
            x: -500,
            y: 100,
            width: 1500,
            height: 900,
        };
        assert_eq!(
            visible_restore_bounds(spanning, &[left_monitor, PRIMARY_MONITOR]),
            spanning
        );
        let separated = PhysicalWindowRect {
            x: -2100,
            ..left_monitor
        };
        assert_ne!(
            visible_restore_bounds(spanning, &[separated, PRIMARY_MONITOR]),
            spanning
        );
    }

    #[test]
    fn fits_removed_monitor_or_oversized_saved_window_into_available_work_area() {
        let oversized = PhysicalWindowRect {
            x: 3000,
            y: 2000,
            width: 3000,
            height: 1800,
        };
        assert_eq!(
            visible_restore_bounds(oversized, &[PRIMARY_MONITOR]),
            PRIMARY_MONITOR
        );
        assert_eq!(visible_restore_bounds(oversized, &[]), oversized);
    }

    #[test]
    fn reads_only_the_persisted_presentation_intent() {
        let json = r#"{
            "main": {
                "width": 1850,
                "height": 1079,
                "x": -11,
                "y": -11,
                "prev_x": 520,
                "prev_y": 394,
                "maximized": true,
                "fullscreen": false
            }
        }"#;

        assert_eq!(
            parse_persisted_window_presentation(json, "main").unwrap(),
            PersistedWindowPresentation {
                width: 1850,
                height: 1079,
                x: -11,
                y: -11,
                prev_x: 520,
                prev_y: 394,
                maximized: true,
                fullscreen: false,
            },
        );
        assert_eq!(
            parse_persisted_window_presentation(json, "missing").unwrap(),
            PersistedWindowPresentation::default(),
        );
    }

    #[test]
    fn normalizes_maximized_restore_bounds_without_touching_other_windows() {
        let json = r#"{
            "main": {
                "width": 1850,
                "height": 1079,
                "x": -11,
                "y": -11,
                "prev_x": -11,
                "prev_y": -11,
                "maximized": true,
                "visible": true,
                "decorated": false,
                "fullscreen": false
            },
            "screenshot": {
                "x": 42
            }
        }"#;
        let restore_bounds = PhysicalWindowRect {
            x: 355,
            y: 260,
            width: 1850,
            height: 1079,
        };
        let normalized = normalize_persisted_main_window_state(json, restore_bounds, None)
            .unwrap()
            .unwrap();
        let normalized: serde_json::Value = serde_json::from_slice(&normalized).unwrap();

        assert_eq!(normalized["main"]["x"], 355);
        assert_eq!(normalized["main"]["y"], 260);
        assert_eq!(normalized["main"]["prev_x"], 355);
        assert_eq!(normalized["main"]["prev_y"], 260);
        assert_eq!(normalized["main"]["width"], 1850);
        assert_eq!(normalized["main"]["height"], 1079);
        assert_eq!(normalized["main"]["maximized"], true);
        assert_eq!(normalized["main"]["visible"], true);
        assert_eq!(normalized["main"]["decorated"], false);
        assert_eq!(normalized["screenshot"]["x"], 42);
    }

    #[test]
    fn presentation_override_persists_recovered_legacy_maximization() {
        let json = r#"{
            "main": {
                "width": 2560,
                "height": 1600,
                "x": -40,
                "y": -40,
                "prev_x": 0,
                "prev_y": 0,
                "maximized": false,
                "fullscreen": false
            }
        }"#;
        let restore_bounds = PhysicalWindowRect {
            x: 880,
            y: 500,
            width: 800,
            height: 600,
        };
        let normalized =
            normalize_persisted_main_window_state(json, restore_bounds, Some((true, false)))
                .unwrap()
                .unwrap();
        let normalized: serde_json::Value = serde_json::from_slice(&normalized).unwrap();

        assert_eq!(normalized["main"]["maximized"], true);
        assert_eq!(normalized["main"]["fullscreen"], false);
        assert_eq!(normalized["main"]["x"], 880);
        assert_eq!(normalized["main"]["prev_x"], 880);
        assert_eq!(normalized["main"]["width"], 800);
        assert_eq!(normalized["main"]["height"], 600);
    }

    #[test]
    fn leaves_normal_persisted_window_state_unchanged() {
        let json = r#"{
            "main": {
                "maximized": false,
                "fullscreen": false
            }
        }"#;

        assert!(
            normalize_persisted_main_window_state(json, PRIMARY_MONITOR, None)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn rejects_maximized_and_fullscreen_event_orders_as_restore_candidates() {
        let work_area = PhysicalWindowRect {
            height: 1500,
            ..PRIMARY_MONITOR
        };
        let normal = PhysicalWindowRect {
            x: 355,
            y: 260,
            width: 1850,
            height: 1079,
        };

        assert!(!is_probable_presentation_transition_bounds(
            normal,
            work_area,
            PRIMARY_MONITOR,
        ));
        assert!(is_probable_presentation_transition_bounds(
            PhysicalWindowRect {
                x: -11,
                y: -11,
                ..normal
            },
            work_area,
            PRIMARY_MONITOR,
        ));
        assert!(is_probable_presentation_transition_bounds(
            PhysicalWindowRect {
                width: work_area.width,
                height: work_area.height,
                ..normal
            },
            work_area,
            PRIMARY_MONITOR,
        ));
        assert!(is_probable_presentation_transition_bounds(
            PhysicalWindowRect {
                width: PRIMARY_MONITOR.width,
                height: PRIMARY_MONITOR.height,
                ..normal
            },
            work_area,
            PRIMARY_MONITOR,
        ));
    }

    #[test]
    fn pending_normal_bounds_survive_a_cancelled_stable_sample() {
        let state = MainWindowPresentationState::default();
        let old_bounds = PhysicalWindowRect {
            x: 200,
            y: 160,
            width: 1200,
            height: 800,
        };
        let latest_bounds = PhysicalWindowRect {
            x: 355,
            y: 260,
            width: 1850,
            height: 1079,
        };

        state.set_restore_bounds(old_bounds);
        state.set_pending_restore_bounds(latest_bounds);

        assert_eq!(state.restore_bounds(), Some(latest_bounds));
    }

    #[test]
    fn recenters_a_restore_origin_collapsed_to_the_maximized_edge() {
        let work_area = PhysicalWindowRect {
            height: 1599,
            ..PRIMARY_MONITOR
        };
        let collapsed = PersistedWindowPresentation {
            width: 1850,
            height: 1079,
            x: -11,
            y: -11,
            prev_x: -11,
            prev_y: -11,
            maximized: true,
            fullscreen: false,
        };

        assert!(is_collapsed_maximized_restore_origin(collapsed, work_area));
        assert_eq!(
            centered_rect_with_size(work_area, 1850, 1079),
            PhysicalWindowRect {
                x: 355,
                y: 260,
                width: 1850,
                height: 1079,
            },
        );
        assert!(!is_collapsed_maximized_restore_origin(
            PersistedWindowPresentation {
                x: 0,
                y: 0,
                prev_x: 0,
                prev_y: 0,
                ..collapsed
            },
            work_area,
        ));
        assert!(is_collapsed_maximized_restore_origin(
            PersistedWindowPresentation {
                x: 0,
                y: 0,
                fullscreen: true,
                ..collapsed
            },
            work_area,
        ));
        assert!(is_collapsed_maximized_restore_origin(
            PersistedWindowPresentation {
                x: 355,
                y: 260,
                ..collapsed
            },
            work_area,
        ));
    }

    #[test]
    fn recovers_known_auto_hide_taskbar_corruption() {
        let corrupted = PhysicalWindowRect {
            x: -363,
            y: 480,
            width: 2560,
            height: 1599,
        };

        assert!(should_recover_legacy_maximized_state(
            false,
            corrupted,
            PRIMARY_MONITOR,
            &[PRIMARY_MONITOR],
        ));
    }

    #[test]
    fn does_not_recover_a_window_that_is_already_maximized() {
        let corrupted = PhysicalWindowRect {
            x: -363,
            y: 480,
            width: 2560,
            height: 1599,
        };

        assert!(!should_recover_legacy_maximized_state(
            true,
            corrupted,
            PRIMARY_MONITOR,
            &[PRIMARY_MONITOR],
        ));
    }

    #[test]
    fn does_not_recover_normal_or_differently_sized_windows() {
        let normal = PhysicalWindowRect {
            x: 880,
            y: 500,
            width: 800,
            height: 600,
        };
        let taskbar_reduced = PhysicalWindowRect {
            x: -100,
            y: 0,
            width: 2560,
            height: 1520,
        };

        assert!(!should_recover_legacy_maximized_state(
            false,
            normal,
            PRIMARY_MONITOR,
            &[PRIMARY_MONITOR],
        ));
        assert!(!should_recover_legacy_maximized_state(
            false,
            taskbar_reduced,
            PRIMARY_MONITOR,
            &[PRIMARY_MONITOR],
        ));
        assert!(!should_recover_legacy_maximized_state(
            false,
            PhysicalWindowRect {
                x: -363,
                y: 480,
                width: 2560,
                height: 1599,
            },
            PRIMARY_MONITOR,
            &[],
        ));
    }

    #[test]
    fn does_not_recover_near_fullscreen_window_inside_monitor() {
        let inside = PhysicalWindowRect {
            x: 0,
            y: 0,
            width: 2560,
            height: 1599,
        };

        assert!(!should_recover_legacy_maximized_state(
            false,
            inside,
            PRIMARY_MONITOR,
            &[PRIMARY_MONITOR],
        ));
    }

    #[test]
    fn ignores_small_shadow_or_rounding_overflow() {
        let slightly_outside = PhysicalWindowRect {
            x: -8,
            y: 0,
            width: 2560,
            height: 1599,
        };

        assert!(!should_recover_legacy_maximized_state(
            false,
            slightly_outside,
            PRIMARY_MONITOR,
            &[PRIMARY_MONITOR],
        ));
    }

    #[test]
    fn supports_monitors_with_negative_desktop_coordinates() {
        let monitor = PhysicalWindowRect {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let corrupted = PhysicalWindowRect {
            x: -2200,
            y: 300,
            width: 1919,
            height: 1080,
        };

        assert!(should_recover_legacy_maximized_state(
            false,
            corrupted,
            monitor,
            &[monitor],
        ));
    }

    #[test]
    fn does_not_recover_a_valid_window_spanning_two_monitors() {
        let left_monitor = PhysicalWindowRect {
            x: -2560,
            y: 32,
            width: 2560,
            height: 1600,
        };
        let spanning_window = PhysicalWindowRect {
            x: -1000,
            y: 0,
            width: 2560,
            height: 1599,
        };

        assert!(!should_recover_legacy_maximized_state(
            false,
            spanning_window,
            PRIMARY_MONITOR,
            &[left_monitor, PRIMARY_MONITOR],
        ));
    }

    #[test]
    fn still_recovers_when_another_monitor_only_covers_one_bad_edge() {
        let left_monitor = PhysicalWindowRect {
            x: -2560,
            y: 0,
            width: 2560,
            height: 1600,
        };
        let corrupted = PhysicalWindowRect {
            x: -363,
            y: 480,
            width: 2560,
            height: 1599,
        };

        assert!(should_recover_legacy_maximized_state(
            false,
            corrupted,
            PRIMARY_MONITOR,
            &[left_monitor, PRIMARY_MONITOR],
        ));
    }

    #[test]
    fn calculates_dpi_aware_centered_restore_bounds() {
        let auto_hide_work_area = PhysicalWindowRect {
            height: 1599,
            ..PRIMARY_MONITOR
        };

        assert_eq!(
            centered_restore_rect(auto_hide_work_area, 1.5),
            PhysicalWindowRect {
                x: 680,
                y: 349,
                width: 1200,
                height: 900,
            },
        );
    }

    #[test]
    fn clips_restore_bounds_to_a_smaller_monitor() {
        let small_monitor = PhysicalWindowRect {
            x: -1280,
            y: 100,
            width: 640,
            height: 480,
        };

        assert_eq!(centered_restore_rect(small_monitor, 2.0), small_monitor,);
    }
}
