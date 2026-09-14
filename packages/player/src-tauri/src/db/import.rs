use std::{
    collections::{HashMap, HashSet},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex, Weak},
};

use rayon::prelude::*;
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, EntityTrait, IntoActiveModel, QueryFilter, QueryOrder,
    QuerySelect, Set, TransactionTrait,
    sea_query::{Expr, OnConflict},
};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::db::{
    DbConnection, cleanup,
    entity::{playlist, playlist_song_sources, playlist_songs, song},
    scanner, utils,
};

const DATABASE_QUERY_CHUNK_SIZE: usize = 400;
const DATABASE_INSERT_CHUNK_SIZE: usize = 40;
const METADATA_PARSE_BATCH_SIZE: usize = 32;

type ImportMutex = tokio::sync::Mutex<()>;

static PLAYLIST_IMPORT_LOCKS: LazyLock<Mutex<HashMap<i32, Weak<ImportMutex>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static CREATE_PLAYLIST_IMPORT_LOCK: ImportMutex = ImportMutex::const_new(());

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPathIssue {
    pub path: String,
    pub stage: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportMusicResult {
    pub playlist_id: Option<i32>,
    pub playlist_name: Option<String>,
    pub total_candidates: u32,
    pub parsed: u32,
    pub reused: u32,
    pub added: u32,
    pub already_present: u32,
    pub added_song_ids: Vec<String>,
    pub skipped: Vec<ImportPathIssue>,
    pub failed: Vec<ImportPathIssue>,
    pub warnings: Vec<ImportPathIssue>,
}

#[derive(Clone, Debug)]
struct MediaCandidate {
    path: PathBuf,
    storage_path: String,
    identity_key: String,
    expected_song_id: String,
}

impl MediaCandidate {
    fn new(path: PathBuf) -> Self {
        let storage_path = normalize_storage_path(&path);
        let identity_key = path_identity_key(&storage_path);
        let expected_song_id = format!("{:x}", md5::compute(storage_path.as_bytes()));
        Self {
            path,
            storage_path,
            identity_key,
            expected_song_id,
        }
    }
}

#[derive(Default)]
struct CandidateCollection {
    candidates: Vec<MediaCandidate>,
    skipped: Vec<ImportPathIssue>,
    failed: Vec<ImportPathIssue>,
}

struct PreparedSong {
    path: String,
    song_id: String,
    new_model: Option<song::Model>,
}

struct PreparedBatch {
    songs: Vec<PreparedSong>,
    parsed: u32,
    reused: u32,
    failed: Vec<ImportPathIssue>,
    warnings: Vec<ImportPathIssue>,
    created_cover_paths: Vec<PathBuf>,
}

#[derive(Debug)]
struct PersistOutcome {
    playlist_id: i32,
    playlist_name: String,
    added_song_ids: Vec<String>,
    already_present: u32,
    playlist_created: bool,
    inserted_song_count: usize,
    inserted_source_count: usize,
}

fn normalize_storage_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn path_identity_key(storage_path: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        // SQLite's built-in LOWER/NOCASE behavior is ASCII-based as well.
        // Keeping both sides identical avoids a Rust/SQLite folding mismatch.
        storage_path.to_ascii_lowercase()
    }
    #[cfg(not(target_os = "windows"))]
    {
        storage_path.to_owned()
    }
}

fn playlist_import_lock(playlist_id: i32) -> Arc<ImportMutex> {
    let mut locks = PLAYLIST_IMPORT_LOCKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(&playlist_id).and_then(Weak::upgrade) {
        return lock;
    }

    let lock = Arc::new(ImportMutex::new(()));
    locks.insert(playlist_id, Arc::downgrade(&lock));
    lock
}

fn path_issue(path: &Path, stage: &str, message: impl Into<String>) -> ImportPathIssue {
    ImportPathIssue {
        path: normalize_storage_path(path),
        stage: stage.to_owned(),
        message: message.into(),
    }
}

fn collect_directory(directory: &Path, result: &mut CandidateCollection) {
    for entry_result in jwalk::WalkDir::new(directory).follow_links(false) {
        match entry_result {
            Ok(entry) => {
                if entry.depth == 0 {
                    continue;
                }
                let path = entry.path();
                if entry.path_is_symlink() {
                    result
                        .skipped
                        .push(path_issue(&path, "classify", "已跳过符号链接或目录联接"));
                    continue;
                }
                if entry.file_type().is_file() && scanner::is_supported_audio_path(&path) {
                    result.candidates.push(MediaCandidate::new(path));
                }
            }
            Err(error) => {
                let path = error.path().unwrap_or(directory);
                result.failed.push(path_issue(
                    path,
                    "traverse",
                    format!("无法遍历目录: {error}"),
                ));
            }
        }
    }
}

fn classify_input_path(path: PathBuf, result: &mut CandidateCollection) {
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) => {
            result.failed.push(path_issue(
                &path,
                "classify",
                format!("无法读取路径: {error}"),
            ));
            return;
        }
    };

    if metadata.file_type().is_symlink() {
        result
            .skipped
            .push(path_issue(&path, "classify", "已跳过符号链接或目录联接"));
    } else if metadata.is_dir() {
        collect_directory(&path, result);
    } else if metadata.is_file() {
        if scanner::is_supported_audio_path(&path) {
            result.candidates.push(MediaCandidate::new(path));
        } else {
            result
                .skipped
                .push(path_issue(&path, "filter", "不是受支持的音频文件"));
        }
    } else {
        result
            .skipped
            .push(path_issue(&path, "classify", "不是普通文件或目录"));
    }
}

fn finish_collection(mut result: CandidateCollection) -> CandidateCollection {
    result.candidates.sort_by(|left, right| {
        left.identity_key
            .cmp(&right.identity_key)
            .then_with(|| left.storage_path.cmp(&right.storage_path))
    });
    result
        .candidates
        .dedup_by(|left, right| left.identity_key == right.identity_key);
    result
}

fn collect_candidates(paths: Vec<String>) -> CandidateCollection {
    let mut result = CandidateCollection::default();
    for path in paths {
        classify_input_path(PathBuf::from(path), &mut result);
    }
    finish_collection(result)
}

fn collect_single_directory(directory_path: String) -> CandidateCollection {
    let directory = PathBuf::from(directory_path);
    let mut result = CandidateCollection::default();
    let metadata = match std::fs::symlink_metadata(&directory) {
        Ok(metadata) => metadata,
        Err(error) => {
            result.failed.push(path_issue(
                &directory,
                "classify",
                format!("无法读取文件夹: {error}"),
            ));
            return result;
        }
    };

    if metadata.file_type().is_symlink() {
        result.skipped.push(path_issue(
            &directory,
            "classify",
            "不能从符号链接或目录联接创建歌单",
        ));
    } else if !metadata.is_dir() {
        result.failed.push(path_issue(
            &directory,
            "classify",
            "创建歌单时必须拖入一个文件夹",
        ));
    } else {
        collect_directory(&directory, &mut result);
    }

    finish_collection(result)
}

async fn find_existing_songs(
    db: &impl ConnectionTrait,
    candidates: &[MediaCandidate],
) -> Result<(HashMap<String, String>, HashMap<String, String>), String> {
    let mut by_id = HashMap::new();
    let mut by_path = HashMap::new();

    for chunk in candidates.chunks(DATABASE_QUERY_CHUNK_SIZE) {
        let ids = chunk
            .iter()
            .map(|candidate| candidate.expected_song_id.clone())
            .collect::<Vec<_>>();
        let rows: Vec<(String, String)> = song::Entity::find()
            .select_only()
            .column(song::Column::Id)
            .column(song::Column::FilePath)
            .filter(song::Column::Id.is_in(ids))
            .order_by_asc(song::Column::Id)
            .into_tuple()
            .all(db)
            .await
            .map_err(|error| format!("Failed to query existing songs by id: {error}"))?;
        for (id, file_path) in rows {
            by_path
                .entry(path_identity_key(&normalize_storage_path(Path::new(
                    &file_path,
                ))))
                .or_insert_with(|| id.clone());
            by_id.insert(id.clone(), id);
        }
    }

    for chunk in candidates.chunks(DATABASE_QUERY_CHUNK_SIZE) {
        #[cfg(target_os = "windows")]
        let path_filter = {
            let placeholders = std::iter::repeat_n("?", chunk.len())
                .collect::<Vec<_>>()
                .join(", ");
            let identity_keys = chunk
                .iter()
                .map(|candidate| candidate.identity_key.clone())
                .collect::<Vec<_>>();
            Condition::all().add(Expr::cust_with_values(
                format!("LOWER(REPLACE(\"file_path\", CHAR(92), '/')) IN ({placeholders})"),
                identity_keys,
            ))
        };
        #[cfg(not(target_os = "windows"))]
        let path_filter = {
            let paths = chunk
                .iter()
                .map(|candidate| candidate.storage_path.clone())
                .collect::<Vec<_>>();
            Condition::all().add(song::Column::FilePath.is_in(paths))
        };

        let rows: Vec<(String, String)> = song::Entity::find()
            .select_only()
            .column(song::Column::Id)
            .column(song::Column::FilePath)
            .filter(path_filter)
            .order_by_asc(song::Column::Id)
            .into_tuple()
            .all(db)
            .await
            .map_err(|error| format!("Failed to query existing songs by path: {error}"))?;
        for (id, file_path) in rows {
            by_path
                .entry(path_identity_key(&normalize_storage_path(Path::new(
                    &file_path,
                ))))
                .or_insert_with(|| id.clone());
            by_id.insert(id.clone(), id);
        }
    }

    Ok((by_id, by_path))
}

fn save_import_cover(
    covers_dir: &Path,
    song_id: &str,
    cover_bytes: Option<&[u8]>,
) -> Result<(Option<String>, Option<PathBuf>), String> {
    let Some(bytes) = cover_bytes.filter(|bytes| !bytes.is_empty()) else {
        return Ok((None, None));
    };

    std::fs::create_dir_all(covers_dir).map_err(|error| format!("无法创建封面目录: {error}"))?;
    let cover_path = covers_dir.join(format!("{song_id}.jpg"));
    let cover_path_string = cover_path.to_string_lossy().to_string();
    if cover_path.exists() {
        return Ok((Some(cover_path_string), None));
    }

    let mut file = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&cover_path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Ok((Some(cover_path_string), None));
        }
        Err(error) => return Err(format!("无法创建歌曲封面: {error}")),
    };
    if let Err(error) = file.write_all(bytes) {
        drop(file);
        let _ = std::fs::remove_file(&cover_path);
        return Err(format!("无法保存歌曲封面: {error}"));
    }
    Ok((Some(cover_path_string), Some(cover_path)))
}

fn cleanup_created_covers(paths: &[PathBuf]) -> Vec<String> {
    paths
        .iter()
        .filter_map(|path| {
            std::fs::remove_file(path).err().and_then(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    None
                } else {
                    Some(format!("{}: {error}", path.display()))
                }
            })
        })
        .collect()
}

fn cleanup_import_error(error: String, prepared: &PreparedBatch) -> String {
    let cleanup_errors = cleanup_created_covers(&prepared.created_cover_paths);
    if cleanup_errors.is_empty() {
        error
    } else {
        format!(
            "{error}; additionally failed to clean imported covers: {}",
            cleanup_errors.join(", ")
        )
    }
}

async fn prepare_candidates(
    db: &DbConnection,
    covers_dir: &Path,
    candidates: Vec<MediaCandidate>,
) -> Result<PreparedBatch, String> {
    let (existing_by_id, existing_by_path) = find_existing_songs(db, &candidates).await?;
    let mut reused = Vec::new();
    let mut to_parse = Vec::new();

    for candidate in candidates {
        let existing = existing_by_id
            .get(&candidate.expected_song_id)
            .or_else(|| existing_by_path.get(&candidate.identity_key));
        if let Some(existing_id) = existing {
            reused.push(PreparedSong {
                path: candidate.storage_path,
                song_id: existing_id.clone(),
                new_model: None,
            });
        } else {
            to_parse.push(candidate);
        }
    }

    let mut songs = reused;
    let reused_count = songs.len() as u32;
    let mut parsed_count = 0u32;
    let mut failed = Vec::new();
    let mut warnings = Vec::new();
    let mut created_cover_paths = Vec::new();

    for batch in to_parse.chunks(METADATA_PARSE_BATCH_SIZE) {
        let batch = batch.to_vec();
        let parsed_results = match tokio::task::spawn_blocking(move || {
            batch
                .into_par_iter()
                .map(|candidate| {
                    let parsed = scanner::process_file_single(&candidate.path);
                    (candidate, parsed)
                })
                .collect::<Vec<_>>()
        })
        .await
        {
            Ok(results) => results,
            Err(error) => {
                let cleanup_errors = cleanup_created_covers(&created_cover_paths);
                let cleanup_suffix = if cleanup_errors.is_empty() {
                    String::new()
                } else {
                    format!("; cover cleanup failed: {}", cleanup_errors.join(", "))
                };
                return Err(format!("Music import task failed: {error}{cleanup_suffix}"));
            }
        };

        for (candidate, parsed) in parsed_results {
            match parsed {
                Ok(scanned) => {
                    let mut model = scanned.model;
                    match save_import_cover(covers_dir, &model.id, scanned.cover_bytes.as_deref()) {
                        Ok((cover_path, created_path)) => {
                            model.cover_path = cover_path;
                            if let Some(created_path) = created_path {
                                created_cover_paths.push(created_path);
                            }
                        }
                        Err(message) => warnings.push(ImportPathIssue {
                            path: candidate.storage_path.clone(),
                            stage: "cover".to_owned(),
                            message,
                        }),
                    }
                    parsed_count += 1;
                    songs.push(PreparedSong {
                        path: candidate.storage_path,
                        song_id: model.id.clone(),
                        new_model: Some(model),
                    });
                }
                Err(message) => failed.push(ImportPathIssue {
                    path: candidate.storage_path,
                    stage: "metadata".to_owned(),
                    message,
                }),
            }
        }
    }

    songs.sort_by(|left, right| {
        path_identity_key(&left.path)
            .cmp(&path_identity_key(&right.path))
            .then_with(|| left.path.cmp(&right.path))
    });
    let mut seen_song_ids = HashSet::new();
    songs.retain(|prepared| seen_song_ids.insert(prepared.song_id.clone()));

    Ok(PreparedBatch {
        songs,
        parsed: parsed_count,
        reused: reused_count,
        failed,
        warnings,
        created_cover_paths,
    })
}

async fn insert_new_song_models(
    db: &impl ConnectionTrait,
    models: Vec<song::Model>,
) -> Result<(), String> {
    for chunk in models.chunks(DATABASE_INSERT_CHUNK_SIZE) {
        let active_models = chunk
            .iter()
            .cloned()
            .map(IntoActiveModel::into_active_model)
            .collect::<Vec<_>>();
        song::Entity::insert_many(active_models)
            .on_conflict_do_nothing()
            .exec(db)
            .await
            .map_err(|error| format!("Failed to insert imported songs: {error}"))?;
    }
    Ok(())
}

async fn insert_playlist_song_models(
    db: &impl ConnectionTrait,
    models: Vec<playlist_songs::ActiveModel>,
) -> Result<(), String> {
    for chunk in models.chunks(DATABASE_INSERT_CHUNK_SIZE) {
        playlist_songs::Entity::insert_many(chunk.iter().cloned())
            .on_conflict(OnConflict::new().do_nothing().to_owned())
            .exec(db)
            .await
            .map_err(|error| format!("Failed to add imported songs to playlist: {error}"))?;
    }
    Ok(())
}

async fn insert_source_models(
    db: &impl ConnectionTrait,
    models: Vec<playlist_song_sources::ActiveModel>,
) -> Result<(), String> {
    for chunk in models.chunks(DATABASE_INSERT_CHUNK_SIZE) {
        playlist_song_sources::Entity::insert_many(chunk.iter().cloned())
            .on_conflict(OnConflict::new().do_nothing().to_owned())
            .exec(db)
            .await
            .map_err(|error| format!("Failed to record imported song sources: {error}"))?;
    }
    Ok(())
}

async fn persist_prepared_batch(
    db: &DbConnection,
    playlist_id: Option<i32>,
    playlist_name: Option<String>,
    prepared: &PreparedBatch,
) -> Result<PersistOutcome, String> {
    let transaction = db
        .begin()
        .await
        .map_err(|error| format!("Failed to begin music import transaction: {error}"))?;

    let operation = async {
        let now = chrono::Utc::now().timestamp_millis();
        let (playlist_model, playlist_created) = match playlist_id {
            Some(playlist_id) => (
                playlist::Entity::find_by_id(playlist_id)
                    .one(&transaction)
                    .await
                    .map_err(|error| format!("Failed to find playlist: {error}"))?
                    .ok_or_else(|| format!("Playlist {playlist_id} not found"))?,
                false,
            ),
            None => {
                let name = playlist_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .unwrap_or("unknown playlist")
                    .to_owned();
                let model = playlist::Entity::insert(playlist::ActiveModel {
                    name: Set(name),
                    create_time: Set(now),
                    update_time: Set(now),
                    play_time: Set(0),
                    ..Default::default()
                })
                .exec_with_returning(&transaction)
                .await
                .map_err(|error| format!("Failed to create playlist: {error}"))?;
                (model, true)
            }
        };
        let playlist_id = playlist_model.id;

        let new_song_models = prepared
            .songs
            .iter()
            .filter_map(|prepared| prepared.new_model.clone())
            .collect::<Vec<_>>();
        let inserted_song_count = new_song_models.len();
        insert_new_song_models(&transaction, new_song_models).await?;

        let existing_relations = playlist_songs::Entity::find()
            .filter(playlist_songs::Column::PlaylistId.eq(playlist_id))
            .all(&transaction)
            .await
            .map_err(|error| format!("Failed to query playlist songs: {error}"))?;
        let mut relation_song_ids = existing_relations
            .iter()
            .map(|relation| relation.song_id.clone())
            .collect::<HashSet<_>>();
        let mut next_added_at = existing_relations
            .iter()
            .map(|relation| relation.added_at)
            .max()
            .map(|value| value.saturating_add(1))
            .unwrap_or(now)
            .max(now);

        let mut added_song_ids = Vec::new();
        let mut new_relations = Vec::new();
        for prepared_song in &prepared.songs {
            if relation_song_ids.insert(prepared_song.song_id.clone()) {
                added_song_ids.push(prepared_song.song_id.clone());
                new_relations.push(playlist_songs::ActiveModel {
                    playlist_id: Set(playlist_id),
                    song_id: Set(prepared_song.song_id.clone()),
                    added_at: Set(next_added_at),
                    ..Default::default()
                });
                next_added_at = next_added_at.saturating_add(1);
            }
        }
        insert_playlist_song_models(&transaction, new_relations).await?;

        let existing_sources = playlist_song_sources::Entity::find()
            .filter(playlist_song_sources::Column::PlaylistId.eq(playlist_id))
            .all(&transaction)
            .await
            .map_err(|error| format!("Failed to query playlist song sources: {error}"))?;
        let any_source_song_ids = existing_sources
            .iter()
            .map(|source| source.song_id.clone())
            .collect::<HashSet<_>>();
        let mut manual_source_song_ids = existing_sources
            .iter()
            .filter(|source| source.source_type == "manual" && source.source_id.is_none())
            .map(|source| source.song_id.clone())
            .collect::<HashSet<_>>();

        let mut source_ids_to_insert = existing_relations
            .iter()
            .filter(|relation| !any_source_song_ids.contains(&relation.song_id))
            .map(|relation| relation.song_id.clone())
            .collect::<Vec<_>>();
        source_ids_to_insert.extend(
            prepared
                .songs
                .iter()
                .map(|prepared| prepared.song_id.clone()),
        );

        let source_models = source_ids_to_insert
            .into_iter()
            .filter(|song_id| manual_source_song_ids.insert(song_id.clone()))
            .map(|song_id| playlist_song_sources::ActiveModel {
                playlist_id: Set(playlist_id),
                song_id: Set(song_id),
                source_type: Set("manual".to_owned()),
                source_id: Set(None),
                ..Default::default()
            })
            .collect::<Vec<_>>();
        let inserted_source_count = source_models.len();
        insert_source_models(&transaction, source_models).await?;

        if playlist_created || !added_song_ids.is_empty() || inserted_source_count > 0 {
            playlist::Entity::update_many()
                .col_expr(playlist::Column::UpdateTime, Expr::value(now))
                .filter(playlist::Column::Id.eq(playlist_id))
                .exec(&transaction)
                .await
                .map_err(|error| format!("Failed to update imported playlist: {error}"))?;
        }

        Ok::<_, String>(PersistOutcome {
            playlist_id,
            playlist_name: playlist_model.name,
            already_present: prepared.songs.len() as u32 - added_song_ids.len() as u32,
            added_song_ids,
            playlist_created,
            inserted_song_count,
            inserted_source_count,
        })
    }
    .await;

    let outcome = match operation {
        Ok(outcome) => {
            transaction
                .commit()
                .await
                .map_err(|error| format!("Failed to commit music import: {error}"))?;
            outcome
        }
        Err(error) => {
            let _ = transaction.rollback().await;
            return Err(error);
        }
    };

    if outcome.inserted_song_count > 0 {
        crate::db_events::emit_event(
            "songs",
            "batch_insert",
            serde_json::json!({ "playlistId": outcome.playlist_id }),
        );
    }
    if !outcome.added_song_ids.is_empty() {
        crate::db_events::emit_event(
            "playlist_songs",
            "insert",
            serde_json::json!({ "playlistId": outcome.playlist_id }),
        );
    }
    if outcome.inserted_source_count > 0 {
        crate::db_events::emit_event(
            "playlist_song_sources",
            "insert",
            serde_json::json!({ "playlistId": outcome.playlist_id }),
        );
    }
    if outcome.playlist_created
        || !outcome.added_song_ids.is_empty()
        || outcome.inserted_source_count > 0
    {
        crate::db_events::emit_event(
            "playlists",
            if outcome.playlist_created {
                "insert"
            } else {
                "update"
            },
            serde_json::json!(outcome.playlist_id),
        );
    }

    Ok(outcome)
}

fn empty_result(
    collection: CandidateCollection,
    prepared: PreparedBatch,
    playlist_id: Option<i32>,
    playlist_name: Option<String>,
) -> ImportMusicResult {
    ImportMusicResult {
        playlist_id,
        playlist_name,
        total_candidates: 0,
        parsed: prepared.parsed,
        reused: prepared.reused,
        added: 0,
        already_present: 0,
        added_song_ids: Vec::new(),
        skipped: collection.skipped,
        failed: collection
            .failed
            .into_iter()
            .chain(prepared.failed)
            .collect(),
        warnings: prepared.warnings,
    }
}

pub async fn import_paths_to_playlist_with_covers_dir(
    db: &DbConnection,
    covers_dir: &Path,
    playlist_id: i32,
    paths: Vec<String>,
) -> Result<ImportMusicResult, String> {
    if playlist::Entity::find_by_id(playlist_id)
        .one(db)
        .await
        .map_err(|error| format!("Failed to find playlist: {error}"))?
        .is_none()
    {
        return Err(format!("Playlist {playlist_id} not found"));
    }

    let mut collection = tokio::task::spawn_blocking(move || collect_candidates(paths))
        .await
        .map_err(|error| format!("Music path collection task failed: {error}"))?;
    let total_candidates = collection.candidates.len() as u32;
    let import_lock = playlist_import_lock(playlist_id);
    let _import_guard = import_lock.lock_owned().await;
    let _cover_storage_guard = cleanup::COVER_STORAGE_LOCK.lock().await;
    let candidates = std::mem::take(&mut collection.candidates);
    let prepared = prepare_candidates(db, covers_dir, candidates).await?;

    if prepared.songs.is_empty() {
        let mut result = empty_result(collection, prepared, Some(playlist_id), None);
        result.total_candidates = total_candidates;
        return Ok(result);
    }

    let outcome = match persist_prepared_batch(db, Some(playlist_id), None, &prepared).await {
        Ok(outcome) => outcome,
        Err(error) => return Err(cleanup_import_error(error, &prepared)),
    };
    Ok(ImportMusicResult {
        playlist_id: Some(outcome.playlist_id),
        playlist_name: Some(outcome.playlist_name),
        total_candidates,
        parsed: prepared.parsed,
        reused: prepared.reused,
        added: outcome.added_song_ids.len() as u32,
        already_present: outcome.already_present,
        added_song_ids: outcome.added_song_ids,
        skipped: collection.skipped,
        failed: collection
            .failed
            .into_iter()
            .chain(prepared.failed)
            .collect(),
        warnings: prepared.warnings,
    })
}

pub async fn create_playlist_from_folder_with_covers_dir(
    db: &DbConnection,
    covers_dir: &Path,
    folder_path: String,
    playlist_name: Option<String>,
) -> Result<ImportMusicResult, String> {
    let default_name = Path::new(&folder_path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "unknown playlist".to_owned());
    let requested_name = playlist_name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(default_name);

    let mut collection = tokio::task::spawn_blocking(move || collect_single_directory(folder_path))
        .await
        .map_err(|error| format!("Music folder collection task failed: {error}"))?;
    let total_candidates = collection.candidates.len() as u32;
    let _import_guard = CREATE_PLAYLIST_IMPORT_LOCK.lock().await;
    let _cover_storage_guard = cleanup::COVER_STORAGE_LOCK.lock().await;
    let candidates = std::mem::take(&mut collection.candidates);
    let prepared = prepare_candidates(db, covers_dir, candidates).await?;

    if prepared.songs.is_empty() {
        let mut result = empty_result(collection, prepared, None, Some(requested_name));
        result.total_candidates = total_candidates;
        return Ok(result);
    }

    let outcome = match persist_prepared_batch(db, None, Some(requested_name), &prepared).await {
        Ok(outcome) => outcome,
        Err(error) => return Err(cleanup_import_error(error, &prepared)),
    };
    Ok(ImportMusicResult {
        playlist_id: Some(outcome.playlist_id),
        playlist_name: Some(outcome.playlist_name),
        total_candidates,
        parsed: prepared.parsed,
        reused: prepared.reused,
        added: outcome.added_song_ids.len() as u32,
        already_present: outcome.already_present,
        added_song_ids: outcome.added_song_ids,
        skipped: collection.skipped,
        failed: collection
            .failed
            .into_iter()
            .chain(prepared.failed)
            .collect(),
        warnings: prepared.warnings,
    })
}

#[tauri::command]
pub async fn import_music_paths_to_playlist(
    db: State<'_, DbConnection>,
    app: AppHandle,
    playlist_id: i32,
    paths: Vec<String>,
) -> Result<ImportMusicResult, String> {
    let covers_dir = utils::get_covers_dir(&app)?;
    import_paths_to_playlist_with_covers_dir(&db, &covers_dir, playlist_id, paths).await
}

#[tauri::command]
pub async fn create_playlist_from_music_folder(
    db: State<'_, DbConnection>,
    app: AppHandle,
    folder_path: String,
    playlist_name: Option<String>,
) -> Result<ImportMusicResult, String> {
    let covers_dir = utils::get_covers_dir(&app)?;
    create_playlist_from_folder_with_covers_dir(&db, &covers_dir, folder_path, playlist_name).await
}

#[cfg(test)]
mod tests {
    use sea_orm::{ActiveModelTrait, Database, PaginatorTrait};

    use super::*;
    use crate::db::{entity::playlist_folder, migration};

    fn write_test_wav(path: &Path) {
        let sample_rate = 8_000u32;
        let sample_count = 800u32;
        let data_size = sample_count * 2;
        let mut bytes = Vec::with_capacity((44 + data_size) as usize);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_size).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&sample_rate.to_le_bytes());
        bytes.extend_from_slice(&(sample_rate * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_size.to_le_bytes());
        for index in 0..sample_count {
            let phase = index as f32 / sample_rate as f32;
            let sample = (phase * 440.0 * std::f32::consts::TAU).sin();
            bytes.extend_from_slice(&((sample * 4_000.0) as i16).to_le_bytes());
        }
        std::fs::write(path, bytes).expect("test WAV should be written");
    }

    async fn test_database() -> DbConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("test database should open");
        migration::run_migrations(&db)
            .await
            .expect("test migrations should run");
        db
    }

    async fn file_databases(database_path: &Path) -> (DbConnection, DbConnection) {
        let database_url = format!(
            "sqlite://{}?mode=rwc",
            normalize_storage_path(database_path)
        );
        let first = Database::connect(&database_url)
            .await
            .expect("first file-backed database connection should open");
        migration::run_migrations(&first)
            .await
            .expect("test migrations should run");
        let second = Database::connect(&database_url)
            .await
            .expect("second file-backed database connection should open");
        (first, second)
    }

    async fn insert_playlist(db: &DbConnection, name: &str) -> i32 {
        let now = chrono::Utc::now().timestamp_millis();
        playlist::ActiveModel {
            name: Set(name.to_owned()),
            create_time: Set(now),
            update_time: Set(now),
            play_time: Set(0),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("playlist fixture should insert")
        .id
    }

    #[test]
    fn candidate_collection_is_recursive_stable_and_deduplicated() {
        let temp_dir = tempfile::tempdir().expect("temporary directory should exist");
        let nested = temp_dir.path().join("nested");
        std::fs::create_dir_all(&nested).expect("nested directory should exist");
        let first = temp_dir.path().join("A.WAV");
        let second = nested.join("b.wav");
        write_test_wav(&first);
        write_test_wav(&second);
        std::fs::write(temp_dir.path().join("cover.jpg"), b"not audio")
            .expect("unsupported fixture should be written");

        let result = collect_candidates(vec![
            temp_dir.path().to_string_lossy().to_string(),
            first.to_string_lossy().to_string(),
        ]);

        assert_eq!(result.candidates.len(), 2);
        assert_eq!(
            result
                .candidates
                .iter()
                .map(|candidate| {
                    candidate
                        .path
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .to_string()
                })
                .collect::<Vec<_>>(),
            vec!["A.WAV", "b.wav"],
        );
        assert!(result.failed.is_empty());
    }

    #[tokio::test]
    async fn importing_reuses_metadata_and_repairs_legacy_manual_sources() {
        let db = test_database().await;
        let temp_dir = tempfile::tempdir().expect("temporary directory should exist");
        let covers_dir = temp_dir.path().join("covers");
        let existing_path = temp_dir.path().join("existing.wav");
        let new_path = temp_dir.path().join("new.wav");
        write_test_wav(&existing_path);
        write_test_wav(&new_path);
        let playlist_id = insert_playlist(&db, "Test").await;

        let existing_storage_path = normalize_storage_path(&existing_path);
        let existing_id = format!("{:x}", md5::compute(existing_storage_path.as_bytes()));
        song::ActiveModel {
            id: Set(existing_id.clone()),
            file_path: Set(existing_storage_path),
            song_name: Set("用户修改的标题".to_owned()),
            song_artists: Set("用户修改的作者".to_owned()),
            song_album: Set("用户修改的专辑".to_owned()),
            duration: Set(1.0),
            lyric_format: Set("lrc".to_owned()),
            lyric: Set("用户修改的歌词".to_owned()),
            translated_lrc: Set(None),
            roman_lrc: Set(None),
            cover_path: Set(Some("custom-cover.jpg".to_owned())),
            modified_at: Set(None),
        }
        .insert(&db)
        .await
        .expect("existing song fixture should insert");
        playlist_songs::ActiveModel {
            playlist_id: Set(playlist_id),
            song_id: Set(existing_id.clone()),
            added_at: Set(1),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("legacy playlist relation should insert");
        let unrelated_id = "legacy-unrelated".to_owned();
        song::ActiveModel {
            id: Set(unrelated_id.clone()),
            file_path: Set(normalize_storage_path(
                &temp_dir.path().join("legacy-unrelated.wav"),
            )),
            song_name: Set("未参与本次导入的旧歌曲".to_owned()),
            song_artists: Set(String::new()),
            song_album: Set(String::new()),
            duration: Set(1.0),
            lyric_format: Set(String::new()),
            lyric: Set(String::new()),
            translated_lrc: Set(None),
            roman_lrc: Set(None),
            cover_path: Set(None),
            modified_at: Set(None),
        }
        .insert(&db)
        .await
        .expect("unrelated legacy song fixture should insert");
        playlist_songs::ActiveModel {
            playlist_id: Set(playlist_id),
            song_id: Set(unrelated_id),
            added_at: Set(2),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("unrelated legacy relation should insert");

        let result = import_paths_to_playlist_with_covers_dir(
            &db,
            &covers_dir,
            playlist_id,
            vec![
                existing_path.to_string_lossy().to_string(),
                new_path.to_string_lossy().to_string(),
            ],
        )
        .await
        .expect("music import should succeed");

        assert_eq!(result.reused, 1);
        assert_eq!(result.parsed, 1);
        assert_eq!(result.added, 1);
        assert_eq!(result.already_present, 1);
        let existing = song::Entity::find_by_id(&existing_id)
            .one(&db)
            .await
            .expect("existing song query should succeed")
            .expect("existing song should remain");
        assert_eq!(existing.song_name, "用户修改的标题");
        assert_eq!(existing.lyric, "用户修改的歌词");
        assert_eq!(existing.cover_path.as_deref(), Some("custom-cover.jpg"));

        let sources = playlist_song_sources::Entity::find()
            .filter(playlist_song_sources::Column::PlaylistId.eq(playlist_id))
            .all(&db)
            .await
            .expect("source query should succeed");
        assert_eq!(sources.len(), 3);
        assert!(
            sources
                .iter()
                .all(|source| { source.source_type == "manual" && source.source_id.is_none() })
        );

        let repeated = import_paths_to_playlist_with_covers_dir(
            &db,
            &covers_dir,
            playlist_id,
            vec![
                existing_path.to_string_lossy().to_string(),
                new_path.to_string_lossy().to_string(),
            ],
        )
        .await
        .expect("repeated music import should remain idempotent");
        assert_eq!(repeated.added, 0);
        assert_eq!(repeated.already_present, 2);
        assert_eq!(
            playlist_songs::Entity::find()
                .filter(playlist_songs::Column::PlaylistId.eq(playlist_id))
                .count(&db)
                .await
                .expect("playlist relation count should succeed"),
            3,
        );
        assert_eq!(
            playlist_song_sources::Entity::find()
                .filter(playlist_song_sources::Column::PlaylistId.eq(playlist_id))
                .count(&db)
                .await
                .expect("playlist source count should succeed"),
            3,
        );
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn importing_reuses_legacy_windows_path_case_and_separator_variants() {
        let db = test_database().await;
        let temp_dir = tempfile::tempdir().expect("temporary directory should exist");
        let covers_dir = temp_dir.path().join("covers");
        let audio_path = temp_dir.path().join("MixedCase.wav");
        write_test_wav(&audio_path);
        let playlist_id = insert_playlist(&db, "Case").await;

        let legacy_path = normalize_storage_path(&audio_path)
            .to_ascii_uppercase()
            .replace('/', "\\");
        let legacy_id = format!("{:x}", md5::compute(legacy_path.as_bytes()));
        song::ActiveModel {
            id: Set(legacy_id.clone()),
            file_path: Set(legacy_path),
            song_name: Set("保留的旧标题".to_owned()),
            song_artists: Set(String::new()),
            song_album: Set(String::new()),
            duration: Set(1.0),
            lyric_format: Set(String::new()),
            lyric: Set(String::new()),
            translated_lrc: Set(None),
            roman_lrc: Set(None),
            cover_path: Set(None),
            modified_at: Set(None),
        }
        .insert(&db)
        .await
        .expect("legacy song fixture should insert");

        let result = import_paths_to_playlist_with_covers_dir(
            &db,
            &covers_dir,
            playlist_id,
            vec![audio_path.to_string_lossy().to_string()],
        )
        .await
        .expect("case-variant import should succeed");

        assert_eq!(result.reused, 1);
        assert_eq!(result.parsed, 0);
        assert_eq!(result.added_song_ids, vec![legacy_id.clone()]);
        assert_eq!(
            song::Entity::find()
                .count(&db)
                .await
                .expect("song count should succeed"),
            1,
        );
        assert_eq!(
            song::Entity::find_by_id(legacy_id)
                .one(&db)
                .await
                .expect("legacy song query should succeed")
                .expect("legacy song should remain")
                .song_name,
            "保留的旧标题",
        );
    }

    #[tokio::test]
    async fn folder_creation_is_a_manual_snapshot_without_folder_link() {
        let db = test_database().await;
        let temp_dir = tempfile::tempdir().expect("temporary directory should exist");
        let music_dir = temp_dir.path().join("Snapshot");
        let nested = music_dir.join("Disc 1");
        std::fs::create_dir_all(&nested).expect("music directory should exist");
        write_test_wav(&nested.join("b.wav"));
        write_test_wav(&music_dir.join("A.WAV"));

        let result = create_playlist_from_folder_with_covers_dir(
            &db,
            &temp_dir.path().join("covers"),
            music_dir.to_string_lossy().to_string(),
            None,
        )
        .await
        .expect("folder import should succeed");

        let playlist_id = result.playlist_id.expect("playlist should be created");
        assert_eq!(result.playlist_name.as_deref(), Some("Snapshot"));
        assert_eq!(result.added, 2);
        assert_eq!(
            playlist_folder::Entity::find()
                .filter(playlist_folder::Column::PlaylistId.eq(playlist_id))
                .count(&db)
                .await
                .expect("folder link count should succeed"),
            0,
        );
        let sources = playlist_song_sources::Entity::find()
            .filter(playlist_song_sources::Column::PlaylistId.eq(playlist_id))
            .all(&db)
            .await
            .expect("source query should succeed");
        assert_eq!(sources.len(), 2);
        assert!(
            sources
                .iter()
                .all(|source| source.source_type == "manual" && source.source_id.is_none())
        );
        let ordered_relations = playlist_songs::Entity::find()
            .filter(playlist_songs::Column::PlaylistId.eq(playlist_id))
            .order_by_asc(playlist_songs::Column::AddedAt)
            .all(&db)
            .await
            .expect("playlist relation query should succeed");
        assert_eq!(
            ordered_relations
                .iter()
                .map(|relation| relation.song_id.clone())
                .collect::<Vec<_>>(),
            result.added_song_ids,
        );
    }

    #[tokio::test]
    async fn empty_or_broken_folder_does_not_create_a_playlist() {
        let db = test_database().await;
        let temp_dir = tempfile::tempdir().expect("temporary directory should exist");
        let music_dir = temp_dir.path().join("Empty");
        std::fs::create_dir_all(&music_dir).expect("empty directory should exist");
        std::fs::write(music_dir.join("broken.wav"), b"not a wave")
            .expect("broken audio fixture should be written");

        let result = create_playlist_from_folder_with_covers_dir(
            &db,
            &temp_dir.path().join("covers"),
            music_dir.to_string_lossy().to_string(),
            None,
        )
        .await
        .expect("broken folder import should return a structured result");

        assert_eq!(result.playlist_id, None);
        assert_eq!(result.total_candidates, 1);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].stage, "metadata");
        assert_eq!(
            playlist::Entity::find()
                .count(&db)
                .await
                .expect("playlist count should succeed"),
            0,
        );
    }

    #[tokio::test]
    async fn concurrent_same_file_import_is_idempotent_across_database_connections() {
        let temp_dir = tempfile::tempdir().expect("temporary directory should exist");
        let (first_db, second_db) = file_databases(&temp_dir.path().join("library.db")).await;
        let playlist_id = insert_playlist(&first_db, "Concurrent same").await;
        let audio_path = temp_dir.path().join("same.wav");
        write_test_wav(&audio_path);
        let covers_dir = temp_dir.path().join("covers");
        let paths = vec![audio_path.to_string_lossy().to_string()];

        let (first_result, second_result) = tokio::join!(
            import_paths_to_playlist_with_covers_dir(
                &first_db,
                &covers_dir,
                playlist_id,
                paths.clone(),
            ),
            import_paths_to_playlist_with_covers_dir(&second_db, &covers_dir, playlist_id, paths,),
        );
        let first_result = first_result.expect("first concurrent import should succeed");
        let second_result = second_result.expect("second concurrent import should succeed");

        assert_eq!(first_result.added + second_result.added, 1);
        assert_eq!(first_result.parsed + second_result.parsed, 1);
        assert_eq!(
            playlist_songs::Entity::find()
                .filter(playlist_songs::Column::PlaylistId.eq(playlist_id))
                .count(&first_db)
                .await
                .expect("playlist relation count should succeed"),
            1,
        );
        assert_eq!(
            playlist_song_sources::Entity::find()
                .filter(playlist_song_sources::Column::PlaylistId.eq(playlist_id))
                .count(&first_db)
                .await
                .expect("source count should succeed"),
            1,
        );
    }

    #[tokio::test]
    async fn concurrent_different_file_imports_have_unique_order_and_sources() {
        let temp_dir = tempfile::tempdir().expect("temporary directory should exist");
        let (first_db, second_db) = file_databases(&temp_dir.path().join("library.db")).await;
        let playlist_id = insert_playlist(&first_db, "Concurrent different").await;
        let first_path = temp_dir.path().join("first.wav");
        let second_path = temp_dir.path().join("second.wav");
        write_test_wav(&first_path);
        write_test_wav(&second_path);
        let covers_dir = temp_dir.path().join("covers");

        let (first_result, second_result) = tokio::join!(
            import_paths_to_playlist_with_covers_dir(
                &first_db,
                &covers_dir,
                playlist_id,
                vec![first_path.to_string_lossy().to_string()],
            ),
            import_paths_to_playlist_with_covers_dir(
                &second_db,
                &covers_dir,
                playlist_id,
                vec![second_path.to_string_lossy().to_string()],
            ),
        );
        assert_eq!(
            first_result
                .expect("first concurrent import should succeed")
                .added,
            1,
        );
        assert_eq!(
            second_result
                .expect("second concurrent import should succeed")
                .added,
            1,
        );

        let relations = playlist_songs::Entity::find()
            .filter(playlist_songs::Column::PlaylistId.eq(playlist_id))
            .order_by_asc(playlist_songs::Column::AddedAt)
            .all(&first_db)
            .await
            .expect("ordered playlist relations should load");
        assert_eq!(relations.len(), 2);
        assert_ne!(relations[0].added_at, relations[1].added_at);
        assert_ne!(relations[0].song_id, relations[1].song_id);
        assert_eq!(
            playlist_song_sources::Entity::find()
                .filter(playlist_song_sources::Column::PlaylistId.eq(playlist_id))
                .count(&first_db)
                .await
                .expect("source count should succeed"),
            2,
        );
    }

    #[tokio::test]
    async fn conflict_helpers_ignore_pair_and_manual_null_duplicates() {
        let db = test_database().await;
        let playlist_id = insert_playlist(&db, "Conflict").await;
        let song_id = "conflict-song".to_owned();
        song::ActiveModel {
            id: Set(song_id.clone()),
            file_path: Set("conflict.wav".to_owned()),
            song_name: Set("Conflict".to_owned()),
            song_artists: Set(String::new()),
            song_album: Set(String::new()),
            duration: Set(1.0),
            lyric_format: Set(String::new()),
            lyric: Set(String::new()),
            translated_lrc: Set(None),
            roman_lrc: Set(None),
            cover_path: Set(None),
            modified_at: Set(None),
        }
        .insert(&db)
        .await
        .expect("song fixture should insert");

        insert_playlist_song_models(
            &db,
            vec![
                playlist_songs::ActiveModel {
                    playlist_id: Set(playlist_id),
                    song_id: Set(song_id.clone()),
                    added_at: Set(1),
                    ..Default::default()
                },
                playlist_songs::ActiveModel {
                    playlist_id: Set(playlist_id),
                    song_id: Set(song_id.clone()),
                    added_at: Set(2),
                    ..Default::default()
                },
            ],
        )
        .await
        .expect("duplicate playlist relation insert should be idempotent");
        insert_source_models(
            &db,
            vec![
                playlist_song_sources::ActiveModel {
                    playlist_id: Set(playlist_id),
                    song_id: Set(song_id.clone()),
                    source_type: Set("manual".to_owned()),
                    source_id: Set(None),
                    ..Default::default()
                },
                playlist_song_sources::ActiveModel {
                    playlist_id: Set(playlist_id),
                    song_id: Set(song_id),
                    source_type: Set("manual".to_owned()),
                    source_id: Set(None),
                    ..Default::default()
                },
            ],
        )
        .await
        .expect("duplicate manual source insert should be idempotent");

        assert_eq!(
            playlist_songs::Entity::find()
                .filter(playlist_songs::Column::PlaylistId.eq(playlist_id))
                .count(&db)
                .await
                .expect("playlist relation count should succeed"),
            1,
        );
        assert_eq!(
            playlist_song_sources::Entity::find()
                .filter(playlist_song_sources::Column::PlaylistId.eq(playlist_id))
                .count(&db)
                .await
                .expect("source count should succeed"),
            1,
        );
    }

    #[tokio::test]
    async fn failed_transaction_rolls_back_rows_and_removes_new_cover() {
        let db = test_database().await;
        let playlist_id = insert_playlist(&db, "Rollback").await;
        let playlist_before = playlist::Entity::find_by_id(playlist_id)
            .one(&db)
            .await
            .expect("playlist query should succeed")
            .expect("playlist should exist");
        let temp_dir = tempfile::tempdir().expect("temporary directory should exist");
        let (cover_path, created_cover_path) =
            save_import_cover(temp_dir.path(), "rollback-song", Some(b"cover"))
                .expect("cover fixture should be staged");
        let created_cover_path = created_cover_path.expect("cover should be newly created");
        let prepared = PreparedBatch {
            songs: vec![PreparedSong {
                path: "rollback.wav".to_owned(),
                song_id: "rollback-song".to_owned(),
                new_model: Some(song::Model {
                    id: "rollback-song".to_owned(),
                    file_path: "rollback.wav".to_owned(),
                    song_name: "Rollback".to_owned(),
                    song_artists: String::new(),
                    song_album: String::new(),
                    duration: 1.0,
                    lyric_format: String::new(),
                    lyric: String::new(),
                    translated_lrc: None,
                    roman_lrc: None,
                    cover_path,
                    modified_at: None,
                }),
            }],
            parsed: 1,
            reused: 0,
            failed: Vec::new(),
            warnings: Vec::new(),
            created_cover_paths: vec![created_cover_path.clone()],
        };
        db.execute_unprepared(
            "CREATE TRIGGER fail_import_relation
             BEFORE INSERT ON playlist_songs
             BEGIN
                 SELECT RAISE(ABORT, 'forced import failure');
             END;",
        )
        .await
        .expect("failure trigger should install");

        let error = persist_prepared_batch(&db, Some(playlist_id), None, &prepared)
            .await
            .expect_err("forced relation failure should abort the import");
        let _ = cleanup_import_error(error, &prepared);

        assert!(!created_cover_path.exists());
        assert!(
            song::Entity::find_by_id("rollback-song")
                .one(&db)
                .await
                .expect("song query should succeed")
                .is_none(),
        );
        assert_eq!(
            playlist_songs::Entity::find()
                .filter(playlist_songs::Column::PlaylistId.eq(playlist_id))
                .count(&db)
                .await
                .expect("playlist relation count should succeed"),
            0,
        );
        assert_eq!(
            playlist::Entity::find_by_id(playlist_id)
                .one(&db)
                .await
                .expect("playlist query should succeed")
                .expect("playlist should remain")
                .update_time,
            playlist_before.update_time,
        );
    }
}
