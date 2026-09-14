use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicIsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    Graphics::Gdi::ClientToScreen,
    System::Threading::GetCurrentThreadId,
    UI::{
        Controls::WM_MOUSELEAVE,
        WindowsAndMessaging::{
            CallNextHookEx, DispatchMessageW, GetClientRect, GetMessageW, IsWindow, MSLLHOOKSTRUCT,
            PM_NOREMOVE, PeekMessageW, PostMessageW, PostQuitMessage, PostThreadMessageW,
            SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, WH_MOUSE_LL, WM_LBUTTONDOWN,
            WM_LBUTTONUP, WM_MOUSEMOVE, WM_QUIT, WM_RBUTTONDOWN, WM_RBUTTONUP,
        },
    },
};

static TOP_HWND: AtomicIsize = AtomicIsize::new(0);
static WEBVIEW_HWND: AtomicIsize = AtomicIsize::new(0);
static IS_FORWARDING: AtomicBool = AtomicBool::new(false);
static INTERCEPT_CLICKS: AtomicBool = AtomicBool::new(false);
static WAS_INSIDE: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Default)]
struct HookLifecycleState {
    generation: u64,
    thread_id: Option<u32>,
}

impl HookLifecycleState {
    fn advance_generation(&mut self) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        if self.generation == 0 {
            self.generation = 1;
        }
        self.generation
    }

    fn begin_worker(&mut self) -> (u64, Option<u32>) {
        let previous_thread_id = self.thread_id.take();
        let generation = self.advance_generation();
        (generation, previous_thread_id)
    }

    fn stop_worker(&mut self) -> Option<u32> {
        self.advance_generation();
        self.thread_id.take()
    }

    fn current_thread_id(&self) -> Option<u32> {
        self.thread_id
    }

    fn cancel_worker(&mut self, generation: u64) -> Option<u32> {
        if self.generation != generation {
            return None;
        }
        self.advance_generation();
        self.thread_id.take()
    }

    fn register_worker(&mut self, generation: u64, thread_id: u32) -> bool {
        if self.generation != generation || self.thread_id.is_some() {
            return false;
        }
        self.thread_id = Some(thread_id);
        true
    }

    fn finish_worker(&mut self, generation: u64, thread_id: u32) -> bool {
        if self.generation != generation || self.thread_id != Some(thread_id) {
            return false;
        }
        self.thread_id = None;
        true
    }
}

static HOOK_LIFECYCLE: Mutex<HookLifecycleState> = Mutex::new(HookLifecycleState {
    generation: 0,
    thread_id: None,
});
static HOOK_OPERATION: Mutex<()> = Mutex::new(());
static HOOK_WORKER_HANDLE: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);
const HOOK_START_TIMEOUT: Duration = Duration::from_secs(1);
const HOOK_STOP_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WebviewBounds {
    left: i32,
    right: i32,
    top: i32,
    bottom: i32,
}

impl WebviewBounds {
    fn contains(self, point: POINT, padding: i32) -> bool {
        point.x >= self.left - padding
            && point.x < self.right + padding
            && point.y >= self.top - padding
            && point.y < self.bottom + padding
    }
}

// Publish all four coordinates together; the hook must not combine two layouts.
static WEBVIEW_BOUNDS: Mutex<Option<(isize, WebviewBounds)>> = Mutex::new(None);

fn make_lparam(x: i32, y: i32) -> LPARAM {
    LPARAM(((y as u16 as u32) << 16 | (x as u16 as u32)) as isize)
}

fn webview_bounds_are_usable(top_left: POINT, bottom_right: POINT) -> bool {
    bottom_right.x > top_left.x && bottom_right.y > top_left.y
}

fn forwarding_target_needs_recovery(
    target_is_valid: bool,
    message_delivery_succeeded: bool,
) -> bool {
    !target_is_valid || !message_delivery_succeeded
}

fn request_forwarding_target_recovery() {
    if IS_FORWARDING.swap(false, Ordering::AcqRel) {
        unsafe {
            PostQuitMessage(0);
        }
    }
}

#[tauri::command]
pub fn set_click_interception(intercept: bool) {
    INTERCEPT_CLICKS.store(intercept, Ordering::Relaxed);
}

#[tauri::command]
pub fn set_forwarding_enabled(enabled: bool) {
    let enabled = enabled && is_mouse_hook_running();
    IS_FORWARDING.store(enabled, Ordering::Release);
}

#[tauri::command]
pub fn stop_mouse_hook() {
    let _operation = HOOK_OPERATION.lock().unwrap();
    IS_FORWARDING.store(false, Ordering::Release);
    if !try_stop_current_hook_worker() {
        tracing::error!("鼠标钩子线程未能在限定时间内停止");
    }
    WAS_INSIDE.store(false, Ordering::Relaxed);
    INTERCEPT_CLICKS.store(false, Ordering::Relaxed);
}

pub fn is_mouse_hook_running() -> bool {
    let _operation = HOOK_OPERATION.lock().unwrap();
    let has_thread_id = HOOK_LIFECYCLE.lock().unwrap().current_thread_id().is_some();
    let worker_running = HOOK_WORKER_HANDLE
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|worker| !worker.is_finished());
    has_thread_id && worker_running
}

fn signal_hook_thread_stop(thread_id: u32) -> bool {
    unsafe { PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0)).is_ok() }
}

fn wait_for_hook_worker(
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
        tracing::error!("鼠标钩子线程异常退出");
    }
    Ok(())
}

fn request_worker_activation(
    activate_tx: &mpsc::SyncSender<()>,
    activated_rx: &mpsc::Receiver<()>,
    timeout: Duration,
) -> bool {
    activate_tx.try_send(()).is_ok() && activated_rx.recv_timeout(timeout).is_ok()
}

fn try_stop_current_hook_worker() -> bool {
    let thread_id = HOOK_LIFECYCLE.lock().unwrap().current_thread_id();
    let Some(worker) = HOOK_WORKER_HANDLE.lock().unwrap().take() else {
        let _ = HOOK_LIFECYCLE.lock().unwrap().stop_worker();
        return true;
    };

    if worker.is_finished() {
        let _ = wait_for_hook_worker(worker, Duration::ZERO);
        let _ = HOOK_LIFECYCLE.lock().unwrap().stop_worker();
        return true;
    }

    let Some(thread_id) = thread_id else {
        *HOOK_WORKER_HANDLE.lock().unwrap() = Some(worker);
        return false;
    };
    if !signal_hook_thread_stop(thread_id) {
        *HOOK_WORKER_HANDLE.lock().unwrap() = Some(worker);
        return false;
    }

    match wait_for_hook_worker(worker, HOOK_STOP_TIMEOUT) {
        Ok(()) => {
            let _ = HOOK_LIFECYCLE.lock().unwrap().stop_worker();
            true
        }
        Err(worker) => {
            *HOOK_WORKER_HANDLE.lock().unwrap() = Some(worker);
            false
        }
    }
}

pub fn update_cached_bounds() -> bool {
    let webview_ptr = WEBVIEW_HWND.load(Ordering::Relaxed);
    if webview_ptr == 0 {
        return false;
    }

    let webview_hwnd = HWND(webview_ptr as _);
    let mut client_rect = RECT::default();

    if unsafe { GetClientRect(webview_hwnd, &mut client_rect) }.is_err() {
        return false;
    }
    let mut top_left = POINT {
        x: client_rect.left,
        y: client_rect.top,
    };
    let mut bottom_right = POINT {
        x: client_rect.right,
        y: client_rect.bottom,
    };
    if !unsafe { ClientToScreen(webview_hwnd, &mut top_left) }.as_bool()
        || !unsafe { ClientToScreen(webview_hwnd, &mut bottom_right) }.as_bool()
        || !webview_bounds_are_usable(top_left, bottom_right)
    {
        return false;
    }

    let mut cached = WEBVIEW_BOUNDS.lock().unwrap();
    if WEBVIEW_HWND.load(Ordering::Relaxed) != webview_ptr {
        return false;
    }
    *cached = Some((
        webview_ptr,
        WebviewBounds {
            left: top_left.x,
            right: bottom_right.x,
            top: top_left.y,
            bottom: bottom_right.y,
        },
    ));
    true
}

fn init_mouse_forwarding_state(top_hwnd: HWND, webview_hwnd: HWND) -> bool {
    TOP_HWND.store(top_hwnd.0 as isize, Ordering::Relaxed);
    WEBVIEW_HWND.store(webview_hwnd.0 as isize, Ordering::Relaxed);

    if update_cached_bounds() {
        true
    } else {
        TOP_HWND.store(0, Ordering::Relaxed);
        WEBVIEW_HWND.store(0, Ordering::Relaxed);
        false
    }
}

pub fn start_mouse_hook_thread<F>(top_hwnd: HWND, webview_hwnd: HWND, on_exit: F) -> bool
where
    F: FnOnce() + Send + 'static,
{
    let _operation = HOOK_OPERATION.lock().unwrap();
    IS_FORWARDING.store(false, Ordering::Release);
    if !try_stop_current_hook_worker() {
        tracing::error!("旧鼠标钩子线程仍在运行，取消启动新线程");
        return false;
    }
    // Hook recovery can replace the render HWND while keeping the same DOM.
    // Preserve hover/click state so the next outside event can deliver leave;
    // a full window shutdown resets both in stop_mouse_hook instead.
    if !init_mouse_forwarding_state(top_hwnd, webview_hwnd) {
        tracing::warn!("WebView 句柄在鼠标钩子启动前已经失效或尚无可用边界");
        return false;
    }
    let (generation, previous_thread_id) = HOOK_LIFECYCLE.lock().unwrap().begin_worker();
    debug_assert!(previous_thread_id.is_none());

    let (thread_ready_tx, thread_ready_rx) = mpsc::sync_channel(1);
    let (hook_ready_tx, hook_ready_rx) = mpsc::sync_channel(1);
    let (activate_tx, activate_rx) = mpsc::sync_channel(1);
    let (activated_tx, activated_rx) = mpsc::sync_channel(0);
    let startup_cancelled = Arc::new(AtomicBool::new(false));
    let worker_cancelled = startup_cancelled.clone();
    let worker = std::thread::spawn(move || unsafe {
        let thread_id = GetCurrentThreadId();
        let mut msg = windows::Win32::UI::WindowsAndMessaging::MSG::default();
        let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
        if thread_ready_tx.send(thread_id).is_err() || worker_cancelled.load(Ordering::Acquire) {
            return;
        }

        let hook = match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), None, 0) {
            Ok(h) => h,
            Err(e) => {
                tracing::error!("无法设置鼠标全局钩子: {e:?}");
                let _ = hook_ready_tx.send(false);
                return;
            }
        };

        if worker_cancelled.load(Ordering::Acquire)
            || hook_ready_tx.send(true).is_err()
            || worker_cancelled.load(Ordering::Acquire)
        {
            let _ = UnhookWindowsHookEx(hook);
            return;
        }
        if activate_rx.recv().is_err() || worker_cancelled.load(Ordering::Acquire) {
            let _ = UnhookWindowsHookEx(hook);
            return;
        }
        if activated_tx.send(()).is_err() || worker_cancelled.load(Ordering::Acquire) {
            let _ = UnhookWindowsHookEx(hook);
            return;
        }

        loop {
            let ret = GetMessageW(&mut msg, Some(HWND::default()), 0, 0);
            if ret.0 == 0 || ret.0 == -1 {
                break;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        let _ = UnhookWindowsHookEx(hook);
        let was_current = HOOK_LIFECYCLE
            .lock()
            .unwrap()
            .finish_worker(generation, thread_id);
        if was_current {
            IS_FORWARDING.store(false, Ordering::Release);
            std::thread::spawn(on_exit);
        }
    });

    let thread_id = match thread_ready_rx.recv_timeout(HOOK_START_TIMEOUT) {
        Ok(thread_id) => thread_id,
        Err(err) => {
            tracing::error!("等待鼠标钩子线程消息队列启动超时: {err}");
            startup_cancelled.store(true, Ordering::Release);
            drop(thread_ready_rx);
            drop(hook_ready_rx);
            drop(activate_tx);
            let _ = HOOK_LIFECYCLE.lock().unwrap().cancel_worker(generation);
            if let Err(worker) = wait_for_hook_worker(worker, HOOK_STOP_TIMEOUT) {
                *HOOK_WORKER_HANDLE.lock().unwrap() = Some(worker);
            }
            return false;
        }
    };

    match hook_ready_rx.recv_timeout(HOOK_START_TIMEOUT) {
        Ok(true)
            if HOOK_LIFECYCLE
                .lock()
                .unwrap()
                .register_worker(generation, thread_id) =>
        {
            *HOOK_WORKER_HANDLE.lock().unwrap() = Some(worker);
            IS_FORWARDING.store(true, Ordering::Release);
            if !request_worker_activation(&activate_tx, &activated_rx, HOOK_START_TIMEOUT) {
                IS_FORWARDING.store(false, Ordering::Release);
                startup_cancelled.store(true, Ordering::Release);
                drop(activate_tx);
                drop(activated_rx);
                let _ = signal_hook_thread_stop(thread_id);
                let worker = HOOK_WORKER_HANDLE.lock().unwrap().take();
                if let Some(worker) = worker {
                    match wait_for_hook_worker(worker, HOOK_STOP_TIMEOUT) {
                        Ok(()) => {
                            let _ = HOOK_LIFECYCLE.lock().unwrap().cancel_worker(generation);
                        }
                        Err(worker) => {
                            *HOOK_WORKER_HANDLE.lock().unwrap() = Some(worker);
                        }
                    }
                }
                return false;
            }
            true
        }
        Ok(true) => {
            startup_cancelled.store(true, Ordering::Release);
            drop(activate_tx);
            let _ = signal_hook_thread_stop(thread_id);
            if let Err(worker) = wait_for_hook_worker(worker, HOOK_STOP_TIMEOUT) {
                *HOOK_WORKER_HANDLE.lock().unwrap() = Some(worker);
            }
            false
        }
        Ok(false) => {
            startup_cancelled.store(true, Ordering::Release);
            drop(activate_tx);
            let _ = HOOK_LIFECYCLE.lock().unwrap().cancel_worker(generation);
            if let Err(worker) = wait_for_hook_worker(worker, HOOK_STOP_TIMEOUT) {
                *HOOK_WORKER_HANDLE.lock().unwrap() = Some(worker);
            }
            false
        }
        Err(err) => {
            tracing::error!("等待鼠标钩子安装超时: {err}");
            startup_cancelled.store(true, Ordering::Release);
            drop(hook_ready_rx);
            drop(activate_tx);
            let signalled = signal_hook_thread_stop(thread_id);
            match wait_for_hook_worker(worker, HOOK_STOP_TIMEOUT) {
                Ok(()) => {
                    let _ = HOOK_LIFECYCLE.lock().unwrap().cancel_worker(generation);
                }
                Err(worker) => {
                    let registered = HOOK_LIFECYCLE
                        .lock()
                        .unwrap()
                        .register_worker(generation, thread_id);
                    if !registered {
                        tracing::error!(
                            "无法登记尚未退出的鼠标钩子线程（停止信号成功: {signalled}）"
                        );
                    }
                    *HOOK_WORKER_HANDLE.lock().unwrap() = Some(worker);
                }
            }
            false
        }
    }
}

unsafe extern "system" fn mouse_hook_proc(n_code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if n_code >= 0 && IS_FORWARDING.load(Ordering::Acquire) {
        let webview_ptr = WEBVIEW_HWND.load(Ordering::Relaxed);

        if webview_ptr != 0 {
            let webview_hwnd = HWND(webview_ptr as _);
            if forwarding_target_needs_recovery(
                unsafe { IsWindow(Some(webview_hwnd)) }.as_bool(),
                true,
            ) {
                request_forwarding_target_recovery();
                return unsafe { CallNextHookEx(None, n_code, wparam, lparam) };
            }
            let hook_struct = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
            let pt = hook_struct.pt;

            let cached_bounds = *WEBVIEW_BOUNDS.lock().unwrap();
            let Some((cached_hwnd, bounds)) = cached_bounds else {
                return unsafe { CallNextHookEx(None, n_code, wparam, lparam) };
            };
            if cached_hwnd != webview_ptr {
                return unsafe { CallNextHookEx(None, n_code, wparam, lparam) };
            }
            let is_inside_padded = bounds.contains(pt, 5);
            let is_inside_actual = bounds.contains(pt, 0);

            let was_inside = WAS_INSIDE.load(Ordering::Relaxed);

            if is_inside_padded {
                let msg_id = wparam.0 as u32;

                if is_inside_actual {
                    let client_x = pt.x - bounds.left;
                    let client_y = pt.y - bounds.top;

                    let client_lparam = make_lparam(client_x, client_y);

                    let message_delivery_succeeded = unsafe {
                        PostMessageW(Some(webview_hwnd), msg_id, WPARAM(0), client_lparam)
                    }
                    .is_ok();
                    if forwarding_target_needs_recovery(true, message_delivery_succeeded) {
                        request_forwarding_target_recovery();
                        return unsafe { CallNextHookEx(None, n_code, wparam, lparam) };
                    }
                }

                let is_click_msg = msg_id == WM_LBUTTONDOWN
                    || msg_id == WM_LBUTTONUP
                    || msg_id == WM_RBUTTONDOWN
                    || msg_id == WM_RBUTTONUP;

                if is_click_msg && INTERCEPT_CLICKS.load(Ordering::Relaxed) {
                    return LRESULT(1);
                }

                if !was_inside {
                    WAS_INSIDE.store(true, Ordering::Relaxed);
                }
            } else {
                if was_inside {
                    let out_of_bounds_lparam = make_lparam(-1, -1);

                    let mouse_move_delivered = unsafe {
                        PostMessageW(
                            Some(webview_hwnd),
                            WM_MOUSEMOVE,
                            WPARAM(0),
                            out_of_bounds_lparam,
                        )
                    }
                    .is_ok();

                    let mouse_leave_delivered = unsafe {
                        PostMessageW(Some(webview_hwnd), WM_MOUSELEAVE, WPARAM(0), LPARAM(0))
                    }
                    .is_ok();
                    if forwarding_target_needs_recovery(
                        true,
                        mouse_move_delivered && mouse_leave_delivered,
                    ) {
                        request_forwarding_target_recovery();
                        return unsafe { CallNextHookEx(None, n_code, wparam, lparam) };
                    }

                    WAS_INSIDE.store(false, Ordering::Relaxed);
                    INTERCEPT_CLICKS.store(false, Ordering::Relaxed);
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
    fn hit_testing_uses_screen_bounds_and_excludes_client_right_bottom_edges() {
        let bounds = WebviewBounds {
            left: -400,
            right: -100,
            top: 900,
            bottom: 940,
        };
        assert!(bounds.contains(POINT { x: -400, y: 900 }, 0));
        assert!(bounds.contains(POINT { x: -101, y: 939 }, 0));
        assert!(!bounds.contains(POINT { x: -100, y: 920 }, 0));
        assert!(!bounds.contains(POINT { x: -200, y: 940 }, 0));
        assert!(!bounds.contains(POINT { x: -401, y: 920 }, 0));
        assert!(bounds.contains(POINT { x: -401, y: 920 }, 5));
        assert!(!bounds.contains(POINT { x: -406, y: 920 }, 5));
    }

    #[test]
    fn stale_worker_cannot_clear_the_reopened_worker_identity() {
        let mut lifecycle = HookLifecycleState::default();
        let (old_generation, _) = lifecycle.begin_worker();
        assert!(lifecycle.register_worker(old_generation, 101));

        let (new_generation, previous_thread_id) = lifecycle.begin_worker();
        assert_eq!(previous_thread_id, Some(101));
        assert!(lifecycle.register_worker(new_generation, 202));

        assert!(!lifecycle.finish_worker(old_generation, 101));
        assert_eq!(lifecycle.thread_id, Some(202));
        assert!(lifecycle.finish_worker(new_generation, 202));
        assert_eq!(lifecycle.thread_id, None);
    }

    #[test]
    fn worker_that_registers_after_stop_is_rejected() {
        let mut lifecycle = HookLifecycleState::default();
        let (generation, _) = lifecycle.begin_worker();

        assert_eq!(lifecycle.stop_worker(), None);
        assert!(!lifecycle.register_worker(generation, 101));
        assert_eq!(lifecycle.thread_id, None);
    }

    #[test]
    fn timed_out_worker_cannot_replace_a_newer_worker() {
        let mut lifecycle = HookLifecycleState::default();
        let (timed_out_generation, _) = lifecycle.begin_worker();
        assert_eq!(lifecycle.cancel_worker(timed_out_generation), None);

        let (new_generation, _) = lifecycle.begin_worker();
        assert!(lifecycle.register_worker(new_generation, 202));
        assert!(!lifecycle.register_worker(timed_out_generation, 101));
        assert_eq!(lifecycle.thread_id, Some(202));
    }

    #[test]
    fn worker_activation_ack_wait_is_bounded() {
        let (activate_tx, activate_rx) = mpsc::sync_channel(1);
        let (activated_tx, activated_rx) = mpsc::sync_channel(0);
        let worker = std::thread::spawn(move || {
            let _ = activate_rx.recv();
            std::thread::sleep(Duration::from_millis(100));
            drop(activated_tx);
        });

        let started_at = Instant::now();
        assert!(!request_worker_activation(
            &activate_tx,
            &activated_rx,
            Duration::from_millis(10),
        ));
        assert!(started_at.elapsed() < Duration::from_millis(500));
        drop(activated_rx);
        worker.join().unwrap();
    }

    #[test]
    fn only_complete_nonempty_screen_bounds_are_usable() {
        assert!(webview_bounds_are_usable(
            POINT { x: 10, y: 20 },
            POINT { x: 110, y: 60 },
        ));
        assert!(!webview_bounds_are_usable(
            POINT { x: 10, y: 20 },
            POINT { x: 10, y: 60 },
        ));
        assert!(!webview_bounds_are_usable(
            POINT { x: 10, y: 20 },
            POINT { x: 110, y: 20 },
        ));
    }

    #[test]
    fn invalid_or_undeliverable_forwarding_target_requests_recovery() {
        assert!(!forwarding_target_needs_recovery(true, true));
        assert!(forwarding_target_needs_recovery(false, true));
        assert!(forwarding_target_needs_recovery(true, false));
        assert!(forwarding_target_needs_recovery(false, false));
    }
}
