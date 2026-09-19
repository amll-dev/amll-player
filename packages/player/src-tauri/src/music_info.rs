use amll_player_core::AudioInfo;
use anyhow::Context;
use ffmpeg_audio::AudioReader;
use serde::*;
use tauri::{AppHandle, Manager, State, path::BaseDirectory};
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
