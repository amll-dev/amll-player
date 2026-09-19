#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// Signals that ndk_context has been initialized on Android.
/// The audio thread waits on this before opening the audio device.
#[cfg(target_os = "android")]
pub(crate) static ANDROID_NDK_READY: std::sync::OnceLock<()> = std::sync::OnceLock::new();

#[cfg(not(mobile))]
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime, path::BaseDirectory};
use tokio::sync::RwLock;
use tracing::*;

use crate::server::AMLLWebSocketServer;
use crate::server::AMLLWebSocketServerWrapper;

mod db;
mod db_events;
#[cfg(target_os = "linux")]
mod linux_graphics;
mod logging;
mod music_info;
mod player;
mod screen_capture;
mod server;
mod ttml_db;
mod utils;
mod window;

#[cfg(desktop)]
mod extension_window;

#[cfg(target_os = "windows")]
mod taskbar_lyric;
#[cfg(target_os = "windows")]
mod theme_watcher;

#[tauri::command]
fn restart_app<R: Runtime>(app: AppHandle<R>) {
    app.request_restart();
}

fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let log_dir = app
        .handle()
        .path()
        .resolve("logs", BaseDirectory::AppData)
        .expect("failed to resolve app data dir");
    let log_guard = logging::init_logging(&log_dir);
    app.manage(log_guard);
    info!("AMLL Player is starting!");

    #[cfg(target_os = "ios")]
    {
        use objc2::msg_send;
        use objc2_avf_audio::AVAudioSession;
        use objc2_foundation::ns_string;

        info!("Initializing iOS AVAudioSession Category to Playback...");
        unsafe {
            let session = AVAudioSession::sharedInstance();
            let category = ns_string!("AVAudioSessionCategoryPlayback");

            let _: () = msg_send![&session, setCategory: category, error: std::ptr::null_mut::<*mut *mut objc2_foundation::NSError>()];

            let _: bool = msg_send![&session, setActive: true, error: std::ptr::null_mut::<*mut *mut objc2_foundation::NSError>()];
        }
        info!("iOS AVAudioSession Category set to Playback successfully!");
    }
    #[cfg(target_os = "android")]
    {
        if let Some(webview) = app.get_webview_window("main") {
            let _ = webview.with_webview(|webview| {
                // with_webview is dispatched to the Android UI thread (async).
                // After initialize_android_context we set ANDROID_NDK_READY so
                // the audio thread (which spins on it) can proceed safely.
                webview.jni_handle().exec(|env, context, _webview| {
                    let vm = env.get_java_vm().expect("Failed to get JavaVM");
                    unsafe {
                        ndk_context::initialize_android_context(
                            vm.get_java_vm_pointer() as *mut _,
                            context.as_raw() as *mut _,
                        );
                    }

                    ANDROID_NDK_READY.get_or_init(|| ());
                    info!("Android NDK context initialized.");
                });
            });
        } else {
            // Webview not available yet at setup time; signal anyway so the
            // audio thread doesn't block forever (best-effort fallback).
            warn!("Main webview not found at setup time; signalling NDK ready without init.");
            ANDROID_NDK_READY.get_or_init(|| ());
        }
    }

    #[cfg(not(mobile))]
    {
        tauri::async_runtime::block_on(window::recreate_window(app.handle(), "main", None));
    }

    player::init_local_player(app.handle().clone());

    let db_conn = tauri::async_runtime::block_on(db::init_database(app.handle()))
        .expect("Failed to initialize database");
    app.manage(db_conn);

    {
        let db_ref = app.state::<db::DbConnection>().inner().clone();
        let gc_app = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            match db::cleanup::run_cover_gc(&db_ref, &gc_app).await {
                Ok(result) if result.deleted > 0 => {
                    info!(
                        "[Startup] Cover GC: scanned {}, deleted {} orphaned covers",
                        result.total_scanned, result.deleted
                    );
                }
                Ok(_) => {}
                Err(e) => warn!("[Startup] Cover GC failed: {e}"),
            }
        });
    }

    let app_handle = app.handle().clone();
    let mut rx = db_events::DB_EVENT_SENDER.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let _ = app_handle.emit("db-row-changed", &event);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    warn!("DB event broadcast lagged, {skipped} events dropped");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    #[cfg(target_os = "windows")]
    app.manage(taskbar_lyric::TaskbarLyricState::default());

    #[cfg(target_os = "windows")]
    {
        match theme_watcher::ThemeWatcher::new(app.handle().clone()) {
            Ok(watcher) => {
                app.manage(watcher);
            }
            Err(e) => {
                warn!("启动系统主题监听失败: {e}");
            }
        }
    }

    #[cfg(desktop)]
    let _ = app
        .handle()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build());

    app.manage(ttml_db::create_shared_reader());

    #[cfg(desktop)]
    app.manage(extension_window::ExtensionWindowState::default());

    app.manage::<AMLLWebSocketServerWrapper>(RwLock::new(AMLLWebSocketServer::new(
        app.handle().clone(),
    )));
    Ok(())
}

fn handle_window_event(_window: &tauri::Window, _event: &tauri::WindowEvent) {
    #[cfg(desktop)]
    if let tauri::WindowEvent::Destroyed = _event {
        extension_window::cleanup_destroyed_window(_window.app_handle(), _window.label());
        if _window.label() == "main" {
            extension_window::destroy_all_extension_windows(_window.app_handle());
        }
    }

    #[cfg(target_os = "windows")]
    if let tauri::WindowEvent::Destroyed = _event
        && _window.label() == "main"
        && let Some(taskbar_win) = _window.app_handle().get_webview_window("taskbar-lyric")
    {
        let _ = taskbar_win.destroy();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    linux_graphics::configure_nvidia_wayland();

    // Install ring as the default crypto provider for rustls, because multiple providers
    // (aws-lc-rs and ring) might be enabled in our dependency tree and rustls demands one to be explicitly chosen.
    #[cfg(target_os = "android")]
    let _ = rustls::crypto::ring::default_provider().install_default();

    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();

    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_macos_fps::init());

    #[cfg(not(mobile))]
    let pubkey = {
        if let Some(Value::Object(updater_config)) = context.config().plugins.0.get("updater") {
            if let Some(Value::String(pubkey)) = updater_config.get("pubkey") {
                pubkey.clone()
            } else {
                "".into()
            }
        } else {
            "".into()
        }
    };
    #[cfg(not(mobile))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().pubkey(pubkey).build());

    #[cfg(mobile)]
    {
        context
            .config_mut()
            .app
            .windows
            .push(tauri::utils::config::WindowConfig {
                ..Default::default()
            })
    }

    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::new().build());

    builder
        .invoke_handler(tauri::generate_handler![
            server::ws_reopen_connection,
            server::ws_get_connections,
            server::ws_broadcast_payload,
            server::ws_close_connection,
            window::open_screenshot_window,
            screen_capture::take_screenshot,
            player::local_player_send_msg,
            player::set_media_controls_enabled,
            music_info::resolve_content_uri,
            music_info::read_local_music_metadata,
            music_info::read_local_music_file_metadata,
            music_info::save_cover_from_path,
            restart_app,
            ttml_db::sync_lyrics,
            ttml_db::search_lyrics,
            ttml_db::get_lyric_detail,
            db::commands::get_all_playlists,
            db::commands::get_playlist,
            db::commands::create_playlist,
            db::commands::update_playlist,
            db::commands::delete_playlist,
            db::commands::add_songs_to_playlist,
            db::commands::remove_song_from_playlist,
            db::commands::upsert_songs,
            db::commands::get_song,
            db::commands::get_songs_by_ids,
            db::commands::update_song,
            db::commands::get_playlist_songs,
            db::commands::save_playlist_cover,
            db::commands::clear_playlist_cover,
            db::commands::scan_and_create_playlist,
            db::commands::get_playlist_folders,
            db::commands::link_playlist_folder,
            db::commands::unlink_playlist_folder,
            db::commands::refresh_playlist,
            db::migrate::migrate_songs_batch,
            db::migrate::migrate_playlists_batch,
            db::cleanup::cleanup_orphaned_covers,
            #[cfg(desktop)]
            extension_window::extension_window_create,
            #[cfg(desktop)]
            extension_window::extension_window_get,
            #[cfg(desktop)]
            extension_window::extension_window_close,
            #[cfg(desktop)]
            extension_window::extension_window_close_all,
            #[cfg(desktop)]
            extension_window::extension_window_show,
            #[cfg(desktop)]
            extension_window::extension_window_hide,
            #[cfg(desktop)]
            extension_window::extension_window_focus,
            #[cfg(desktop)]
            extension_window::extension_window_center,
            #[cfg(desktop)]
            extension_window::extension_window_set_title,
            #[cfg(desktop)]
            extension_window::extension_window_set_size,
            #[cfg(desktop)]
            extension_window::extension_window_set_position,
            #[cfg(desktop)]
            extension_window::extension_window_mark_ready,
            #[cfg(desktop)]
            extension_window::extension_window_get_current,
            #[cfg(desktop)]
            extension_window::extension_window_get_current_extension_files,
            #[cfg(target_os = "windows")]
            window::set_window_always_on_top,
            #[cfg(target_os = "windows")]
            taskbar_lyric::mouse_forward::set_click_interception,
            #[cfg(target_os = "windows")]
            taskbar_lyric::mouse_forward::set_forwarding_enabled,
            #[cfg(target_os = "windows")]
            taskbar_lyric::mouse_forward::stop_mouse_hook,
            #[cfg(target_os = "windows")]
            taskbar_lyric::close_taskbar_lyric,
            #[cfg(target_os = "windows")]
            taskbar_lyric::open_taskbar_lyric,
            #[cfg(target_os = "windows")]
            taskbar_lyric::open_taskbar_lyric_devtools,
            #[cfg(target_os = "windows")]
            theme_watcher::get_system_theme
        ])
        .setup(setup_app)
        .on_window_event(handle_window_event)
        .run(context)
        .expect("error while running tauri application");
}
