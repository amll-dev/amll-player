use std::fmt::Debug;

use self::audio_quality::AudioQuality;
use serde::*;

mod audio_quality;
mod ffmpeg_decoder;
mod fft_player;
mod media_controls;
mod player;
pub mod utils;
pub use now_playing_controls::model::NowPlayingOptions;
pub use player::*;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SongData {
    pub file_path: String,
    pub song_id: Option<String>,
}

impl SongData {
    fn get_id(&self) -> String {
        self.song_id
            .clone()
            .unwrap_or_else(|| format!("{:x}", md5::compute(&self.file_path)))
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RepeatMode {
    #[serde(rename_all = "camelCase")]
    Off,
    #[serde(rename_all = "camelCase")]
    All,
    #[serde(rename_all = "camelCase")]
    One,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
#[serde(rename_all = "camelCase")]
pub enum AudioThreadMessage {
    #[serde(rename_all = "camelCase")]
    ResumeAudio,
    #[serde(rename_all = "camelCase")]
    PauseAudio,
    #[serde(rename_all = "camelCase")]
    ResumeOrPauseAudio,
    #[serde(rename_all = "camelCase")]
    SeekAudio { position: f64 },
    #[serde(rename_all = "camelCase")]
    PlayAudio { song: SongData },
    #[serde(rename_all = "camelCase")]
    SetVolume { volume: f64 },
    #[serde(rename_all = "camelCase")]
    SetVolumeRelative { volume: f64 },
    #[serde(rename_all = "camelCase")]
    SetAudioOutput { name: String },
    #[serde(rename_all = "camelCase")]
    SetFFT { enabled: bool },
    #[serde(rename_all = "camelCase")]
    SetFFTRange { from_freq: f32, to_freq: f32 },
    #[serde(rename_all = "camelCase")]
    SetMediaControlsEnabled { enabled: bool },
    #[serde(rename_all = "camelCase")]
    StopAudio,
    #[serde(rename_all = "camelCase")]
    ToggleShuffle,
    #[serde(rename_all = "camelCase")]
    ToggleRepeat,
    #[serde(rename_all = "camelCase")]
    UpdatePlayMode {
        is_shuffling: bool,
        repeat_mode: RepeatMode,
    },
    #[serde(rename_all = "camelCase")]
    SetPlaybackRate { rate: f64 },
    #[serde(rename_all = "camelCase")]
    Close,
}

pub type AudioPlayerEventSender =
    tokio::sync::mpsc::UnboundedSender<AudioThreadEventMessage<AudioThreadEvent>>;
pub type AudioPlayerMessageSender =
    tokio::sync::mpsc::UnboundedSender<AudioThreadEventMessage<AudioThreadMessage>>;
pub type AudioPlayerEventReceiver =
    tokio::sync::mpsc::UnboundedReceiver<AudioThreadEventMessage<AudioThreadEvent>>;
pub type AudioPlayerMessageReceiver =
    tokio::sync::mpsc::UnboundedReceiver<AudioThreadEventMessage<AudioThreadMessage>>;

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "type", content = "data")]
pub enum AudioThreadEvent {
    #[serde(rename_all = "camelCase")]
    PlayPosition { position: f64 },
    #[serde(rename_all = "camelCase")]
    LoadProgress { position: f64 },
    #[serde(rename_all = "camelCase")]
    LoadAudio {
        music_id: String,
        music_info: Box<AudioInfo>,
        quality: AudioQuality,
    },
    #[serde(rename_all = "camelCase")]
    LoadingAudio { music_id: String },
    #[serde(rename_all = "camelCase")]
    AudioPlayFinished { music_id: String },
    #[serde(rename_all = "camelCase")]
    TrackEnded,
    #[serde(rename_all = "camelCase")]
    HardwareMediaCommand { command: String },
    #[serde(rename_all = "camelCase")]
    PlayStatus { is_playing: bool },
    #[serde(rename_all = "camelCase")]
    LoadError { error: String },
    #[serde(rename_all = "camelCase")]
    PlayError { error: String },
    #[serde(rename_all = "camelCase")]
    VolumeChanged { volume: f64 },
    #[serde(rename = "fftData")]
    #[serde(rename_all = "camelCase")]
    FFTData { data: Vec<f32> },
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioThreadEventMessage<T> {
    callback_id: String,
    data: Option<T>,
}

impl<T> AudioThreadEventMessage<T> {
    pub fn new(callback_id: String, data: Option<T>) -> Self {
        Self { callback_id, data }
    }

    pub fn data(&self) -> Option<&T> {
        self.data.as_ref()
    }

    pub fn callback_id(&self) -> &str {
        &self.callback_id
    }

    pub fn to<D>(self, new_data: D) -> AudioThreadEventMessage<D> {
        AudioThreadEventMessage {
            callback_id: self.callback_id,
            data: Some(new_data),
        }
    }

    pub fn to_none<D>(self) -> AudioThreadEventMessage<D> {
        AudioThreadEventMessage {
            callback_id: self.callback_id,
            data: None,
        }
    }
}
