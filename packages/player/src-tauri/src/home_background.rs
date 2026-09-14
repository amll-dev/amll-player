use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    LazyLock, Mutex,
    atomic::{AtomicU64, Ordering},
};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tracing::warn;

const HOME_BACKGROUND_DIR: &str = "home-backgrounds";
const HOME_BACKGROUND_MANIFEST: &str = "config.json";
const HOME_BACKGROUND_MANIFEST_VERSION: u32 = 1;
const DEFAULT_HOME_BACKGROUND_COLOR: &str = "#111111";
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_MUTATION_FUTURE_SKEW_MICROS: u64 = 5 * 1_000 * 1_000;
const MAX_IMAGE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_VIDEO_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const ORPHAN_GRACE_PERIOD: Duration = Duration::from_secs(24 * 60 * 60);

static HOME_BACKGROUND_STORAGE_LOCK: LazyLock<std::sync::Arc<tokio::sync::Mutex<()>>> =
    LazyLock::new(|| std::sync::Arc::new(tokio::sync::Mutex::new(())));
static PENDING_HOME_BACKGROUND_ASSETS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));
static LATEST_HOME_BACKGROUND_MUTATION_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HomeBackgroundAssetKind {
    Image,
    Video,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HomeBackgroundMode {
    Default,
    Color,
    Image,
    Video,
}

impl HomeBackgroundAssetKind {
    fn mode(self) -> HomeBackgroundMode {
        match self {
            Self::Image => HomeBackgroundMode::Image,
            Self::Video => HomeBackgroundMode::Video,
        }
    }

    fn size_limit(self) -> u64 {
        match self {
            Self::Image => MAX_IMAGE_BYTES,
            Self::Video => MAX_VIDEO_BYTES,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHomeBackgroundAsset {
    pub asset_id: String,
    pub file_path: String,
    pub mime_type: String,
    pub bytes: u64,
    pub kind: HomeBackgroundAssetKind,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeBackgroundConfig {
    pub mode: HomeBackgroundMode,
    pub color: String,
    pub asset_id: Option<String>,
    pub file_path: Option<String>,
    pub mime_type: Option<String>,
    pub bytes: Option<u64>,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HomeBackgroundManifest {
    version: u32,
    mode: HomeBackgroundMode,
    color: String,
    asset_id: Option<String>,
    mime_type: Option<String>,
    bytes: Option<u64>,
    updated_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeBackgroundGcResult {
    pub total_scanned: u32,
    pub deleted: u32,
    pub errors: Vec<String>,
}

fn default_config() -> HomeBackgroundConfig {
    HomeBackgroundConfig {
        mode: HomeBackgroundMode::Default,
        color: DEFAULT_HOME_BACKGROUND_COLOR.to_owned(),
        asset_id: None,
        file_path: None,
        mime_type: None,
        bytes: None,
        updated_at: 0,
    }
}

fn claim_home_background_mutation(mutation_id: u64) -> Result<(), String> {
    if mutation_id == 0 {
        return Err("The home background mutation identifier is invalid".into());
    }
    let now_micros = chrono::Utc::now()
        .timestamp_millis()
        .max(0)
        .unsigned_abs()
        .saturating_mul(1_000);
    if mutation_id > now_micros.saturating_add(MAX_MUTATION_FUTURE_SKEW_MICROS) {
        return Err("The home background mutation identifier is too far in the future".into());
    }
    let latest = LATEST_HOME_BACKGROUND_MUTATION_ID.load(Ordering::Relaxed);
    if mutation_id <= latest {
        return Err("The home background change was superseded by a newer request".into());
    }
    // All callers hold HOME_BACKGROUND_STORAGE_LOCK, so a relaxed store is
    // sufficient and keeps the ordering decision process-local and monotonic.
    LATEST_HOME_BACKGROUND_MUTATION_ID.store(mutation_id, Ordering::Relaxed);
    Ok(())
}

fn home_background_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resolve(HOME_BACKGROUND_DIR, BaseDirectory::AppData)
        .map_err(|error| format!("Failed to resolve home background directory: {error}"))
}

fn ensure_storage_directory(directory: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(directory) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(format!(
                    "Home background storage is not a regular directory: {}",
                    directory.display()
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(directory)
                .map_err(|error| format!("Failed to create home background directory: {error}"))?;
            let metadata = std::fs::symlink_metadata(directory)
                .map_err(|error| format!("Failed to inspect home background directory: {error}"))?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(format!(
                    "Home background storage is not a regular directory: {}",
                    directory.display()
                ));
            }
        }
        Err(error) => {
            return Err(format!(
                "Failed to inspect home background directory: {error}"
            ));
        }
    }
    Ok(())
}

fn normalize_color(color: &str) -> Result<String, String> {
    let normalized = color.trim().to_ascii_lowercase();
    if normalized.len() == 7
        && normalized.starts_with('#')
        && normalized[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        Ok(normalized)
    } else {
        Err("Home background color must use the #RRGGBB format".into())
    }
}

fn asset_kind_for_extension(extension: &str) -> Option<HomeBackgroundAssetKind> {
    match extension {
        "jpg" | "png" | "webp" | "gif" => Some(HomeBackgroundAssetKind::Image),
        "mp4" | "webm" => Some(HomeBackgroundAssetKind::Video),
        _ => None,
    }
}

fn validate_asset_id(asset_id: &str) -> Result<HomeBackgroundAssetKind, String> {
    let (stem, extension) = asset_id.rsplit_once('.').unwrap_or_default();
    let (digest, timestamp) = stem.split_once('-').unwrap_or_default();
    let kind = asset_kind_for_extension(extension)
        .ok_or_else(|| "Invalid home background asset identifier".to_string())?;
    let valid = digest.len() == 32
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        && !timestamp.is_empty()
        && timestamp.len() <= 20
        && timestamp.bytes().all(|byte| byte.is_ascii_digit());
    if !valid {
        return Err("Invalid home background asset identifier".into());
    }
    Ok(kind)
}

fn resolve_asset_path(directory: &Path, asset_id: &str) -> Result<PathBuf, String> {
    validate_asset_id(asset_id)?;
    Ok(directory.join(asset_id))
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
    if before.len() != opened.len() || before.modified().ok() != opened.modified().ok() {
        return Err(format!("{context} changed while it was being opened"));
    }
    Ok((file, opened.len()))
}

fn detect_supported_asset_from_reader(
    reader: &mut impl Read,
    expected_kind: HomeBackgroundAssetKind,
) -> Result<(&'static str, &'static str), String> {
    let mut header = [0_u8; 8192];
    let bytes_read = reader
        .read(&mut header)
        .map_err(|error| format!("Failed to inspect home background: {error}"))?;
    let kind = infer::get(&header[..bytes_read])
        .ok_or_else(|| "Unable to detect the selected background's format".to_string())?;
    let detected = match kind.mime_type() {
        "image/jpeg" => (HomeBackgroundAssetKind::Image, "image/jpeg", "jpg"),
        "image/png" => (HomeBackgroundAssetKind::Image, "image/png", "png"),
        "image/webp" => (HomeBackgroundAssetKind::Image, "image/webp", "webp"),
        "image/gif" => (HomeBackgroundAssetKind::Image, "image/gif", "gif"),
        "video/mp4" | "video/x-m4v" => (HomeBackgroundAssetKind::Video, "video/mp4", "mp4"),
        "video/webm"
            if header[..bytes_read]
                .windows(4)
                .any(|window| window == b"webm") =>
        {
            (HomeBackgroundAssetKind::Video, "video/webm", "webm")
        }
        mime => return Err(format!("Unsupported home background format: {mime}")),
    };
    if detected.0 != expected_kind {
        return Err(format!(
            "The selected file is not a {}",
            match expected_kind {
                HomeBackgroundAssetKind::Image => "supported image",
                HomeBackgroundAssetKind::Video => "supported video",
            }
        ));
    }
    Ok((detected.1, detected.2))
}

fn detect_supported_asset(
    path: &Path,
    expected_kind: HomeBackgroundAssetKind,
) -> Result<(&'static str, &'static str), String> {
    let mut file = File::open(path)
        .map_err(|error| format!("Failed to open home background for inspection: {error}"))?;
    detect_supported_asset_from_reader(&mut file, expected_kind)
}

fn mark_asset_pending(asset_id: &str) {
    PENDING_HOME_BACKGROUND_ASSETS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(asset_id.to_owned());
}

fn unmark_asset_pending(asset_id: &str) {
    PENDING_HOME_BACKGROUND_ASSETS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(asset_id);
}

fn is_asset_pending(asset_id: &str) -> bool {
    PENDING_HOME_BACKGROUND_ASSETS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains(asset_id)
}

fn pending_assets_snapshot() -> HashSet<String> {
    PENDING_HOME_BACKGROUND_ASSETS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn read_manifest(directory: &Path) -> Result<Option<HomeBackgroundManifest>, String> {
    let path = directory.join(HOME_BACKGROUND_MANIFEST);
    match std::fs::symlink_metadata(&path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Failed to inspect home background settings: {error}"
            ));
        }
    }
    let (mut file, bytes) = open_regular_file_for_read(&path, "home background settings")?;
    if bytes == 0 || bytes > MAX_MANIFEST_BYTES {
        return Err("The home background settings file has an invalid size".into());
    }
    let mut encoded = Vec::with_capacity(bytes as usize);
    std::io::Read::by_ref(&mut file)
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut encoded)
        .map_err(|error| format!("Failed to read home background settings: {error}"))?;
    if encoded.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("The home background settings file is too large".into());
    };
    let manifest: HomeBackgroundManifest = serde_json::from_slice(&encoded)
        .map_err(|error| format!("Failed to parse home background settings: {error}"))?;
    if manifest.version != HOME_BACKGROUND_MANIFEST_VERSION {
        return Err("Unsupported home background settings version".into());
    }
    normalize_color(&manifest.color)?;
    match manifest.mode {
        HomeBackgroundMode::Color => {
            if manifest.asset_id.is_some() {
                return Err("A color home background cannot reference an asset".into());
            }
        }
        HomeBackgroundMode::Image | HomeBackgroundMode::Video => {
            let asset_id = manifest
                .asset_id
                .as_deref()
                .ok_or_else(|| "The home background asset is missing".to_string())?;
            let kind = validate_asset_id(asset_id)?;
            if kind.mode() != manifest.mode {
                return Err("The home background mode does not match its asset".into());
            }
        }
        HomeBackgroundMode::Default => {
            return Err("The default home background must not be stored as a manifest".into());
        }
    }
    Ok(Some(manifest))
}

fn manifest_to_config(
    directory: &Path,
    manifest: HomeBackgroundManifest,
) -> Result<HomeBackgroundConfig, String> {
    if manifest.mode == HomeBackgroundMode::Color {
        return Ok(HomeBackgroundConfig {
            mode: manifest.mode,
            color: normalize_color(&manifest.color)?,
            asset_id: None,
            file_path: None,
            mime_type: None,
            bytes: None,
            updated_at: manifest.updated_at,
        });
    }
    let asset_id = manifest
        .asset_id
        .clone()
        .ok_or_else(|| "The home background asset is missing".to_string())?;
    let kind = validate_asset_id(&asset_id)?;
    let path = resolve_asset_path(directory, &asset_id)?;
    let metadata = validate_regular_file(&path, "home background asset")?;
    if metadata.len() == 0 || metadata.len() > kind.size_limit() {
        return Err("The stored home background asset has an invalid size".into());
    }
    let (mime_type, _) = detect_supported_asset(&path, kind)?;
    if manifest.mime_type.as_deref() != Some(mime_type) {
        return Err("The stored home background type does not match its contents".into());
    }
    Ok(HomeBackgroundConfig {
        mode: manifest.mode,
        color: normalize_color(&manifest.color)?,
        asset_id: Some(asset_id),
        file_path: Some(path.to_string_lossy().into_owned()),
        mime_type: Some(mime_type.to_owned()),
        bytes: Some(metadata.len()),
        updated_at: manifest.updated_at,
    })
}

fn write_manifest(directory: &Path, manifest: &HomeBackgroundManifest) -> Result<(), String> {
    ensure_storage_directory(directory)?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".home-background-config-")
        .tempfile_in(directory)
        .map_err(|error| format!("Failed to stage home background settings: {error}"))?;
    serde_json::to_writer_pretty(temporary.as_file_mut(), manifest)
        .map_err(|error| format!("Failed to encode home background settings: {error}"))?;
    temporary
        .as_file_mut()
        .flush()
        .map_err(|error| format!("Failed to flush home background settings: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("Failed to sync home background settings: {error}"))?;
    temporary
        .persist(directory.join(HOME_BACKGROUND_MANIFEST))
        .map_err(|error| format!("Failed to publish home background settings: {error}"))?;
    Ok(())
}

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to remove home background asset: {error}")),
    }
}

async fn import_home_background_into_directory(
    source: PathBuf,
    target_dir: PathBuf,
    expected_kind: HomeBackgroundAssetKind,
) -> Result<ImportedHomeBackgroundAsset, String> {
    let metadata = validate_regular_file(&source, "selected home background")?;
    let limit = expected_kind.size_limit();
    if metadata.len() == 0 || metadata.len() > limit {
        return Err(format!(
            "The selected background must be between 1 byte and {} MiB",
            limit / 1024 / 1024
        ));
    }
    ensure_storage_directory(&target_dir)?;
    let now = chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let timestamp = now.unsigned_abs();
    let identity = format!("{}:{}:{now}", source.display(), metadata.len());
    let digest = format!("{:x}", md5::compute(identity.as_bytes()));
    let expected_bytes = metadata.len();
    let storage_guard = HOME_BACKGROUND_STORAGE_LOCK.clone().lock_owned().await;

    let imported = tokio::task::spawn_blocking(move || {
        let storage_guard = storage_guard;
        let (mut input, opened_bytes) =
            open_regular_file_for_read(&source, "selected home background")?;
        if opened_bytes != expected_bytes {
            return Err("The selected background changed before it could be copied".to_string());
        }
        let (mime_type, extension) = detect_supported_asset_from_reader(&mut input, expected_kind)?;
        input
            .rewind()
            .map_err(|error| format!("Failed to rewind selected background: {error}"))?;
        let mut staged = tempfile::Builder::new()
            .prefix(".home-background-")
            .tempfile_in(&target_dir)
            .map_err(|error| format!("Failed to stage home background: {error}"))?;
        let mut bounded_input = std::io::Read::by_ref(&mut input).take(limit + 1);
        let copied = std::io::copy(&mut bounded_input, staged.as_file_mut())
            .map_err(|error| format!("Failed to copy home background: {error}"))?;
        if copied != expected_bytes || copied > limit {
            return Err("The selected background changed while it was being copied".to_string());
        }
        staged
            .as_file_mut()
            .flush()
            .map_err(|error| format!("Failed to flush home background: {error}"))?;
        staged
            .as_file()
            .sync_all()
            .map_err(|error| format!("Failed to sync home background: {error}"))?;
        let (stored_mime, stored_extension) = detect_supported_asset(staged.path(), expected_kind)?;
        if stored_mime != mime_type || stored_extension != extension {
            return Err("The selected background changed while it was being copied".to_string());
        }
        let asset_id = format!("{digest}-{timestamp}.{extension}");
        validate_asset_id(&asset_id)?;
        let target = target_dir.join(&asset_id);
        staged
            .persist_noclobber(&target)
            .map_err(|error| format!("Failed to publish home background: {error}"))?;
        Ok::<_, String>((
            ImportedHomeBackgroundAsset {
                asset_id,
                file_path: target.to_string_lossy().into_owned(),
                mime_type: mime_type.to_owned(),
                bytes: copied,
                kind: expected_kind,
            },
            storage_guard,
        ))
    })
    .await
    .map_err(|error| format!("Home background import task failed: {error}"))??;

    let (imported, storage_guard) = imported;
    mark_asset_pending(&imported.asset_id);
    drop(storage_guard);
    Ok(imported)
}

#[tauri::command]
pub async fn pick_and_import_home_background_asset(
    title: String,
    kind: HomeBackgroundAssetKind,
    app: AppHandle,
) -> Result<Option<ImportedHomeBackgroundAsset>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title(title);
    dialog = match kind {
        HomeBackgroundAssetKind::Image => {
            dialog.add_filter("Image files", &["jpg", "jpeg", "png", "webp", "gif"])
        }
        HomeBackgroundAssetKind::Video => dialog.add_filter("Video files", &["mp4", "webm"]),
    };
    let initial_directory = match kind {
        HomeBackgroundAssetKind::Image => app.path().picture_dir(),
        HomeBackgroundAssetKind::Video => app.path().video_dir(),
    };
    if let Ok(directory) = initial_directory
        && directory.is_dir()
    {
        dialog = dialog.set_directory(directory);
    }

    // Keep the Windows Shell picker ownerless and use its callback API. This
    // matches the song-video picker path that avoids blocking Tauri's event loop.
    dialog.pick_file(move |selected| {
        let _ = sender.send(selected);
    });
    let selected = tokio::time::timeout(Duration::from_secs(30 * 60), receiver)
        .await
        .map_err(|_| "The home background picker timed out".to_string())?
        .map_err(|_| "The home background picker closed unexpectedly".to_string())?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let source = selected
        .into_path()
        .map_err(|error| format!("The selected background is not a regular local file: {error}"))?;
    let imported =
        import_home_background_into_directory(source, home_background_dir(&app)?, kind).await?;
    Ok(Some(imported))
}

#[tauri::command]
pub async fn get_home_background_config(app: AppHandle) -> Result<HomeBackgroundConfig, String> {
    let _guard = HOME_BACKGROUND_STORAGE_LOCK.lock().await;
    let directory = home_background_dir(&app)?;
    ensure_storage_directory(&directory)?;
    match read_manifest(&directory)? {
        Some(manifest) => manifest_to_config(&directory, manifest),
        None => Ok(default_config()),
    }
}

#[tauri::command]
pub async fn apply_home_background_asset(
    asset_id: String,
    kind: HomeBackgroundAssetKind,
    mutation_id: u64,
    app: AppHandle,
) -> Result<HomeBackgroundConfig, String> {
    let _guard = HOME_BACKGROUND_STORAGE_LOCK.lock().await;
    let directory = home_background_dir(&app)?;
    ensure_storage_directory(&directory)?;
    let current = read_manifest(&directory).ok().flatten();
    let currently_active = current
        .as_ref()
        .and_then(|manifest| manifest.asset_id.as_deref())
        == Some(asset_id.as_str());
    if !is_asset_pending(&asset_id) && !currently_active {
        return Err("The home background asset was not imported by this application".into());
    }
    let stored_kind = validate_asset_id(&asset_id)?;
    if stored_kind != kind {
        return Err("The selected home background type does not match its asset".into());
    }
    let asset_path = resolve_asset_path(&directory, &asset_id)?;
    let metadata = validate_regular_file(&asset_path, "home background asset")?;
    if metadata.len() == 0 || metadata.len() > kind.size_limit() {
        return Err("The home background asset has an invalid size".into());
    }
    let (mime_type, _) = detect_supported_asset(&asset_path, kind)?;
    claim_home_background_mutation(mutation_id)?;
    let manifest = HomeBackgroundManifest {
        version: HOME_BACKGROUND_MANIFEST_VERSION,
        mode: kind.mode(),
        color: current
            .as_ref()
            .map(|manifest| manifest.color.clone())
            .unwrap_or_else(|| DEFAULT_HOME_BACKGROUND_COLOR.to_owned()),
        asset_id: Some(asset_id.clone()),
        mime_type: Some(mime_type.to_owned()),
        bytes: Some(metadata.len()),
        updated_at: chrono::Utc::now().timestamp_millis(),
    };
    write_manifest(&directory, &manifest)?;
    unmark_asset_pending(&asset_id);
    if let Some(previous_id) = current.and_then(|manifest| manifest.asset_id)
        && previous_id != asset_id
        && let Err(error) = remove_file_if_exists(&resolve_asset_path(&directory, &previous_id)?)
    {
        warn!("[HomeBackground] Failed to remove replaced asset: {error}");
    }
    manifest_to_config(&directory, manifest)
}

#[tauri::command]
pub async fn discard_home_background_asset(asset_id: String, app: AppHandle) -> Result<(), String> {
    let _guard = HOME_BACKGROUND_STORAGE_LOCK.lock().await;
    let directory = home_background_dir(&app)?;
    ensure_storage_directory(&directory)?;
    if !is_asset_pending(&asset_id) {
        return Err("Only pending home background assets can be discarded".into());
    }
    remove_file_if_exists(&resolve_asset_path(&directory, &asset_id)?)?;
    unmark_asset_pending(&asset_id);
    Ok(())
}

#[tauri::command]
pub async fn set_home_background_color(
    color: String,
    mutation_id: u64,
    app: AppHandle,
) -> Result<HomeBackgroundConfig, String> {
    let color = normalize_color(&color)?;
    let _guard = HOME_BACKGROUND_STORAGE_LOCK.lock().await;
    let directory = home_background_dir(&app)?;
    ensure_storage_directory(&directory)?;
    let previous = read_manifest(&directory).ok().flatten();
    claim_home_background_mutation(mutation_id)?;
    let manifest = HomeBackgroundManifest {
        version: HOME_BACKGROUND_MANIFEST_VERSION,
        mode: HomeBackgroundMode::Color,
        color,
        asset_id: None,
        mime_type: None,
        bytes: None,
        updated_at: chrono::Utc::now().timestamp_millis(),
    };
    write_manifest(&directory, &manifest)?;
    if let Some(previous_id) = previous.and_then(|manifest| manifest.asset_id)
        && let Err(error) = remove_file_if_exists(&resolve_asset_path(&directory, &previous_id)?)
    {
        warn!("[HomeBackground] Failed to remove replaced asset: {error}");
    }
    manifest_to_config(&directory, manifest)
}

#[tauri::command]
pub async fn reset_home_background(
    mutation_id: u64,
    app: AppHandle,
) -> Result<HomeBackgroundConfig, String> {
    let _guard = HOME_BACKGROUND_STORAGE_LOCK.lock().await;
    let directory = home_background_dir(&app)?;
    ensure_storage_directory(&directory)?;
    let previous = read_manifest(&directory).ok().flatten();
    claim_home_background_mutation(mutation_id)?;
    remove_file_if_exists(&directory.join(HOME_BACKGROUND_MANIFEST))?;
    if let Some(previous_id) = previous.and_then(|manifest| manifest.asset_id)
        && let Err(error) = remove_file_if_exists(&resolve_asset_path(&directory, &previous_id)?)
    {
        warn!("[HomeBackground] Failed to remove reset asset: {error}");
    }
    Ok(default_config())
}

pub async fn run_home_background_gc(app: &AppHandle) -> Result<HomeBackgroundGcResult, String> {
    let _guard = HOME_BACKGROUND_STORAGE_LOCK.lock().await;
    let directory = home_background_dir(app)?;
    ensure_storage_directory(&directory)?;
    let active = read_manifest(&directory)?
        .and_then(|manifest| manifest.asset_id)
        .into_iter()
        .collect::<HashSet<_>>();
    let pending = pending_assets_snapshot();
    let mut result = HomeBackgroundGcResult {
        total_scanned: 0,
        deleted: 0,
        errors: Vec::new(),
    };
    let entries = std::fs::read_dir(&directory)
        .map_err(|error| format!("Failed to scan home background directory: {error}"))?;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                result.errors.push(error.to_string());
                continue;
            }
        };
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if file_name == HOME_BACKGROUND_MANIFEST {
            continue;
        }
        let recognized_asset = validate_asset_id(&file_name).is_ok();
        let recognized_staging = file_name.starts_with(".home-background-");
        if !recognized_asset && !recognized_staging {
            continue;
        }
        result.total_scanned += 1;
        if active.contains(&file_name) || pending.contains(&file_name) {
            continue;
        }
        let metadata = match std::fs::symlink_metadata(entry.path()) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => metadata,
            Ok(_) => {
                result.errors.push(format!(
                    "Skipped non-regular home background entry: {}",
                    entry.path().display()
                ));
                continue;
            }
            Err(error) => {
                result.errors.push(error.to_string());
                continue;
            }
        };
        let old_enough = metadata
            .modified()
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age >= ORPHAN_GRACE_PERIOD);
        if !old_enough {
            continue;
        }
        match std::fs::remove_file(entry.path()) {
            Ok(()) => result.deleted += 1,
            Err(error) => result.errors.push(error.to_string()),
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn cleanup_orphaned_home_backgrounds(
    app: AppHandle,
) -> Result<HomeBackgroundGcResult, String> {
    run_home_background_gc(&app).await
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
    const MP4_MAGIC: &[u8] = b"\0\0\0\x18ftypisom\0\0\0\0isomiso2";

    #[test]
    fn validates_colors_asset_ids_and_detected_kinds() {
        assert_eq!(normalize_color(" #A1b2C3 ").unwrap(), "#a1b2c3");
        assert!(normalize_color("red").is_err());
        assert_eq!(
            validate_asset_id("abcdef0123456789abcdef0123456789-1.png").unwrap(),
            HomeBackgroundAssetKind::Image
        );
        assert_eq!(
            validate_asset_id("abcdef0123456789abcdef0123456789-2.mp4").unwrap(),
            HomeBackgroundAssetKind::Video
        );
        assert!(validate_asset_id("../asset.png").is_err());
        assert!(validate_asset_id("asset.svg").is_err());

        let mut png = Cursor::new(PNG_MAGIC);
        assert_eq!(
            detect_supported_asset_from_reader(&mut png, HomeBackgroundAssetKind::Image).unwrap(),
            ("image/png", "png")
        );
        let mut mp4 = Cursor::new(MP4_MAGIC);
        assert_eq!(
            detect_supported_asset_from_reader(&mut mp4, HomeBackgroundAssetKind::Video).unwrap(),
            ("video/mp4", "mp4")
        );
    }

    #[tokio::test]
    async fn imports_assets_atomically_and_round_trips_manifest() {
        let temp = tempfile::tempdir().expect("temporary directory should exist");
        let source = temp.path().join("source.png");
        std::fs::write(&source, PNG_MAGIC).expect("fixture should write");
        let storage = temp.path().join("storage");
        let imported = import_home_background_into_directory(
            source,
            storage.clone(),
            HomeBackgroundAssetKind::Image,
        )
        .await
        .expect("image should import");
        assert!(storage.join(&imported.asset_id).is_file());
        assert!(is_asset_pending(&imported.asset_id));

        let manifest = HomeBackgroundManifest {
            version: HOME_BACKGROUND_MANIFEST_VERSION,
            mode: HomeBackgroundMode::Image,
            color: DEFAULT_HOME_BACKGROUND_COLOR.to_owned(),
            asset_id: Some(imported.asset_id.clone()),
            mime_type: Some(imported.mime_type.clone()),
            bytes: Some(imported.bytes),
            updated_at: 1,
        };
        write_manifest(&storage, &manifest).expect("manifest should write");
        let restored = manifest_to_config(
            &storage,
            read_manifest(&storage)
                .expect("manifest should read")
                .expect("manifest should exist"),
        )
        .expect("manifest should resolve");
        assert_eq!(restored.mode, HomeBackgroundMode::Image);
        assert_eq!(
            restored.asset_id.as_deref(),
            Some(imported.asset_id.as_str())
        );
        unmark_asset_pending(&imported.asset_id);
    }
}
