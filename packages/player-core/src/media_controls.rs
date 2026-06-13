use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc::UnboundedReceiver;
use tracing::warn;

use crate::{
    AudioInfo, AudioPlayerEventSender, AudioPlayerHandle, AudioThreadEvent,
    AudioThreadEventMessage, AudioThreadMessage, RepeatMode,
};
use now_playing_controls::NowPlayingSession;
use now_playing_controls::model::{
    MetadataPayload, NowPlayingOptions, PlayModePayload, PlayStatePayload, PlaybackStatus,
    RepeatMode as NpcRepeatMode, SystemMediaEvent, SystemMediaEventType, TimelinePayload,
};

pub struct SystemMediaManager {
    session: Option<NowPlayingSession>,
    _dummy_tx: Option<tokio::sync::mpsc::UnboundedSender<SystemMediaEvent>>,
}

impl SystemMediaManager {
    pub fn spawn(
        options: Option<NowPlayingOptions>,
    ) -> (Self, UnboundedReceiver<SystemMediaEvent>) {
        if let Some(opt) = options {
            let (npc_tx, npc_rx) = tokio::sync::mpsc::unbounded_channel();
            let callback: now_playing_controls::EventCallback = Arc::new(move |event| {
                let _ = npc_tx.send(event);
            });

            match NowPlayingSession::new(opt, callback) {
                Ok(session) => {
                    session.enable_system_media();
                    return (
                        Self {
                            session: Some(session),
                            _dummy_tx: None,
                        },
                        npc_rx,
                    );
                }
                Err(e) => {
                    warn!("初始化系统媒体控件失败: {e:?}");
                }
            }
        }

        let (dummy_tx, dummy_rx) = tokio::sync::mpsc::unbounded_channel();
        (
            Self {
                session: None,
                _dummy_tx: Some(dummy_tx),
            },
            dummy_rx,
        )
    }

    pub fn update_metadata(&self, audio_info: &AudioInfo) {
        if let Some(session) = &self.session {
            session.update_metadata(MetadataPayload {
                song_name: audio_info.name.clone(),
                author_name: audio_info.artist.clone(),
                album_name: audio_info.album.clone(),
                cover_data: audio_info.cover.clone(),
                original_cover_url: None,
                genre: Vec::new(),
                track_id: None,
                discord_buttons: None,
                duration: Some(Duration::from_secs_f64(audio_info.duration)),
            });
        }
    }

    pub fn update_play_state(&self, is_playing: bool) {
        if let Some(session) = &self.session {
            session.update_play_state(PlayStatePayload {
                status: if is_playing {
                    PlaybackStatus::Playing
                } else {
                    PlaybackStatus::Paused
                },
            });
        }
    }

    pub fn update_timeline(&self, current_time_sec: f64, total_time_sec: f64) {
        if let Some(session) = &self.session {
            session.update_timeline(TimelinePayload {
                current_time: Duration::from_secs_f64(current_time_sec),
                total_time: Duration::from_secs_f64(total_time_sec),
                seeked: None,
            });
        }
    }

    pub fn update_playback_rate(&self, rate: f64) {
        if let Some(session) = &self.session {
            session.update_playback_rate(rate);
        }
    }

    pub fn update_play_mode(&self, is_shuffling: bool, repeat_mode: RepeatMode) {
        if let Some(session) = &self.session {
            let repeat = match repeat_mode {
                RepeatMode::All => NpcRepeatMode::List,
                RepeatMode::One => NpcRepeatMode::Track,
                RepeatMode::Off => NpcRepeatMode::None,
            };
            session.update_play_mode(PlayModePayload {
                is_shuffling,
                repeat_mode: repeat,
            });
        }
    }

    pub fn set_enabled(&self, enabled: bool) {
        if let Some(session) = &self.session {
            if enabled {
                session.enable_system_media();
            } else {
                session.disable_system_media();
            }
        }
    }

    pub async fn handle_event(
        &self,
        event: SystemMediaEvent,
        player_handler: &AudioPlayerHandle,
        event_sender: &AudioPlayerEventSender,
    ) {
        let result = match event.type_ {
            SystemMediaEventType::Play => {
                player_handler
                    .send_anonymous(AudioThreadMessage::ResumeAudio)
                    .await
            }
            SystemMediaEventType::Pause => {
                player_handler
                    .send_anonymous(AudioThreadMessage::PauseAudio)
                    .await
            }
            SystemMediaEventType::NextSong => {
                let evt = AudioThreadEventMessage::new(
                    "".into(),
                    Some(AudioThreadEvent::HardwareMediaCommand {
                        command: "next".into(),
                    }),
                );
                event_sender.send(evt).map_err(anyhow::Error::from)
            }
            SystemMediaEventType::PreviousSong => {
                let evt = AudioThreadEventMessage::new(
                    "".into(),
                    Some(AudioThreadEvent::HardwareMediaCommand {
                        command: "prev".into(),
                    }),
                );
                event_sender.send(evt).map_err(anyhow::Error::from)
            }
            SystemMediaEventType::Seek => {
                if let Some(pos) = event.position {
                    player_handler
                        .send_anonymous(AudioThreadMessage::SeekAudio {
                            position: pos.as_secs_f64(),
                        })
                        .await
                } else {
                    Ok(())
                }
            }
            SystemMediaEventType::Stop => {
                player_handler
                    .send_anonymous(AudioThreadMessage::StopAudio)
                    .await
            }
            SystemMediaEventType::ToggleShuffle => {
                player_handler
                    .send_anonymous(AudioThreadMessage::ToggleShuffle)
                    .await
            }
            SystemMediaEventType::ToggleRepeat => {
                player_handler
                    .send_anonymous(AudioThreadMessage::ToggleRepeat)
                    .await
            }
            SystemMediaEventType::SetRate => {
                if let Some(rate) = event.rate {
                    player_handler
                        .send_anonymous(AudioThreadMessage::SetPlaybackRate { rate })
                        .await
                } else {
                    Ok(())
                }
            }
            SystemMediaEventType::SetVolume => {
                if let Some(volume) = event.volume {
                    player_handler
                        .send_anonymous(AudioThreadMessage::SetVolume { volume })
                        .await
                } else {
                    Ok(())
                }
            }
        };

        if let Err(e) = result {
            warn!("处理系统媒体控件事件失败: {e:?}");
        }
    }
}
