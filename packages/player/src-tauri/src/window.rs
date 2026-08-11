use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewWindowBuilder};
#[cfg(desktop)]
use tauri::{PhysicalSize, Size, utils::config::WindowEffectsConfig, window::Effect};
use tracing::*;

#[derive(Serialize)]
pub struct LinuxWebviewPrompt {
    config_path: String,
}

pub async fn create_common_win<'a>(
    app: &'a AppHandle,
    url: tauri::WebviewUrl,
    label: &str,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let win = WebviewWindowBuilder::new(app, label, url);
    #[cfg(target_os = "linux")]
    let win = if label == "main" && crate::linux_webview::is_openbox_wrapper() {
        win.initialization_script("document.documentElement.dataset.amllOpenboxWrapper = 'true';")
    } else {
        win
    };
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
    let win = create_common_win(app, url, label).await;

    let win = win.build().expect("can't show original window");

    #[cfg(desktop)]
    {
        let _ = win.set_focus();
        #[cfg(target_os = "linux")]
        let apply_redraw_workaround = !crate::linux_webview::is_openbox_wrapper();
        #[cfg(not(target_os = "linux"))]
        let apply_redraw_workaround = true;
        if apply_redraw_workaround && let Ok(orig_size) = win.inner_size() {
            let _ = win.set_size(Size::Physical(PhysicalSize::new(0, 0)));
            let _ = win.set_size(orig_size);
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

#[tauri::command]
pub fn get_linux_webview_startup_prompt() -> Option<LinuxWebviewPrompt> {
    #[cfg(target_os = "linux")]
    {
        crate::linux_webview::first_run_prompt().map(|path| LinuxWebviewPrompt {
            config_path: path.display().to_string(),
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

#[tauri::command]
pub fn set_linux_webview_backend(backend: String) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        crate::linux_webview::save_preference(&backend)
            .map(|path| path.display().to_string())
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = backend;
        Err("Linux webview settings are only available on Linux".to_string())
    }
}

#[tauri::command]
pub fn restart_linux_webview_with_system_backend() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        crate::linux_webview::restart_with_system_backend()
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err("Linux webview settings are only available on Linux".to_string())
    }
}

#[tauri::command]
pub fn toggle_openbox_fullscreen() -> Result<Option<bool>, String> {
    #[cfg(target_os = "linux")]
    {
        crate::linux_webview::toggle_openbox_fullscreen()
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(None)
    }
}

#[tauri::command]
pub fn is_openbox_maximized() -> Result<Option<bool>, String> {
    #[cfg(target_os = "linux")]
    {
        crate::linux_webview::is_openbox_maximized()
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(None)
    }
}

#[tauri::command]
pub fn toggle_openbox_maximize() -> Result<Option<bool>, String> {
    #[cfg(target_os = "linux")]
    {
        crate::linux_webview::toggle_openbox_maximize()
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(None)
    }
}

#[tauri::command]
pub fn minimize_openbox_wrapper() -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        crate::linux_webview::minimize_openbox_wrapper()
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(false)
    }
}

#[tauri::command]
pub fn start_openbox_drag() -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        crate::linux_webview::start_openbox_drag()
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(false)
    }
}

#[tauri::command]
pub fn start_openbox_resize(direction: String) -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        crate::linux_webview::start_openbox_resize(&direction)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = direction;
        Ok(false)
    }
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
