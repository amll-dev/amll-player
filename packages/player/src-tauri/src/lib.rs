#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// Signals that ndk_context has been initialized on Android.
/// The audio thread waits on this before opening the audio device.
#[cfg(target_os = "android")]
pub(crate) static ANDROID_NDK_READY: std::sync::OnceLock<()> = std::sync::OnceLock::new();

use std::net::SocketAddr;

use amll_player_core::AudioInfo;
use anyhow::Context;
use ffmpeg_audio::AudioReader;
use serde::*;
#[cfg(not(mobile))]
use serde_json::Value;
use tauri::{
    AppHandle, Emitter, Manager, Runtime, State, WebviewWindowBuilder, ipc::Channel,
    path::BaseDirectory,
};
#[cfg(desktop)]
use tauri::{PhysicalSize, Size, utils::config::WindowEffectsConfig, window::Effect};
use tokio::sync::RwLock;
use tracing::*;

use crate::server::AMLLWebSocketServer;

mod db;
mod db_events;
mod player;
mod screen_capture;
mod server;
mod ttml_db;
mod utils;

#[cfg(desktop)]
mod extension_window;

#[cfg(target_os = "windows")]
mod taskbar_lyric;
#[cfg(target_os = "windows")]
mod theme_watcher;

pub type AMLLWebSocketServerWrapper = RwLock<AMLLWebSocketServer>;
pub type AMLLWebSocketServerState<'r> = State<'r, AMLLWebSocketServerWrapper>;

// Learn more about Tauri commands at https://tauri.app/v1/guides/features/command
#[tauri::command]
async fn ws_reopen_connection(
    addr: &str,
    ws: AMLLWebSocketServerState<'_>,
    channel: Channel<ws_protocol::v2::Payload>,
) -> Result<(), String> {
    ws.write().await.reopen(addr.to_string(), channel);
    Ok(())
}

#[tauri::command]
async fn ws_close_connection(ws: AMLLWebSocketServerState<'_>) -> Result<(), String> {
    ws.write().await.close().await;
    Ok(())
}

#[tauri::command]
async fn ws_get_connections(ws: AMLLWebSocketServerState<'_>) -> Result<Vec<SocketAddr>, String> {
    let server_guard = ws.read().await;
    let connections = server_guard.get_connections().await;
    Ok(connections)
}

#[tauri::command]
async fn ws_broadcast_payload(
    ws: AMLLWebSocketServerState<'_>,
    payload: ws_protocol::v2::Payload,
) -> Result<(), String> {
    ws.write().await.broadcast_payload(payload).await;
    Ok(())
}

#[tauri::command]
fn restart_app<R: Runtime>(app: AppHandle<R>) {
    tauri::process::restart(&app.env())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn set_window_always_on_top<R: Runtime>(enabled: bool, app: AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.set_always_on_top(enabled).map_err(|e| e.to_string())
    } else {
        Err("Main window not found.".to_string())
    }
}

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicInfo {
    pub name: String,
    pub artist: String,
    pub album: String,
    pub lyric_format: String,
    pub lyric: String,
    pub cover_path: String,
    pub duration: f64,
}

impl MusicInfo {
    fn from_audio_info(v: AudioInfo, cover_path: String) -> Self {
        Self {
            name: v.name,
            artist: v.artist,
            album: v.album,
            lyric_format: if v.lyric.is_empty() {
                "".into()
            } else {
                "lrc".into()
            },
            lyric: v.lyric,
            cover_path,
            duration: v.duration,
        }
    }
}

#[tauri::command]
async fn resolve_content_uri(
    file_path: tauri_plugin_fs::FilePath,
    fs: State<'_, tauri_plugin_fs::Fs<tauri::Wry>>,
    app: AppHandle,
) -> Result<String, String> {
    // If it's already a real filesystem path, return it directly
    if let Some(p) = file_path.as_path() {
        return Ok(p.to_string_lossy().into_owned());
    }

    // For content:// URIs (Android), use the fs plugin to open via ContentResolver,
    // then copy to app data dir so FFmpeg can access the real file path.
    let uri_string = match &file_path {
        tauri_plugin_fs::FilePath::Url(u) => u.to_string(),
        tauri_plugin_fs::FilePath::Path(p) => p.to_string_lossy().into_owned(),
    };

    // Determine file extension from URI
    let ext = uri_string
        .rsplit('/')
        .next()
        .and_then(|segment| {
            let decoded = urlencoding::decode(segment).unwrap_or(segment.into());
            let name = decoded.rsplit('/').next().unwrap_or(&decoded);
            name.rsplit('.').next().map(|e| e.to_lowercase())
        })
        .filter(|e| {
            ["mp3", "flac", "wav", "m4a", "aac", "ogg", "wma", "opus"].contains(&e.as_str())
        })
        .unwrap_or_else(|| "audio".to_string());

    // Create a hash-based filename to avoid duplicates
    let uri_hash = format!("{:x}", md5::compute(uri_string.as_bytes()));
    let filename = format!("{uri_hash}.{ext}");

    // Build target directory: app_data_dir/music_cache/
    let data_dir = app
        .path()
        .resolve("music_cache", BaseDirectory::AppData)
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create music_cache dir: {e}"))?;

    let target_path = data_dir.join(&filename);

    // If already cached, return directly
    if target_path.exists() {
        return Ok(target_path.to_string_lossy().into_owned());
    }

    // Open the content:// URI via tauri-plugin-fs (uses ContentResolver on Android)
    let mut open_opts = tauri_plugin_fs::OpenOptions::new();
    open_opts.read(true);
    let mut src_file = fs
        .open(file_path, open_opts)
        .map_err(|e| format!("Failed to open content URI: {e}"))?;

    let mut dst_file = std::fs::File::create(&target_path)
        .map_err(|e| format!("Failed to create cache file: {e}"))?;

    std::io::copy(&mut src_file, &mut dst_file).map_err(|e| {
        // Clean up partial file on failure
        let _ = std::fs::remove_file(&target_path);
        format!("Failed to copy file: {e}")
    })?;

    info!("Resolved content URI to: {}", target_path.display());
    Ok(target_path.to_string_lossy().into_owned())
}

pub(crate) fn get_covers_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .resolve("covers", BaseDirectory::AppData)
        .map_err(|e| format!("Failed to resolve covers dir: {e}"))
}

#[tauri::command]
async fn read_local_music_metadata(
    file_path: tauri_plugin_fs::FilePath,
    fs: State<'_, tauri_plugin_fs::Fs<tauri::Wry>>,
    app: AppHandle,
) -> Result<MusicInfo, String> {
    let path_clone = file_path
        .as_path()
        .context("Invalid file path")
        .map_err(|e| e.to_string())?
        .to_path_buf();

    let audio_info = tokio::task::spawn_blocking(move || -> anyhow::Result<AudioInfo> {
        let file = std::fs::File::open(&path_clone)
            .with_context(|| format!("无法打开文件: {}", path_clone.display()))?;
        let reader = AudioReader::new(file)
            .with_context(|| format!("无法初始化音频解码器: {}", path_clone.display()))?;
        let info = amll_player_core::utils::build_audio_info(&reader);
        Ok(info)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    let cover_bytes = audio_info.cover.clone().unwrap_or_default();
    let song_id = format!(
        "{:x}",
        md5::compute(
            file_path
                .as_path()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default()
                .as_bytes(),
        )
    );

    let cover_path = if !cover_bytes.is_empty() {
        let covers_dir = get_covers_dir(&app)?;
        std::fs::create_dir_all(&covers_dir)
            .map_err(|e| format!("Failed to create covers dir: {e}"))?;
        let cover_file = covers_dir.join(format!("{song_id}.jpg"));
        std::fs::write(&cover_file, &cover_bytes)
            .map_err(|e| format!("Failed to save cover: {e}"))?;
        cover_file.to_string_lossy().to_string()
    } else {
        String::new()
    };

    let mut music_info = MusicInfo::from_audio_info(audio_info, cover_path);

    if let Some(file_path_ref) = file_path.as_path()
        && music_info.lyric.is_empty()
    {
        const LYRIC_FILE_EXTENSIONS: &[&str] = &["ttml", "lys", "yrc", "qrc", "eslrc", "lrc"];
        for ext in LYRIC_FILE_EXTENSIONS {
            let lyric_file_path = file_path_ref.with_extension(ext);
            if lyric_file_path.exists() {
                if let Ok(lyric) = fs.read_to_string(&lyric_file_path) {
                    music_info.lyric_format = ext.to_string();
                    music_info.lyric = lyric;
                    break;
                } else {
                    warn!("歌词文件存在但读取失败: {}", lyric_file_path.display());
                }
            }
        }
    }

    Ok(music_info)
}

#[tauri::command]
async fn save_cover_from_path(
    song_id: String,
    source_path: String,
    app: AppHandle,
) -> Result<String, String> {
    let covers_dir = get_covers_dir(&app)?;
    std::fs::create_dir_all(&covers_dir)
        .map_err(|e| format!("Failed to create covers dir: {e}"))?;

    let source = std::path::Path::new(&source_path);
    let ext = crate::utils::cover_ext_for_path(source);
    let cover_file = covers_dir.join(format!("{song_id}.{ext}"));

    std::fs::copy(source, &cover_file).map_err(|e| format!("Failed to copy cover: {e}"))?;

    Ok(cover_file.to_string_lossy().to_string())
}

async fn create_common_win<'a>(
    app: &'a AppHandle,
    url: tauri::WebviewUrl,
    label: &str,
) -> tauri::WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
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

async fn recreate_window(app: &AppHandle, label: &str, path: Option<&str>) {
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
        if let Ok(orig_size) = win.inner_size() {
            let _ = win.set_size(Size::Physical(PhysicalSize::new(0, 0)));
            let _ = win.set_size(orig_size);
        }
    }
    #[cfg(not(desktop))]
    let _ = win;

    info!("Created window: {}", label);
}

#[tauri::command]
async fn open_screenshot_window(app: AppHandle) {
    recreate_window(&app, "screenshot", Some("screenshot.html")).await;
}

#[tauri::command]
async fn sync_lyrics(
    app: AppHandle,
    reader_state: State<'_, ttml_db::LyricDbReader>,
) -> Result<ttml_db::model::SyncResult, String> {
    let data_dir = ttml_db::get_lyric_db_dir(&app)?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create lyric-db dir: {e}"))?;

    let mut syncer = ttml_db::sync::LyricSyncer::new(data_dir);
    let result = syncer.sync().await.map_err(|e| format!("{:#}", e))?;

    if result.status == ttml_db::model::SyncStatus::Updated {
        let index_file = ttml_db::get_index_file_path(&app)?;
        if index_file.exists() {
            let _ = ttml_db::refresh_shared_reader(&reader_state, &index_file).await;
        }
    }

    Ok(result)
}

#[tauri::command]
async fn search_lyrics(
    app: AppHandle,
    reader_state: State<'_, ttml_db::LyricDbReader>,
    filters: Vec<ttml_db::model::SearchFilter>,
) -> Result<Vec<ttml_db::model::LyricSearchResult>, String> {
    let index_file = ttml_db::get_index_file_path(&app)?;

    if !index_file.exists() {
        return Ok(Vec::new());
    }

    ttml_db::get_or_create_reader(&reader_state, &index_file).await?;

    let reader_guard = reader_state.read().await;
    let reader = reader_guard
        .as_ref()
        .ok_or_else(|| "Reader not initialized".to_string())?;

    Ok(reader.search(&filters))
}

#[tauri::command]
async fn get_lyric_detail(
    app: AppHandle,
    reader_state: State<'_, ttml_db::LyricDbReader>,
    file_path: String,
) -> Result<Option<String>, String> {
    let index_file = ttml_db::get_index_file_path(&app)?;

    if !index_file.exists() {
        return Ok(None);
    }

    ttml_db::get_or_create_reader(&reader_state, &index_file).await?;

    let reader_guard = reader_state.read().await;
    let reader = reader_guard
        .as_ref()
        .ok_or_else(|| "Reader not initialized".to_string())?;

    Ok(reader.get_lyric_detail(&file_path))
}

fn init_logging() {
    #[cfg(not(debug_assertions))]
    {
        let log_file = std::fs::File::create("amll-player.log");
        if let Ok(log_file) = log_file {
            tracing_subscriber::fmt()
                .map_writer(move |_| log_file)
                .with_thread_names(true)
                .with_ansi(false)
                .with_timer(tracing_subscriber::fmt::time::uptime())
                .init();
        } else {
            tracing_subscriber::fmt()
                .with_thread_names(true)
                .with_timer(tracing_subscriber::fmt::time::uptime())
                .init();
        }
    }
    #[cfg(debug_assertions)]
    {
        tracing_subscriber::fmt()
            .with_env_filter(
                "amll_player=trace,wry=info,taskbar_lyric=warn,now_playing_controls=warn,ffmpeg=warn",
            )
            .with_thread_names(true)
            .with_timer(tracing_subscriber::fmt::time::uptime())
            .init();
    }
    std::panic::set_hook(Box::new(move |info| {
        error!("Fatal error occurred! AMLL Player will exit now.");
        error!("Error: {info}");
        error!("{info:#?}");
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Install ring as the default crypto provider for rustls, because multiple providers
    // (aws-lc-rs and ring) might be enabled in our dependency tree and rustls demands one to be explicitly chosen.
    #[cfg(target_os = "android")]
    let _ = rustls::crypto::ring::default_provider().install_default();

    init_logging();
    info!("AMLL Player is starting!");
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

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            ws_reopen_connection,
            ws_get_connections,
            ws_broadcast_payload,
            ws_close_connection,
            open_screenshot_window,
            screen_capture::take_screenshot,
            player::local_player_send_msg,
            player::set_media_controls_enabled,
            resolve_content_uri,
            read_local_music_metadata,
            save_cover_from_path,
            restart_app,
            sync_lyrics,
            search_lyrics,
            get_lyric_detail,
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
            set_window_always_on_top,
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
        .setup(|app| {
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
                tauri::async_runtime::block_on(recreate_window(app.handle(), "main", None));
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
        })
        .on_window_event(|_window, _event| {
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
        })
        .run(context)
        .expect("error while running tauri application");
}
