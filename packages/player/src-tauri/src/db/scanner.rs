use std::{
    collections::HashSet,
    fs::File,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
};

use jwalk::WalkDir;
use rayon::prelude::*;

use crate::db::entity::song;

const AUDIO_EXTENSIONS: &[&str] = &[
    "flac", "wav", "m4a", "alac", "ape", "mac", "wv", "tta", "tak", "aiff", "aif", "aifc", "mp3",
    "aac", "mp4", "ogg", "oga", "opus", "wma", "asf", "mpc", "mpp", "mp+", "dsf", "ac3", "eac3",
    "dts", "dtshd", "thd", "mlp", "mka", "amr", "rm", "ra", "au", "snd", "caf", "w64", "iff",
    "8svx",
];

const LYRIC_EXTENSIONS: &[&str] = &["ttml", "lys", "yrc", "qrc", "eslrc", "lrc"];

fn run_parallel_scan<P, T, F>(
    folder: P,
    cancel_token: &Arc<AtomicBool>,
    on_progress: &(dyn Fn(u32) + Send + Sync),
    processor: F,
) -> Vec<T>
where
    P: AsRef<Path>,
    T: Send,
    F: Fn(&Path) -> T + Send + Sync,
{
    let extensions: HashSet<String> = AUDIO_EXTENSIONS.iter().map(|s| s.to_string()).collect();

    let walker = WalkDir::new(&folder).follow_links(true);
    let results = Mutex::new(Vec::new());
    let processed = AtomicU32::new(0);

    walker
        .into_iter()
        .par_bridge()
        .filter_map(|entry_result| {
            if cancel_token.load(Ordering::Relaxed) {
                return None;
            }

            let entry = entry_result.ok()?;
            let path = entry.path();

            if !entry.file_type().is_file() {
                return None;
            }

            let is_valid = path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| extensions.contains(&ext.to_lowercase()));

            if is_valid { Some(path) } else { None }
        })
        .for_each(|path| {
            let result = processor(&path);

            let count = processed.fetch_add(1, Ordering::Relaxed) + 1;
            results.lock().unwrap().push(result);
            on_progress(count);
        });

    results.into_inner().unwrap()
}

pub struct ScannedSong {
    pub model: song::Model,
    pub cover_bytes: Option<Vec<u8>>,
}

pub fn scan_folder<P: AsRef<Path>>(
    folder: P,
    cancel_token: &Arc<AtomicBool>,
    on_progress: &(dyn Fn(u32) + Send + Sync),
) -> Vec<Result<ScannedSong, String>> {
    run_parallel_scan(folder, cancel_token, on_progress, process_file)
}

pub fn process_file_single(path: &std::path::Path) -> Result<ScannedSong, String> {
    process_file(path)
}

fn process_file(path: &std::path::Path) -> Result<ScannedSong, String> {
    let modified_at = path
        .metadata()
        .and_then(|m| m.modified())
        .map(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64
        })
        .unwrap_or(0);

    let file = File::open(path).map_err(|e| format!("无法打开文件 {}: {e}", path.display()))?;

    let reader = ffmpeg_audio::AudioReader::new(file)
        .map_err(|e| format!("无法读取音频 {}: {e}", path.display()))?;

    let path_str = path.to_string_lossy().replace('\\', "/");
    let song_id = format!("{:x}", md5::compute(path_str.as_bytes()));

    let metadata = reader.metadata();
    let duration_secs = reader.duration().map(|d| d.as_secs_f64()).unwrap_or(0.0);

    let song_name = metadata.get("title").cloned().unwrap_or_else(|| {
        path.file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "未知歌曲".to_string())
    });

    let song_artists = metadata.get("artist").cloned().unwrap_or_default();
    let song_album = metadata.get("album").cloned().unwrap_or_default();

    let cover_bytes = reader.cover().map(|c| c.data.to_vec());

    let (lyric_format, lyric) = find_lyric_file(path);

    let model = song::Model {
        id: song_id,
        file_path: path_str,
        song_name,
        song_artists,
        song_album,
        duration: duration_secs,
        lyric_format,
        lyric,
        translated_lrc: None,
        roman_lrc: None,
        cover_path: None,
        modified_at: Some(modified_at),
    };

    Ok(ScannedSong { model, cover_bytes })
}

fn find_lyric_file(audio_path: &Path) -> (String, String) {
    for ext in LYRIC_EXTENSIONS {
        let lyric_path = audio_path.with_extension(ext);
        if let Ok(content) = std::fs::read_to_string(&lyric_path) {
            return (ext.to_string(), content);
        }
    }
    (String::new(), String::new())
}

pub struct QuickFileEntry {
    pub file_path: String,
    pub modified_at: i64,
}

pub fn scan_folder_quick<P: AsRef<Path>>(
    folder: P,
    cancel_token: &Arc<AtomicBool>,
    on_progress: &(dyn Fn(u32) + Send + Sync),
) -> Vec<QuickFileEntry> {
    run_parallel_scan(folder, cancel_token, on_progress, |path| {
        quick_process_file(path)
    })
}

fn quick_process_file(path: &Path) -> QuickFileEntry {
    let path_str = path.to_string_lossy().replace('\\', "/");
    let modified_at = path
        .metadata()
        .and_then(|m| m.modified())
        .map(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64
        })
        .unwrap_or(0);

    QuickFileEntry {
        file_path: path_str,
        modified_at,
    }
}
