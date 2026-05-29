use std::{
    fmt::Debug,
    fs::File,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use super::fft_player::FFTPlayer;
use crate::{
    AudioPlayerEventReceiver, AudioPlayerEventSender, AudioPlayerMessageReceiver,
    AudioPlayerMessageSender, AudioThreadEvent, AudioThreadEventMessage, AudioThreadMessage,
    SongData,
    audio_quality::AudioQuality,
    ffmpeg_decoder::{FFmpegDecoder, FFmpegDecoderHandle},
};
use anyhow::{Context, anyhow};
use now_playing_controls::model::{
    MetadataPayload, PlayStatePayload, PlaybackStatus, SystemMediaEvent, SystemMediaEventType,
    TimelinePayload,
};
use parking_lot::RwLock as ParkingLotRwLock;
use rodio::{MixerDeviceSink, Player, Source};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock as TokioRwLock;
use tokio::{
    sync::mpsc::{UnboundedReceiver, UnboundedSender},
    task::JoinHandle,
};
use tracing::{info, warn};

pub struct AudioPlayer {
    evt_sender: AudioPlayerEventSender,
    evt_receiver: AudioPlayerEventReceiver,
    msg_sender: AudioPlayerMessageSender,
    msg_receiver: AudioPlayerMessageReceiver,
    audio_player: Arc<Player>,
    current_decoder_handle: Option<FFmpegDecoderHandle>,
    stream_handle: MixerDeviceSink,
    volume: f64,
    current_song: Option<SongData>,
    current_audio_info: Arc<TokioRwLock<AudioInfo>>,
    current_samples_counter: Arc<TokioRwLock<Option<Arc<AtomicU64>>>>,

    current_audio_quality: Arc<TokioRwLock<AudioQuality>>,
    play_pos_sx: UnboundedSender<(bool, Option<f64>)>,
    tasks: Vec<JoinHandle<()>>,
    npc_event_rx: Option<UnboundedReceiver<SystemMediaEvent>>,
    fft_player: Arc<ParkingLotRwLock<FFTPlayer>>,

    fft_broadcast_task: Option<JoinHandle<()>>,
    target_channels: u16,
    target_sample_rate: u32,
}

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInfo {
    pub name: String,
    pub artist: String,
    pub album: String,
    pub lyric: String,
    #[serde(skip)]
    pub cover_media_type: String,
    #[serde(skip)]
    pub cover: Option<Vec<u8>>,
    pub comment: String,
    pub duration: f64,
    pub position: f64,
}

impl Debug for AudioInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AudioInfo")
            .field("name", &self.name)
            .field("artist", &self.artist)
            .field("album", &self.album)
            .field("lyric", &self.lyric)
            .field("cover_media_type", &self.cover_media_type)
            .field("cover", &self.cover.as_ref().map(|x| x.len()))
            .field("comment", &self.comment)
            .field("duration", &self.duration)
            .field("position", &self.position)
            .finish()
    }
}

pub type CustomSongLoaderReturn =
    Box<dyn futures::Future<Output = anyhow::Result<Box<dyn Source<Item = f32> + Send>>> + Send>;
pub type CustomSongLoaderFn = Box<dyn Fn(String) -> CustomSongLoaderReturn + Send + Sync>;
pub type LocalSongLoaderReturn = Box<dyn futures::Future<Output = anyhow::Result<File>> + Send>;
pub type LocalSongLoaderFn = Box<dyn Fn(String) -> LocalSongLoaderReturn + Send + Sync>;

pub struct AudioPlayerConfig {}

impl AudioPlayer {
    pub fn new(_config: AudioPlayerConfig, handle: MixerDeviceSink) -> Self {
        let (evt_sender, evt_receiver) = tokio::sync::mpsc::unbounded_channel();
        let (msg_sender, msg_receiver) = tokio::sync::mpsc::unbounded_channel();
        let audio_player = Arc::new(Player::connect_new(handle.mixer()));

        audio_player.pause();

        let stream_config = handle.config();
        let target_channels = stream_config.channel_count().get();
        let target_sample_rate = stream_config.sample_rate().get();

        info!("音频输出设备 声道数:{target_channels}, 采样率:{target_sample_rate}");

        let current_audio_info = Arc::new(TokioRwLock::new(AudioInfo::default()));
        let current_samples_counter: Arc<TokioRwLock<Option<Arc<AtomicU64>>>> =
            Arc::new(TokioRwLock::new(None));
        let current_audio_quality = Arc::new(TokioRwLock::new(AudioQuality::default()));
        let fft_player = Arc::new(ParkingLotRwLock::new(FFTPlayer::new()));

        let mut tasks = Vec::new();

        let npc_event_rx = match now_playing_controls::initialize() {
            Ok(()) => {
                let (npc_tx, npc_rx) = tokio::sync::mpsc::unbounded_channel();
                if let Err(e) = now_playing_controls::register_event_handler(Arc::new(
                    move |event: SystemMediaEvent| {
                        let _ = npc_tx.send(event);
                    },
                )) {
                    tracing::warn!("注册系统媒体控件事件处理器失败：{e:?}");
                }
                if let Err(e) = now_playing_controls::enable_system_media() {
                    tracing::warn!("启用系统媒体控件失败：{e:?}");
                }
                Some(npc_rx)
            }
            Err(err) => {
                tracing::warn!("初始化系统媒体控件时出错：{err:?}");
                None
            }
        };

        let audio_info_reader = current_audio_info.clone();
        let samples_counter_reader = current_samples_counter.clone();
        let emitter_pos = AudioPlayerEventEmitter::new(evt_sender.clone());
        let (play_pos_sx, mut play_pos_rx) =
            tokio::sync::mpsc::unbounded_channel::<(bool, Option<f64>)>();

        tasks.push(tokio::task::spawn(async move {
            let mut time_it = tokio::time::interval(Duration::from_secs(1));

            let mut is_playing = false;
            let mut base_time = 0.0;
            let mut local_current_pos = 0.0;

            loop {
                tokio::select! {
                    msg = play_pos_rx.recv() => {
                        if let Some((new_is_playing, new_base_time_opt)) = msg {
                            is_playing = new_is_playing;

                            if let Some(new_base_time) = new_base_time_opt {
                                base_time = new_base_time;
                                local_current_pos = base_time;

                                let _ = emitter_pos
                                    .emit(AudioThreadEvent::PlayPosition {
                                        position: base_time,
                                    })
                                    .await;
                            }

                            if is_playing
                            {
                                now_playing_controls::update_timeline(TimelinePayload {
                                    current_time: local_current_pos * 1000.0,
                                    total_time: audio_info_reader.read().await.duration * 1000.0,
                                    seeked: None,
                                });
                            }
                        } else {
                            break;
                        }
                    }

                    _ = time_it.tick() => {
                        if is_playing {
                            let duration = audio_info_reader.read().await.duration;
                            if duration > 0.0 {
                                let played_time = if let Some(counter) = samples_counter_reader.read().await.as_ref() {
                                    let samples = counter.load(Ordering::Relaxed) as f64;
                                    let rate = target_sample_rate as f64;
                                    let ch = target_channels as f64;
                                    samples / (rate * ch)
                                } else {
                                    0.0
                                };

                                local_current_pos = (base_time + played_time).min(duration);

                                let _ = emitter_pos
                                    .emit(AudioThreadEvent::PlayPosition {
                                        position: local_current_pos,
                                    })
                                    .await;

                                now_playing_controls::update_timeline(TimelinePayload {
                                    current_time: local_current_pos * 1000.0,
                                    total_time: duration * 1000.0,
                                    seeked: None,
                                });
                            }
                        }
                    }
                }
            }
        }));

        let fft_player_clone = fft_player.clone();
        let emitter_clone = AudioPlayerEventEmitter::new(evt_sender.clone());
        let fft_broadcast_task = Some(tokio::task::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(50));
            let mut fft_buffer = vec![0.0; 128];

            loop {
                interval.tick().await;

                let data_to_send: Option<Vec<f32>> = {
                    if let Some(mut player) = fft_player_clone.try_write() {
                        if player.has_data() && player.read(&mut fft_buffer) {
                            Some(fft_buffer.clone())
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                };

                if let Some(data) = data_to_send {
                    let _ = emitter_clone.emit(AudioThreadEvent::FFTData { data }).await;
                }
            }
        }));

        Self {
            evt_sender,
            evt_receiver,
            msg_sender,
            msg_receiver,
            stream_handle: handle,
            audio_player,
            current_decoder_handle: None,
            volume: 1.0,
            current_song: None,
            current_audio_info,
            current_samples_counter,
            current_audio_quality,
            play_pos_sx,
            tasks,
            npc_event_rx,
            fft_player,
            fft_broadcast_task,
            target_channels,
            target_sample_rate,
        }
    }

    pub fn handler(&self) -> AudioPlayerHandle {
        AudioPlayerHandle::new(self.msg_sender.clone())
    }

    fn emitter(&self) -> AudioPlayerEventEmitter {
        AudioPlayerEventEmitter::new(self.evt_sender.clone())
    }

    async fn update_npc_metadata(&self) {
        let audio_info = self.current_audio_info.read().await;
        now_playing_controls::update_metadata(MetadataPayload {
            song_name: audio_info.name.clone(),
            author_name: audio_info.artist.clone(),
            album_name: audio_info.album.clone(),
            cover_data: audio_info.cover.clone(),
            original_cover_url: None,
            genre: Vec::new(),
            track_id: None,
            discord_button_url: None,
            duration: Some(audio_info.duration * 1000.0),
        });
    }

    fn update_npc_play_state(is_playing: bool) {
        now_playing_controls::update_play_state(PlayStatePayload {
            status: if is_playing {
                PlaybackStatus::Playing
            } else {
                PlaybackStatus::Paused
            },
        });
    }

    pub async fn run(
        mut self,
        on_event: impl Fn(AudioThreadEventMessage<AudioThreadEvent>) + Send + 'static,
    ) {
        let mut check_end_interval = tokio::time::interval(Duration::from_millis(50));

        loop {
            let npc_event_fut = async {
                if let Some(rx) = self.npc_event_rx.as_mut() {
                    rx.recv().await
                } else {
                    futures::future::pending().await
                }
            };

            tokio::select! {
                biased;
                msg = self.msg_receiver.recv() => {
                    if let Some(msg) = msg {
                        if let Some(AudioThreadMessage::Close) = &msg.data { break; }
                        if let Err(err) = self.process_message(msg).await {
                            warn!("处理音频线程消息时出错：{err:?}");
                        }
                    } else { break; }
                },
                msg = npc_event_fut => {
                    if let Some(event) = msg {
                        self.on_system_media_event(event).await;
                    } else {
                        self.npc_event_rx = None;
                    }
                }
                evt = self.evt_receiver.recv() => {
                    if let Some(evt) = evt { on_event(evt); }
                    else { break; }
                }
                _ = check_end_interval.tick() => {
                    if self.audio_player.empty() && !self.audio_player.is_paused() && self.current_song.is_some() {
                        let _ = self.play_pos_sx.send((false, Some(0.0)));
                        self.current_song = None;

                        if let Err(e) = self.emitter().emit(AudioThreadEvent::TrackEnded).await {
                            warn!("发送 TrackEnded 事件失败：{e:?}");
                        }
                    }
                }
            }
        }
    }

    pub async fn on_system_media_event(&self, event: SystemMediaEvent) {
        let handler = self.handler();
        let result = match event.type_ {
            SystemMediaEventType::Play => {
                handler
                    .send_anonymous(AudioThreadMessage::ResumeAudio)
                    .await
            }
            SystemMediaEventType::Pause => {
                handler.send_anonymous(AudioThreadMessage::PauseAudio).await
            }
            SystemMediaEventType::NextSong => {
                self.emitter()
                    .emit(AudioThreadEvent::HardwareMediaCommand {
                        command: "next".into(),
                    })
                    .await
            }
            SystemMediaEventType::PreviousSong => {
                self.emitter()
                    .emit(AudioThreadEvent::HardwareMediaCommand {
                        command: "prev".into(),
                    })
                    .await
            }
            SystemMediaEventType::Seek => {
                if let Some(pos_ms) = event.position_ms {
                    handler
                        .send_anonymous(AudioThreadMessage::SeekAudio {
                            position: pos_ms / 1000.0,
                        })
                        .await
                } else {
                    Ok(())
                }
            }
            SystemMediaEventType::Stop => {
                handler.send_anonymous(AudioThreadMessage::StopAudio).await
            }
            SystemMediaEventType::ToggleShuffle => {
                handler
                    .send_anonymous(AudioThreadMessage::ToggleShuffle)
                    .await
            }
            SystemMediaEventType::ToggleRepeat => {
                handler
                    .send_anonymous(AudioThreadMessage::ToggleRepeat)
                    .await
            }
            SystemMediaEventType::SetRate => {
                if let Some(rate) = event.rate {
                    handler
                        .send_anonymous(AudioThreadMessage::SetPlaybackRate { rate })
                        .await
                } else {
                    Ok(())
                }
            }
            SystemMediaEventType::SetVolume => {
                if let Some(volume) = event.volume {
                    handler
                        .send_anonymous(AudioThreadMessage::SetVolume { volume })
                        .await
                } else {
                    Ok(())
                }
            }
        };
        if let Err(e) = result {
            warn!("发送系统媒体控件事件失败: {e:?}");
        }
    }

    pub async fn process_message(
        &mut self,
        msg: AudioThreadEventMessage<AudioThreadMessage>,
    ) -> anyhow::Result<()> {
        let emitter = self.emitter();
        if let Some(ref data) = msg.data {
            match data {
                AudioThreadMessage::ResumeAudio => {
                    self.audio_player.play();
                    let _ = self.play_pos_sx.send((true, None));
                    Self::update_npc_play_state(true);
                    let _ = emitter
                        .emit(AudioThreadEvent::PlayStatus { is_playing: true })
                        .await;
                }
                AudioThreadMessage::PauseAudio => {
                    self.audio_player.pause();
                    let _ = self.play_pos_sx.send((false, None));
                    Self::update_npc_play_state(false);
                    let _ = emitter
                        .emit(AudioThreadEvent::PlayStatus { is_playing: false })
                        .await;
                }
                AudioThreadMessage::ResumeOrPauseAudio => {
                    let was_paused = self.audio_player.is_paused();
                    if was_paused {
                        self.audio_player.play();
                    } else {
                        self.audio_player.pause();
                    }

                    let is_playing_now = was_paused;
                    let _ = self.play_pos_sx.send((is_playing_now, None));
                    Self::update_npc_play_state(is_playing_now);
                    let _ = emitter
                        .emit(AudioThreadEvent::PlayStatus {
                            is_playing: is_playing_now,
                        })
                        .await;
                }
                AudioThreadMessage::SeekAudio { position } => {
                    if let Some(handle) = &self.current_decoder_handle {
                        let seek_pos = Duration::from_secs_f64(*position);

                        if handle.seek(seek_pos).is_err() {
                            warn!("发送跳转命令失败, 解码器可能已关闭");
                        } else {
                            if let Some(counter) =
                                self.current_samples_counter.read().await.as_ref()
                            {
                                counter.store(0, Ordering::SeqCst);
                            }

                            let fft_player_clone = self.fft_player.clone();
                            tokio::task::spawn_blocking(move || {
                                fft_player_clone.write().clear();
                            })
                            .await?;
                            let is_playing = !self.audio_player.is_paused();
                            let _ = self.play_pos_sx.send((is_playing, Some(*position)));
                            Self::update_npc_play_state(is_playing);
                        }
                    } else {
                        warn!("找不到解码器句柄, 无法执行跳转");
                    }
                }
                AudioThreadMessage::PlayAudio { song } => {
                    self.current_song = Some(song.clone());
                    self.start_playing_song(true).await?;
                }
                AudioThreadMessage::SetVolume { volume } => {
                    self.volume = volume.clamp(0.0, 1.0);
                    self.audio_player.set_volume(self.volume as f32);
                    let _ = emitter
                        .emit(AudioThreadEvent::VolumeChanged {
                            volume: self.volume,
                        })
                        .await;
                }
                AudioThreadMessage::SetFFTRange { from_freq, to_freq } => {
                    let fft_player_clone = self.fft_player.clone();
                    let (from_freq, to_freq) = (*from_freq, *to_freq);
                    tokio::task::spawn_blocking(move || {
                        fft_player_clone.write().set_freq_range(from_freq, to_freq);
                    })
                    .await?;
                }
                AudioThreadMessage::SetMediaControlsEnabled { enabled } => {
                    if *enabled {
                        if let Err(e) = now_playing_controls::enable_system_media() {
                            warn!("启用系统媒体控件失败: {e:?}");
                        }
                    } else {
                        if let Err(e) = now_playing_controls::disable_system_media() {
                            warn!("禁用系统媒体控件失败: {e:?}");
                        }
                    }
                }
                AudioThreadMessage::StopAudio => {
                    self.audio_player.pause();
                    let _ = self.play_pos_sx.send((false, None));
                    Self::update_npc_play_state(false);
                    let _ = emitter
                        .emit(AudioThreadEvent::PlayStatus { is_playing: false })
                        .await;
                }
                AudioThreadMessage::ToggleShuffle => {
                    let _ = emitter
                        .emit(AudioThreadEvent::HardwareMediaCommand {
                            command: "toggleShuffle".into(),
                        })
                        .await;
                }
                AudioThreadMessage::ToggleRepeat => {
                    let _ = emitter
                        .emit(AudioThreadEvent::HardwareMediaCommand {
                            command: "toggleRepeat".into(),
                        })
                        .await;
                }
                AudioThreadMessage::SetPlaybackRate { rate } => {
                    now_playing_controls::update_playback_rate(*rate);
                }
                _ => {}
            }
        }
        emitter.ret_none(msg).await?;
        Ok(())
    }

    async fn start_playing_song(&mut self, clear_sink: bool) -> anyhow::Result<()> {
        if clear_sink {
            self.audio_player.stop();

            let fft_player_clone = self.fft_player.clone();
            tokio::task::spawn_blocking(move || {
                fft_player_clone.write().clear();
            })
            .await?;

            self.audio_player = Arc::new(Player::connect_new(self.stream_handle.mixer()));
            self.audio_player.set_volume(self.volume as f32);
            self.current_decoder_handle = None;
        }

        let song_data = self.current_song.clone().context("没有当前歌曲可播放")?;
        let file_path = match &song_data {
            SongData::Local { file_path, .. } => file_path.clone(),
            _ => return Err(anyhow!("当前实现仅支持本地文件")),
        };

        let target_channels = self.target_channels;
        let target_sample_rate = self.target_sample_rate;

        let fft_player_clone = self.fft_player.clone();
        let file_path_clone = file_path.clone();

        let source_result = tokio::task::spawn_blocking(move || {
            FFmpegDecoder::new(
                file_path_clone,
                fft_player_clone,
                target_channels,
                target_sample_rate,
            )
        })
        .await?;

        let (source, handle, samples_counter) = source_result?;
        self.current_decoder_handle = Some(handle);
        *self.current_samples_counter.write().await = Some(samples_counter);

        let info = source.audio_info();
        let quality = source.audio_quality();

        *self.current_audio_info.write().await = info.clone();
        *self.current_audio_quality.write().await = quality.clone();

        self.audio_player.append(source);
        self.update_npc_metadata().await;

        let is_playing = !self.audio_player.is_paused();
        Self::update_npc_play_state(is_playing);
        let _ = self.play_pos_sx.send((is_playing, Some(0.0)));

        let status_event = AudioThreadEvent::LoadAudio {
            music_id: song_data.get_id(),
            music_info: Box::new(info),
            quality,
        };
        self.emitter().emit(status_event).await?;
        self.emitter()
            .emit(AudioThreadEvent::PlayStatus { is_playing })
            .await?;

        Ok(())
    }
}

impl Drop for AudioPlayer {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
        if let Some(handle) = self.fft_broadcast_task.take() {
            handle.abort();
        }
        now_playing_controls::shutdown();
    }
}

#[derive(Debug, Clone)]
pub struct AudioPlayerHandle {
    msg_sender: AudioPlayerMessageSender,
}
impl AudioPlayerHandle {
    pub(crate) fn new(msg_sender: AudioPlayerMessageSender) -> Self {
        Self { msg_sender }
    }
    pub async fn send(
        &self,
        msg: AudioThreadEventMessage<AudioThreadMessage>,
    ) -> anyhow::Result<()> {
        self.msg_sender.send(msg)?;
        Ok(())
    }
    pub async fn send_anonymous(&self, msg: AudioThreadMessage) -> anyhow::Result<()> {
        self.msg_sender
            .send(AudioThreadEventMessage::new("".into(), Some(msg)))?;
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AudioPlayerEventEmitter {
    evt_sender: AudioPlayerEventSender,
}
impl AudioPlayerEventEmitter {
    pub(crate) fn new(evt_sender: AudioPlayerEventSender) -> Self {
        Self { evt_sender }
    }
    pub async fn emit(&self, msg: AudioThreadEvent) -> anyhow::Result<()> {
        self.evt_sender
            .send(AudioThreadEventMessage::new("".into(), Some(msg)))?;
        Ok(())
    }
    pub async fn ret_none(
        &self,
        req: AudioThreadEventMessage<AudioThreadMessage>,
    ) -> anyhow::Result<()> {
        self.evt_sender.send(req.to_none())?;
        Ok(())
    }
}
