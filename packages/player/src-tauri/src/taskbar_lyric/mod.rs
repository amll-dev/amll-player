use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use serde::Serialize;
use taskbar_lyric::TaskbarService;
use tauri::{Emitter, Manager};
use tracing::warn;
use windows::Win32::{
    Foundation::{HWND, RECT},
    Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromRect},
    UI::{
        Shell::{ABM_GETSTATE, ABM_GETTASKBARPOS, ABS_AUTOHIDE, APPBARDATA, SHAppBarMessage},
        WindowsAndMessaging::{
            FindWindowW, GA_PARENT, GetAncestor, SWP_NOACTIVATE, SWP_NOZORDER, SetWindowPos,
        },
    },
};
use windows::core::w;

pub mod mouse_forward;
pub mod webview_finder;

#[allow(dead_code)]
pub struct TaskbarLyricWatchers {
    pub uia: Option<taskbar_lyric::UiaWatcher>,
    pub tray: Option<taskbar_lyric::TrayWatcher>,
    pub reg: Option<taskbar_lyric::RegistryWatcher>,
}

#[derive(Default)]
pub struct TaskbarLyricState {
    service: Mutex<Option<GenerationResource<taskbar_lyric::TaskbarService>>>,
    watchers: Mutex<Option<GenerationResource<TaskbarLyricWatchers>>>,
    service_retirements: Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>,
    service_shutdown: tokio::sync::Mutex<()>,
    creation: tokio::sync::Mutex<()>,
    visibility: TaskbarLyricVisibility,
}

struct GenerationResource<T> {
    generation: u64,
    value: T,
}

fn generation_resource_ref<T>(
    resource: &Option<GenerationResource<T>>,
    generation: u64,
) -> Option<&T> {
    resource
        .as_ref()
        .filter(|resource| resource.generation == generation)
        .map(|resource| &resource.value)
}

fn take_generation_resource<T>(
    slot: &Mutex<Option<GenerationResource<T>>>,
    generation: u64,
) -> Option<T> {
    let mut resource = slot.lock().unwrap();
    if resource
        .as_ref()
        .is_some_and(|resource| resource.generation == generation)
    {
        resource.take().map(|resource| resource.value)
    } else {
        None
    }
}

impl TaskbarLyricState {
    fn install_service(
        &self,
        generation: u64,
        service: taskbar_lyric::TaskbarService,
    ) -> Result<(), taskbar_lyric::TaskbarService> {
        let visibility = self.visibility.state.lock().unwrap();
        if visibility.generation != generation {
            return Err(service);
        }
        let previous = self.service.lock().unwrap().replace(GenerationResource {
            generation,
            value: service,
        });
        drop(visibility);
        if let Some(previous) = previous {
            self.retire_service(previous.value);
        }
        Ok(())
    }

    fn install_watchers(
        &self,
        generation: u64,
        watchers: TaskbarLyricWatchers,
    ) -> Result<(), TaskbarLyricWatchers> {
        let visibility = self.visibility.state.lock().unwrap();
        if visibility.generation != generation {
            return Err(watchers);
        }
        let mut slot = self.watchers.lock().unwrap();
        let previous = slot.replace(GenerationResource {
            generation,
            value: watchers,
        });
        drop(slot);
        drop(visibility);
        drop(previous);
        Ok(())
    }

    fn take_resources_for_generation(&self, generation: u64) {
        let _ = take_generation_resource(&self.watchers, generation);
        if let Some(service) = take_generation_resource(&self.service, generation) {
            self.retire_service(service);
        }
    }

    fn retire_service(&self, mut service: TaskbarService) {
        service.stop();
        let retirement = tauri::async_runtime::spawn_blocking(move || service.stop_and_join());
        self.service_retirements.lock().unwrap().push(retirement);
    }

    async fn wait_for_retired_services(&self) {
        // Concurrent destroy requests must not overtake the task joining the
        // old worker. Its queued HWND commands must finish before HWND reuse.
        let _shutdown_guard = self.service_shutdown.lock().await;
        loop {
            let retirements = std::mem::take(&mut *self.service_retirements.lock().unwrap());
            if retirements.is_empty() {
                break;
            }
            for retirement in retirements {
                let _ = retirement.await;
            }
        }
    }

    fn update_service_for_generation(&self, generation: u64) -> bool {
        if !self.visibility.is_current(generation) {
            return false;
        }
        let service = self.service.lock().unwrap();
        let Some(service) = generation_resource_ref(&service, generation) else {
            return false;
        };
        service.update(300);
        true
    }
}

#[derive(Default)]
struct TaskbarLyricVisibility {
    state: Mutex<TaskbarLyricVisibilityState>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TaskbarShowFailureAction {
    RetryLayout,
    Exhausted,
    Stale,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MouseForwardingInstallResult {
    Installed,
    InstalledAndRearm,
    Retry,
    Stale,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WebviewLookupReservation {
    Start(u64),
    Queued,
    Skip,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WebviewLookupFinish {
    Rearm,
    Exhausted,
    Stale,
}

#[derive(Default)]
struct TaskbarLyricVisibilityState {
    generation: u64,
    layout_ready: bool,
    page_ready: bool,
    show_pending: bool,
    shown: bool,
    layout_retry_count: u8,
    layout_retry_pending: bool,
    show_retry_count: u8,
    window_hwnd: Option<usize>,
    webview_lookup_pending: bool,
    webview_lookup_rearm_requested: bool,
    webview_lookup_epoch: u64,
    mouse_forwarding_webview_hwnd: Option<usize>,
}

impl TaskbarLyricVisibility {
    fn begin_open(&self) -> u64 {
        self.begin_open_with_previous().1
    }

    fn begin_open_with_previous(&self) -> (u64, u64) {
        self.begin_open_with_previous_action(|| {})
    }

    fn begin_open_with_previous_action<F>(&self, on_begin: F) -> (u64, u64)
    where
        F: FnOnce(),
    {
        self.advance_if_current_with_previous_action(None, on_begin)
            .unwrap()
    }

    fn begin_open_if_current_with_previous_action<F>(
        &self,
        generation: u64,
        on_begin: F,
    ) -> Option<(u64, u64)>
    where
        F: FnOnce(),
    {
        self.advance_if_current_with_previous_action(Some(generation), on_begin)
    }

    fn invalidate_with_previous_action<F>(&self, on_invalidate: F) -> (u64, u64)
    where
        F: FnOnce(),
    {
        self.advance_if_current_with_previous_action(None, on_invalidate)
            .unwrap()
    }

    fn advance_if_current_with_previous_action<F>(
        &self,
        expected_generation: Option<u64>,
        action: F,
    ) -> Option<(u64, u64)>
    where
        F: FnOnce(),
    {
        let mut state = self.state.lock().unwrap();
        if expected_generation.is_some_and(|generation| state.generation != generation) {
            return None;
        }
        let previous_generation = state.generation;
        Self::advance_generation(&mut state);
        action();
        Some((previous_generation, state.generation))
    }

    fn invalidate(&self) {
        let mut state = self.state.lock().unwrap();
        Self::advance_generation(&mut state);
    }

    fn invalidate_if_current(&self, generation: u64) -> Option<u64> {
        self.invalidate_if_current_with(generation, || {})
    }

    fn invalidate_if_current_with<F>(&self, generation: u64, on_invalidate: F) -> Option<u64>
    where
        F: FnOnce(),
    {
        let mut state = self.state.lock().unwrap();
        if state.generation != generation {
            return None;
        }
        Self::advance_generation(&mut state);
        on_invalidate();
        Some(state.generation)
    }

    fn advance_generation(state: &mut TaskbarLyricVisibilityState) {
        state.generation = state.generation.wrapping_add(1);
        if state.generation == 0 {
            state.generation = 1;
        }
        state.layout_ready = false;
        state.page_ready = false;
        state.show_pending = false;
        state.shown = false;
        state.layout_retry_count = 0;
        state.layout_retry_pending = false;
        state.show_retry_count = 0;
        state.window_hwnd = None;
        state.webview_lookup_pending = false;
        state.webview_lookup_rearm_requested = false;
        state.webview_lookup_epoch = 0;
        state.mouse_forwarding_webview_hwnd = None;
    }

    fn current_generation(&self) -> u64 {
        self.state.lock().unwrap().generation
    }

    fn current_window_identity(&self) -> Option<(u64, usize)> {
        let state = self.state.lock().unwrap();
        state
            .window_hwnd
            .map(|window_hwnd| (state.generation, window_hwnd))
    }

    fn is_shown(&self) -> bool {
        self.state.lock().unwrap().shown
    }

    fn is_current(&self, generation: u64) -> bool {
        self.current_generation() == generation
    }

    fn bind_window(&self, generation: u64, hwnd: usize) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.generation != generation {
            return false;
        }
        match state.window_hwnd {
            Some(bound_hwnd) => bound_hwnd == hwnd,
            None => {
                state.window_hwnd = Some(hwnd);
                true
            }
        }
    }

    fn window_matches(&self, generation: u64, hwnd: usize) -> bool {
        let state = self.state.lock().unwrap();
        state.generation == generation && state.window_hwnd == Some(hwnd)
    }

    fn reserve_webview_lookup(
        &self,
        generation: u64,
        top_hwnd: usize,
        force_revalidate: bool,
    ) -> WebviewLookupReservation {
        self.reserve_webview_lookup_with_hook_health(
            generation,
            top_hwnd,
            force_revalidate,
            mouse_forward::is_mouse_hook_running,
        )
    }

    fn reserve_webview_lookup_with_hook_health<F>(
        &self,
        generation: u64,
        top_hwnd: usize,
        force_revalidate: bool,
        hook_running: F,
    ) -> WebviewLookupReservation
    where
        F: FnOnce() -> bool,
    {
        let mut state = self.state.lock().unwrap();
        if state.generation != generation || state.window_hwnd != Some(top_hwnd) {
            return WebviewLookupReservation::Skip;
        }
        let hook_running = hook_running();
        if state.mouse_forwarding_webview_hwnd.is_some() && !hook_running {
            state.mouse_forwarding_webview_hwnd = None;
        }
        if state.webview_lookup_pending {
            if force_revalidate {
                state.webview_lookup_rearm_requested = true;
            }
            return WebviewLookupReservation::Queued;
        }
        if state.mouse_forwarding_webview_hwnd.is_some() && !force_revalidate {
            return WebviewLookupReservation::Skip;
        }
        state.webview_lookup_epoch = state.webview_lookup_epoch.wrapping_add(1);
        if state.webview_lookup_epoch == 0 {
            state.webview_lookup_epoch = 1;
        }
        state.webview_lookup_pending = true;
        WebviewLookupReservation::Start(state.webview_lookup_epoch)
    }

    fn finish_webview_lookup(
        &self,
        generation: u64,
        top_hwnd: usize,
        lookup_epoch: u64,
    ) -> WebviewLookupFinish {
        let mut state = self.state.lock().unwrap();
        if state.generation != generation
            || state.window_hwnd != Some(top_hwnd)
            || !state.webview_lookup_pending
            || state.webview_lookup_epoch != lookup_epoch
        {
            return WebviewLookupFinish::Stale;
        }
        state.webview_lookup_pending = false;
        if state.webview_lookup_rearm_requested {
            state.webview_lookup_rearm_requested = false;
            WebviewLookupFinish::Rearm
        } else {
            WebviewLookupFinish::Exhausted
        }
    }

    fn invalidate_exhausted_webview_lookup_if_current<F>(
        &self,
        generation: u64,
        top_hwnd: usize,
        lookup_epoch: u64,
        on_invalidate: F,
    ) -> bool
    where
        F: FnOnce(),
    {
        let mut state = self.state.lock().unwrap();
        if state.generation != generation
            || state.window_hwnd != Some(top_hwnd)
            || state.webview_lookup_pending
            || state.webview_lookup_rearm_requested
            || state.webview_lookup_epoch != lookup_epoch
            || state.mouse_forwarding_webview_hwnd.is_some()
        {
            return false;
        }
        Self::advance_generation(&mut state);
        on_invalidate();
        true
    }

    fn commit_mouse_forwarding_install(
        state: &mut TaskbarLyricVisibilityState,
        webview_hwnd: usize,
    ) -> MouseForwardingInstallResult {
        state.mouse_forwarding_webview_hwnd = Some(webview_hwnd);
        state.webview_lookup_pending = false;
        if std::mem::take(&mut state.webview_lookup_rearm_requested) {
            MouseForwardingInstallResult::InstalledAndRearm
        } else {
            MouseForwardingInstallResult::Installed
        }
    }

    fn install_mouse_forwarding<F>(
        &self,
        generation: u64,
        top_hwnd: HWND,
        webview_hwnd: HWND,
        lookup_epoch: u64,
        on_exit: F,
    ) -> MouseForwardingInstallResult
    where
        F: FnOnce() + Send + 'static,
    {
        let mut state = self.state.lock().unwrap();
        if state.generation != generation
            || state.window_hwnd != Some(top_hwnd.0 as usize)
            || !state.webview_lookup_pending
            || state.webview_lookup_epoch != lookup_epoch
        {
            return MouseForwardingInstallResult::Stale;
        }
        let webview_hwnd_ptr = webview_hwnd.0 as usize;
        if state.mouse_forwarding_webview_hwnd == Some(webview_hwnd_ptr)
            && mouse_forward::is_mouse_hook_running()
        {
            return Self::commit_mouse_forwarding_install(&mut state, webview_hwnd_ptr);
        }

        if mouse_forward::start_mouse_hook_thread(top_hwnd, webview_hwnd, on_exit) {
            Self::commit_mouse_forwarding_install(&mut state, webview_hwnd_ptr)
        } else {
            state.mouse_forwarding_webview_hwnd = None;
            mouse_forward::set_forwarding_enabled(false);
            MouseForwardingInstallResult::Retry
        }
    }

    fn mark_layout_ready(&self, generation: u64) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.generation != generation {
            return false;
        }
        state.layout_ready = true;
        state.layout_retry_count = 0;
        state.layout_retry_pending = false;
        Self::take_show_request(&mut state)
    }

    fn mark_page_ready(&self, generation: u64) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.generation != generation {
            return false;
        }
        state.page_ready = true;
        Self::take_show_request(&mut state)
    }

    fn take_show_request(state: &mut TaskbarLyricVisibilityState) -> bool {
        if !state.layout_ready || !state.page_ready || state.show_pending || state.shown {
            return false;
        }
        state.show_pending = true;
        true
    }

    fn record_show_failure(&self, generation: u64) -> TaskbarShowFailureAction {
        let mut state = self.state.lock().unwrap();
        if state.generation != generation {
            return TaskbarShowFailureAction::Stale;
        }
        state.show_pending = false;
        state.shown = false;
        state.layout_ready = false;
        state.layout_retry_count = 0;
        state.layout_retry_pending = false;
        state.show_retry_count = state.show_retry_count.saturating_add(1);
        if state.show_retry_count >= MAX_TASKBAR_SHOW_FAILURES {
            TaskbarShowFailureAction::Exhausted
        } else {
            TaskbarShowFailureAction::RetryLayout
        }
    }

    fn mark_show_succeeded(&self, generation: u64) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.generation != generation {
            return false;
        }
        state.show_pending = false;
        state.shown = true;
        state.show_retry_count = 0;
        true
    }

    fn reserve_layout_retry(&self, generation: u64) -> Option<u8> {
        let mut state = self.state.lock().unwrap();
        if state.generation != generation
            || state.layout_ready
            || state.layout_retry_pending
            || state.layout_retry_count >= MAX_TASKBAR_LAYOUT_RETRIES
        {
            return None;
        }
        state.layout_retry_count += 1;
        state.layout_retry_pending = true;
        Some(state.layout_retry_count)
    }

    fn begin_reserved_layout_retry(&self, generation: u64) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.generation != generation || !state.layout_retry_pending {
            return false;
        }
        state.layout_retry_pending = false;
        !state.layout_ready
    }

    fn layout_retries_exhausted(&self, generation: u64) -> bool {
        let state = self.state.lock().unwrap();
        state.generation == generation
            && !state.layout_ready
            && state.layout_retry_count >= MAX_TASKBAR_LAYOUT_RETRIES
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskbarLayoutExtraPayload {
    pub is_centered: bool,
    pub system_type: String,
    pub content_offset_x: f64,
    pub content_offset_y: f64,
}

const AUTO_HIDE_TRIGGER_BAND_PX: i32 = 2;
const MAX_TASKBAR_LAYOUT_RETRIES: u8 = 4;
const MAX_TASKBAR_SHOW_FAILURES: u8 = 4;
const TASKBAR_LAYOUT_RETRY_BASE_DELAY_MS: u64 = 50;
const MAX_WEBVIEW_HWND_LOOKUP_ATTEMPTS: u8 = 7;
const WEBVIEW_HWND_RETRY_BASE_DELAY_MS: u64 = 50;

fn primary_taskbar_hwnd() -> Option<HWND> {
    unsafe { FindWindowW(w!("Shell_TrayWnd"), None) }
        .ok()
        .filter(|hwnd| !hwnd.0.is_null())
}

fn webview_hwnd_retry_delay(attempt: u8) -> Option<Duration> {
    if attempt + 1 >= MAX_WEBVIEW_HWND_LOOKUP_ATTEMPTS {
        return None;
    }
    Some(Duration::from_millis(
        WEBVIEW_HWND_RETRY_BASE_DELAY_MS * (1_u64 << attempt),
    ))
}

fn schedule_webview_hwnd_lookup(
    app: tauri::AppHandle,
    generation: u64,
    top_hwnd: usize,
    force_revalidate: bool,
) {
    let Some(state) = app.try_state::<TaskbarLyricState>() else {
        return;
    };
    let lookup_epoch =
        match state
            .visibility
            .reserve_webview_lookup(generation, top_hwnd, force_revalidate)
        {
            WebviewLookupReservation::Start(lookup_epoch) => lookup_epoch,
            WebviewLookupReservation::Queued | WebviewLookupReservation::Skip => return,
        };

    tauri::async_runtime::spawn(async move {
        for attempt in 0..MAX_WEBVIEW_HWND_LOOKUP_ATTEMPTS {
            let Some(state) = app.try_state::<TaskbarLyricState>() else {
                return;
            };
            if !state.visibility.window_matches(generation, top_hwnd) {
                return;
            }

            let top_hwnd = HWND(top_hwnd as _);
            if let Some(webview_hwnd) = webview_finder::find_webview_hwnd(top_hwnd) {
                let recovery_app = app.clone();
                let recovery_top_hwnd = top_hwnd.0 as usize;
                let on_exit = move || {
                    schedule_webview_hwnd_lookup(recovery_app, generation, recovery_top_hwnd, true);
                };
                match state.visibility.install_mouse_forwarding(
                    generation,
                    top_hwnd,
                    webview_hwnd,
                    lookup_epoch,
                    on_exit,
                ) {
                    MouseForwardingInstallResult::Installed => return,
                    MouseForwardingInstallResult::InstalledAndRearm => {
                        schedule_webview_hwnd_lookup(
                            app.clone(),
                            generation,
                            top_hwnd.0 as usize,
                            true,
                        );
                        return;
                    }
                    MouseForwardingInstallResult::Stale => return,
                    MouseForwardingInstallResult::Retry => {}
                }
            }

            let Some(delay) = webview_hwnd_retry_delay(attempt) else {
                match state.visibility.finish_webview_lookup(
                    generation,
                    top_hwnd.0 as usize,
                    lookup_epoch,
                ) {
                    WebviewLookupFinish::Rearm => {
                        schedule_webview_hwnd_lookup(
                            app.clone(),
                            generation,
                            top_hwnd.0 as usize,
                            true,
                        );
                    }
                    WebviewLookupFinish::Exhausted => {
                        let window = app.get_webview_window("taskbar-lyric");
                        if state
                            .visibility
                            .invalidate_exhausted_webview_lookup_if_current(
                                generation,
                                top_hwnd.0 as usize,
                                lookup_epoch,
                                mouse_forward::stop_mouse_hook,
                            )
                        {
                            warn!("多次重试后仍未能初始化任务栏歌词 WebView 鼠标转发");
                            schedule_taskbar_generation_cleanup(&app, generation);
                            if let Some(window) = window {
                                destroy_taskbar_window(&app, generation, &window);
                            } else {
                                crate::window::reconcile_background_restore_entry(&app);
                            }
                        }
                    }
                    WebviewLookupFinish::Stale => {}
                }
                return;
            };
            tokio::time::sleep(delay).await;
        }
    });
}

fn show_taskbar_lyric_if_ready(app: &tauri::AppHandle, generation: u64, should_show: bool) {
    if !should_show {
        return;
    }

    let Some(state) = app.try_state::<TaskbarLyricState>() else {
        return;
    };
    if !state.visibility.is_current(generation) {
        return;
    }

    let Some(window) = app.get_webview_window("taskbar-lyric") else {
        handle_taskbar_show_failure(app, generation, None);
        return;
    };
    let Ok(hwnd) = window.hwnd() else {
        invalidate_and_destroy_taskbar_window(app, generation, &window);
        return;
    };
    if !state.visibility.window_matches(generation, hwnd.0 as usize) {
        return;
    }

    if window.show().is_ok() {
        if state.visibility.mark_show_succeeded(generation) {
            crate::window::reconcile_background_restore_entry(app);
        }
    } else {
        handle_taskbar_show_failure(app, generation, Some(&window));
    }
}

fn handle_taskbar_show_failure(
    app: &tauri::AppHandle,
    generation: u64,
    window: Option<&tauri::WebviewWindow>,
) {
    let Some(state) = app.try_state::<TaskbarLyricState>() else {
        return;
    };
    match state.visibility.record_show_failure(generation) {
        TaskbarShowFailureAction::RetryLayout => {
            schedule_taskbar_layout_watchdog(app.clone(), generation);
        }
        TaskbarShowFailureAction::Exhausted => {
            warn!("任务栏歌词窗口显示重试次数已耗尽");
            if let Some(window) = window {
                invalidate_and_destroy_taskbar_window(app, generation, window);
            } else if let Some(window) = app.get_webview_window("taskbar-lyric") {
                invalidate_and_destroy_taskbar_window(app, generation, &window);
            } else {
                invalidate_taskbar_generation(app, generation);
            }
        }
        TaskbarShowFailureAction::Stale => {}
    }
}

fn invalidate_taskbar_generation(app: &tauri::AppHandle, generation: u64) -> bool {
    let Some(state) = app.try_state::<TaskbarLyricState>() else {
        return false;
    };
    if state
        .visibility
        .invalidate_if_current_with(generation, mouse_forward::stop_mouse_hook)
        .is_none()
    {
        return false;
    }

    schedule_taskbar_generation_cleanup(app, generation);
    crate::window::reconcile_background_restore_entry(app);
    true
}

fn schedule_taskbar_generation_cleanup(app: &tauri::AppHandle, generation: u64) {
    if let Some(state) = app.try_state::<TaskbarLyricState>() {
        state.take_resources_for_generation(generation);
    }
}

fn invalidate_and_destroy_taskbar_window(
    app: &tauri::AppHandle,
    generation: u64,
    window: &tauri::WebviewWindow,
) {
    if !invalidate_taskbar_generation(app, generation) {
        return;
    }
    destroy_taskbar_window(app, generation, window);
}

fn destroy_taskbar_window(app: &tauri::AppHandle, generation: u64, window: &tauri::WebviewWindow) {
    if let Some(state) = app.try_state::<TaskbarLyricState>() {
        state.take_resources_for_generation(generation);
    }
    let _ = window.hide();
    let app = app.clone();
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(state) = app.try_state::<TaskbarLyricState>() {
            state.wait_for_retired_services().await;
        }
        if let Err(error) = window.destroy() {
            warn!("销毁任务栏歌词窗口失败：{error}");
            // No Destroyed event will arrive to schedule the normal recovery.
            crate::window::reconcile_background_restore_entry(&app);
        }
    });
}

fn schedule_taskbar_layout_watchdog(app: tauri::AppHandle, generation: u64) {
    let Some(state) = app.try_state::<TaskbarLyricState>() else {
        return;
    };
    let Some(attempt) = state.visibility.reserve_layout_retry(generation) else {
        if state.visibility.layout_retries_exhausted(generation) {
            warn!("任务栏歌词窗口布局重试次数已耗尽");
            if let Some(window) = app.get_webview_window("taskbar-lyric") {
                invalidate_and_destroy_taskbar_window(&app, generation, &window);
            } else {
                invalidate_taskbar_generation(&app, generation);
            }
        }
        return;
    };

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(
            TASKBAR_LAYOUT_RETRY_BASE_DELAY_MS * u64::from(attempt),
        ))
        .await;

        let Some(state) = app.try_state::<TaskbarLyricState>() else {
            return;
        };
        if !state.visibility.begin_reserved_layout_retry(generation) {
            return;
        }
        let Some(window) = app.get_webview_window("taskbar-lyric") else {
            schedule_taskbar_layout_watchdog(app.clone(), generation);
            return;
        };
        let Ok(hwnd) = window.hwnd() else {
            invalidate_and_destroy_taskbar_window(&app, generation, &window);
            return;
        };
        if !state.visibility.window_matches(generation, hwnd.0 as usize) {
            return;
        }

        let service = state.service.lock().unwrap();
        if let Some(service) = generation_resource_ref(&service, generation) {
            service.embed_window_by_ptr(hwnd.0 as usize);
            service.update(300);
        }
        drop(service);
        schedule_taskbar_layout_watchdog(app.clone(), generation);
    });
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TaskbarEdge {
    Left,
    Top,
    Right,
    Bottom,
}

fn taskbar_edge_from_rect(taskbar: RECT, monitor: RECT) -> Option<TaskbarEdge> {
    let width = i64::from(taskbar.right) - i64::from(taskbar.left);
    let height = i64::from(taskbar.bottom) - i64::from(taskbar.top);
    if width <= 0 || height <= 0 {
        return None;
    }

    if width >= height {
        let top_distance = (i64::from(taskbar.top) - i64::from(monitor.top)).abs();
        let bottom_distance = (i64::from(monitor.bottom) - i64::from(taskbar.bottom)).abs();
        Some(if top_distance <= bottom_distance {
            TaskbarEdge::Top
        } else {
            TaskbarEdge::Bottom
        })
    } else {
        let left_distance = (i64::from(taskbar.left) - i64::from(monitor.left)).abs();
        let right_distance = (i64::from(monitor.right) - i64::from(taskbar.right)).abs();
        Some(if left_distance <= right_distance {
            TaskbarEdge::Left
        } else {
            TaskbarEdge::Right
        })
    }
}

fn auto_hidden_taskbar_edge() -> Option<TaskbarEdge> {
    let mut appbar_data = APPBARDATA {
        cbSize: std::mem::size_of::<APPBARDATA>() as u32,
        ..Default::default()
    };

    let state = unsafe { SHAppBarMessage(ABM_GETSTATE, &mut appbar_data) };
    if state & ABS_AUTOHIDE as usize == 0 {
        return None;
    }

    if unsafe { SHAppBarMessage(ABM_GETTASKBARPOS, &mut appbar_data) } == 0 {
        return None;
    }

    let monitor = unsafe { MonitorFromRect(&appbar_data.rc, MONITOR_DEFAULTTONEAREST) };
    let mut monitor_info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !unsafe { GetMonitorInfoW(monitor, &mut monitor_info) }.as_bool() {
        return None;
    }

    taskbar_edge_from_rect(appbar_data.rc, monitor_info.rcMonitor)
}

fn reserve_auto_hide_trigger_band(
    mut rect: taskbar_lyric::Rect,
    edge: Option<TaskbarEdge>,
) -> taskbar_lyric::Rect {
    match edge {
        Some(TaskbarEdge::Bottom) => {
            let reserved = rect.height.clamp(0, AUTO_HIDE_TRIGGER_BAND_PX);
            rect.y += reserved;
            rect.height -= reserved;
        }
        Some(TaskbarEdge::Top) => {
            rect.height -= rect.height.clamp(0, AUTO_HIDE_TRIGGER_BAND_PX);
        }
        Some(TaskbarEdge::Right) => {
            let reserved = rect.width.clamp(0, AUTO_HIDE_TRIGGER_BAND_PX);
            rect.x += reserved;
            rect.width -= reserved;
        }
        Some(TaskbarEdge::Left) => {
            rect.width -= rect.width.clamp(0, AUTO_HIDE_TRIGGER_BAND_PX);
        }
        None => {}
    }

    rect
}

fn auto_hide_content_offset(edge: Option<TaskbarEdge>, scale_factor: f64) -> (f64, f64) {
    let scale_factor = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    let half_trigger_band = f64::from(AUTO_HIDE_TRIGGER_BAND_PX) / scale_factor / 2.0;

    match edge {
        Some(TaskbarEdge::Bottom) => (0.0, -half_trigger_band),
        Some(TaskbarEdge::Top) => (0.0, half_trigger_band),
        Some(TaskbarEdge::Right) => (-half_trigger_band, 0.0),
        Some(TaskbarEdge::Left) => (half_trigger_band, 0.0),
        None => (0.0, 0.0),
    }
}

#[tauri::command]
pub fn close_taskbar_lyric(app: tauri::AppHandle) {
    if let Some(state) = app.try_state::<TaskbarLyricState>() {
        // Invalidate atomically even if a deferred reopen just advanced the
        // generation. A newer close must always cancel pending creation/recovery.
        let (generation, closed_generation) = state
            .visibility
            .invalidate_with_previous_action(mouse_forward::stop_mouse_hook);
        state.take_resources_for_generation(generation);

        tauri::async_runtime::spawn(async move {
            let Some(state) = app.try_state::<TaskbarLyricState>() else {
                return;
            };
            // A build already in flight may produce its window after close was
            // requested. Wait for it before looking up the window to destroy.
            let _creation_guard = state.creation.lock().await;
            if !state.visibility.is_current(closed_generation) {
                return;
            }
            if let Some(window) = app.get_webview_window("taskbar-lyric") {
                destroy_taskbar_window(&app, generation, &window);
                wait_for_taskbar_window_removal(&app, closed_generation).await;
            }
            crate::window::reconcile_background_restore_entry(&app);
        });
    }
}

async fn wait_for_taskbar_window_removal(app: &tauri::AppHandle, generation: u64) -> bool {
    for _ in 0..200 {
        if !app
            .try_state::<TaskbarLyricState>()
            .is_some_and(|state| state.visibility.is_current(generation))
        {
            return false;
        }
        if app.get_webview_window("taskbar-lyric").is_none() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    warn!("任务栏歌词旧窗口尚未销毁，取消本次重建并保留托盘恢复入口");
    false
}

pub(crate) fn schedule_destroyed_window_recovery(app: tauri::AppHandle) {
    let recovery_target = app
        .try_state::<TaskbarLyricState>()
        .and_then(|state| state.visibility.current_window_identity());

    tauri::async_runtime::spawn(async move {
        // WindowEvent::Destroyed runs on Tao's event loop. Defer all state
        // cleanup and window queries so that callback can return immediately.
        tokio::task::yield_now().await;

        let mut recovery_generation = None;
        if let (Some(state), Some((generation, destroyed_hwnd))) =
            (app.try_state::<TaskbarLyricState>(), recovery_target)
        {
            if state.visibility.window_matches(generation, destroyed_hwnd)
                && let Some(next_generation) = state
                    .visibility
                    .invalidate_if_current_with(generation, mouse_forward::stop_mouse_hook)
            {
                state.take_resources_for_generation(generation);
                if app.get_webview_window("main").is_some() {
                    recovery_generation = Some(next_generation);
                }
            }
        }

        crate::window::reconcile_background_restore_entry(&app);
        if let Some(generation) = recovery_generation
            && wait_for_taskbar_window_removal(&app, generation).await
        {
            open_taskbar_lyric_for_generation(app, generation, 0);
        }
    });
}

pub(crate) fn taskbar_lyric_restore_available(app: &tauri::AppHandle) -> bool {
    app.try_state::<TaskbarLyricState>()
        .is_some_and(|state| state.visibility.is_shown())
        && app.get_webview_window("taskbar-lyric").is_some()
}

#[tauri::command]
pub fn open_taskbar_lyric_devtools(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("taskbar-lyric") {
        win.open_devtools();
    }
}

#[tauri::command]
pub fn refresh_taskbar_lyric_layout(app: tauri::AppHandle) {
    if let Some(state) = app.try_state::<TaskbarLyricState>() {
        let generation = state.visibility.current_generation();
        state.update_service_for_generation(generation);
    }
}

#[tauri::command]
pub fn taskbar_lyric_page_ready(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    generation: u64,
) -> Result<(), String> {
    if window.label() != "taskbar-lyric" {
        return Err("页面就绪通知不是来自任务栏歌词窗口".to_string());
    }

    let state = app
        .try_state::<TaskbarLyricState>()
        .ok_or_else(|| "任务栏歌词状态尚未初始化".to_string())?;
    if !state.visibility.is_current(generation) {
        return Err("页面就绪通知来自已经失效的任务栏歌词窗口代际".to_string());
    }
    let current_window = app
        .get_webview_window("taskbar-lyric")
        .ok_or_else(|| "任务栏歌词窗口已关闭".to_string())?;
    let current_hwnd = match current_window.hwnd() {
        Ok(hwnd) => hwnd,
        Err(err) => {
            invalidate_and_destroy_taskbar_window(&app, generation, &current_window);
            return Err(err.to_string());
        }
    };
    let caller_hwnd = match window.hwnd() {
        Ok(hwnd) => hwnd,
        Err(err) => {
            invalidate_and_destroy_taskbar_window(&app, generation, &current_window);
            return Err(err.to_string());
        }
    };
    if caller_hwnd.0 != current_hwnd.0 {
        return Err("页面就绪通知来自已经失效的任务栏歌词窗口".to_string());
    }
    if !state
        .visibility
        .window_matches(generation, current_hwnd.0 as usize)
    {
        return Err("任务栏歌词窗口身份与页面代际不匹配".to_string());
    }
    schedule_webview_hwnd_lookup(app.clone(), generation, current_hwnd.0 as usize, true);

    let should_show = state.visibility.mark_page_ready(generation);
    if !state.visibility.is_current(generation) {
        return Err("任务栏歌词窗口代际已经失效".to_string());
    }
    show_taskbar_lyric_if_ready(&app, generation, should_show);
    Ok(())
}

#[tauri::command]
pub fn open_taskbar_lyric(app: tauri::AppHandle) {
    let Some(state) = app.try_state::<TaskbarLyricState>() else {
        warn!("任务栏歌词状态尚未初始化");
        return;
    };
    let generation = state.visibility.current_generation();
    open_taskbar_lyric_for_generation(app, generation, 0);
}

fn open_taskbar_lyric_for_generation(app: tauri::AppHandle, expected_generation: u64, attempt: u8) {
    let Some(state) = app.try_state::<TaskbarLyricState>() else {
        return;
    };
    // A label can remain registered after destroy() until Tao processes the
    // event. Only an active, bound window satisfies an open request.
    if app.get_webview_window("taskbar-lyric").is_some()
        && state
            .visibility
            .current_window_identity()
            .is_some_and(|(generation, _)| generation == expected_generation)
    {
        return;
    }
    let Some((previous_generation, generation)) =
        state.visibility.begin_open_if_current_with_previous_action(
            expected_generation,
            mouse_forward::stop_mouse_hook,
        )
    else {
        return;
    };
    state.take_resources_for_generation(previous_generation);

    let app_clone = app.clone();
    let service = TaskbarService::new(move |layout| {
        let Some(state) = app_clone.try_state::<TaskbarLyricState>() else {
            return;
        };
        if !state.visibility.is_current(generation) {
            return;
        }

        if let Some(win) = app_clone.get_webview_window("taskbar-lyric") {
            let left = layout.space.left;
            let current_rect = if left.width > 0 {
                left
            } else {
                layout.space.right
            };
            let auto_hide_edge = auto_hidden_taskbar_edge();
            let current_rect = reserve_auto_hide_trigger_band(current_rect, auto_hide_edge);
            let (content_offset_x, content_offset_y) =
                auto_hide_content_offset(auto_hide_edge, win.scale_factor().unwrap_or(1.0));

            if let Ok(hwnd) = win.hwnd() {
                let top_hwnd = HWND(hwnd.0);
                if !state.visibility.window_matches(generation, hwnd.0 as usize) {
                    return;
                }
                let is_embedded = primary_taskbar_hwnd().is_some_and(|taskbar_hwnd| {
                    unsafe { GetAncestor(top_hwnd, GA_PARENT) }.0 == taskbar_hwnd.0
                });
                let position_updated = is_embedded
                    && unsafe {
                        SetWindowPos(
                            top_hwnd,
                            None,
                            current_rect.x,
                            current_rect.y,
                            current_rect.width,
                            current_rect.height,
                            SWP_NOACTIVATE | SWP_NOZORDER,
                        )
                    }
                    .is_ok();

                if !position_updated {
                    schedule_taskbar_layout_watchdog(app_clone.clone(), generation);
                    return;
                }

                // Do not leave hit testing at the previous taskbar position
                // while waiting for the child WebView to finish resizing.
                mouse_forward::update_cached_bounds();

                // The page waits for this layout before acknowledging its first
                // frame, so only publish coordinates that were applied successfully.
                let _ = app_clone.emit(
                    "taskbar-layout-extra",
                    TaskbarLayoutExtraPayload {
                        is_centered: layout.extra.is_centered,
                        system_type: format!("{:?}", layout.extra.system_type),
                        content_offset_x,
                        content_offset_y,
                    },
                );

                let bounds_app = app_clone.clone();
                let bounds_top_hwnd = hwnd.0 as usize;
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    let is_current =
                        bounds_app
                            .try_state::<TaskbarLyricState>()
                            .is_some_and(|state| {
                                state.visibility.window_matches(generation, bounds_top_hwnd)
                            });
                    if is_current && !mouse_forward::update_cached_bounds() {
                        tracing::debug!("任务栏歌词鼠标边界刷新失败，重新验证 WebView 转发目标");
                        schedule_webview_hwnd_lookup(bounds_app, generation, bounds_top_hwnd, true);
                    }
                });

                let should_show = state.visibility.mark_layout_ready(generation);
                show_taskbar_lyric_if_ready(&app_clone, generation, should_show);
            } else {
                invalidate_and_destroy_taskbar_window(&app_clone, generation, &win);
            }
        }
    });

    if let Err(service) = state.install_service(generation, service) {
        state.retire_service(service);
        return;
    }

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        // Coalesce rapid on/off gestures before creating another WebView.
        tokio::time::sleep(Duration::from_millis(120)).await;
        let Some(state) = app_clone.try_state::<TaskbarLyricState>() else {
            return;
        };
        let _creation_guard = state.creation.lock().await;
        state.wait_for_retired_services().await;
        if !state.visibility.is_current(generation) {
            return;
        }

        // Reopening after close (or after cancelling an in-flight build) must
        // release the old WebView before reusing its label for a fresh page.
        if let Some(previous_window) = app_clone.get_webview_window("taskbar-lyric") {
            destroy_taskbar_window(&app_clone, previous_generation, &previous_window);
        }
        if !wait_for_taskbar_window_removal(&app_clone, generation).await {
            invalidate_taskbar_generation(&app_clone, generation);
            return;
        }

        #[cfg(debug_assertions)]
        let url = {
            let mut url = app_clone
                .config()
                .build
                .dev_url
                .clone()
                .unwrap()
                .join("taskbar-lyric.html")
                .unwrap();
            url.query_pairs_mut()
                .append_pair("generation", &generation.to_string());
            tauri::WebviewUrl::External(url)
        };
        #[cfg(not(debug_assertions))]
        let url =
            tauri::WebviewUrl::App(format!("taskbar-lyric.html?generation={generation}").into());

        let Some(taskbar_hwnd) = primary_taskbar_hwnd() else {
            warn!("找不到主任务栏窗口，无法创建任务栏歌词");
            invalidate_taskbar_generation(&app_clone, generation);
            return;
        };
        let tauri_taskbar_hwnd = windows_061::Win32::Foundation::HWND(taskbar_hwnd.0.cast());
        let win_builder = tauri::WebviewWindowBuilder::new(&app_clone, "taskbar-lyric", url)
            // Create a real child window from the outset. SetParent alone does
            // not replace WS_POPUP with WS_CHILD, which leaves a non-client
            // frame that can consume the lyric surface and cover the taskbar's
            // auto-hide trigger band.
            .parent_raw(tauri_taskbar_hwnd)
            .decorations(false)
            .shadow(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .visible(false);

        let result = win_builder.build();
        if let Ok(win) = result {
            let is_current = app_clone
                .try_state::<TaskbarLyricState>()
                .is_some_and(|state| state.visibility.is_current(generation));
            if !is_current {
                destroy_taskbar_window(&app_clone, generation, &win);
                return;
            }

            if let Ok(hwnd) = win.hwnd() {
                let hwnd_ptr = hwnd.0 as usize;
                if !state.visibility.bind_window(generation, hwnd_ptr) {
                    destroy_taskbar_window(&app_clone, generation, &win);
                    return;
                }

                if let Some(state) = app_clone.try_state::<TaskbarLyricState>() {
                    let service = state.service.lock().unwrap();
                    if let Some(service) = generation_resource_ref(&service, generation) {
                        service.embed_window_by_ptr(hwnd_ptr);
                        service.update(300);
                    }
                    drop(service);
                    schedule_taskbar_layout_watchdog(app_clone.clone(), generation);
                }

                if let Some(state) = app_clone.try_state::<TaskbarLyricState>() {
                    let uia_counter = Arc::new(AtomicUsize::new(0));
                    let win_clone = app_clone.clone();
                    let uia_cb = Box::new(move || {
                        let current = uia_counter.fetch_add(1, Ordering::SeqCst) + 1;
                        let counter_clone = uia_counter.clone();
                        let win_clone_inner = win_clone.clone();

                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                            if counter_clone.load(Ordering::SeqCst) == current
                                && let Some(s) = win_clone_inner.try_state::<TaskbarLyricState>()
                            {
                                s.update_service_for_generation(generation);
                            }
                        });
                    });

                    let win_clone2 = app_clone.clone();
                    let tray_cb = Box::new(move || {
                        if let Some(s) = win_clone2.try_state::<TaskbarLyricState>() {
                            s.update_service_for_generation(generation);
                        }
                    });

                    let reg_counter = Arc::new(AtomicUsize::new(0));
                    let win_clone3 = app_clone.clone();
                    let reg_cb = Box::new(move || {
                        let is_current = win_clone3
                            .try_state::<TaskbarLyricState>()
                            .is_some_and(|state| state.visibility.is_current(generation));
                        if !is_current {
                            return;
                        }
                        let _ = win_clone3.emit("taskbar-lyric:fade-out", ());

                        let current = reg_counter.fetch_add(1, Ordering::SeqCst) + 1;
                        let counter_clone = reg_counter.clone();
                        let win_clone_inner = win_clone3.clone();

                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                            if counter_clone.load(Ordering::SeqCst) == current
                                && let Some(s) = win_clone_inner.try_state::<TaskbarLyricState>()
                                && s.update_service_for_generation(generation)
                            {
                                let _ = win_clone_inner.emit("taskbar-lyric:fade-in", ());
                            }
                        });
                    });

                    let watchers = TaskbarLyricWatchers {
                        uia: taskbar_lyric::UiaWatcher::new(uia_cb).ok(),
                        tray: taskbar_lyric::TrayWatcher::new(tray_cb).ok(),
                        reg: taskbar_lyric::RegistryWatcher::new(reg_cb).ok(),
                    };
                    let install_result = state.install_watchers(generation, watchers);
                    if install_result.is_err() {
                        destroy_taskbar_window(&app_clone, generation, &win);
                        return;
                    }
                    schedule_webview_hwnd_lookup(app_clone.clone(), generation, hwnd_ptr, false);
                }
            } else {
                tracing::warn!("Failed to get hwnd for taskbar-lyric window");
                invalidate_and_destroy_taskbar_window(&app_clone, generation, &win);
            }
        } else if let Err(error) = result {
            warn!("任务栏歌词窗口创建失败（第 {} 次）：{error}", attempt + 1);
            if let Some(retry_generation) = state
                .visibility
                .invalidate_if_current_with(generation, mouse_forward::stop_mouse_hook)
            {
                state.take_resources_for_generation(generation);
                crate::window::reconcile_background_restore_entry(&app_clone);
                if attempt < 2 {
                    let retry_app = app_clone.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        open_taskbar_lyric_for_generation(retry_app, retry_generation, attempt + 1);
                    });
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect_tuple(rect: taskbar_lyric::Rect) -> (i32, i32, i32, i32) {
        (rect.x, rect.y, rect.width, rect.height)
    }

    fn sample_rect() -> taskbar_lyric::Rect {
        taskbar_lyric::Rect {
            x: 100,
            y: 200,
            width: 300,
            height: 40,
        }
    }

    #[test]
    fn taskbar_window_waits_for_layout_when_page_is_ready_first() {
        let visibility = TaskbarLyricVisibility::default();
        let generation = visibility.begin_open();

        assert!(!visibility.mark_page_ready(generation));
        assert!(visibility.mark_layout_ready(generation));
        assert!(!visibility.mark_layout_ready(generation));
        assert!(!visibility.mark_page_ready(generation));
    }

    #[test]
    fn taskbar_window_waits_for_page_when_layout_is_ready_first() {
        let visibility = TaskbarLyricVisibility::default();
        let generation = visibility.begin_open();

        assert!(!visibility.mark_layout_ready(generation));
        assert!(visibility.mark_page_ready(generation));
        assert!(!visibility.mark_page_ready(generation));
        assert!(!visibility.mark_layout_ready(generation));
    }

    #[test]
    fn stale_taskbar_window_generation_cannot_unlock_a_recreated_window() {
        let visibility = TaskbarLyricVisibility::default();
        let old_generation = visibility.begin_open();

        assert!(!visibility.mark_page_ready(old_generation));
        let new_generation = visibility.begin_open();

        assert!(!visibility.mark_layout_ready(old_generation));
        assert!(!visibility.mark_page_ready(old_generation));
        assert!(!visibility.mark_page_ready(new_generation));
        assert!(visibility.mark_layout_ready(new_generation));
    }

    #[test]
    fn stale_page_ready_payload_cannot_mark_the_new_window_ready() {
        let visibility = TaskbarLyricVisibility::default();
        let stale_payload_generation = visibility.begin_open();
        let current_generation = visibility.begin_open();

        assert!(!visibility.is_current(stale_payload_generation));
        assert!(!visibility.mark_page_ready(stale_payload_generation));
        assert!(!visibility.mark_layout_ready(current_generation));
        assert!(visibility.mark_page_ready(current_generation));
    }

    #[test]
    fn closing_taskbar_window_invalidates_pending_ready_callbacks() {
        let visibility = TaskbarLyricVisibility::default();
        let generation = visibility.begin_open();

        assert!(!visibility.mark_page_ready(generation));
        visibility.invalidate();

        assert!(!visibility.mark_layout_ready(generation));
        assert!(!visibility.is_current(generation));
    }

    #[test]
    fn reopen_after_close_reserves_a_fresh_page_generation() {
        let visibility = TaskbarLyricVisibility::default();
        let original = visibility.begin_open();
        assert!(visibility.bind_window(original, 100));

        let (closed, pending_reopen) = visibility.invalidate_with_previous_action(|| {});
        assert_eq!(closed, original);
        // Tao may still own the old window, but it cannot satisfy the new open.
        assert_eq!(visibility.current_window_identity(), None);
        let (previous, reopened) = visibility
            .begin_open_if_current_with_previous_action(pending_reopen, || {})
            .unwrap();
        assert_eq!(previous, pending_reopen);
        assert!(visibility.bind_window(reopened, 200));
        assert!(!visibility.mark_page_ready(original));
        assert!(!visibility.mark_page_ready(reopened));
        assert!(visibility.mark_layout_ready(reopened));
    }

    #[test]
    fn a_later_close_cancels_deferred_reopen_without_running_its_cleanup() {
        let visibility = TaskbarLyricVisibility::default();
        let original = visibility.begin_open();
        let recovery = visibility.invalidate_if_current(original).unwrap();
        let (_, closed) = visibility.invalidate_with_previous_action(|| {});
        let mut cleanup_ran = false;

        assert_eq!(
            visibility.begin_open_if_current_with_previous_action(recovery, || cleanup_ran = true),
            None
        );
        assert!(!cleanup_ran);
        assert!(visibility.is_current(closed));
        assert_eq!(visibility.current_window_identity(), None);
    }

    #[test]
    fn close_invalidates_a_reopen_that_won_the_race_first() {
        let visibility = TaskbarLyricVisibility::default();
        let original = visibility.begin_open();
        let (_, recovery) = visibility.invalidate_with_previous_action(|| {});
        let (_, reopened) = visibility
            .begin_open_if_current_with_previous_action(recovery, || {})
            .unwrap();
        assert!(visibility.bind_window(reopened, 200));

        let (cancelled, closed) = visibility.invalidate_with_previous_action(|| {});
        assert_eq!(cancelled, reopened);
        assert!(!visibility.is_current(original));
        assert!(!visibility.is_current(reopened));
        assert!(visibility.is_current(closed));
        assert!(!visibility.bind_window(reopened, 200));
        assert_eq!(visibility.current_window_identity(), None);
    }

    #[test]
    fn only_one_deferred_recovery_can_claim_a_generation() {
        let visibility = TaskbarLyricVisibility::default();
        let (_, recovery) = visibility.invalidate_with_previous_action(|| {});
        let (_, reopened) = visibility
            .begin_open_if_current_with_previous_action(recovery, || {})
            .unwrap();

        assert_eq!(
            visibility.begin_open_if_current_with_previous_action(recovery, || {}),
            None
        );
        assert!(visibility.is_current(reopened));
    }

    #[test]
    fn taskbar_layout_watchdog_rearms_when_no_callback_arrives() {
        let visibility = TaskbarLyricVisibility::default();
        let old_generation = visibility.begin_open();

        // Each iteration represents one watchdog waking after the previous
        // Embed+Update request produced no layout callback.
        for expected_attempt in 1..=MAX_TASKBAR_LAYOUT_RETRIES {
            assert_eq!(
                visibility.reserve_layout_retry(old_generation),
                Some(expected_attempt)
            );
            assert_eq!(visibility.reserve_layout_retry(old_generation), None);
            assert!(visibility.begin_reserved_layout_retry(old_generation));
        }
        assert_eq!(visibility.reserve_layout_retry(old_generation), None);
        assert!(visibility.layout_retries_exhausted(old_generation));
        let invalidated_generation = visibility
            .invalidate_if_current(old_generation)
            .expect("exhausted watchdog must invalidate its generation");
        assert!(!visibility.is_current(old_generation));
        assert!(visibility.is_current(invalidated_generation));

        let new_generation = visibility.begin_open();
        assert_eq!(visibility.reserve_layout_retry(old_generation), None);
        assert_eq!(visibility.reserve_layout_retry(new_generation), Some(1));
        assert!(!visibility.begin_reserved_layout_retry(old_generation));
        assert!(visibility.begin_reserved_layout_retry(new_generation));
    }

    #[test]
    fn successful_taskbar_layout_cancels_a_pending_retry() {
        let visibility = TaskbarLyricVisibility::default();
        let generation = visibility.begin_open();

        assert_eq!(visibility.reserve_layout_retry(generation), Some(1));
        assert!(!visibility.mark_layout_ready(generation));

        assert!(!visibility.begin_reserved_layout_retry(generation));
        assert_eq!(visibility.reserve_layout_retry(generation), None);
    }

    #[test]
    fn repeated_show_failures_exhaust_their_independent_budget() {
        let visibility = TaskbarLyricVisibility::default();
        let generation = visibility.begin_open();

        assert!(!visibility.mark_page_ready(generation));
        assert!(visibility.mark_layout_ready(generation));

        for failure in 1..=MAX_TASKBAR_SHOW_FAILURES {
            let expected = if failure == MAX_TASKBAR_SHOW_FAILURES {
                TaskbarShowFailureAction::Exhausted
            } else {
                TaskbarShowFailureAction::RetryLayout
            };
            assert_eq!(visibility.record_show_failure(generation), expected);

            if expected == TaskbarShowFailureAction::RetryLayout {
                assert_eq!(visibility.reserve_layout_retry(generation), Some(1));
                assert!(visibility.begin_reserved_layout_retry(generation));
                assert!(visibility.mark_layout_ready(generation));
            }
        }
    }

    #[test]
    fn successful_show_clears_the_show_failure_budget() {
        let visibility = TaskbarLyricVisibility::default();
        let generation = visibility.begin_open();

        for _ in 1..MAX_TASKBAR_SHOW_FAILURES {
            assert_eq!(
                visibility.record_show_failure(generation),
                TaskbarShowFailureAction::RetryLayout
            );
        }
        assert!(visibility.mark_show_succeeded(generation));

        assert_eq!(
            visibility.record_show_failure(generation),
            TaskbarShowFailureAction::RetryLayout
        );
    }

    #[test]
    fn stale_cleanup_cannot_take_resources_installed_by_a_reopen() {
        let resources = Mutex::new(Some(GenerationResource {
            generation: 1,
            value: "old",
        }));

        *resources.lock().unwrap() = Some(GenerationResource {
            generation: 2,
            value: "new",
        });

        assert_eq!(take_generation_resource(&resources, 1), None);
        assert_eq!(take_generation_resource(&resources, 2), Some("new"));
    }

    #[test]
    fn stale_show_request_cannot_match_the_reopened_window_handle() {
        let visibility = TaskbarLyricVisibility::default();
        let old_generation = visibility.begin_open();
        assert!(visibility.bind_window(old_generation, 100));

        let new_generation = visibility.begin_open();
        assert!(visibility.bind_window(new_generation, 200));

        assert!(!visibility.window_matches(old_generation, 100));
        assert!(!visibility.window_matches(old_generation, 200));
        assert!(visibility.window_matches(new_generation, 200));
    }

    #[test]
    fn webview_lookup_is_single_flight_and_can_be_rearmed_after_exhaustion() {
        let visibility = TaskbarLyricVisibility::default();
        let generation = visibility.begin_open();
        assert!(visibility.bind_window(generation, 100));

        let first_lookup_epoch =
            match visibility
                .reserve_webview_lookup_with_hook_health(generation, 100, false, || false)
            {
                WebviewLookupReservation::Start(lookup_epoch) => lookup_epoch,
                result => panic!("unexpected lookup reservation: {result:?}"),
            };
        assert_eq!(
            visibility.reserve_webview_lookup_with_hook_health(generation, 100, true, || false),
            WebviewLookupReservation::Queued
        );
        assert_eq!(
            visibility.finish_webview_lookup(generation, 100, first_lookup_epoch),
            WebviewLookupFinish::Rearm
        );
        let second_lookup_epoch =
            match visibility
                .reserve_webview_lookup_with_hook_health(generation, 100, true, || false)
            {
                WebviewLookupReservation::Start(lookup_epoch) => lookup_epoch,
                result => panic!("unexpected lookup reservation: {result:?}"),
            };
        assert_ne!(first_lookup_epoch, second_lookup_epoch);

        let new_generation = visibility.begin_open();
        assert!(visibility.bind_window(new_generation, 200));
        assert_eq!(
            visibility.finish_webview_lookup(generation, 100, second_lookup_epoch),
            WebviewLookupFinish::Stale
        );
        assert_eq!(
            visibility.reserve_webview_lookup_with_hook_health(generation, 100, true, || false),
            WebviewLookupReservation::Skip
        );
    }

    #[test]
    fn webview_lookup_ready_state_tracks_hook_health_and_forced_revalidation() {
        let visibility = TaskbarLyricVisibility::default();
        let generation = visibility.begin_open();
        assert!(visibility.bind_window(generation, 100));
        visibility
            .state
            .lock()
            .unwrap()
            .mouse_forwarding_webview_hwnd = Some(300);

        assert_eq!(
            visibility.reserve_webview_lookup_with_hook_health(generation, 100, false, || true),
            WebviewLookupReservation::Skip
        );
        let lookup_epoch = match visibility.reserve_webview_lookup_with_hook_health(
            generation,
            100,
            true,
            || true,
        ) {
            WebviewLookupReservation::Start(lookup_epoch) => lookup_epoch,
            result => panic!("unexpected lookup reservation: {result:?}"),
        };
        assert_eq!(
            visibility.finish_webview_lookup(generation, 100, lookup_epoch),
            WebviewLookupFinish::Exhausted
        );

        assert!(matches!(
            visibility.reserve_webview_lookup_with_hook_health(generation, 100, false, || false),
            WebviewLookupReservation::Start(_)
        ));
    }

    #[test]
    fn queued_force_revalidation_survives_inflight_install_success() {
        let visibility = TaskbarLyricVisibility::default();
        let generation = visibility.begin_open();
        assert!(visibility.bind_window(generation, 100));

        let lookup_epoch =
            match visibility
                .reserve_webview_lookup_with_hook_health(generation, 100, false, || false)
            {
                WebviewLookupReservation::Start(lookup_epoch) => lookup_epoch,
                result => panic!("unexpected lookup reservation: {result:?}"),
            };
        assert_eq!(
            visibility.reserve_webview_lookup_with_hook_health(generation, 100, true, || false),
            WebviewLookupReservation::Queued
        );

        let install_result = {
            let mut state = visibility.state.lock().unwrap();
            assert_eq!(state.webview_lookup_epoch, lookup_epoch);
            TaskbarLyricVisibility::commit_mouse_forwarding_install(&mut state, 300)
        };
        assert_eq!(
            install_result,
            MouseForwardingInstallResult::InstalledAndRearm
        );

        let successor_epoch = match visibility.reserve_webview_lookup_with_hook_health(
            generation,
            100,
            true,
            || true,
        ) {
            WebviewLookupReservation::Start(lookup_epoch) => lookup_epoch,
            result => panic!("unexpected lookup reservation: {result:?}"),
        };
        assert_ne!(lookup_epoch, successor_epoch);
    }

    #[test]
    fn exhausted_lookup_cannot_invalidate_a_newer_lookup() {
        let visibility = TaskbarLyricVisibility::default();
        let generation = visibility.begin_open();
        assert!(visibility.bind_window(generation, 100));

        let exhausted_epoch =
            match visibility
                .reserve_webview_lookup_with_hook_health(generation, 100, false, || false)
            {
                WebviewLookupReservation::Start(lookup_epoch) => lookup_epoch,
                result => panic!("unexpected lookup reservation: {result:?}"),
            };
        assert_eq!(
            visibility.finish_webview_lookup(generation, 100, exhausted_epoch),
            WebviewLookupFinish::Exhausted
        );

        let replacement_epoch =
            match visibility
                .reserve_webview_lookup_with_hook_health(generation, 100, true, || false)
            {
                WebviewLookupReservation::Start(lookup_epoch) => lookup_epoch,
                result => panic!("unexpected lookup reservation: {result:?}"),
            };
        assert_ne!(exhausted_epoch, replacement_epoch);
        {
            let mut state = visibility.state.lock().unwrap();
            state.webview_lookup_pending = false;
            state.mouse_forwarding_webview_hwnd = Some(300);
        }

        assert!(!visibility.invalidate_exhausted_webview_lookup_if_current(
            generation,
            100,
            exhausted_epoch,
            || panic!("stale lookup invalidated the replacement"),
        ));
        assert!(visibility.window_matches(generation, 100));
    }

    #[test]
    fn webview_hwnd_lookup_retry_schedule_is_finite() {
        let delays = (0..MAX_WEBVIEW_HWND_LOOKUP_ATTEMPTS)
            .map(webview_hwnd_retry_delay)
            .collect::<Vec<_>>();

        assert_eq!(
            delays,
            vec![
                Some(Duration::from_millis(50)),
                Some(Duration::from_millis(100)),
                Some(Duration::from_millis(200)),
                Some(Duration::from_millis(400)),
                Some(Duration::from_millis(800)),
                Some(Duration::from_millis(1_600)),
                None,
            ]
        );
    }

    #[test]
    fn infers_each_edge_from_taskbar_and_monitor_rects() {
        let monitor = RECT {
            left: -1_280,
            top: -200,
            right: 640,
            bottom: 880,
        };

        assert_eq!(
            taskbar_edge_from_rect(
                RECT {
                    left: -1_280,
                    top: -246,
                    right: 640,
                    bottom: -198,
                },
                monitor,
            ),
            Some(TaskbarEdge::Top)
        );
        assert_eq!(
            taskbar_edge_from_rect(
                RECT {
                    left: -1_280,
                    top: 878,
                    right: 640,
                    bottom: 926,
                },
                monitor,
            ),
            Some(TaskbarEdge::Bottom)
        );
        assert_eq!(
            taskbar_edge_from_rect(
                RECT {
                    left: -1_326,
                    top: -200,
                    right: -1_278,
                    bottom: 880,
                },
                monitor,
            ),
            Some(TaskbarEdge::Left)
        );
        assert_eq!(
            taskbar_edge_from_rect(
                RECT {
                    left: 638,
                    top: -200,
                    right: 686,
                    bottom: 880,
                },
                monitor,
            ),
            Some(TaskbarEdge::Right)
        );
        assert_eq!(
            taskbar_edge_from_rect(
                RECT {
                    left: 10,
                    top: 10,
                    right: 10,
                    bottom: 20,
                },
                monitor,
            ),
            None
        );
    }

    #[test]
    fn reserves_trigger_band_for_each_auto_hidden_taskbar_edge() {
        assert_eq!(
            rect_tuple(reserve_auto_hide_trigger_band(
                sample_rect(),
                Some(TaskbarEdge::Bottom)
            )),
            (100, 202, 300, 38)
        );
        assert_eq!(
            rect_tuple(reserve_auto_hide_trigger_band(
                sample_rect(),
                Some(TaskbarEdge::Top)
            )),
            (100, 200, 300, 38)
        );
        assert_eq!(
            rect_tuple(reserve_auto_hide_trigger_band(
                sample_rect(),
                Some(TaskbarEdge::Right)
            )),
            (102, 200, 298, 40)
        );
        assert_eq!(
            rect_tuple(reserve_auto_hide_trigger_band(
                sample_rect(),
                Some(TaskbarEdge::Left)
            )),
            (100, 200, 298, 40)
        );
    }

    #[test]
    fn offsets_content_back_to_the_unreserved_taskbar_center() {
        assert_eq!(
            auto_hide_content_offset(Some(TaskbarEdge::Bottom), 1.0),
            (0.0, -1.0)
        );
        assert_eq!(
            auto_hide_content_offset(Some(TaskbarEdge::Top), 1.0),
            (0.0, 1.0)
        );
        assert_eq!(
            auto_hide_content_offset(Some(TaskbarEdge::Right), 2.0),
            (-0.5, 0.0)
        );
        assert_eq!(
            auto_hide_content_offset(Some(TaskbarEdge::Left), 2.0),
            (0.5, 0.0)
        );
        assert_eq!(auto_hide_content_offset(None, 1.0), (0.0, 0.0));
        assert_eq!(
            auto_hide_content_offset(Some(TaskbarEdge::Bottom), 0.0),
            (0.0, -1.0)
        );
    }

    #[test]
    fn leaves_rect_unchanged_when_taskbar_is_not_auto_hidden() {
        assert_eq!(
            rect_tuple(reserve_auto_hide_trigger_band(sample_rect(), None)),
            (100, 200, 300, 40)
        );
    }

    #[test]
    fn does_not_make_tiny_rect_dimensions_negative() {
        let tiny = taskbar_lyric::Rect {
            x: 10,
            y: 20,
            width: 1,
            height: 1,
        };

        assert_eq!(
            rect_tuple(reserve_auto_hide_trigger_band(
                tiny,
                Some(TaskbarEdge::Bottom)
            )),
            (10, 21, 1, 0)
        );
        assert_eq!(
            rect_tuple(reserve_auto_hide_trigger_band(tiny, Some(TaskbarEdge::Top))),
            (10, 20, 1, 0)
        );
        assert_eq!(
            rect_tuple(reserve_auto_hide_trigger_band(
                tiny,
                Some(TaskbarEdge::Right)
            )),
            (11, 20, 0, 1)
        );
        assert_eq!(
            rect_tuple(reserve_auto_hide_trigger_band(
                tiny,
                Some(TaskbarEdge::Left)
            )),
            (10, 20, 0, 1)
        );
    }
}
