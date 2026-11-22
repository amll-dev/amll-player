use std::sync::LazyLock;

use amll_player_core::AudioThreadEventMessage;
use amll_player_core::AudioThreadMessage;
use amll_player_core::{AudioPlayer, AudioPlayerConfig, AudioPlayerHandle, NowPlayingOptions};
use tauri::{AppHandle, Emitter, Runtime};
#[cfg(target_os = "windows")]
use tauri::Manager;
use tokio::sync::RwLock;
use tracing::error;
use tracing::warn;

pub static PLAYER_HANDLER: LazyLock<RwLock<Option<AudioPlayerHandle>>> =
    LazyLock::new(|| RwLock::new(None));

#[tauri::command]
pub async fn local_player_send_msg(msg: AudioThreadEventMessage<AudioThreadMessage>) {
    if let Some(handler) = &*PLAYER_HANDLER.read().await
        && let Err(err) = handler.send(msg).await
    {
        warn!("failed to send msg to local player: {:?}", err);
    }
}

#[tauri::command]
pub async fn set_media_controls_enabled(enabled: bool) {
    if let Some(handler) = &*PLAYER_HANDLER.read().await {
        let msg = AudioThreadMessage::SetMediaControlsEnabled { enabled };
        if let Err(err) = handler.send_anonymous(msg).await {
            warn!(
                "failed to send SetMediaControlsEnabled msg to local player: {:?}",
                err
            );
        }
    }
}

pub fn init_local_player<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        // On Android, ndk_context must be initialized before cpal/AAudio can be used.
        // with_webview() dispatches to the Android UI thread asynchronously, so we
        // spin here until ANDROID_NDK_READY is signalled from that callback.
        #[cfg(target_os = "android")]
        {
            use tracing::info;
            info!("Audio thread: waiting for Android NDK context...");
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
            while crate::ANDROID_NDK_READY.get().is_none() {
                if std::time::Instant::now() > deadline {
                    tracing::error!(
                        "Timed out waiting for Android NDK context; proceeding anyway."
                    );
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            info!("Audio thread: NDK context ready, opening audio device.");
        }

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("创建 Tokio 运行时失败");

        runtime.block_on(local_player_main(app));
    });
}

async fn local_player_main<R: Runtime>(app: AppHandle<R>) {
    let (evt_tx, mut evt_rx) = tokio::sync::mpsc::unbounded_channel();

    let media_controls_options = get_media_controls_options(&app);

    let config = AudioPlayerConfig {
        media_controls_options,
    };

    let player = match AudioPlayer::new(config, evt_tx) {
        Ok(p) => p,
        Err(e) => {
            error!("初始化 Cpal 音频设备失败: {e:?}");
            return;
        }
    };

    let handler = player.handler();
    PLAYER_HANDLER.write().await.replace(handler);

    let app_clone = app.clone();
    tokio::task::spawn(async move {
        while let Some(evt) = evt_rx.recv().await {
            if let Err(err) = app_clone.emit("plugin:player-core-event", &evt) {
                error!("发送事件时出错: {err:?}");
            }
        }
    });

    player.run().await;
}

fn get_media_controls_options<R: Runtime>(_app: &AppHandle<R>) -> NowPlayingOptions {
    #[cfg(target_os = "windows")]
    let hwnd = _app
        .get_webview_window("main")
        .and_then(|win| win.hwnd().ok())
        .map(|h| h.0 as isize);

    #[cfg(not(target_os = "windows"))]
    let hwnd = None;

    NowPlayingOptions {
        hwnd,
        discord: None,
        // 会被拼进 MPRIS 的 D-Bus 名，只能用 [A-Za-z0-9_-]，不能带空格
        app_name: Some("AMLLPlayer".into()),
    }
}
