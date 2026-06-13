use std::{
    fmt::Debug,
    fs::File,
    io::{Read, Seek},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    },
    time::Duration,
};

use super::fft_player::FFTPlayer;
use crate::{
    AudioPlayerEventSender, AudioPlayerMessageReceiver, AudioPlayerMessageSender, AudioThreadEvent,
    AudioThreadEventMessage, AudioThreadMessage, SongData, audio_quality::AudioQuality,
    ffmpeg_decoder::FFmpegDecoder, media_controls::SystemMediaManager,
};
use anyhow::Context;
use cpal::traits::{DeviceTrait as _, HostTrait as _, StreamTrait as _};
use now_playing_controls::model::{NowPlayingOptions, SystemMediaEvent};
use parking_lot::RwLock as ParkingLotRwLock;
use ringbuf::traits::Consumer;
use serde::{Deserialize, Serialize};
use tokio::sync::{RwLock as TokioRwLock, mpsc::UnboundedReceiver, watch};
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

pub struct AudioPlayer {
    evt_sender: AudioPlayerEventSender,
    msg_sender: AudioPlayerMessageSender,
    msg_receiver: AudioPlayerMessageReceiver,

    cpal_device: cpal::Device,
    cpal_config: cpal::StreamConfig,
    current_stream: Option<cpal::Stream>,
    cpal_state: CpalCallbackState,
    target_channels: u16,
    target_sample_rate: u32,

    is_playing_tx: watch::Sender<bool>,
    is_playing_rx: watch::Receiver<bool>,
    current_song_token: Option<CancellationToken>,
    cancel_token: CancellationToken,

    media_manager: Arc<SystemMediaManager>,
    current_decoder_handle: Option<FFmpegDecoder>,
    volume: f32,
    current_song: Option<SongData>,
    current_audio_info: Arc<TokioRwLock<AudioInfo>>,
    current_audio_quality: Arc<TokioRwLock<AudioQuality>>,
    playback_state: Arc<ParkingLotRwLock<PlaybackState>>,
    npc_event_rx: UnboundedReceiver<SystemMediaEvent>,
    fft_player: Arc<ParkingLotRwLock<FFTPlayer>>,
}

#[derive(Clone, Debug)]
pub struct CpalCallbackState {
    pub volume_bits: Arc<AtomicU32>,
    pub track_finished: Arc<AtomicBool>,
    pub consumed_frames: Arc<AtomicU64>,
}

impl Default for CpalCallbackState {
    fn default() -> Self {
        Self {
            volume_bits: Arc::new(AtomicU32::new(1.0_f32.to_bits())),
            track_finished: Arc::new(AtomicBool::new(false)),
            consumed_frames: Arc::new(AtomicU64::new(0)),
        }
    }
}

#[derive(Default, Debug)]
pub struct PlaybackState {
    pub base_time_sec: f64,
    pub samples_counter: Option<Arc<AtomicU64>>,
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
    pub duration: f64,
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
            .field("duration", &self.duration)
            .finish()
    }
}

pub trait CustomMediaSource: Read + Seek + Send + 'static {}
impl<T: Read + Seek + Send + 'static> CustomMediaSource for T {}

pub struct AudioPlayerConfig {
    pub media_controls_options: NowPlayingOptions,
}

impl AudioPlayer {
    pub fn new(
        config: AudioPlayerConfig,
        evt_sender: AudioPlayerEventSender,
    ) -> anyhow::Result<Self> {
        let (msg_sender, msg_receiver) = tokio::sync::mpsc::unbounded_channel();

        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .context("未找到系统默认音频输出设备")?;

        let default_config = device.default_output_config()?;
        let target_channels = default_config.channels();
        let target_sample_rate = default_config.sample_rate();
        let cpal_config: cpal::StreamConfig = default_config.into();

        info!(
            "初始化 Cpal 音频设备: {}, 声道数: {}, 采样率: {}",
            device.description()?.name(),
            target_channels,
            target_sample_rate
        );

        let current_audio_info = Arc::new(TokioRwLock::new(AudioInfo::default()));
        let current_audio_quality = Arc::new(TokioRwLock::new(AudioQuality::default()));
        let fft_player = Arc::new(ParkingLotRwLock::new(FFTPlayer::new(target_sample_rate)));
        let playback_state = Arc::new(ParkingLotRwLock::new(PlaybackState::default()));
        let cpal_state = CpalCallbackState::default();

        let (manager_instance, npc_event_rx) =
            SystemMediaManager::spawn(Some(config.media_controls_options));
        let media_manager = Arc::new(manager_instance);

        let (is_playing_tx, is_playing_rx) = watch::channel(false);
        let mut is_playing_rx_for_timeline = is_playing_rx.clone();

        let audio_info_reader = current_audio_info.clone();
        let emitter_pos = AudioPlayerEventEmitter::new(evt_sender.clone());
        let media_manager_for_task = media_manager.clone();
        let playback_state_for_timeline = playback_state.clone();
        let cancel_token = CancellationToken::new();
        let timeline_token = cancel_token.clone();

        tokio::task::spawn(async move {
            let mut time_it = tokio::time::interval(Duration::from_secs(1));

            loop {
                if !*is_playing_rx_for_timeline.borrow() {
                    tokio::select! {
                        _ = timeline_token.cancelled() => { break; }
                        res = is_playing_rx_for_timeline.changed() => {
                            if res.is_err() { break; }
                            continue;
                        }
                    }
                }

                tokio::select! {
                    _ = timeline_token.cancelled() => break,
                    res = is_playing_rx_for_timeline.changed() => {
                        if res.is_err() {
                            break;
                        }

                        continue;
                    }
                    _ = time_it.tick() => {
                        let (base_time, counter_clone) = {
                            let state = playback_state_for_timeline.read();
                            (state.base_time_sec, state.samples_counter.clone())
                        };

                        let duration = audio_info_reader.read().await.duration;
                        if duration > 0.0 {
                            let played_time = if let Some(counter) = &counter_clone {
                                let samples = counter.load(Ordering::Relaxed) as f64;
                                let rate = target_sample_rate as f64;
                                let ch = target_channels as f64;
                                samples / (rate * ch)
                            } else {
                                0.0
                            };

                            let local_current_pos = (base_time + played_time).min(duration);

                            let _ = emitter_pos
                                .emit(AudioThreadEvent::PlayPosition {
                                    position: local_current_pos,
                                })
                                .await;

                            media_manager_for_task.update_timeline(local_current_pos, duration);
                        }
                    }
                }
            }
        });

        Ok(Self {
            evt_sender,
            msg_sender,
            msg_receiver,
            cpal_device: device,
            cpal_config,
            current_stream: None,
            cpal_state,
            target_channels,
            target_sample_rate,
            is_playing_tx,
            is_playing_rx,
            current_song_token: None,
            cancel_token,
            media_manager,
            current_decoder_handle: None,
            volume: 1.0,
            current_song: None,
            current_audio_info,
            current_audio_quality,
            playback_state,
            npc_event_rx,
            fft_player,
        })
    }

    pub fn handler(&self) -> AudioPlayerHandle {
        AudioPlayerHandle::new(self.msg_sender.clone())
    }

    fn emitter(&self) -> AudioPlayerEventEmitter {
        AudioPlayerEventEmitter::new(self.evt_sender.clone())
    }

    pub async fn run(mut self) {
        let mut check_end_interval = tokio::time::interval(Duration::from_millis(50));

        loop {
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
                msg = self.npc_event_rx.recv() => {
                    if let Some(event) = msg {
                        self.media_manager
                            .handle_event(event, &self.handler(), &self.evt_sender)
                            .await;
                    }
                },
                _ = check_end_interval.tick() => {
                    if self.cpal_state.track_finished.load(Ordering::Acquire) && self.current_song.is_some() {
                        self.current_stream = None;

                        {
                            let mut state = self.playback_state.write();
                            state.base_time_sec = 0.0;
                        }

                        self.current_song = None;

                        self.cpal_state
                            .track_finished
                            .store(false, Ordering::Release);

                        let _ = self.is_playing_tx.send(false);

                        if let Err(e) = self.emitter().emit(AudioThreadEvent::TrackEnded).await {
                            warn!("发送 TrackEnded 事件失败：{e:?}");
                        }
                    }
                }
            }
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
                    if let Some(stream) = &self.current_stream {
                        let _ = stream.play();
                    }
                    let _ = self.is_playing_tx.send(true);
                    self.media_manager.update_play_state(true);
                    let _ = emitter
                        .emit(AudioThreadEvent::PlayStatus { is_playing: true })
                        .await;
                }
                AudioThreadMessage::PauseAudio => {
                    if let Some(stream) = &self.current_stream {
                        let _ = stream.pause();
                    }
                    let _ = self.is_playing_tx.send(false);
                    self.media_manager.update_play_state(false);
                    let _ = emitter
                        .emit(AudioThreadEvent::PlayStatus { is_playing: false })
                        .await;
                }
                AudioThreadMessage::ResumeOrPauseAudio => {
                    let is_playing_now = !*self.is_playing_rx.borrow();

                    if let Some(stream) = &self.current_stream {
                        if is_playing_now {
                            let _ = stream.play();
                        } else {
                            let _ = stream.pause();
                        }
                    }

                    let _ = self.is_playing_tx.send(is_playing_now);
                    self.media_manager.update_play_state(is_playing_now);
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
                            self.cpal_state
                                .track_finished
                                .store(false, Ordering::Release);
                            self.cpal_state.consumed_frames.store(0, Ordering::Release);

                            let fft_player_clone = self.fft_player.clone();
                            tokio::task::spawn_blocking(move || {
                                fft_player_clone.write().clear();
                            })
                            .await?;

                            let is_playing = *self.is_playing_rx.borrow();
                            {
                                let mut state = self.playback_state.write();
                                state.base_time_sec = *position;
                                if let Some(counter) = &state.samples_counter {
                                    counter.store(0, Ordering::SeqCst);
                                }
                            }

                            self.media_manager.update_play_state(is_playing);
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
                    self.volume = (*volume as f32).clamp(0.0, 1.0);
                    self.cpal_state
                        .volume_bits
                        .store(self.volume.to_bits(), Ordering::Relaxed);

                    let _ = emitter
                        .emit(AudioThreadEvent::VolumeChanged {
                            volume: self.volume as f64,
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
                    self.media_manager.set_enabled(*enabled);
                }
                AudioThreadMessage::StopAudio => {
                    self.current_stream = None;

                    {
                        let mut state = self.playback_state.write();
                        state.base_time_sec = 0.0;
                    }
                    let _ = self.is_playing_tx.send(false);
                    self.media_manager.update_play_state(false);
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
                    self.media_manager.update_playback_rate(*rate);
                }
                AudioThreadMessage::UpdatePlayMode {
                    is_shuffling,
                    repeat_mode,
                } => {
                    self.media_manager
                        .update_play_mode(*is_shuffling, *repeat_mode);
                }
                _ => {}
            }
        }
        emitter.ret_none(msg).await?;
        Ok(())
    }

    async fn start_playing_song(&mut self, clear_sink: bool) -> anyhow::Result<()> {
        if clear_sink {
            self.current_stream = None;
            self.current_decoder_handle = None;
            let fft_player_clone = self.fft_player.clone();
            tokio::task::spawn_blocking(move || {
                fft_player_clone.write().clear();
            })
            .await?;
        }

        let song_data = self.current_song.clone().context("没有当前歌曲可播放")?;

        let file = File::open(&song_data.file_path)
            .with_context(|| format!("打开 {} 失败", song_data.file_path))?;
        let source_stream: Box<dyn CustomMediaSource> = Box::new(file);

        let target_channels = self.target_channels;
        let target_sample_rate = self.target_sample_rate;

        let source_result = tokio::task::spawn_blocking(move || {
            FFmpegDecoder::spawn(source_stream, target_channels, target_sample_rate)
        })
        .await?;

        let spawned = source_result?;
        self.current_decoder_handle = Some(spawned.handle);
        {
            let mut state = self.playback_state.write();
            state.samples_counter = Some(spawned.samples_counter);
            state.base_time_sec = 0.0;
        }
        let info = spawned.source.audio_info();
        let quality = spawned.source.audio_quality();

        *self.current_audio_info.write().await = info.clone();
        *self.current_audio_quality.write().await = quality.clone();

        let mut audio_iter = spawned.source;
        let cpal_state_clone = self.cpal_state.clone();

        cpal_state_clone
            .track_finished
            .store(false, Ordering::Release);
        cpal_state_clone.consumed_frames.store(0, Ordering::Release);
        cpal_state_clone
            .volume_bits
            .store(self.volume.to_bits(), Ordering::Relaxed);

        let channels = target_channels as u64;

        let stream = self.cpal_device.build_output_stream(
            &self.cpal_config,
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                let current_volume =
                    f32::from_bits(cpal_state_clone.volume_bits.load(Ordering::Relaxed));
                let mut eof_reached = false;
                let mut local_consumed_samples = 0;

                for sample in data.iter_mut() {
                    if let Some(s) = audio_iter.next() {
                        *sample = s * current_volume;
                        local_consumed_samples += 1;
                    } else {
                        *sample = 0.0;
                        eof_reached = true;
                    }
                }

                if local_consumed_samples > 0 {
                    let frames_played = local_consumed_samples / channels;
                    cpal_state_clone
                        .consumed_frames
                        .fetch_add(frames_played, Ordering::Relaxed);
                }

                if eof_reached {
                    cpal_state_clone
                        .track_finished
                        .store(true, Ordering::Relaxed);
                }
            },
            |err| error!("Cpal 音频流发生错误: {err}"),
            None,
        )?;

        stream.play()?;

        self.current_stream = Some(stream);

        self.spawn_fft_pacemaker(spawned.fft_consumer, target_sample_rate);

        self.media_manager.update_metadata(&info);
        self.media_manager.update_play_state(true);
        let _ = self.is_playing_tx.send(true);

        self.emitter()
            .emit(AudioThreadEvent::LoadAudio {
                music_id: song_data.get_id(),
                music_info: Box::new(info),
                quality,
            })
            .await?;
        self.emitter()
            .emit(AudioThreadEvent::PlayStatus { is_playing: true })
            .await?;

        Ok(())
    }

    fn spawn_fft_pacemaker<C>(&mut self, mut fft_consumer: C, target_sample_rate: u32)
    where
        C: Consumer<Item = f32> + Send + 'static,
    {
        if let Some(old_token) = self.current_song_token.take() {
            old_token.cancel();
        }

        let song_token = CancellationToken::new();
        self.current_song_token = Some(song_token.clone());

        let cpal_state_fft = self.cpal_state.clone();
        let fft_player_clone = self.fft_player.clone();
        let emitter_fft = self.emitter();
        let mut is_playing_rx = self.is_playing_rx.clone();

        tokio::task::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(50));
            let mut last_consumed = 0;
            let mut pull_buf = vec![0.0; 4096];

            {
                *fft_player_clone.write() = FFTPlayer::new(target_sample_rate);
            }

            loop {
                if !*is_playing_rx.borrow() {
                    tokio::select! {
                        _ = song_token.cancelled() => break,
                        res = is_playing_rx.changed() => {
                            if res.is_err() { break; }
                            continue;
                        }
                    }
                }

                tokio::select! {
                    _ = song_token.cancelled() => break,
                    res = is_playing_rx.changed() => {
                        if res.is_err() { break; }
                        continue;
                    }
                    _ = interval.tick() => {
                        let current_frames = cpal_state_fft.consumed_frames.load(Ordering::Acquire);
                        let diff = current_frames.saturating_sub(last_consumed) as usize;
                        last_consumed = current_frames;

                        if diff > 0 {
                            let mut pulled_total = 0;
                            while pulled_total < diff {
                                let to_pull = (diff - pulled_total).min(pull_buf.len());
                                let n = fft_consumer.pop_slice(&mut pull_buf[..to_pull]);
                                if n == 0 {
                                    break;
                                }

                                fft_player_clone.write().push_samples(&pull_buf[..n]);
                                pulled_total += n;
                            }

                            let mut fft_result = vec![0.0; 128];
                            if fft_player_clone.write().read(&mut fft_result) {
                                let _ = emitter_fft
                                    .emit(AudioThreadEvent::FFTData { data: fft_result })
                                    .await;
                            }
                        }
                    }
                }
            }
        });
    }
}

impl Drop for AudioPlayer {
    fn drop(&mut self) {
        self.cancel_token.cancel();
        if let Some(token) = &self.current_song_token {
            token.cancel();
        }
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
