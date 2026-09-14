use crate::AudioInfo;
use ffmpeg_audio::{AudioError, AudioReader};

pub(crate) const MAX_RECOVERABLE_DECODE_ERRORS: usize = 8;

pub(crate) fn can_skip_decode_error(error: &AudioError, skipped_errors: usize) -> bool {
    skipped_errors < MAX_RECOVERABLE_DECODE_ERRORS
        && matches!(
            error,
            AudioError::FFmpeg(code, _) if *code == ffmpeg_audio::sys::AVERROR_INVALIDDATA
        )
}

pub fn build_audio_info(reader: &AudioReader) -> AudioInfo {
    let mut info = AudioInfo::default();

    let metadata = reader.metadata();

    let get_meta = |search_key: &str| -> String {
        metadata
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(search_key))
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };

    info.name = get_meta("title");
    info.artist = get_meta("artist");
    info.album = get_meta("album");
    info.lyric = get_meta("lyrics");

    if let Some(cover) = reader.cover() {
        info.cover = Some(cover.data);
        info.cover_media_type = cover.mime_type.unwrap_or_default();
    }

    if let Some(duration) = reader.duration() {
        info.duration = duration.as_secs_f64();
    }

    info
}
