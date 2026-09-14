use std::{collections::BTreeMap, time::UNIX_EPOCH};

use amll_player_core::AudioInfo;
use anyhow::Context;
use ffmpeg_audio::AudioReader;
use serde::*;
use tauri::{AppHandle, Manager, State, path::BaseDirectory};
use tauri_plugin_dialog::DialogExt;
use tracing::*;

use crate::db;

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

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMusicFileMetadata {
    pub tags: BTreeMap<String, String>,
    pub codec: Option<String>,
    pub sample_format: Option<String>,
    pub sample_rate: Option<i32>,
    pub channels: Option<i32>,
    pub bit_rate: Option<i64>,
    pub bits_per_sample: Option<i32>,
    pub file_size: Option<u64>,
    pub modified_at: Option<u64>,
}

const MAX_FILE_METADATA_TAGS: usize = 256;
const MAX_FILE_METADATA_KEY_CHARS: usize = 128;
const MAX_FILE_METADATA_VALUE_CHARS: usize = 4096;
const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const JS_DATE_MAX_MILLISECONDS: u64 = 8_640_000_000_000_000;

fn normalize_file_metadata_key(key: &str) -> String {
    key.chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(|character| character.to_lowercase())
        .collect()
}

fn is_hidden_file_metadata_key(key: &str) -> bool {
    matches!(
        normalize_file_metadata_key(key).as_str(),
        "title"
            | "tracktitle"
            | "titlesort"
            | "sorttitle"
            | "artist"
            | "artists"
            | "author"
            | "performer"
            | "artistsort"
            | "sortartist"
            | "lyric"
            | "lyrics"
            | "unsyncedlyrics"
            | "syncedlyrics"
            | "metadatablockpicture"
            | "cover"
            | "coverart"
            | "picture"
            | "attachedpic"
    )
}

fn truncate_file_metadata_text(value: &str, max_chars: usize) -> String {
    let mut characters = value.chars();
    let mut result: String = characters.by_ref().take(max_chars).collect();
    if characters.next().is_some() {
        result.push('…');
    }
    result
}

fn sanitize_file_metadata_tags(
    tags: impl IntoIterator<Item = (String, String)>,
) -> BTreeMap<String, String> {
    let mut sanitized = tags
        .into_iter()
        .filter_map(|(key, value)| {
            let key = key.trim();
            if key.is_empty() || is_hidden_file_metadata_key(key) {
                return None;
            }
            let value = value.trim();
            if value.is_empty() {
                return None;
            }
            Some((
                truncate_file_metadata_text(key, MAX_FILE_METADATA_KEY_CHARS),
                truncate_file_metadata_text(value, MAX_FILE_METADATA_VALUE_CHARS),
            ))
        })
        .collect::<Vec<_>>();
    sanitized.sort_by(|left, right| left.0.cmp(&right.0));
    sanitized.truncate(MAX_FILE_METADATA_TAGS);
    sanitized.into_iter().collect()
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
pub async fn resolve_content_uri(
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

#[tauri::command]
pub async fn read_local_music_metadata(
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
        let covers_dir = db::utils::get_covers_dir(&app)?;
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
pub async fn read_local_music_file_metadata(
    file_path: tauri_plugin_fs::FilePath,
) -> Result<LocalMusicFileMetadata, String> {
    let path = file_path
        .as_path()
        .context("Invalid file path")
        .map_err(|e| e.to_string())?
        .to_path_buf();

    tokio::task::spawn_blocking(move || -> anyhow::Result<LocalMusicFileMetadata> {
        let file_metadata = std::fs::metadata(&path)
            .with_context(|| format!("无法读取文件信息: {}", path.display()))?;
        let file = std::fs::File::open(&path)
            .with_context(|| format!("无法打开文件: {}", path.display()))?;
        let reader = AudioReader::new(file)
            .with_context(|| format!("无法初始化音频解码器: {}", path.display()))?;
        let source_info = reader.source_info();
        let modified_at = file_metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .and_then(|duration| u64::try_from(duration.as_millis()).ok())
            .filter(|milliseconds| *milliseconds <= JS_DATE_MAX_MILLISECONDS);

        Ok(LocalMusicFileMetadata {
            tags: sanitize_file_metadata_tags(reader.metadata()),
            codec: source_info.codec_name.clone(),
            sample_format: source_info.sample_fmt.clone(),
            sample_rate: (source_info.sample_rate > 0).then_some(source_info.sample_rate),
            channels: (source_info.channels > 0).then_some(source_info.channels),
            bit_rate: (source_info.bit_rate > 0
                && source_info.bit_rate <= JS_MAX_SAFE_INTEGER as i64)
                .then_some(source_info.bit_rate),
            bits_per_sample: (source_info.bits_per_sample > 0)
                .then_some(source_info.bits_per_sample),
            file_size: (file_metadata.len() <= JS_MAX_SAFE_INTEGER).then_some(file_metadata.len()),
            modified_at,
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

async fn copy_cover_from_path(
    song_id: String,
    source_path: String,
    app: AppHandle,
) -> Result<String, String> {
    let covers_dir = db::utils::get_covers_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&covers_dir)
            .map_err(|e| format!("Failed to create covers dir: {e}"))?;

        let source = std::path::PathBuf::from(source_path);
        let ext = crate::utils::cover_ext_for_path(&source);
        let cover_file = covers_dir.join(format!("{song_id}.{ext}"));

        std::fs::copy(&source, &cover_file).map_err(|e| format!("Failed to copy cover: {e}"))?;

        Ok(cover_file.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("Cover copy task failed: {e}"))?
}

#[tauri::command]
pub async fn save_cover_from_path(
    song_id: String,
    source_path: String,
    app: AppHandle,
) -> Result<String, String> {
    copy_cover_from_path(song_id, source_path, app).await
}

#[tauri::command]
pub async fn pick_and_save_song_cover(
    song_id: String,
    title: String,
    media_filter_name: String,
    all_files_filter_name: String,
    app: AppHandle,
) -> Result<Option<String>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let dialog = app
        .dialog()
        .file()
        .set_title(title)
        .add_filter(
            media_filter_name,
            &["jpg", "jpeg", "png", "gif", "mp4", "webm"],
        )
        .add_filter(all_files_filter_name, &["*"]);

    // Do not parent the Windows Shell dialog to our transparent frameless main
    // window. The callback API also avoids the JavaScript dialog command's
    // blocking picker path, matching the video-background picker fix.
    dialog.pick_file(move |selected| {
        let _ = sender.send(selected);
    });

    let selected = receiver
        .await
        .map_err(|_| "The song cover picker closed unexpectedly".to_string())?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let source_path = selected
        .into_path()
        .map_err(|error| format!("The selected cover is not a regular local file: {error}"))?
        .to_string_lossy()
        .into_owned();

    let cover_path = copy_cover_from_path(song_id, source_path, app).await?;
    Ok(Some(cover_path))
}
