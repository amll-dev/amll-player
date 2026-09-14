use std::{
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicI32, AtomicIsize, AtomicU32, AtomicU64, AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

use tauri::AppHandle;
use windows::Win32::{
    Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    Graphics::Gdi::ScreenToClient,
    System::{
        LibraryLoader::GetModuleHandleW,
        Threading::{GetCurrentProcessId, GetCurrentThreadId},
    },
    UI::{
        Controls::{MEASUREITEMSTRUCT, ODT_MENU, WM_MOUSELEAVE},
        WindowsAndMessaging::{
            AppendMenuW, CBT_CREATEWNDW, CallNextHookEx, CreatePopupMenu, CreateWindowExW,
            DefWindowProcW, DestroyMenu, DestroyWindow, DispatchMessageW, EndMenu, GWL_EXSTYLE,
            GetClassNameW, GetMessageW, GetParent, GetWindowLongPtrW, GetWindowRect,
            GetWindowThreadProcessId, HCBT_ACTIVATE, HCBT_CREATEWND, IsWindow, KillTimer,
            LWA_ALPHA, MF_DISABLED, MF_GRAYED, MF_OWNERDRAW, MSG, MSLLHOOKSTRUCT, PM_NOREMOVE,
            PeekMessageW, PostMessageW, PostThreadMessageW, RegisterClassW, SWP_ASYNCWINDOWPOS,
            SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
            SetForegroundWindow, SetLayeredWindowAttributes, SetTimer, SetWindowLongPtrW,
            SetWindowPos, SetWindowsHookExW, TPM_BOTTOMALIGN, TPM_LEFTALIGN, TPM_NOANIMATION,
            TPM_NONOTIFY, TPM_RETURNCMD, TrackPopupMenuEx, TranslateMessage, UnhookWindowsHookEx,
            UnregisterClassW, WH_CBT, WH_MOUSE_LL, WM_APP, WM_DRAWITEM, WM_LBUTTONDOWN,
            WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MEASUREITEM, WM_MOUSEMOVE, WM_NULL,
            WM_QUIT, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_TIMER, WM_XBUTTONDOWN, WM_XBUTTONUP,
            WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
            WS_OVERLAPPED,
        },
    },
};
use windows::core::{PCWSTR, w};

const OUTSIDE_CLICK_MESSAGE: u32 = WM_APP + 0x41;
const OUTSIDE_RIGHT_CLICK_MESSAGE: u32 = WM_APP + 0x42;
const MENU_SESSION_START_MESSAGE: u32 = WM_APP + 0x43;
const MENU_SESSION_END_MESSAGE: u32 = WM_APP + 0x44;
const MENU_SESSION_STOP_MESSAGE: u32 = WM_APP + 0x45;
const MENU_SESSION_STYLE_MESSAGE: u32 = WM_APP + 0x46;
const MENU_REARM_TIMER_ID: usize = 0xA11;
const MENU_REARM_DELAY_MS: u32 = 45;
const MENU_PROBE_ITEM_ID: usize = 1;
const RIGHT_CLICK_TRAY_TOGGLE_GRACE: Duration = Duration::from_millis(50);
const HOOK_START_TIMEOUT: Duration = Duration::from_secs(1);
const HOOK_STOP_TIMEOUT: Duration = Duration::from_secs(1);

static TRACKING_ACTIVE: AtomicBool = AtomicBool::new(false);
static TRACKING_GENERATION: AtomicU64 = AtomicU64::new(0);
static POPUP_HWND: AtomicIsize = AtomicIsize::new(0);
static ANCHOR_LEFT: AtomicI32 = AtomicI32::new(0);
static ANCHOR_TOP: AtomicI32 = AtomicI32::new(0);
static ANCHOR_RIGHT: AtomicI32 = AtomicI32::new(0);
static ANCHOR_BOTTOM: AtomicI32 = AtomicI32::new(0);
static HOOK_THREAD_ID: AtomicU32 = AtomicU32::new(0);
static HOOK_OWNER_HWND: AtomicIsize = AtomicIsize::new(0);
static HOOK_STOP_REQUESTED: AtomicBool = AtomicBool::new(false);
static HOOK_SHUTDOWN: AtomicBool = AtomicBool::new(false);
static HOOK_OPERATION: Mutex<()> = Mutex::new(());
static HOOK_WORKER: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);
static WEBVIEW_HWND: AtomicIsize = AtomicIsize::new(0);
static MENU_SESSION_DESIRED: AtomicBool = AtomicBool::new(false);
static MENU_SESSION_ACTIVE: AtomicBool = AtomicBool::new(false);
static MENU_SESSION_GENERATION: AtomicU64 = AtomicU64::new(0);
static MENU_ACTIVE_GENERATION: AtomicU64 = AtomicU64::new(0);
static MENU_STARTING_GENERATION: AtomicU64 = AtomicU64::new(0);
static MENU_START_QUEUED_GENERATION: AtomicU64 = AtomicU64::new(0);
static MENU_REARM_ON_BUTTON_UP: AtomicU32 = AtomicU32::new(0);
static MENU_REARM_TIMER_TOKEN: AtomicUsize = AtomicUsize::new(0);
static MENU_REARM_GENERATION: AtomicU64 = AtomicU64::new(0);
static MENU_PENDING_CLOSE_GENERATION: AtomicU64 = AtomicU64::new(0);
static MENU_PENDING_CLOSE_MESSAGE: AtomicU32 = AtomicU32::new(0);
static MENU_WINDOW_HWND: AtomicIsize = AtomicIsize::new(0);
static CARD_POINTER_INSIDE: AtomicBool = AtomicBool::new(false);
static CARD_LEFT_BUTTON_FORWARDED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ScreenRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

impl ScreenRect {
    pub(crate) fn from_xywh(x: i32, y: i32, width: u32, height: u32) -> Self {
        Self {
            left: x,
            top: y,
            right: clamp_screen_coordinate(i64::from(x) + i64::from(width)),
            bottom: clamp_screen_coordinate(i64::from(y) + i64::from(height)),
        }
    }

    fn from_win32(rect: RECT) -> Self {
        Self {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        }
    }

    fn contains(self, point: POINT) -> bool {
        point.x >= self.left && point.x < self.right && point.y >= self.top && point.y < self.bottom
    }
}

fn clamp_screen_coordinate(value: i64) -> i32 {
    value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

pub(crate) fn harden_webview_noactivate(popup_hwnd: HWND) -> Result<(), String> {
    let render_hwnd = crate::taskbar_lyric::webview_finder::find_webview_hwnd(popup_hwnd)
        .ok_or_else(|| "The tray-player WebView render window was not found.".to_string())?;
    let host_hwnd = unsafe { GetParent(render_hwnd) }.map_err(|error| error.to_string())?;
    let mut host_process_id = 0;
    unsafe {
        GetWindowThreadProcessId(host_hwnd, Some(&mut host_process_id));
    }
    if host_process_id == 0 || host_process_id != unsafe { GetCurrentProcessId() } {
        return Err("The tray-player WebView host window is not owned by this process.".into());
    }

    let old_style = unsafe { GetWindowLongPtrW(host_hwnd, GWL_EXSTYLE) };
    let noactivate = WS_EX_NOACTIVATE.0 as isize;
    if old_style & noactivate == 0 {
        unsafe {
            SetWindowLongPtrW(host_hwnd, GWL_EXSTYLE, old_style | noactivate);
        }
        let applied_style = unsafe { GetWindowLongPtrW(host_hwnd, GWL_EXSTYLE) };
        if applied_style & noactivate == 0 {
            return Err("The tray-player WebView host rejected WS_EX_NOACTIVATE.".into());
        }
        unsafe {
            SetWindowPos(
                host_hwnd,
                None,
                0,
                0,
                0,
                0,
                SWP_ASYNCWINDOWPOS
                    | SWP_FRAMECHANGED
                    | SWP_NOACTIVATE
                    | SWP_NOMOVE
                    | SWP_NOSIZE
                    | SWP_NOZORDER,
            )
        }
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn pointer_down_should_dismiss(
    point: POINT,
    popup_rect: ScreenRect,
    anchor_rect: ScreenRect,
) -> bool {
    !popup_rect.contains(point) && !anchor_rect.contains(point)
}

fn store_anchor_rect(rect: ScreenRect) {
    ANCHOR_LEFT.store(rect.left, Ordering::Relaxed);
    ANCHOR_TOP.store(rect.top, Ordering::Relaxed);
    ANCHOR_RIGHT.store(rect.right, Ordering::Relaxed);
    ANCHOR_BOTTOM.store(rect.bottom, Ordering::Relaxed);
}

fn current_anchor_rect() -> ScreenRect {
    ScreenRect {
        left: ANCHOR_LEFT.load(Ordering::Relaxed),
        top: ANCHOR_TOP.load(Ordering::Relaxed),
        right: ANCHOR_RIGHT.load(Ordering::Relaxed),
        bottom: ANCHOR_BOTTOM.load(Ordering::Relaxed),
    }
}

fn split_generation(generation: u64) -> (WPARAM, LPARAM) {
    (
        WPARAM((generation as u32) as usize),
        LPARAM(((generation >> 32) as u32 as i32) as isize),
    )
}

fn combine_generation(wparam: WPARAM, lparam: LPARAM) -> u64 {
    u64::from(wparam.0 as u32) | (u64::from(lparam.0 as i32 as u32) << 32)
}

fn menu_owner_class_name() -> PCWSTR {
    w!("AMLLTrayMenuCompatibilityOwner")
}

fn is_system_menu_class_name(class_name: &[u16]) -> bool {
    class_name
        == [
            '#' as u16, '3' as u16, '2' as u16, '7' as u16, '6' as u16, '8' as u16,
        ]
}

fn is_system_menu_window(hwnd: HWND) -> bool {
    let mut class_name = [0u16; 16];
    let class_name_length = unsafe { GetClassNameW(hwnd, &mut class_name) };
    class_name_length > 0 && is_system_menu_class_name(&class_name[..class_name_length as usize])
}

fn pointer_button_up_for_down(message: u32) -> Option<u32> {
    match message {
        WM_LBUTTONDOWN => Some(WM_LBUTTONUP),
        WM_RBUTTONDOWN => Some(WM_RBUTTONUP),
        WM_MBUTTONDOWN => Some(WM_MBUTTONUP),
        WM_XBUTTONDOWN => Some(WM_XBUTTONUP),
        _ => None,
    }
}

fn make_mouse_lparam(x: i32, y: i32) -> LPARAM {
    LPARAM(((y as u16 as u32) << 16 | (x as u16 as u32)) as isize)
}

fn cancel_menu_rearm_timer_on_worker() {
    MENU_REARM_GENERATION.store(0, Ordering::Release);
    let timer = MENU_REARM_TIMER_TOKEN.swap(0, Ordering::AcqRel);
    if timer != 0 {
        let _ = unsafe { KillTimer(None, timer) };
    }
}

fn queue_menu_session_start(thread_id: u32, generation: u64) -> Result<(), ()> {
    if generation == 0 {
        return Err(());
    }
    let previous_generation = MENU_START_QUEUED_GENERATION.swap(generation, Ordering::AcqRel);
    if previous_generation == generation {
        return Ok(());
    }
    let (low, high) = split_generation(generation);
    if unsafe { PostThreadMessageW(thread_id, MENU_SESSION_START_MESSAGE, low, high) }.is_err() {
        let _ = MENU_START_QUEUED_GENERATION.compare_exchange(
            generation,
            0,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        return Err(());
    }
    Ok(())
}

fn post_menu_session_end(generation: u64) {
    let owner_ptr = HOOK_OWNER_HWND.load(Ordering::Acquire);
    if owner_ptr == 0 {
        return;
    }
    let (low, high) = split_generation(generation);
    let _ = unsafe {
        PostMessageW(
            Some(HWND(owner_ptr as _)),
            MENU_SESSION_END_MESSAGE,
            low,
            high,
        )
    };
}

fn post_menu_session_stop(thread_id: u32) {
    let owner_ptr = HOOK_OWNER_HWND.load(Ordering::Acquire);
    let delivered_to_owner = owner_ptr != 0
        && unsafe {
            PostMessageW(
                Some(HWND(owner_ptr as _)),
                MENU_SESSION_STOP_MESSAGE,
                WPARAM(0),
                LPARAM(0),
            )
        }
        .is_ok();
    if !delivered_to_owner {
        let _ = unsafe { PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
    }
}

fn post_menu_window_style(hwnd: HWND) -> bool {
    let owner_ptr = HOOK_OWNER_HWND.load(Ordering::Acquire);
    owner_ptr != 0
        && unsafe {
            PostMessageW(
                Some(HWND(owner_ptr as _)),
                MENU_SESSION_STYLE_MESSAGE,
                WPARAM(hwnd.0 as usize),
                LPARAM(0),
            )
        }
        .is_ok()
}

fn mark_menu_session_close(generation: u64, close_message: u32) {
    MENU_SESSION_DESIRED.store(false, Ordering::Release);
    MENU_REARM_ON_BUTTON_UP.store(0, Ordering::Release);
    MENU_PENDING_CLOSE_GENERATION.store(generation, Ordering::Relaxed);
    MENU_PENDING_CLOSE_MESSAGE.store(close_message, Ordering::Release);
}

fn disable_menu_session_if_current(generation: u64) {
    if MENU_SESSION_GENERATION.load(Ordering::Acquire) == generation {
        MENU_SESSION_DESIRED.store(false, Ordering::Release);
    }
}

fn is_forwarded_card_pointer_message(message: u32) -> bool {
    matches!(message, WM_MOUSEMOVE | WM_LBUTTONDOWN | WM_LBUTTONUP)
}

fn forward_menu_pointer_message(point: POINT, message: u32) -> bool {
    if !is_forwarded_card_pointer_message(message) {
        return false;
    }
    let webview_ptr = WEBVIEW_HWND.load(Ordering::Relaxed);
    if webview_ptr == 0 {
        return false;
    }
    let webview_hwnd = HWND(webview_ptr as _);
    if !unsafe { IsWindow(Some(webview_hwnd)) }.as_bool() {
        return false;
    }
    let mut client_point = point;
    if unsafe { ScreenToClient(webview_hwnd, &mut client_point) }.as_bool() {
        let key_state = if message == WM_LBUTTONDOWN
            || (message == WM_MOUSEMOVE && CARD_LEFT_BUTTON_FORWARDED.load(Ordering::Relaxed))
        {
            1
        } else {
            0
        };
        return unsafe {
            PostMessageW(
                Some(webview_hwnd),
                message,
                WPARAM(key_state),
                make_mouse_lparam(client_point.x, client_point.y),
            )
        }
        .is_ok();
    }
    false
}

fn forward_menu_pointer_leave() {
    let webview_ptr = WEBVIEW_HWND.load(Ordering::Relaxed);
    if webview_ptr == 0 {
        return;
    }
    let webview_hwnd = HWND(webview_ptr as _);
    if !unsafe { IsWindow(Some(webview_hwnd)) }.as_bool() {
        return;
    }
    let _ = unsafe {
        PostMessageW(
            Some(webview_hwnd),
            WM_MOUSEMOVE,
            WPARAM(0),
            make_mouse_lparam(-1, -1),
        )
    };
    let _ = unsafe { PostMessageW(Some(webview_hwnd), WM_MOUSELEAVE, WPARAM(0), LPARAM(0)) };
}

fn system_menu_transparent_style() -> isize {
    (WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT).0 as isize
}

fn prepare_system_menu_creation(hwnd: HWND, lparam: LPARAM) {
    if lparam.0 == 0 || !is_system_menu_window(hwnd) {
        return;
    }

    let create_window = unsafe { &mut *(lparam.0 as *mut CBT_CREATEWNDW) };
    if !create_window.lpcs.is_null() {
        unsafe {
            (*create_window.lpcs).dwExStyle.0 |= system_menu_transparent_style() as u32;
        }
    }
}

fn make_system_menu_window_transparent(hwnd: HWND) -> bool {
    if !is_system_menu_window(hwnd) {
        return false;
    }

    let old_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
    let transparent_style = system_menu_transparent_style();
    unsafe {
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, old_style | transparent_style);
    }
    let applied_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
    if applied_style & transparent_style != transparent_style {
        return false;
    }
    if unsafe {
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER,
        )
    }
    .is_err()
    {
        return false;
    }
    if unsafe { SetLayeredWindowAttributes(hwnd, COLORREF(0), 0, LWA_ALPHA) }.is_err() {
        return false;
    }
    MENU_WINDOW_HWND.store(hwnd.0 as isize, Ordering::Release);
    true
}

unsafe extern "system" fn menu_cbt_hook_proc(
    n_code: i32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if MENU_SESSION_ACTIVE.load(Ordering::Acquire)
        && matches!(n_code as u32, HCBT_CREATEWND | HCBT_ACTIVATE)
    {
        let hwnd = HWND(wparam.0 as _);
        if is_system_menu_window(hwnd) {
            if n_code as u32 == HCBT_CREATEWND {
                prepare_system_menu_creation(hwnd, lparam);
                if !post_menu_window_style(hwnd) {
                    let generation = MENU_ACTIVE_GENERATION.load(Ordering::Acquire);
                    disable_menu_session_if_current(generation);
                    post_menu_session_end(generation);
                }
            } else if !make_system_menu_window_transparent(hwnd) {
                let generation = MENU_ACTIVE_GENERATION.load(Ordering::Acquire);
                disable_menu_session_if_current(generation);
                post_menu_session_end(generation);
            }
        }
    }
    unsafe { CallNextHookEx(None, n_code, wparam, lparam) }
}

unsafe extern "system" fn menu_owner_wnd_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        MENU_SESSION_STYLE_MESSAGE => {
            if MENU_SESSION_ACTIVE.load(Ordering::Acquire) {
                let menu_hwnd = HWND(wparam.0 as _);
                if !make_system_menu_window_transparent(menu_hwnd) {
                    let generation = MENU_ACTIVE_GENERATION.load(Ordering::Acquire);
                    disable_menu_session_if_current(generation);
                    let _ = unsafe { EndMenu() };
                }
            }
            LRESULT(0)
        }
        MENU_SESSION_END_MESSAGE => {
            let requested_generation = combine_generation(wparam, lparam);
            if requested_generation == 0
                || MENU_ACTIVE_GENERATION.load(Ordering::Acquire) == requested_generation
            {
                cancel_menu_rearm_timer_on_worker();
                MENU_REARM_ON_BUTTON_UP.store(0, Ordering::Release);
                if MENU_SESSION_ACTIVE.load(Ordering::Acquire) {
                    let _ = unsafe { EndMenu() };
                }
            }
            LRESULT(0)
        }
        MENU_SESSION_STOP_MESSAGE => {
            HOOK_STOP_REQUESTED.store(true, Ordering::Release);
            MENU_SESSION_DESIRED.store(false, Ordering::Release);
            cancel_menu_rearm_timer_on_worker();
            MENU_REARM_ON_BUTTON_UP.store(0, Ordering::Release);
            if MENU_SESSION_ACTIVE.load(Ordering::Acquire) {
                let _ = unsafe { EndMenu() };
            }
            LRESULT(0)
        }
        WM_MEASUREITEM if lparam.0 != 0 => {
            let measure = unsafe { &mut *(lparam.0 as *mut MEASUREITEMSTRUCT) };
            if measure.CtlType == ODT_MENU {
                // The item only keeps the HMENU valid. The CBT hook makes the
                // system menu window fully transparent; keep its hit area tiny
                // so it cannot cover the WebView card if transparency fails.
                measure.itemWidth = 1;
                measure.itemHeight = 1;
                return LRESULT(1);
            }
            unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
        }
        WM_DRAWITEM => LRESULT(1),
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

fn create_menu_owner_window() -> Result<(HWND, HINSTANCE), String> {
    let module = unsafe { GetModuleHandleW(None) }.map_err(|error| error.to_string())?;
    let instance = HINSTANCE(module.0);
    let class_name = menu_owner_class_name();
    let window_class = WNDCLASSW {
        lpfnWndProc: Some(menu_owner_wnd_proc),
        hInstance: instance,
        lpszClassName: class_name,
        ..Default::default()
    };
    // A previous worker can leave the process-wide class registered if it
    // terminated unexpectedly. CreateWindowExW below is authoritative.
    unsafe {
        RegisterClassW(&raw const window_class);
    }
    let owner = unsafe {
        CreateWindowExW(
            WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT,
            class_name,
            w!(""),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            None,
            None,
            Some(instance),
            None,
        )
    }
    .map_err(|error| error.to_string())?;
    let _ = unsafe { SetLayeredWindowAttributes(owner, COLORREF(0), 0, LWA_ALPHA) };
    Ok((owner, instance))
}

fn destroy_menu_owner_window(owner: HWND, instance: HINSTANCE) {
    let _ = unsafe { DestroyWindow(owner) };
    let _ = unsafe { UnregisterClassW(menu_owner_class_name(), Some(instance)) };
}

fn is_pointer_dismiss_message(message: u32) -> bool {
    matches!(
        message,
        WM_LBUTTONDOWN | WM_RBUTTONUP | WM_MBUTTONDOWN | WM_XBUTTONDOWN
    )
}

fn schedule_generation_close(app: AppHandle, generation: u64, delay: Duration) {
    tauri::async_runtime::spawn(async move {
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        if HOOK_SHUTDOWN.load(Ordering::Acquire) {
            return;
        }
        let task_app = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            crate::window::hide_background_tray_player_if_generation(&task_app, generation);
        }) {
            tracing::warn!("Failed to schedule tray-player outside-click close: {error}");
        }
    });
}

fn menu_session_is_current(generation: u64) -> bool {
    !HOOK_STOP_REQUESTED.load(Ordering::Acquire)
        && !HOOK_SHUTDOWN.load(Ordering::Acquire)
        && TRACKING_ACTIVE.load(Ordering::Acquire)
        && MENU_SESSION_DESIRED.load(Ordering::Acquire)
        && TRACKING_GENERATION.load(Ordering::Relaxed) == generation
        && MENU_SESSION_GENERATION.load(Ordering::Relaxed) == generation
}

fn run_hidden_menu_session(app: &AppHandle, owner: HWND, thread_id: u32, generation: u64) {
    if !menu_session_is_current(generation) {
        return;
    }

    let menu = match unsafe { CreatePopupMenu() } {
        Ok(menu) => menu,
        Err(error) => {
            disable_menu_session_if_current(generation);
            tracing::warn!("Failed to create the tray HMENU compatibility session: {error}");
            return;
        }
    };
    if let Err(error) = unsafe {
        AppendMenuW(
            menu,
            MF_OWNERDRAW | MF_DISABLED | MF_GRAYED,
            MENU_PROBE_ITEM_ID,
            PCWSTR::null(),
        )
    } {
        let _ = unsafe { DestroyMenu(menu) };
        disable_menu_session_if_current(generation);
        tracing::warn!("Failed to populate the tray HMENU compatibility session: {error}");
        return;
    }

    let cbt_hook = match unsafe {
        SetWindowsHookExW(WH_CBT, Some(menu_cbt_hook_proc), None, thread_id)
    } {
        Ok(hook) => hook,
        Err(error) => {
            let _ = unsafe { DestroyMenu(menu) };
            disable_menu_session_if_current(generation);
            tracing::warn!(
                "Failed to install the tray HMENU transparency hook; keeping only the custom card: {error}"
            );
            return;
        }
    };

    MENU_WINDOW_HWND.store(0, Ordering::Release);
    if !menu_session_is_current(generation) {
        let _ = unsafe { UnhookWindowsHookEx(cbt_hook) };
        let _ = unsafe { DestroyMenu(menu) };
        return;
    }
    MENU_ACTIVE_GENERATION.store(generation, Ordering::Relaxed);
    MENU_SESSION_ACTIVE.store(true, Ordering::Release);
    let started_at = Instant::now();
    if !unsafe { SetForegroundWindow(owner) }.as_bool() {
        tracing::debug!("The tray HMENU compatibility owner could not become foreground");
    }
    let anchor = current_anchor_rect();
    let _ = unsafe {
        TrackPopupMenuEx(
            menu,
            (TPM_BOTTOMALIGN | TPM_LEFTALIGN | TPM_NONOTIFY | TPM_RETURNCMD | TPM_NOANIMATION).0,
            anchor.left,
            anchor.top,
            owner,
            None,
        )
    };
    MENU_SESSION_ACTIVE.store(false, Ordering::Release);
    MENU_ACTIVE_GENERATION.store(0, Ordering::Release);
    let observed_menu_window = MENU_WINDOW_HWND.swap(0, Ordering::AcqRel) != 0;
    let _ = unsafe { UnhookWindowsHookEx(cbt_hook) };
    let _ = unsafe { DestroyMenu(menu) };
    let _ = unsafe { PostMessageW(Some(owner), WM_NULL, WPARAM(0), LPARAM(0)) };

    if !observed_menu_window {
        disable_menu_session_if_current(generation);
        tracing::warn!(
            "The tray HMENU compatibility session ended without a transparent #32768 window; the custom card remains active"
        );
    } else {
        tracing::debug!(
            elapsed_ms = started_at.elapsed().as_millis(),
            generation,
            "Tray HMENU compatibility session ended"
        );
    }

    let pending_message = MENU_PENDING_CLOSE_MESSAGE.swap(0, Ordering::AcqRel);
    // The message is the release-published ready flag for the accompanying
    // generation. Acquire it first so an outside click cannot be lost on a
    // weakly ordered CPU.
    let pending_generation = MENU_PENDING_CLOSE_GENERATION.swap(0, Ordering::AcqRel);
    if pending_generation != 0
        && matches!(
            pending_message,
            OUTSIDE_CLICK_MESSAGE | OUTSIDE_RIGHT_CLICK_MESSAGE
        )
    {
        let delay = if pending_message == OUTSIDE_RIGHT_CLICK_MESSAGE {
            RIGHT_CLICK_TRAY_TOGGLE_GRACE
        } else {
            Duration::ZERO
        };
        // The visible card can advance to a newer generation while an older
        // TrackPopupMenuEx loop is still unwinding. The hide operation is
        // generation-safe, so preserve and dispatch the generation that the
        // outside click actually observed instead of dropping it here.
        schedule_generation_close(app.clone(), pending_generation, delay);
    }

    let next_generation = MENU_SESSION_GENERATION.load(Ordering::Acquire);
    if MENU_SESSION_DESIRED.load(Ordering::Acquire)
        && next_generation != generation
        && TRACKING_ACTIVE.load(Ordering::Acquire)
        && TRACKING_GENERATION.load(Ordering::Relaxed) == next_generation
    {
        if queue_menu_session_start(thread_id, next_generation).is_err() {
            disable_menu_session_if_current(next_generation);
            tracing::warn!(
                "Failed to re-arm the tray HMENU compatibility session after a generation change"
            );
        }
    }
}

fn wait_for_worker(
    worker: std::thread::JoinHandle<()>,
    timeout: Duration,
) -> Result<(), std::thread::JoinHandle<()>> {
    let deadline = Instant::now() + timeout;
    while !worker.is_finished() {
        if Instant::now() >= deadline {
            return Err(worker);
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    if worker.join().is_err() {
        tracing::error!("Tray-player outside-click worker panicked");
    }
    Ok(())
}

fn ensure_hook_worker_locked(app: &AppHandle) -> Result<(), String> {
    let previous_worker = HOOK_WORKER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    if let Some(worker) = previous_worker {
        if worker.is_finished() {
            let _ = wait_for_worker(worker, Duration::ZERO);
            HOOK_THREAD_ID.store(0, Ordering::Release);
            HOOK_STOP_REQUESTED.store(false, Ordering::Release);
        } else if HOOK_THREAD_ID.load(Ordering::Acquire) != 0
            && !HOOK_STOP_REQUESTED.load(Ordering::Acquire)
        {
            *HOOK_WORKER
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(worker);
            return Ok(());
        } else if let Err(worker) = wait_for_worker(worker, HOOK_STOP_TIMEOUT) {
            *HOOK_WORKER
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(worker);
            return Err("The previous tray-player outside-click worker is still stopping.".into());
        } else {
            HOOK_THREAD_ID.store(0, Ordering::Release);
            HOOK_STOP_REQUESTED.store(false, Ordering::Release);
        }
    } else if HOOK_THREAD_ID.swap(0, Ordering::AcqRel) != 0 {
        tracing::warn!("Recovered a stale tray-player outside-click worker id");
    }

    HOOK_STOP_REQUESTED.store(false, Ordering::Release);
    let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<u32, String>>(1);
    let worker_app = app.clone();
    let worker = std::thread::spawn(move || unsafe {
        let thread_id = GetCurrentThreadId();
        let mut message = MSG::default();
        let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);

        let (owner, owner_instance) = match create_menu_owner_window() {
            Ok(owner) => owner,
            Err(error) => {
                let _ = ready_tx.send(Err(format!(
                    "Failed to create the tray HMENU compatibility owner: {error}"
                )));
                return;
            }
        };

        let hook = match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), None, 0) {
            Ok(hook) => hook,
            Err(error) => {
                destroy_menu_owner_window(owner, owner_instance);
                let _ = ready_tx.send(Err(format!(
                    "Failed to install the tray-player outside-click hook: {error}"
                )));
                return;
            }
        };

        HOOK_OWNER_HWND.store(owner.0 as isize, Ordering::Release);
        HOOK_THREAD_ID.store(thread_id, Ordering::Release);
        if ready_tx.send(Ok(thread_id)).is_err() {
            HOOK_OWNER_HWND.store(0, Ordering::Release);
            HOOK_THREAD_ID.store(0, Ordering::Release);
            let _ = UnhookWindowsHookEx(hook);
            destroy_menu_owner_window(owner, owner_instance);
            return;
        }

        while !HOOK_STOP_REQUESTED.load(Ordering::Acquire) {
            let result = GetMessageW(&mut message, None, 0, 0);
            if result.0 == 0 || result.0 == -1 {
                break;
            }
            if message.message == MENU_SESSION_START_MESSAGE {
                let generation = combine_generation(message.wParam, message.lParam);
                if MENU_START_QUEUED_GENERATION.load(Ordering::Acquire) != generation {
                    continue;
                }
                MENU_STARTING_GENERATION.store(generation, Ordering::Release);
                if MENU_START_QUEUED_GENERATION
                    .compare_exchange(generation, 0, Ordering::AcqRel, Ordering::Acquire)
                    .is_err()
                {
                    let _ = MENU_STARTING_GENERATION.compare_exchange(
                        generation,
                        0,
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    );
                    continue;
                }
                run_hidden_menu_session(&worker_app, owner, thread_id, generation);
                let _ = MENU_STARTING_GENERATION.compare_exchange(
                    generation,
                    0,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                );
                let next_generation = MENU_SESSION_GENERATION.load(Ordering::Acquire);
                if MENU_SESSION_DESIRED.load(Ordering::Acquire)
                    && next_generation != generation
                    && TRACKING_ACTIVE.load(Ordering::Acquire)
                    && TRACKING_GENERATION.load(Ordering::Relaxed) == next_generation
                    && queue_menu_session_start(thread_id, next_generation).is_err()
                {
                    disable_menu_session_if_current(next_generation);
                    tracing::warn!("Failed to arm the latest tray HMENU compatibility generation");
                }
                continue;
            }
            if message.message == WM_TIMER
                && message.wParam.0 == MENU_REARM_TIMER_TOKEN.load(Ordering::Acquire)
            {
                let generation = MENU_REARM_GENERATION.load(Ordering::Acquire);
                cancel_menu_rearm_timer_on_worker();
                if generation != 0
                    && MENU_SESSION_DESIRED.load(Ordering::Acquire)
                    && TRACKING_ACTIVE.load(Ordering::Acquire)
                    && MENU_SESSION_GENERATION.load(Ordering::Relaxed) == generation
                    && TRACKING_GENERATION.load(Ordering::Relaxed) == generation
                    && queue_menu_session_start(thread_id, generation).is_err()
                {
                    disable_menu_session_if_current(generation);
                    tracing::warn!("Failed to re-arm the tray HMENU compatibility timer");
                }
                continue;
            }
            if matches!(
                message.message,
                OUTSIDE_CLICK_MESSAGE | OUTSIDE_RIGHT_CLICK_MESSAGE
            ) {
                let generation = combine_generation(message.wParam, message.lParam);
                let delay = if message.message == OUTSIDE_RIGHT_CLICK_MESSAGE {
                    RIGHT_CLICK_TRAY_TOGGLE_GRACE
                } else {
                    Duration::ZERO
                };
                schedule_generation_close(worker_app.clone(), generation, delay);
                continue;
            }
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }

        HOOK_STOP_REQUESTED.store(true, Ordering::Release);
        MENU_SESSION_DESIRED.store(false, Ordering::Release);
        MENU_SESSION_ACTIVE.store(false, Ordering::Release);
        MENU_SESSION_GENERATION.store(0, Ordering::Release);
        MENU_ACTIVE_GENERATION.store(0, Ordering::Release);
        MENU_STARTING_GENERATION.store(0, Ordering::Release);
        MENU_START_QUEUED_GENERATION.store(0, Ordering::Release);
        MENU_REARM_ON_BUTTON_UP.store(0, Ordering::Release);
        cancel_menu_rearm_timer_on_worker();
        let interrupted_generation = TRACKING_GENERATION.load(Ordering::Relaxed);
        let interrupted_while_active = TRACKING_ACTIVE.swap(false, Ordering::AcqRel);
        HOOK_OWNER_HWND
            .compare_exchange(owner.0 as isize, 0, Ordering::AcqRel, Ordering::Acquire)
            .ok();
        HOOK_THREAD_ID
            .compare_exchange(thread_id, 0, Ordering::AcqRel, Ordering::Acquire)
            .ok();
        let _ = UnhookWindowsHookEx(hook);
        destroy_menu_owner_window(owner, owner_instance);
        HOOK_STOP_REQUESTED.store(false, Ordering::Release);
        if interrupted_while_active && interrupted_generation != 0 {
            let app = worker_app.clone();
            if let Err(error) = worker_app.run_on_main_thread(move || {
                crate::window::hide_background_tray_player_if_generation(
                    &app,
                    interrupted_generation,
                );
            }) {
                tracing::warn!("Failed to close tray player after hook worker exit: {error}");
            }
        }
    });

    match ready_rx.recv_timeout(HOOK_START_TIMEOUT) {
        Ok(Ok(thread_id))
            if HOOK_THREAD_ID.load(Ordering::Acquire) == thread_id && !worker.is_finished() =>
        {
            *HOOK_WORKER
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(worker);
            Ok(())
        }
        Ok(Ok(_)) => {
            if let Err(worker) = wait_for_worker(worker, HOOK_STOP_TIMEOUT) {
                *HOOK_WORKER
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(worker);
            }
            Err("The tray-player outside-click worker exited during startup.".into())
        }
        Ok(Err(error)) => {
            if let Err(worker) = wait_for_worker(worker, HOOK_STOP_TIMEOUT) {
                *HOOK_WORKER
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(worker);
            }
            Err(error)
        }
        Err(error) => {
            let thread_id = HOOK_THREAD_ID.load(Ordering::Acquire);
            if thread_id != 0 {
                HOOK_STOP_REQUESTED.store(true, Ordering::Release);
                post_menu_session_stop(thread_id);
            }
            if let Err(worker) = wait_for_worker(worker, HOOK_STOP_TIMEOUT) {
                *HOOK_WORKER
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(worker);
            }
            Err(format!(
                "Timed out while starting the tray-player outside-click worker: {error}"
            ))
        }
    }
}

pub(crate) fn activate(
    app: &AppHandle,
    popup_hwnd: HWND,
    generation: u64,
    anchor_rect: ScreenRect,
) -> Result<bool, String> {
    let _operation = HOOK_OPERATION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if HOOK_SHUTDOWN.load(Ordering::Acquire) {
        return Err("The tray-player outside-click watcher is shutting down.".into());
    }
    ensure_hook_worker_locked(app)?;
    if !crate::window::background_tray_player_activation_is_current(app, generation) {
        return Ok(false);
    }
    let previous_menu_generation = MENU_SESSION_GENERATION.load(Ordering::Acquire);
    MENU_SESSION_DESIRED.store(false, Ordering::Release);
    MENU_REARM_ON_BUTTON_UP.store(0, Ordering::Release);
    if previous_menu_generation != 0 {
        post_menu_session_end(previous_menu_generation);
    }
    TRACKING_ACTIVE.store(false, Ordering::Release);
    POPUP_HWND.store(popup_hwnd.0 as isize, Ordering::Relaxed);
    CARD_POINTER_INSIDE.store(false, Ordering::Relaxed);
    CARD_LEFT_BUTTON_FORWARDED.store(false, Ordering::Relaxed);
    WEBVIEW_HWND.store(
        crate::taskbar_lyric::webview_finder::find_webview_hwnd(popup_hwnd)
            .map(|hwnd| hwnd.0 as isize)
            .unwrap_or_default(),
        Ordering::Relaxed,
    );
    TRACKING_GENERATION.store(generation, Ordering::Relaxed);
    store_anchor_rect(anchor_rect);
    TRACKING_ACTIVE.store(true, Ordering::Release);
    Ok(true)
}

pub(crate) fn begin_menu_session(app: &AppHandle, generation: u64) -> Result<bool, String> {
    let _operation = HOOK_OPERATION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if HOOK_SHUTDOWN.load(Ordering::Acquire) {
        return Err("The tray HMENU compatibility session is shutting down.".into());
    }
    if !crate::window::background_tray_player_activation_is_current(app, generation)
        || !TRACKING_ACTIVE.load(Ordering::Acquire)
        || TRACKING_GENERATION.load(Ordering::Relaxed) != generation
    {
        return Ok(false);
    }
    let thread_id = HOOK_THREAD_ID.load(Ordering::Acquire);
    if thread_id == 0 || HOOK_OWNER_HWND.load(Ordering::Acquire) == 0 {
        return Err("The tray HMENU compatibility worker is unavailable.".into());
    }

    MENU_PENDING_CLOSE_GENERATION.store(0, Ordering::Relaxed);
    MENU_PENDING_CLOSE_MESSAGE.store(0, Ordering::Relaxed);
    MENU_REARM_ON_BUTTON_UP.store(0, Ordering::Relaxed);
    MENU_REARM_GENERATION.store(0, Ordering::Relaxed);
    MENU_SESSION_GENERATION.store(generation, Ordering::Relaxed);
    MENU_SESSION_DESIRED.store(true, Ordering::Release);
    if MENU_SESSION_ACTIVE.load(Ordering::Acquire) {
        let active_generation = MENU_ACTIVE_GENERATION.load(Ordering::Acquire);
        if active_generation != 0 {
            post_menu_session_end(active_generation);
        }
        return Ok(true);
    }
    let starting_generation = MENU_STARTING_GENERATION.load(Ordering::Acquire);
    if starting_generation != 0 {
        if starting_generation != generation {
            post_menu_session_end(starting_generation);
        }
        return Ok(true);
    }
    if queue_menu_session_start(thread_id, generation).is_err() {
        MENU_SESSION_DESIRED.store(false, Ordering::Release);
        return Err("Failed to start the tray HMENU compatibility session.".into());
    }
    Ok(true)
}

fn deactivate_locked() {
    MENU_SESSION_DESIRED.store(false, Ordering::Release);
    MENU_REARM_ON_BUTTON_UP.store(0, Ordering::Release);
    MENU_REARM_GENERATION.store(0, Ordering::Release);
    // Deactivation invalidates every generation, so ending whichever menu is
    // active is safe and avoids targeting a newer desired generation while an
    // older TrackPopupMenuEx call is still entering its loop.
    post_menu_session_end(0);
    TRACKING_ACTIVE.store(false, Ordering::Release);
    TRACKING_GENERATION.store(0, Ordering::Relaxed);
    POPUP_HWND.store(0, Ordering::Relaxed);
    CARD_LEFT_BUTTON_FORWARDED.store(false, Ordering::Release);
    if CARD_POINTER_INSIDE.swap(false, Ordering::AcqRel) {
        forward_menu_pointer_leave();
    }
    WEBVIEW_HWND.store(0, Ordering::Relaxed);
}

pub(crate) fn deactivate() {
    let _operation = HOOK_OPERATION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    deactivate_locked();
}

pub(crate) fn stop() {
    HOOK_SHUTDOWN.store(true, Ordering::Release);
    {
        let _operation = HOOK_OPERATION
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        deactivate_locked();
        let thread_id = HOOK_THREAD_ID.load(Ordering::Acquire);
        if thread_id != 0 {
            HOOK_STOP_REQUESTED.store(true, Ordering::Release);
            post_menu_session_stop(thread_id);
        }
        let worker = HOOK_WORKER
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(worker) = worker
            && let Err(worker) = wait_for_worker(worker, HOOK_STOP_TIMEOUT)
        {
            tracing::warn!("Tray-player outside-click worker did not stop before timeout");
            *HOOK_WORKER
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(worker);
        }
    }
}

unsafe extern "system" fn mouse_hook_proc(n_code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if n_code >= 0 && TRACKING_ACTIVE.load(Ordering::Acquire) {
        let message = wparam.0 as u32;
        let popup_ptr = POPUP_HWND.load(Ordering::Relaxed);
        let generation = TRACKING_GENERATION.load(Ordering::Relaxed);
        if popup_ptr != 0 && generation != 0 {
            let mut popup_rect = RECT::default();
            if unsafe { GetWindowRect(HWND(popup_ptr as _), &mut popup_rect) }.is_ok() {
                let point = unsafe { (*(lparam.0 as *const MSLLHOOKSTRUCT)).pt };
                let popup_rect = ScreenRect::from_win32(popup_rect);
                let anchor_rect = current_anchor_rect();
                let inside_popup = popup_rect.contains(point);
                let inside_anchor = anchor_rect.contains(point);
                let menu_active = MENU_SESSION_ACTIVE.load(Ordering::Acquire)
                    && MENU_ACTIVE_GENERATION.load(Ordering::Relaxed) == generation;

                if menu_active && message == WM_MOUSEMOVE {
                    if inside_popup {
                        CARD_POINTER_INSIDE.store(true, Ordering::Release);
                        let _ = forward_menu_pointer_message(point, message);
                    } else if CARD_POINTER_INSIDE.swap(false, Ordering::AcqRel) {
                        forward_menu_pointer_leave();
                    }
                }

                if menu_active && inside_popup && message == WM_LBUTTONDOWN {
                    // Keep the genuine HMENU session alive so Explorer keeps
                    // treating the tray interaction as active. The WebView
                    // receives the same pointer sequence and remains the sole
                    // visible/interactive UI. Swallowing the physical press
                    // prevents both the menu loop and Explorer from treating
                    // the custom card as an outside click.
                    CARD_LEFT_BUTTON_FORWARDED.store(true, Ordering::Release);
                    if forward_menu_pointer_message(point, message) {
                        CARD_POINTER_INSIDE.store(true, Ordering::Release);
                        return LRESULT(1);
                    }
                    CARD_LEFT_BUTTON_FORWARDED.store(false, Ordering::Release);
                }

                if menu_active && message == WM_LBUTTONUP {
                    let forwarded_press = CARD_LEFT_BUTTON_FORWARDED.swap(false, Ordering::AcqRel);
                    if inside_popup || forwarded_press {
                        let delivered = forward_menu_pointer_message(point, message);
                        if !inside_popup && CARD_POINTER_INSIDE.swap(false, Ordering::AcqRel) {
                            forward_menu_pointer_leave();
                        }
                        if delivered {
                            return LRESULT(1);
                        }
                        if forwarded_press {
                            // The synthetic down was already consumed, so an
                            // undeliverable up must fall back to the physical
                            // WebView path instead of leaving it pressed. End
                            // this failed compatibility session and let the up
                            // continue through the normal hook chain.
                            disable_menu_session_if_current(generation);
                            let _ = unsafe { EndMenu() };
                            return unsafe { CallNextHookEx(None, n_code, wparam, lparam) };
                        }
                    }
                }

                if menu_active && let Some(button_up) = pointer_button_up_for_down(message) {
                    if inside_popup || inside_anchor {
                        // End the native capture before this physical press is
                        // queued. Once its matching button-up has reached the
                        // WebView/tray, a short timer re-arms the HMENU session.
                        MENU_REARM_ON_BUTTON_UP.store(button_up, Ordering::Release);
                    } else {
                        let close_message = if message == WM_RBUTTONDOWN {
                            OUTSIDE_RIGHT_CLICK_MESSAGE
                        } else {
                            OUTSIDE_CLICK_MESSAGE
                        };
                        mark_menu_session_close(generation, close_message);
                    }
                    let _ = unsafe { EndMenu() };
                    return unsafe { CallNextHookEx(None, n_code, wparam, lparam) };
                }

                let expected_button_up = MENU_REARM_ON_BUTTON_UP.load(Ordering::Acquire);
                if expected_button_up != 0 && message == expected_button_up {
                    MENU_REARM_ON_BUTTON_UP.store(0, Ordering::Release);
                    if MENU_SESSION_DESIRED.load(Ordering::Acquire)
                        && TRACKING_GENERATION.load(Ordering::Relaxed) == generation
                    {
                        let timer = unsafe {
                            cancel_menu_rearm_timer_on_worker();
                            MENU_REARM_GENERATION.store(generation, Ordering::Release);
                            SetTimer(None, MENU_REARM_TIMER_ID, MENU_REARM_DELAY_MS, None)
                        };
                        MENU_REARM_TIMER_TOKEN.store(timer, Ordering::Release);
                        if timer == 0 {
                            MENU_REARM_GENERATION.store(0, Ordering::Release);
                            MENU_SESSION_DESIRED.store(false, Ordering::Release);
                        }
                    }
                }

                if is_pointer_dismiss_message(message)
                    && pointer_down_should_dismiss(point, popup_rect, anchor_rect)
                    && TRACKING_ACTIVE.load(Ordering::Acquire)
                    && TRACKING_GENERATION.load(Ordering::Relaxed) == generation
                {
                    let close_message = if message == WM_RBUTTONUP {
                        OUTSIDE_RIGHT_CLICK_MESSAGE
                    } else {
                        OUTSIDE_CLICK_MESSAGE
                    };
                    // Publish the close before touching the worker queue. This
                    // also cancels a start that was queued but has not entered
                    // TrackPopupMenuEx yet. EndMenu is harmless without an
                    // active menu and synchronously releases either the
                    // current session or an older session still unwinding.
                    mark_menu_session_close(generation, close_message);
                    let _ = unsafe { EndMenu() };
                    if menu_active {
                        return unsafe { CallNextHookEx(None, n_code, wparam, lparam) };
                    }
                    let thread_id = HOOK_THREAD_ID.load(Ordering::Acquire);
                    if thread_id != 0 {
                        let (generation_low, generation_high) = split_generation(generation);
                        let _ = unsafe {
                            PostThreadMessageW(
                                thread_id,
                                close_message,
                                generation_low,
                                generation_high,
                            )
                        };
                    }
                }
            }
        }
    }

    unsafe { CallNextHookEx(None, n_code, wparam, lparam) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dismisses_only_pointer_downs_outside_popup_and_tray_anchor() {
        let popup = ScreenRect::from_xywh(100, 100, 380, 192);
        let anchor = ScreenRect::from_xywh(300, 330, 24, 24);

        assert!(!pointer_down_should_dismiss(
            POINT { x: 100, y: 100 },
            popup,
            anchor
        ));
        assert!(!pointer_down_should_dismiss(
            POINT { x: 479, y: 291 },
            popup,
            anchor
        ));
        assert!(!pointer_down_should_dismiss(
            POINT { x: 311, y: 341 },
            popup,
            anchor
        ));
        assert!(pointer_down_should_dismiss(
            POINT { x: 480, y: 291 },
            popup,
            anchor
        ));
        assert!(pointer_down_should_dismiss(
            POINT { x: 479, y: 292 },
            popup,
            anchor
        ));
        assert!(pointer_down_should_dismiss(
            POINT { x: 99, y: 100 },
            popup,
            anchor
        ));
    }

    #[test]
    fn supports_negative_monitor_coordinates() {
        let popup = ScreenRect::from_xywh(-900, -500, 380, 192);
        let anchor = ScreenRect::from_xywh(-700, -270, 24, 24);

        assert!(!pointer_down_should_dismiss(
            POINT { x: -850, y: -450 },
            popup,
            anchor
        ));
        assert!(pointer_down_should_dismiss(
            POINT { x: 0, y: 0 },
            popup,
            anchor
        ));
    }

    #[test]
    fn transports_full_visibility_generation_through_thread_message() {
        for generation in [
            0,
            1,
            u32::MAX as u64,
            u32::MAX as u64 + 1,
            0x8000_0000_0000_0000,
            0xfedc_ba98_7654_3210,
            u64::MAX,
        ] {
            let (low, high) = split_generation(generation);
            assert_eq!(combine_generation(low, high), generation);
        }
    }

    #[test]
    fn maps_each_pointer_press_to_its_matching_release() {
        assert_eq!(
            pointer_button_up_for_down(WM_LBUTTONDOWN),
            Some(WM_LBUTTONUP)
        );
        assert_eq!(
            pointer_button_up_for_down(WM_RBUTTONDOWN),
            Some(WM_RBUTTONUP)
        );
        assert_eq!(
            pointer_button_up_for_down(WM_MBUTTONDOWN),
            Some(WM_MBUTTONUP)
        );
        assert_eq!(
            pointer_button_up_for_down(WM_XBUTTONDOWN),
            Some(WM_XBUTTONUP)
        );
        assert_eq!(pointer_button_up_for_down(WM_MOUSEMOVE), None);
    }

    #[test]
    fn forwards_only_pointer_messages_needed_by_the_custom_card() {
        assert!(is_forwarded_card_pointer_message(WM_MOUSEMOVE));
        assert!(is_forwarded_card_pointer_message(WM_LBUTTONDOWN));
        assert!(is_forwarded_card_pointer_message(WM_LBUTTONUP));
        assert!(!is_forwarded_card_pointer_message(WM_RBUTTONDOWN));
        assert!(!is_forwarded_card_pointer_message(WM_MBUTTONDOWN));
        assert!(!is_forwarded_card_pointer_message(WM_XBUTTONDOWN));
    }

    #[test]
    fn defers_right_click_dismissal_until_button_up() {
        assert!(!is_pointer_dismiss_message(
            windows::Win32::UI::WindowsAndMessaging::WM_RBUTTONDOWN
        ));
        assert!(is_pointer_dismiss_message(WM_RBUTTONUP));
    }
}
