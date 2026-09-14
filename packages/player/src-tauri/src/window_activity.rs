use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager};
use tracing::debug;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    ICoreWebView2_19,
};
use windows::Win32::{
    Foundation::HWND,
    UI::WindowsAndMessaging::{IsIconic, IsWindowVisible},
};
use windows_061::core::Interface;

const MAIN_WINDOW_ACTIVITY_EVENT: &str = "amll-player://main-window-activity";

#[derive(Default)]
pub(crate) struct MainWindowActivityState {
    refresh_lock: tokio::sync::Mutex<()>,
    last_reported: Arc<Mutex<Option<(usize, bool)>>>,
}

/// Leave Tao's event callback before looking up a window or dispatching work.
/// The native WebView closure must not re-enter Tauri's window/manager APIs.
pub(crate) fn refresh_main_window_activity(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<MainWindowActivityState>() else {
            return;
        };
        // Serialize reads and event delivery so a late worker cannot publish an
        // older hidden state after a newer restore. No UI callback takes this lock.
        let _refresh_guard = state.refresh_lock.lock().await;
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        let Ok(raw_hwnd) = window.hwnd() else {
            return;
        };
        let hwnd_value = raw_hwnd.0 as usize;
        let last_reported = state.last_reported.clone();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        if let Err(error) = window.with_webview(move |webview| {
            let hwnd = HWND(hwnd_value as *mut _);
            // Read the current native state, not a possibly stale hide/show intent.
            let active = unsafe { IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool() };
            {
                let mut last_reported = last_reported
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let next = Some((hwnd_value, active));
                if *last_reported == next {
                    let _ = sender.send(None);
                    return;
                }
                *last_reported = next;
            }

            // LOW keeps JavaScript and network connections running. Suspending
            // this WebView would also suspend playback and taskbar/tray bridges.
            let result = (|| -> windows_061::core::Result<()> {
                let core = unsafe { webview.controller().CoreWebView2()? };
                let memory = core.cast::<ICoreWebView2_19>()?;
                unsafe {
                    memory.SetMemoryUsageTargetLevel(if active {
                        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                    } else {
                        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                    })
                }
            })();
            if let Err(error) = result {
                // Older runtimes can lack this optional interface. Frontend
                // resource disposal remains available independently.
                debug!("Unable to adjust main WebView memory target: {error}");
            }
            let _ = sender.send(Some(active));
        }) {
            debug!("Unable to refresh main window activity: {error}");
            return;
        }
        if let Ok(Some(active)) = receiver.await {
            debug!(active, "Main window activity changed");
            let _ = window.emit(MAIN_WINDOW_ACTIVITY_EVENT, active);
        }
    });
}

pub(crate) fn handle_main_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "main" {
        return;
    }
    match event {
        // Tauri reports Windows WM_SIZE, including minimize/restore, as
        // Resized. Focus loss alone does not mean the window is hidden.
        tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(_) => {
            refresh_main_window_activity(window.app_handle());
        }
        tauri::WindowEvent::Destroyed => {
            *window
                .state::<MainWindowActivityState>()
                .last_reported
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        }
        _ => {}
    }
}
