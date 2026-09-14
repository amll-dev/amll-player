use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime};

use sea_orm::{
    ColumnTrait, EntityTrait, QueryFilter, Set, TransactionTrait,
    sea_query::{Expr, OnConflict},
};
use serde::{Deserialize, Serialize};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tracing::{info, warn};

use crate::db::DbConnection;
use crate::db::entity::{song, song_background_override, song_video_background};
use crate::db_events;

const VIDEO_BACKGROUND_DIR: &str = "song-backgrounds";
const MAX_VIDEO_BACKGROUND_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const ORPHAN_GRACE_PERIOD: Duration = Duration::from_secs(24 * 60 * 60);

static VIDEO_BACKGROUND_STORAGE_LOCK: LazyLock<std::sync::Arc<tokio::sync::Mutex<()>>> =
    LazyLock::new(|| std::sync::Arc::new(tokio::sync::Mutex::new(())));
static PENDING_VIDEO_BACKGROUND_ASSETS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSongVideoBackground {
    pub asset_id: String,
    pub file_path: String,
    pub mime_type: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongVideoBackground {
    pub song_id: String,
    pub asset_id: String,
    pub file_path: String,
    pub mime_type: String,
    pub duration_ms: i64,
    pub width: i32,
    pub height: i32,
    pub fit_mode: String,
    pub in_point_ms: i64,
    pub out_point_ms: i64,
    pub loop_enabled: bool,
    pub sync_on_seek: bool,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSongVideoBackgroundPayload {
    pub song_id: String,
    pub asset_id: String,
    pub duration_ms: i64,
    pub width: i32,
    pub height: i32,
    pub fit_mode: String,
    pub in_point_ms: i64,
    pub out_point_ms: i64,
    pub loop_enabled: bool,
    pub sync_on_seek: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoBackgroundGcResult {
    pub total_scanned: u32,
    pub deleted: u32,
    pub errors: Vec<String>,
}

fn video_background_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resolve(VIDEO_BACKGROUND_DIR, BaseDirectory::AppData)
        .map_err(|error| format!("Failed to resolve video background directory: {error}"))
}

fn pending_assets_snapshot() -> HashSet<String> {
    PENDING_VIDEO_BACKGROUND_ASSETS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn is_asset_pending(asset_id: &str) -> bool {
    PENDING_VIDEO_BACKGROUND_ASSETS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains(asset_id)
}

fn mark_asset_pending(asset_id: &str) {
    PENDING_VIDEO_BACKGROUND_ASSETS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(asset_id.to_owned());
}

fn unmark_asset_pending(asset_id: &str) {
    PENDING_VIDEO_BACKGROUND_ASSETS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(asset_id);
}

fn ensure_storage_directory(directory: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(directory) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(format!(
                    "Video background storage is not a regular directory: {}",
                    directory.display()
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(directory)
                .map_err(|error| format!("Failed to create video background directory: {error}"))?;
            let metadata = std::fs::symlink_metadata(directory).map_err(|error| {
                format!("Failed to inspect video background directory: {error}")
            })?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(format!(
                    "Video background storage is not a regular directory: {}",
                    directory.display()
                ));
            }
        }
        Err(error) => {
            return Err(format!(
                "Failed to inspect video background directory: {error}"
            ));
        }
    }
    Ok(())
}

fn validate_asset_id(asset_id: &str) -> Result<(), String> {
    let (stem, extension) = asset_id.rsplit_once('.').unwrap_or_default();
    let (digest, timestamp) = stem.split_once('-').unwrap_or_default();
    let valid = matches!(extension, "mp4" | "webm")
        && digest.len() == 32
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        && !timestamp.is_empty()
        && timestamp.len() <= 20
        && timestamp.bytes().all(|byte| byte.is_ascii_digit());
    if !valid {
        return Err("Invalid video background asset identifier".into());
    }
    Ok(())
}

fn resolve_asset_path(app: &AppHandle, asset_id: &str) -> Result<PathBuf, String> {
    resolve_asset_path_in_directory(&video_background_dir(app)?, asset_id)
}

fn resolve_asset_path_in_directory(directory: &Path, asset_id: &str) -> Result<PathBuf, String> {
    validate_asset_id(asset_id)?;
    Ok(directory.join(asset_id))
}

fn detect_supported_video(path: &Path) -> Result<(&'static str, &'static str), String> {
    let mut file = File::open(path)
        .map_err(|error| format!("Failed to open video background for inspection: {error}"))?;
    detect_supported_video_from_reader(&mut file)
}

fn detect_supported_video_from_reader(
    reader: &mut impl Read,
) -> Result<(&'static str, &'static str), String> {
    let mut header = [0_u8; 8192];
    let bytes_read = reader
        .read(&mut header)
        .map_err(|error| format!("Failed to inspect video background: {error}"))?;
    let kind = infer::get(&header[..bytes_read])
        .ok_or_else(|| "Unable to detect the selected video's format".to_string())?;

    match kind.mime_type() {
        "video/mp4" | "video/x-m4v" => Ok(("video/mp4", "mp4")),
        "video/webm"
            if header[..bytes_read]
                .windows(4)
                .any(|window| window == b"webm") =>
        {
            Ok(("video/webm", "webm"))
        }
        mime => Err(format!(
            "Unsupported video background format: {mime}. Only MP4 and WebM are supported"
        )),
    }
}

fn validate_regular_file(path: &Path, context: &str) -> Result<std::fs::Metadata, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("Failed to inspect {context}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{context} must be a regular file"));
    }
    Ok(metadata)
}

fn open_regular_file_for_read(path: &Path, context: &str) -> Result<(File, u64), String> {
    let before = validate_regular_file(path, context)?;
    let file = File::open(path).map_err(|error| format!("Failed to open {context}: {error}"))?;
    let opened = file
        .metadata()
        .map_err(|error| format!("Failed to inspect opened {context}: {error}"))?;
    if !opened.is_file() {
        return Err(format!("{context} must be a regular file"));
    }

    // Opening the file before copying narrows the check/open race. Requiring the
    // opened handle to match the path metadata also rejects a source swapped
    // between validation and open on platforms where file identity is exposed.
    if before.len() != opened.len() || before.modified().ok() != opened.modified().ok() {
        return Err(format!("{context} changed while it was being opened"));
    }
    Ok((file, opened.len()))
}

fn mime_for_asset_id(asset_id: &str) -> Result<&'static str, String> {
    validate_asset_id(asset_id)?;
    if asset_id.ends_with(".mp4") {
        Ok("video/mp4")
    } else {
        Ok("video/webm")
    }
}

fn model_to_view(
    app: &AppHandle,
    model: song_video_background::Model,
) -> Result<SongVideoBackground, String> {
    model_to_view_in_directory(&video_background_dir(app)?, model)
}

fn model_to_view_in_directory(
    directory: &Path,
    model: song_video_background::Model,
) -> Result<SongVideoBackground, String> {
    let file_path = resolve_asset_path_in_directory(directory, &model.asset_id)?;
    Ok(SongVideoBackground {
        song_id: model.song_id,
        asset_id: model.asset_id,
        file_path: file_path.to_string_lossy().into_owned(),
        mime_type: model.mime_type,
        duration_ms: model.duration_ms,
        width: model.width,
        height: model.height,
        fit_mode: model.fit_mode,
        in_point_ms: model.in_point_ms,
        out_point_ms: model.out_point_ms,
        loop_enabled: model.loop_enabled,
        sync_on_seek: model.sync_on_seek,
        updated_at: model.updated_at,
    })
}

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to remove {}: {error}", path.display())),
    }
}

async fn remove_asset_if_unreferenced(
    db: &sea_orm::DatabaseConnection,
    app: &AppHandle,
    asset_id: &str,
) -> Result<(), String> {
    remove_asset_if_unreferenced_in_directory(db, &video_background_dir(app)?, asset_id).await
}

async fn remove_asset_if_unreferenced_in_directory(
    db: &sea_orm::DatabaseConnection,
    directory: &Path,
    asset_id: &str,
) -> Result<(), String> {
    let referenced = song_video_background::Entity::find()
        .filter(song_video_background::Column::AssetId.eq(asset_id))
        .one(db)
        .await
        .map_err(|error| format!("Failed to check video background references: {error}"))?
        .is_some();
    if !referenced {
        remove_file_if_exists(&resolve_asset_path_in_directory(directory, asset_id)?)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn import_song_video_background(
    source_path: String,
    app: AppHandle,
) -> Result<ImportedSongVideoBackground, String> {
    if source_path.starts_with("content://") {
        return Err(
            "Android content URIs are not supported for video backgrounds; select a regular local file"
                .into(),
        );
    }
    import_song_video_background_into_directory(
        PathBuf::from(source_path),
        video_background_dir(&app)?,
    )
    .await
}

#[tauri::command]
pub async fn pick_and_import_song_video_background(
    title: String,
    app: AppHandle,
) -> Result<Option<ImportedSongVideoBackground>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let mut dialog = app
        .dialog()
        .file()
        .set_title(title)
        .add_filter("Video files", &["mp4", "webm"]);
    if let Ok(video_dir) = app.path().video_dir()
        && video_dir.is_dir()
    {
        dialog = dialog.set_directory(video_dir);
    }

    // Keep this picker ownerless. The JavaScript dialog command automatically
    // parents IFileDialog to our transparent frameless window, while Windows
    // hang reports for this flow involved both Explorer and the app. The
    // callback API also keeps the Shell dialog off Tauri's event loop.
    dialog.pick_file(move |selected| {
        let _ = sender.send(selected);
    });

    let selected = receiver
        .await
        .map_err(|_| "The video background picker closed unexpectedly".to_string())?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let source = selected
        .into_path()
        .map_err(|error| format!("The selected video is not a regular local file: {error}"))?;
    let imported =
        import_song_video_background_into_directory(source, video_background_dir(&app)?).await?;
    Ok(Some(imported))
}

async fn import_song_video_background_into_directory(
    source: PathBuf,
    target_dir: PathBuf,
) -> Result<ImportedSongVideoBackground, String> {
    let metadata = validate_regular_file(&source, "selected video")?;
    if metadata.len() == 0 || metadata.len() > MAX_VIDEO_BACKGROUND_BYTES {
        return Err(format!(
            "The selected video must be between 1 byte and {} GiB",
            MAX_VIDEO_BACKGROUND_BYTES / 1024 / 1024 / 1024
        ));
    }

    ensure_storage_directory(&target_dir)?;

    let now = chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let identity = format!("{}:{}:{now}", source.display(), metadata.len());
    let timestamp = now.unsigned_abs();
    let asset_digest = format!("{:x}", md5::compute(identity.as_bytes()));
    let expected_bytes = metadata.len();

    let storage_guard = VIDEO_BACKGROUND_STORAGE_LOCK.clone().lock_owned().await;
    let copy_result = tokio::task::spawn_blocking({
        let source = source.clone();
        let target_dir = target_dir.clone();
        let asset_digest = asset_digest.clone();
        move || -> Result<
            (
                String,
                PathBuf,
                &'static str,
                tokio::sync::OwnedMutexGuard<()>,
            ),
            String,
        > {
            // Move the owned guard into the non-cancellable blocking task. If
            // the command future is aborted, GC/discard still cannot race the
            // in-flight copy and finalization.
            let storage_guard = storage_guard;
            let (mut input, opened_bytes) = open_regular_file_for_read(&source, "selected video")?;
            if opened_bytes != expected_bytes {
                return Err("The selected video changed before it could be copied".into());
            }
            let (mime_type, extension) = detect_supported_video_from_reader(&mut input)?;
            input
                .rewind()
                .map_err(|error| format!("Failed to rewind selected video: {error}"))?;
            let (mut output, partial_path, candidate_timestamp) =
                create_staged_asset_file(&target_dir, &asset_digest, timestamp, extension)?;
            let mut bounded_input = input.by_ref().take(MAX_VIDEO_BACKGROUND_BYTES + 1);
            let copied = match std::io::copy(&mut bounded_input, &mut output) {
                Ok(copied) => copied,
                Err(error) => {
                    let _ = std::fs::remove_file(&partial_path);
                    return Err(format!("Failed to copy video background: {error}"));
                }
            };
            if copied > MAX_VIDEO_BACKGROUND_BYTES {
                let _ = std::fs::remove_file(&partial_path);
                return Err(format!(
                    "The selected video exceeds the {} GiB size limit",
                    MAX_VIDEO_BACKGROUND_BYTES / 1024 / 1024 / 1024
                ));
            }
            if copied != expected_bytes {
                let _ = std::fs::remove_file(&partial_path);
                return Err("The selected video changed while it was being copied".into());
            }
            if let Err(error) = output.sync_all() {
                let _ = std::fs::remove_file(&partial_path);
                return Err(format!("Failed to flush video background: {error}"));
            }
            drop(output);
            let (stored_mime, _) = match detect_supported_video(&partial_path) {
                Ok(detected) => detected,
                Err(error) => {
                    let _ = std::fs::remove_file(&partial_path);
                    return Err(error);
                }
            };
            if stored_mime != mime_type {
                let _ = std::fs::remove_file(&partial_path);
                return Err("The selected video changed while it was being copied".into());
            }
            let (asset_id, target_path) = publish_staged_asset_without_overwrite(
                &partial_path,
                &target_dir,
                &asset_digest,
                candidate_timestamp,
                extension,
            )?;
            Ok((asset_id, target_path, mime_type, storage_guard))
        }
    })
    .await
    .map_err(|error| format!("Video background import task failed: {error}"))?;
    let (asset_id, target_path, mime_type, storage_guard) = copy_result?;
    mark_asset_pending(&asset_id);
    drop(storage_guard);
    Ok(ImportedSongVideoBackground {
        asset_id,
        file_path: target_path.to_string_lossy().into_owned(),
        mime_type: mime_type.to_owned(),
        bytes: expected_bytes,
    })
}

fn create_staged_asset_file(
    directory: &Path,
    digest: &str,
    initial_timestamp: u64,
    extension: &str,
) -> Result<(File, PathBuf, u64), String> {
    for offset in 0..1024_u64 {
        let timestamp = initial_timestamp
            .checked_add(offset)
            .ok_or_else(|| "Unable to allocate video background identifier".to_string())?;
        let partial = directory.join(format!(".{digest}-{timestamp}.{extension}.part"));
        match OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&partial)
        {
            Ok(file) => return Ok((file, partial, timestamp)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!("Failed to create video background: {error}"));
            }
        }
    }
    Err("Unable to allocate a unique video background staging file".into())
}

fn publish_staged_asset_without_overwrite(
    partial: &Path,
    directory: &Path,
    digest: &str,
    initial_timestamp: u64,
    extension: &str,
) -> Result<(String, PathBuf), String> {
    // Both paths are in the same private AppData directory. Creating a hard
    // link publishes the already-flushed staged inode atomically and, unlike
    // rename on Unix, never overwrites an existing target.
    for offset in 0..1024_u64 {
        let timestamp = initial_timestamp
            .checked_add(offset)
            .ok_or_else(|| "Unable to allocate video background identifier".to_string())?;
        let asset_id = format!("{digest}-{timestamp}.{extension}");
        let target = directory.join(&asset_id);
        match std::fs::hard_link(partial, &target) {
            Ok(()) => {
                remove_file_if_exists(partial)?;
                return Ok((asset_id, target));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                let _ = std::fs::remove_file(partial);
                return Err(format!("Failed to finalize video background: {error}"));
            }
        }
    }
    let _ = std::fs::remove_file(partial);
    Err("Unable to allocate a unique video background asset".into())
}

#[tauri::command]
pub async fn get_song_video_background(
    song_id: String,
    db: State<'_, DbConnection>,
    app: AppHandle,
) -> Result<Option<SongVideoBackground>, String> {
    let model = song_video_background::Entity::find_by_id(song_id)
        .one(&*db)
        .await
        .map_err(|error| format!("Failed to get song video background: {error}"))?;
    model.map(|model| model_to_view(&app, model)).transpose()
}

#[tauri::command]
pub async fn save_song_video_background(
    payload: SaveSongVideoBackgroundPayload,
    db: State<'_, DbConnection>,
    app: AppHandle,
) -> Result<SongVideoBackground, String> {
    let directory = video_background_dir(&app)?;
    let saved = save_song_video_background_record(payload, &*db, &directory).await?;
    model_to_view_in_directory(&directory, saved)
}

fn validate_save_payload(payload: &SaveSongVideoBackgroundPayload) -> Result<(), String> {
    if !matches!(payload.fit_mode.as_str(), "cover" | "contain" | "fill") {
        return Err("Invalid video background fit mode".into());
    }
    if payload.duration_ms <= 0
        || payload.width <= 0
        || payload.height <= 0
        || payload.in_point_ms < 0
        || payload.out_point_ms <= payload.in_point_ms
        || payload.out_point_ms > payload.duration_ms
    {
        return Err("Invalid video background metadata or playback range".into());
    }
    Ok(())
}

async fn save_song_video_background_record(
    payload: SaveSongVideoBackgroundPayload,
    db: &sea_orm::DatabaseConnection,
    directory: &Path,
) -> Result<song_video_background::Model, String> {
    validate_save_payload(&payload)?;

    // Serialize validation with discard/GC so a valid asset cannot disappear
    // between the filesystem check and the database upsert.
    let _storage_guard = VIDEO_BACKGROUND_STORAGE_LOCK.as_ref().lock().await;
    song::Entity::find_by_id(&payload.song_id)
        .one(db)
        .await
        .map_err(|error| format!("Failed to find song: {error}"))?
        .ok_or_else(|| format!("Song {} not found", payload.song_id))?;

    let asset_path = resolve_asset_path_in_directory(directory, &payload.asset_id)?;
    let asset_metadata = validate_regular_file(&asset_path, "video background asset")?;
    if asset_metadata.len() == 0 || asset_metadata.len() > MAX_VIDEO_BACKGROUND_BYTES {
        return Err("Video background asset has an invalid size".into());
    }
    let mime_type = mime_for_asset_id(&payload.asset_id)?;
    let (detected_mime, _) = detect_supported_video(&asset_path)?;
    if detected_mime != mime_type {
        return Err("Video background asset format does not match its identifier".into());
    }
    let mime_type = mime_type.to_owned();

    let transaction = db
        .begin()
        .await
        .map_err(|error| format!("Failed to begin video background save: {error}"))?;
    let asset_was_imported = is_asset_pending(&payload.asset_id)
        || song_video_background::Entity::find()
            .filter(song_video_background::Column::AssetId.eq(&payload.asset_id))
            .one(&transaction)
            .await
            .map_err(|error| format!("Failed to verify video background asset: {error}"))?
            .is_some();
    if !asset_was_imported {
        transaction
            .rollback()
            .await
            .map_err(|error| format!("Failed to reject unimported video background: {error}"))?;
        return Err("Video background asset was not imported by this application".into());
    }
    let previous_asset_id = song_video_background::Entity::find_by_id(&payload.song_id)
        .one(&transaction)
        .await
        .map_err(|error| format!("Failed to get previous video background: {error}"))?
        .map(|model| model.asset_id);

    let updated_at = chrono::Utc::now().timestamp_millis();
    let model = song_video_background::ActiveModel {
        song_id: Set(payload.song_id.clone()),
        asset_id: Set(payload.asset_id.clone()),
        mime_type: Set(mime_type),
        duration_ms: Set(payload.duration_ms),
        width: Set(payload.width),
        height: Set(payload.height),
        fit_mode: Set(payload.fit_mode),
        in_point_ms: Set(payload.in_point_ms),
        out_point_ms: Set(payload.out_point_ms),
        loop_enabled: Set(payload.loop_enabled),
        sync_on_seek: Set(payload.sync_on_seek),
        updated_at: Set(updated_at),
    };

    song_video_background::Entity::insert(model)
        .on_conflict(
            OnConflict::column(song_video_background::Column::SongId)
                .update_columns([
                    song_video_background::Column::AssetId,
                    song_video_background::Column::MimeType,
                    song_video_background::Column::DurationMs,
                    song_video_background::Column::Width,
                    song_video_background::Column::Height,
                    song_video_background::Column::FitMode,
                    song_video_background::Column::InPointMs,
                    song_video_background::Column::OutPointMs,
                    song_video_background::Column::LoopEnabled,
                    song_video_background::Column::SyncOnSeek,
                    song_video_background::Column::UpdatedAt,
                ])
                .to_owned(),
        )
        .exec(&transaction)
        .await
        .map_err(|error| format!("Failed to save song video background: {error}"))?;
    let saved = song_video_background::Entity::find_by_id(&payload.song_id)
        .one(&transaction)
        .await
        .map_err(|error| format!("Failed to read saved song video background: {error}"))?
        .ok_or_else(|| "Saved video background could not be read back".to_string())?;
    let existing_override = song_background_override::Entity::find_by_id(&payload.song_id)
        .one(&transaction)
        .await
        .map_err(|error| format!("Failed to check song background override: {error}"))?;
    let override_changed = if existing_override.is_none() {
        song_background_override::Entity::insert(song_background_override::ActiveModel {
            song_id: Set(payload.song_id.clone()),
            override_enabled: Set(true),
            renderer_mode: Set("video".to_owned()),
            dual_layer: Set(true),
            video_opacity: Set(0.4),
            video_base_renderer_mode: Set("css-bg".to_owned()),
            video_base_css_background: Set("#000000".to_owned()),
            renderer_options: Set(None),
            updated_at: Set(updated_at),
        })
        .exec(&transaction)
        .await
        .map_err(|error| format!("Failed to enable song video background override: {error}"))?;
        true
    } else {
        let existing_override = existing_override.expect("checked above");
        if !existing_override.override_enabled || existing_override.renderer_mode != "video" {
            song_background_override::Entity::update_many()
                .col_expr(
                    song_background_override::Column::OverrideEnabled,
                    Expr::value(true),
                )
                .col_expr(
                    song_background_override::Column::RendererMode,
                    Expr::value("video"),
                )
                .col_expr(
                    song_background_override::Column::UpdatedAt,
                    Expr::value(updated_at),
                )
                .filter(song_background_override::Column::SongId.eq(&payload.song_id))
                .exec(&transaction)
                .await
                .map_err(|error| {
                    format!("Failed to enable song video background override: {error}")
                })?;
            true
        } else {
            false
        }
    };
    transaction
        .commit()
        .await
        .map_err(|error| format!("Failed to commit song video background: {error}"))?;
    unmark_asset_pending(&saved.asset_id);
    db_events::emit_event(
        "song_video_backgrounds",
        "upsert",
        serde_json::json!(&saved.song_id),
    );
    if override_changed {
        db_events::emit_event(
            "song_background_overrides",
            "upsert",
            serde_json::json!(&saved.song_id),
        );
    }

    if let Some(previous_asset_id) = previous_asset_id
        && previous_asset_id != saved.asset_id
        && let Err(error) =
            remove_asset_if_unreferenced_in_directory(db, directory, &previous_asset_id).await
    {
        warn!("[VideoBackground] Failed to remove replaced asset: {error}");
    }

    Ok(saved)
}

#[tauri::command]
pub async fn delete_song_video_background(
    song_id: String,
    db: State<'_, DbConnection>,
    app: AppHandle,
) -> Result<(), String> {
    let _storage_guard = VIDEO_BACKGROUND_STORAGE_LOCK.as_ref().lock().await;
    let transaction = db
        .begin()
        .await
        .map_err(|error| format!("Failed to begin video background deletion: {error}"))?;
    let previous = song_video_background::Entity::find_by_id(&song_id)
        .one(&transaction)
        .await
        .map_err(|error| format!("Failed to get song video background: {error}"))?;
    if previous.is_some() {
        song_video_background::Entity::delete_by_id(&song_id)
            .exec(&transaction)
            .await
            .map_err(|error| format!("Failed to delete song video background: {error}"))?;
    }
    let disabled_video_override = song_background_override::Entity::update_many()
        .col_expr(
            song_background_override::Column::OverrideEnabled,
            Expr::value(false),
        )
        .col_expr(
            song_background_override::Column::UpdatedAt,
            Expr::value(chrono::Utc::now().timestamp_millis()),
        )
        .filter(song_background_override::Column::SongId.eq(&song_id))
        .filter(song_background_override::Column::RendererMode.eq("video"))
        .exec(&transaction)
        .await
        .map_err(|error| format!("Failed to reset song video background override: {error}"))?;
    transaction
        .commit()
        .await
        .map_err(|error| format!("Failed to commit video background deletion: {error}"))?;

    if let Some(previous) = previous {
        db_events::emit_event(
            "song_video_backgrounds",
            "delete",
            serde_json::json!(&song_id),
        );
        if let Err(error) = remove_asset_if_unreferenced(&db, &app, &previous.asset_id).await {
            warn!("[VideoBackground] Failed to remove deleted asset: {error}");
        }
    }
    if disabled_video_override.rows_affected > 0 {
        db_events::emit_event(
            "song_background_overrides",
            "upsert",
            serde_json::json!(&song_id),
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn discard_song_video_background_asset(
    asset_id: String,
    db: State<'_, DbConnection>,
    app: AppHandle,
) -> Result<(), String> {
    let _storage_guard = VIDEO_BACKGROUND_STORAGE_LOCK.as_ref().lock().await;
    let referenced = song_video_background::Entity::find()
        .filter(song_video_background::Column::AssetId.eq(&asset_id))
        .one(&*db)
        .await
        .map_err(|error| format!("Failed to check video background references: {error}"))?
        .is_some();
    if referenced {
        return Err("Cannot discard an active video background asset".into());
    }
    remove_file_if_exists(&resolve_asset_path(&app, &asset_id)?)?;
    unmark_asset_pending(&asset_id);
    Ok(())
}

async fn referenced_asset_ids(db: &sea_orm::DatabaseConnection) -> Result<HashSet<String>, String> {
    Ok(song_video_background::Entity::find()
        .all(db)
        .await
        .map_err(|error| format!("Failed to query video backgrounds: {error}"))?
        .into_iter()
        .map(|model| model.asset_id)
        .collect())
}

pub async fn run_song_video_background_gc(
    db: &sea_orm::DatabaseConnection,
    app: &AppHandle,
) -> Result<VideoBackgroundGcResult, String> {
    run_song_video_background_gc_in_directory(db, &video_background_dir(app)?).await
}

async fn run_song_video_background_gc_in_directory(
    db: &sea_orm::DatabaseConnection,
    directory: &Path,
) -> Result<VideoBackgroundGcResult, String> {
    run_song_video_background_gc_in_directory_at(db, directory, SystemTime::now()).await
}

fn should_collect_orphan(modified: SystemTime, now: SystemTime) -> bool {
    now.duration_since(modified)
        .is_ok_and(|age| age >= ORPHAN_GRACE_PERIOD)
}

async fn run_song_video_background_gc_in_directory_at(
    db: &sea_orm::DatabaseConnection,
    directory: &Path,
    now: SystemTime,
) -> Result<VideoBackgroundGcResult, String> {
    let _storage_guard = VIDEO_BACKGROUND_STORAGE_LOCK.as_ref().lock().await;
    match std::fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(format!(
                "Video background storage is not a regular directory: {}",
                directory.display()
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(VideoBackgroundGcResult {
                total_scanned: 0,
                deleted: 0,
                errors: Vec::new(),
            });
        }
        Err(error) => {
            return Err(format!(
                "Failed to inspect video background directory: {error}"
            ));
        }
    }

    let mut referenced = referenced_asset_ids(db).await?;
    referenced.extend(pending_assets_snapshot());
    let mut result = VideoBackgroundGcResult {
        total_scanned: 0,
        deleted: 0,
        errors: Vec::new(),
    };

    for entry in std::fs::read_dir(directory)
        .map_err(|error| format!("Failed to read video background directory: {error}"))?
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                warn!("[VideoBackgroundGC] Failed to read directory entry: {error}");
                continue;
            }
        };
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                result.errors.push(error.to_string());
                continue;
            }
        };
        if !file_type.is_file() {
            continue;
        }
        result.total_scanned += 1;
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if !referenced.contains(&file_name) {
            let modified = match entry.metadata().and_then(|metadata| metadata.modified()) {
                Ok(modified) => modified,
                Err(error) => {
                    result.errors.push(error.to_string());
                    continue;
                }
            };
            // Pending state is process-local. A grace period protects a freshly
            // imported candidate from another concurrently running instance's
            // startup GC; explicit discard still removes it immediately.
            if !should_collect_orphan(modified, now) {
                continue;
            }
            match std::fs::remove_file(entry.path()) {
                Ok(()) => result.deleted += 1,
                Err(error) => result.errors.push(error.to_string()),
            }
        }
    }

    info!(
        "[VideoBackgroundGC] Completed: scanned {}, deleted {} orphaned assets",
        result.total_scanned, result.deleted
    );
    Ok(result)
}

#[tauri::command]
pub async fn cleanup_orphaned_song_video_backgrounds(
    db: State<'_, DbConnection>,
    app: AppHandle,
) -> Result<VideoBackgroundGcResult, String> {
    run_song_video_background_gc(&db, &app).await
}

#[cfg(test)]
mod tests {
    use sea_orm::{Database, EntityTrait};

    use super::*;
    use crate::db::migration;

    const MP4_MAGIC: &[u8] = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2";
    const WEBM_MAGIC: &[u8] = b"\x1A\x45\xDF\xA3\x01\x00\x00\x00\x42\x82\x84webm";

    async fn test_database() -> sea_orm::DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("in-memory SQLite should open");
        migration::run_migrations(&db)
            .await
            .expect("video background migration should run");
        db
    }

    async fn insert_song(db: &sea_orm::DatabaseConnection, song_id: &str) {
        song::Entity::insert(song::ActiveModel {
            id: Set(song_id.to_owned()),
            file_path: Set(format!("{song_id}.flac")),
            song_name: Set("Song".to_owned()),
            song_artists: Set("Artist".to_owned()),
            song_album: Set("Album".to_owned()),
            duration: Set(180.0),
            lyric_format: Set("lrc".to_owned()),
            lyric: Set(String::new()),
            translated_lrc: Set(None),
            roman_lrc: Set(None),
            cover_path: Set(None),
            modified_at: Set(None),
        })
        .exec(db)
        .await
        .expect("song fixture should insert");
    }

    fn payload(song_id: &str, asset_id: &str) -> SaveSongVideoBackgroundPayload {
        SaveSongVideoBackgroundPayload {
            song_id: song_id.to_owned(),
            asset_id: asset_id.to_owned(),
            duration_ms: 12_000,
            width: 1920,
            height: 1080,
            fit_mode: "cover".to_owned(),
            in_point_ms: 500,
            out_point_ms: 10_000,
            loop_enabled: true,
            sync_on_seek: true,
        }
    }

    #[test]
    fn validates_magic_asset_ids_and_camel_case_contract() {
        let temp = tempfile::tempdir().expect("temporary directory should exist");
        let mp4_path = temp.path().join("renamed.data");
        let webm_path = temp.path().join("renamed.bin");
        let text_path = temp.path().join("fake.mp4");
        std::fs::write(&mp4_path, MP4_MAGIC).expect("MP4 fixture should write");
        std::fs::write(&webm_path, WEBM_MAGIC).expect("WebM fixture should write");
        std::fs::write(&text_path, b"not a video").expect("text fixture should write");

        assert_eq!(detect_supported_video(&mp4_path), Ok(("video/mp4", "mp4")));
        assert_eq!(
            detect_supported_video(&webm_path),
            Ok(("video/webm", "webm"))
        );
        assert!(detect_supported_video(&text_path).is_err());
        let generic_ebml_path = temp.path().join("generic-ebml.bin");
        std::fs::write(&generic_ebml_path, b"\x1A\x45\xDF\xA3matroska")
            .expect("generic EBML fixture should write");
        assert!(detect_supported_video(&generic_ebml_path).is_err());
        assert!(validate_regular_file(temp.path(), "fixture").is_err());
        for invalid in [
            "",
            ".",
            "..",
            "../escape.mp4",
            "dir\\escape.webm",
            "x.mov",
            "asset.mp4",
            "ABCDEF0123456789abcdef0123456789-1.mp4",
            "abcdef0123456789abcdef0123456789--1.mp4",
        ] {
            assert!(validate_asset_id(invalid).is_err(), "accepted {invalid}");
        }
        assert!(validate_asset_id("abcdef0123456789abcdef0123456789-1.mp4").is_ok());
        assert!(validate_asset_id("abcdef0123456789abcdef0123456789-2.webm").is_ok());

        let collision_dir = temp.path().join("collision");
        ensure_storage_directory(&collision_dir).expect("collision storage should initialize");
        let digest = "abcdef0123456789abcdef0123456789";
        let occupied = collision_dir.join(format!("{digest}-10.mp4"));
        let staged = collision_dir.join(".staged.part");
        std::fs::write(&occupied, b"existing").expect("occupied target should write");
        std::fs::write(&staged, MP4_MAGIC).expect("staged target should write");
        let (published_id, published_path) =
            publish_staged_asset_without_overwrite(&staged, &collision_dir, digest, 10, "mp4")
                .expect("publisher should retry target collision");
        assert_eq!(published_id, format!("{digest}-11.mp4"));
        assert_eq!(std::fs::read(&occupied).unwrap(), b"existing");
        assert_eq!(std::fs::read(published_path).unwrap(), MP4_MAGIC);
        assert!(!staged.exists());

        let decoded: SaveSongVideoBackgroundPayload = serde_json::from_value(serde_json::json!({
            "songId": "song-1",
            "assetId": "abcdef0123456789abcdef0123456789-1.mp4",
            "durationMs": 1000,
            "width": 1280,
            "height": 720,
            "fitMode": "contain",
            "inPointMs": 0,
            "outPointMs": 1000,
            "loopEnabled": false,
            "syncOnSeek": true
        }))
        .expect("camelCase payload should deserialize");
        assert_eq!(decoded.song_id, "song-1");
        assert_eq!(decoded.asset_id, "abcdef0123456789abcdef0123456789-1.mp4");
        assert_eq!(decoded.fit_mode, "contain");

        let serialized = serde_json::to_value(ImportedSongVideoBackground {
            asset_id: "abcdef0123456789abcdef0123456789-1.mp4".to_owned(),
            file_path: "path".to_owned(),
            mime_type: "video/mp4".to_owned(),
            bytes: 24,
        })
        .expect("import result should serialize");
        assert_eq!(
            serialized["assetId"],
            "abcdef0123456789abcdef0123456789-1.mp4"
        );
        assert!(serialized.get("asset_id").is_none());
    }

    #[tokio::test]
    async fn import_is_atomic_and_pending_asset_survives_gc_until_released() {
        let temp = tempfile::tempdir().expect("temporary directory should exist");
        let source = temp.path().join("source.without-video-extension");
        let storage = temp.path().join("song-backgrounds");
        std::fs::write(&source, MP4_MAGIC).expect("source fixture should write");

        let imported = import_song_video_background_into_directory(source, storage.clone())
            .await
            .expect("magic-valid source should import");
        assert!(imported.asset_id.ends_with(".mp4"));
        assert_eq!(imported.mime_type, "video/mp4");
        assert_eq!(imported.bytes, MP4_MAGIC.len() as u64);
        assert!(storage.join(&imported.asset_id).is_file());
        assert!(pending_assets_snapshot().contains(&imported.asset_id));
        assert!(
            std::fs::read_dir(&storage)
                .expect("storage should be readable")
                .all(|entry| !entry
                    .expect("directory entry should be readable")
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".part"))
        );

        let db = test_database().await;
        let protected = run_song_video_background_gc_in_directory(&db, &storage)
            .await
            .expect("GC should succeed");
        assert_eq!(protected.total_scanned, 1);
        assert_eq!(protected.deleted, 0);

        unmark_asset_pending(&imported.asset_id);
        let released = run_song_video_background_gc_in_directory_at(
            &db,
            &storage,
            SystemTime::now() + ORPHAN_GRACE_PERIOD + Duration::from_secs(1),
        )
        .await
        .expect("GC should succeed after release and grace period");
        assert_eq!(released.deleted, 1);
        assert!(!storage.join(&imported.asset_id).exists());
    }

    #[test]
    fn orphan_gc_grace_period_is_fail_safe() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(100_000);
        assert!(!should_collect_orphan(now, now));
        assert!(!should_collect_orphan(
            now - ORPHAN_GRACE_PERIOD + Duration::from_secs(1),
            now
        ));
        assert!(should_collect_orphan(now - ORPHAN_GRACE_PERIOD, now));
        assert!(!should_collect_orphan(now + Duration::from_secs(1), now));
    }

    #[tokio::test]
    async fn concurrent_saves_upsert_one_mapping_and_collect_replaced_asset() {
        let temp = tempfile::tempdir().expect("temporary directory should exist");
        let storage = temp.path().join("song-backgrounds");
        ensure_storage_directory(&storage).expect("storage should initialize");
        let first_id = "11111111111111111111111111111111-1.mp4";
        let second_id = "22222222222222222222222222222222-2.webm";
        std::fs::write(storage.join(first_id), MP4_MAGIC).expect("first asset should write");
        std::fs::write(storage.join(second_id), WEBM_MAGIC).expect("second asset should write");
        mark_asset_pending(first_id);
        mark_asset_pending(second_id);

        let db = test_database().await;
        insert_song(&db, "song-concurrent").await;
        let (first_result, second_result) = tokio::join!(
            save_song_video_background_record(payload("song-concurrent", first_id), &db, &storage),
            save_song_video_background_record(payload("song-concurrent", second_id), &db, &storage)
        );
        first_result.expect("first save should succeed");
        second_result.expect("second save should succeed");

        let saved = song_video_background::Entity::find_by_id("song-concurrent")
            .one(&db)
            .await
            .expect("mapping query should succeed")
            .expect("one mapping should remain");
        assert!(saved.asset_id == first_id || saved.asset_id == second_id);
        assert!(storage.join(&saved.asset_id).is_file());
        let replaced_id = if saved.asset_id == first_id {
            second_id
        } else {
            first_id
        };
        assert!(!storage.join(replaced_id).exists());
        assert!(!pending_assets_snapshot().contains(first_id));
        assert!(!pending_assets_snapshot().contains(second_id));
        let background_override = song_background_override::Entity::find_by_id("song-concurrent")
            .one(&db)
            .await
            .expect("override query should succeed")
            .expect("saving the first video should create an override");
        assert!(background_override.override_enabled);
        assert_eq!(background_override.renderer_mode, "video");
        assert!(background_override.dual_layer);
        assert_eq!(background_override.video_opacity, 0.4);
        assert_eq!(background_override.video_base_renderer_mode, "css-bg");
        assert_eq!(background_override.video_base_css_background, "#000000");

        song_background_override::Entity::update_many()
            .col_expr(
                song_background_override::Column::OverrideEnabled,
                Expr::value(false),
            )
            .col_expr(
                song_background_override::Column::RendererMode,
                Expr::value("mesh"),
            )
            .filter(song_background_override::Column::SongId.eq("song-concurrent"))
            .exec(&db)
            .await
            .expect("override fixture should change");
        save_song_video_background_record(
            payload("song-concurrent", &saved.asset_id),
            &db,
            &storage,
        )
        .await
        .expect("saving a video should re-enable video mode");
        let reenabled_override = song_background_override::Entity::find_by_id("song-concurrent")
            .one(&db)
            .await
            .expect("override query should succeed")
            .expect("override should remain");
        assert!(reenabled_override.override_enabled);
        assert_eq!(reenabled_override.renderer_mode, "video");

        let mut invalid = payload("song-concurrent", &saved.asset_id);
        invalid.out_point_ms = invalid.duration_ms + 1;
        assert!(
            save_song_video_background_record(invalid, &db, &storage)
                .await
                .is_err()
        );
        assert_eq!(
            song_video_background::Entity::find_by_id("song-concurrent")
                .one(&db)
                .await
                .expect("mapping query should succeed")
                .expect("mapping should remain")
                .asset_id,
            saved.asset_id
        );

        let forged_id = "33333333333333333333333333333333-3.mp4";
        std::fs::write(storage.join(forged_id), MP4_MAGIC)
            .expect("forged-but-well-formed asset should write");
        let forged_error =
            save_song_video_background_record(payload("song-concurrent", forged_id), &db, &storage)
                .await
                .expect_err(
                    "save should reject an asset that was not imported or already referenced",
                );
        assert!(forged_error.contains("not imported"));
        assert_eq!(
            song_video_background::Entity::find_by_id("song-concurrent")
                .one(&db)
                .await
                .expect("mapping query should succeed")
                .expect("mapping should remain")
                .asset_id,
            saved.asset_id
        );
    }
}
