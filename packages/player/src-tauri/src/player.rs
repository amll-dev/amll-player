use std::sync::LazyLock;

use amll_player_core::AudioThreadEventMessage;
use amll_player_core::AudioThreadMessage;
use amll_player_core::{AudioPlayer, AudioPlayerConfig, AudioPlayerHandle};
use rodio::DeviceSinkBuilder;
use rodio::MixerDeviceSink;
use tauri::{AppHandle, Emitter, Runtime};
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
                    tracing::error!("Timed out waiting for Android NDK context; proceeding anyway.");
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            info!("Audio thread: NDK context ready, opening audio device.");
        }

        let stream = DeviceSinkBuilder::open_default_sink().expect("无法创建默认的音频输出流");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("创建 Tokio 运行时失败");

        runtime.block_on(local_player_main(app, stream));
    });
}

async fn local_player_main<R: Runtime>(app: AppHandle<R>, stream: MixerDeviceSink) {
    let player = AudioPlayer::new(AudioPlayerConfig {}, stream);
    let handler = player.handler();
    PLAYER_HANDLER.write().await.replace(handler);
    let app_clone = app.clone();
    player
        .run(move |evt| {
            if let Err(err) = app_clone.emit("plugin:player-core-event", &evt) {
                error!("发送事件时出错: {err:?}");
            }
        })
        .await;
}
