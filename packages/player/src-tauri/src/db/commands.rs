use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::{Emitter, State};
use tracing::warn;

use crate::db::entity::{playlist, playlist_folder, playlist_song_sources, playlist_songs, song};
use crate::db::{DbConnection, utils};
use crate::db_events;

pub use crate::db::refresh::*;

// ============ Playlist Commands ============

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistWithSongs {
    #[serde(flatten)]
    pub playlist: playlist::Model,
    pub song_ids: Vec<String>,
}

#[tauri::command]
pub async fn get_all_playlists(
    db: State<'_, DbConnection>,
) -> Result<Vec<PlaylistWithSongs>, String> {
    let playlists = playlist::Entity::find()
        .order_by_asc(playlist::Column::Id)
        .all(&*db)
        .await
        .map_err(|e| format!("Failed to get playlists: {e}"))?;

    let playlist_ids: Vec<i32> = playlists.iter().map(|p| p.id).collect();

    let all_playlist_songs = if playlist_ids.is_empty() {
        Vec::new()
    } else {
        playlist_songs::Entity::find()
            .filter(playlist_songs::Column::PlaylistId.is_in(playlist_ids))
            .order_by_asc(playlist_songs::Column::AddedAt)
            .all(&*db)
            .await
            .map_err(|e| format!("Failed to get playlist songs: {e}"))?
    };

    let mut ps_map: HashMap<i32, Vec<String>> = HashMap::new();
    for ps in all_playlist_songs {
        ps_map.entry(ps.playlist_id).or_default().push(ps.song_id);
    }

    let result = playlists
        .into_iter()
        .map(|p| {
            let song_ids = ps_map.remove(&p.id).unwrap_or_default();
            PlaylistWithSongs {
                playlist: p,
                song_ids,
            }
        })
        .collect();

    Ok(result)
}

#[tauri::command]
pub async fn get_playlist(
    db: State<'_, DbConnection>,
    id: i32,
) -> Result<Option<PlaylistWithSongs>, String> {
    let p = playlist::Entity::find_by_id(id)
        .one(&*db)
        .await
        .map_err(|e| format!("Failed to get playlist: {e}"))?;

    match p {
        Some(p) => {
            let song_ids = playlist_songs::Entity::find()
                .filter(playlist_songs::Column::PlaylistId.eq(p.id))
                .order_by_asc(playlist_songs::Column::AddedAt)
                .all(&*db)
                .await
                .map_err(|e| format!("Failed to get playlist songs: {e}"))?
                .into_iter()
                .map(|ps| ps.song_id)
                .collect();
            Ok(Some(PlaylistWithSongs {
                playlist: p,
                song_ids,
            }))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn create_playlist(db: State<'_, DbConnection>, name: String) -> Result<i32, String> {
    let now = chrono::Utc::now().timestamp_millis();
    let model = playlist::ActiveModel {
        name: Set(name),
        create_time: Set(now),
        update_time: Set(now),
        play_time: Set(0),
        ..Default::default()
    };

    let result = model
        .insert(&*db)
        .await
        .map_err(|e| format!("Failed to create playlist: {e}"))?;

    Ok(result.id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePlaylistPayload {
    pub name: Option<String>,
    pub play_time: Option<i64>,
}

#[tauri::command]
pub async fn update_playlist(
    db: State<'_, DbConnection>,
    id: i32,
    changes: UpdatePlaylistPayload,
) -> Result<(), String> {
    let model = playlist::Entity::find_by_id(id)
        .one(&*db)
        .await
        .map_err(|e| format!("Failed to find playlist: {e}"))?
        .ok_or_else(|| format!("Playlist {id} not found"))?;

    let mut active: playlist::ActiveModel = model.into();

    if let Some(name) = changes.name {
        active.name = Set(name);
    }
    if let Some(play_time) = changes.play_time {
        active.play_time = Set(play_time);
    }
    active.update_time = Set(chrono::Utc::now().timestamp_millis());

    active
        .update(&*db)
        .await
        .map_err(|e| format!("Failed to update playlist: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn delete_playlist(db: State<'_, DbConnection>, id: i32) -> Result<(), String> {
    let song_ids: Vec<String> = playlist_songs::Entity::find()
        .filter(playlist_songs::Column::PlaylistId.eq(id))
        .all(&*db)
        .await
        .map_err(|e| format!("Failed to query playlist songs: {e}"))?
        .into_iter()
        .map(|ps| ps.song_id)
        .collect();

    playlist_songs::Entity::delete_many()
        .filter(playlist_songs::Column::PlaylistId.eq(id))
        .exec(&*db)
        .await
        .map_err(|e| format!("Failed to delete playlist songs: {e}"))?;

    if let Some(p) = playlist::Entity::find_by_id(id)
        .one(&*db)
        .await
        .map_err(|e| format!("Failed to delete playlist: {e}"))?
    {
        if let Some(ref cover_path) = p.cover_path
            && !cover_path.is_empty()
        {
            let _ = std::fs::remove_file(cover_path);
        }
        let active: playlist::ActiveModel = p.into();
        active.delete(&*db).await.map_err(|e| format!("{e}"))?;
    }

    if !song_ids.is_empty() {
        match utils::cleanup_orphaned_songs(&*db, &song_ids).await {
            Ok(deleted) if !deleted.is_empty() => {
                tracing::info!(
                    "[delete_playlist] Cleaned up {} orphaned songs: {:?}",
                    deleted.len(),
                    deleted
                );
            }
            Err(e) => warn!("[delete_playlist] Failed to cleanup orphaned songs: {e}"),
            _ => {}
        }
    }

    Ok(())
}

// ============ Playlist-Song Commands ============

#[tauri::command]
pub async fn add_songs_to_playlist(
    db: State<'_, DbConnection>,
    playlist_id: i32,
    song_ids: Vec<String>,
) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    let all_song_ids = song_ids.clone();

    db.transaction::<_, _, String>(|txn| {
        let song_ids = song_ids.clone();
        let all_song_ids = all_song_ids.clone();
        Box::pin(async move {
            let mut seen: HashSet<String> = playlist_songs::Entity::find()
                .filter(playlist_songs::Column::PlaylistId.eq(playlist_id))
                .all(txn)
                .await
                .map_err(|e| format!("Failed to query existing songs: {e}"))?
                .into_iter()
                .map(|ps| ps.song_id)
                .collect();

            let mut i = 0i64;
            let new_entries: Vec<playlist_songs::ActiveModel> = song_ids
                .into_iter()
                .filter(|id| seen.insert(id.clone()))
                .map(|song_id| {
                    let at = now + i;
                    i += 1;
                    playlist_songs::ActiveModel {
                        playlist_id: Set(playlist_id),
                        song_id: Set(song_id),
                        added_at: Set(at),
                        ..Default::default()
                    }
                })
                .collect();

            if !new_entries.is_empty() {
                playlist_songs::Entity::insert_many(new_entries)
                    .exec(txn)
                    .await
                    .map_err(|e| format!("Failed to add songs to playlist: {e}"))?;
            }

            utils::link_song_sources(txn, playlist_id, &all_song_ids, "manual", None).await?;

            if let Some(p) = playlist::Entity::find_by_id(playlist_id)
                .one(txn)
                .await
                .map_err(|e| format!("Failed to find playlist: {e}"))?
            {
                let mut active: playlist::ActiveModel = p.into();
                active.update_time = Set(now);
                active
                    .update(txn)
                    .await
                    .map_err(|e| format!("Failed to update playlist: {e}"))?;
            }

            Ok(())
        })
    })
    .await
    .map_err(|e| match e {
        sea_orm::TransactionError::Connection(e) => format!("Transaction connection error: {e}"),
        sea_orm::TransactionError::Transaction(e) => e,
    })?;

    db_events::emit_event(
        "playlist_songs",
        "insert",
        serde_json::json!({ "playlistId": playlist_id }),
    );

    Ok(())
}

#[tauri::command]
pub async fn remove_song_from_playlist(
    db: State<'_, DbConnection>,
    playlist_id: i32,
    song_id: String,
) -> Result<(), String> {
    db.transaction::<_, _, String>(|txn| {
        let song_id = song_id.clone();
        Box::pin(async move {
            playlist_songs::Entity::delete_many()
                .filter(playlist_songs::Column::PlaylistId.eq(playlist_id))
                .filter(playlist_songs::Column::SongId.eq(&song_id))
                .exec(txn)
                .await
                .map_err(|e| format!("Failed to remove song from playlist: {e}"))?;

            playlist_song_sources::Entity::delete_many()
                .filter(playlist_song_sources::Column::PlaylistId.eq(playlist_id))
                .filter(playlist_song_sources::Column::SongId.eq(&song_id))
                .exec(txn)
                .await
                .map_err(|e| format!("Failed to remove song sources: {e}"))?;

            match utils::cleanup_orphaned_songs(txn, &[song_id]).await {
                Ok(deleted) if !deleted.is_empty() => {
                    tracing::info!(
                        "[remove_song_from_playlist] Cleaned up orphaned song: {deleted:?}"
                    );
                }
                Err(e) => {
                    warn!("[remove_song_from_playlist] Failed to cleanup orphaned song: {e}")
                }
                _ => {}
            }

            if let Some(p) = playlist::Entity::find_by_id(playlist_id)
                .one(txn)
                .await
                .map_err(|e| format!("Failed to find playlist: {e}"))?
            {
                let mut active: playlist::ActiveModel = p.into();
                active.update_time = Set(chrono::Utc::now().timestamp_millis());
                active
                    .update(txn)
                    .await
                    .map_err(|e| format!("Failed to update playlist: {e}"))?;
            }

            Ok(())
        })
    })
    .await
    .map_err(|e| match e {
        sea_orm::TransactionError::Connection(e) => format!("Transaction connection error: {e}"),
        sea_orm::TransactionError::Transaction(e) => e,
    })?;

    db_events::emit_event(
        "playlist_songs",
        "delete",
        serde_json::json!({ "playlistId": playlist_id }),
    );

    Ok(())
}

// ============ Song Commands ============

#[tauri::command]
pub async fn upsert_songs(
    db: State<'_, DbConnection>,
    songs: Vec<song::Model>,
) -> Result<(), String> {
    for s in songs {
        let song_id = s.id.clone();
        utils::upsert_song(&*db, &s)
            .await
            .map_err(|e| format!("Failed to upsert song: {e}"))?;
        db_events::emit_event("songs", "upsert", serde_json::json!(song_id));
    }

    Ok(())
}

#[tauri::command]
pub async fn get_song(
    db: State<'_, DbConnection>,
    id: String,
) -> Result<Option<song::Model>, String> {
    song::Entity::find_by_id(id)
        .one(&*db)
        .await
        .map_err(|e| format!("Failed to get song: {e}"))
}

#[tauri::command]
pub async fn get_songs_by_ids(
    db: State<'_, DbConnection>,
    ids: Vec<String>,
) -> Result<Vec<song::Model>, String> {
    song::Entity::find()
        .filter(song::Column::Id.is_in(ids))
        .all(&*db)
        .await
        .map_err(|e| format!("Failed to get songs: {e}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSongPayload {
    pub song_name: Option<String>,
    pub song_artists: Option<String>,
    pub song_album: Option<String>,
    pub lyric_format: Option<String>,
    pub lyric: Option<String>,
    pub translated_lrc: Option<Option<String>>,
    pub roman_lrc: Option<Option<String>>,
    pub cover_path: Option<Option<String>>,
}

#[tauri::command]
pub async fn update_song(
    db: State<'_, DbConnection>,
    id: String,
    changes: UpdateSongPayload,
) -> Result<(), String> {
    let model = song::Entity::find_by_id(&id)
        .one(&*db)
        .await
        .map_err(|e| format!("Failed to find song: {e}"))?
        .ok_or_else(|| format!("Song {id} not found"))?;

    let mut active: song::ActiveModel = model.into();

    if let Some(v) = changes.song_name {
        active.song_name = Set(v);
    }
    if let Some(v) = changes.song_artists {
        active.song_artists = Set(v);
    }
    if let Some(v) = changes.song_album {
        active.song_album = Set(v);
    }
    if let Some(v) = changes.lyric_format {
        active.lyric_format = Set(v);
    }
    if let Some(v) = changes.lyric {
        active.lyric = Set(v);
    }
    if let Some(v) = changes.translated_lrc {
        active.translated_lrc = Set(v);
    }
    if let Some(v) = changes.roman_lrc {
        active.roman_lrc = Set(v);
    }
    if let Some(v) = changes.cover_path {
        active.cover_path = Set(v);
    }

    active
        .update(&*db)
        .await
        .map_err(|e| format!("Failed to update song: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn get_playlist_songs(
    db: State<'_, DbConnection>,
    playlist_id: i32,
) -> Result<Vec<song::Model>, String> {
    let playlist_song_ids: Vec<String> = playlist_songs::Entity::find()
        .filter(playlist_songs::Column::PlaylistId.eq(playlist_id))
        .order_by_asc(playlist_songs::Column::AddedAt)
        .all(&*db)
        .await
        .map_err(|e| format!("Failed to get playlist song ids: {e}"))?
        .into_iter()
        .map(|ps| ps.song_id)
        .collect();

    if playlist_song_ids.is_empty() {
        return Ok(Vec::new());
    }

    let songs = song::Entity::find()
        .filter(song::Column::Id.is_in(&playlist_song_ids))
        .all(&*db)
        .await
        .map_err(|e| format!("Failed to get playlist songs: {e}"))?;

    let song_map: std::collections::HashMap<String, song::Model> =
        songs.into_iter().map(|s| (s.id.clone(), s)).collect();

    let ordered_songs: Vec<song::Model> = playlist_song_ids
        .into_iter()
        .filter_map(|id| song_map.get(&id).cloned())
        .collect();

    Ok(ordered_songs)
}

// ============ Playlist Cover Commands ============

#[tauri::command]
pub async fn save_playlist_cover(
    db: State<'_, DbConnection>,
    app: tauri::AppHandle,
    playlist_id: i32,
    source_path: String,
) -> Result<String, String> {
    use tauri::Manager;
    use tauri::path::BaseDirectory;

    let covers_dir = app
        .path()
        .resolve("covers", BaseDirectory::AppData)
        .map_err(|e| format!("Failed to resolve covers dir: {e}"))?;
    std::fs::create_dir_all(&covers_dir)
        .map_err(|e| format!("Failed to create covers dir: {e}"))?;

    let source = std::path::Path::new(&source_path);
    let ext = crate::utils::cover_ext_for_path(source);
    let dest_filename = format!("playlist_{playlist_id}.{ext}");
    let dest_path = covers_dir.join(&dest_filename);

    std::fs::copy(&source_path, &dest_path)
        .map_err(|e| format!("Failed to copy cover file: {e}"))?;

    let dest_str = dest_path.to_string_lossy().to_string();

    let model = playlist::Entity::find_by_id(playlist_id)
        .one(&*db)
        .await
        .map_err(|e| format!("Failed to find playlist: {e}"))?
        .ok_or_else(|| format!("Playlist {playlist_id} not found"))?;

    let mut active: playlist::ActiveModel = model.into();
    active.cover_path = Set(Some(dest_str.clone()));
    active.update_time = Set(chrono::Utc::now().timestamp_millis());
    active
        .update(&*db)
        .await
        .map_err(|e| format!("Failed to update playlist cover: {e}"))?;

    Ok(dest_str)
}

#[tauri::command]
pub async fn clear_playlist_cover(
    db: State<'_, DbConnection>,
    playlist_id: i32,
) -> Result<(), String> {
    let model = playlist::Entity::find_by_id(playlist_id)
        .one(&*db)
        .await
        .map_err(|e| format!("Failed to find playlist: {e}"))?
        .ok_or_else(|| format!("Playlist {playlist_id} not found"))?;

    let mut active: playlist::ActiveModel = model.into();
    active.cover_path = Set(None);
    active.update_time = Set(chrono::Utc::now().timestamp_millis());
    active
        .update(&*db)
        .await
        .map_err(|e| format!("Failed to clear playlist cover: {e}"))?;

    Ok(())
}

// ============ Scan Folder Commands ============

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanFolderResult {
    pub playlist_id: i32,
    pub total_scanned: u32,
    pub imported: u32,
    pub failed: u32,
    pub failed_paths: Vec<String>,
}

#[tauri::command]
pub async fn scan_and_create_playlist(
    db: State<'_, DbConnection>,
    app: tauri::AppHandle,
    folder_path: String,
    playlist_name: Option<String>,
) -> Result<ScanFolderResult, String> {
    use std::sync::{Arc, atomic::AtomicBool};

    let folder = std::path::PathBuf::from(&folder_path);
    if !folder.is_dir() {
        return Err(format!("The path is not a valid folder: {folder_path}"));
    }

    let name = playlist_name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| {
            folder
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "unknown playlist".to_string())
        });

    let cancel_token = Arc::new(AtomicBool::new(false));
    let scan_folder = folder.clone();
    let app_handle = app.clone();
    let scan_results = tokio::task::spawn_blocking(move || {
        super::scanner::scan_folder(&scan_folder, &cancel_token, &move |count| {
            let _ = app_handle.emit("scan-folder-progress", count);
        })
    })
    .await
    .map_err(|e| format!("Scan task failed: {e}"))?;

    let total_scanned = scan_results.len() as u32;

    let now = chrono::Utc::now().timestamp_millis();
    let playlist_model = playlist::ActiveModel {
        name: Set(name),
        create_time: Set(now),
        update_time: Set(now),
        play_time: Set(0),
        ..Default::default()
    };
    let playlist_result = playlist_model
        .insert(&*db)
        .await
        .map_err(|e| format!("Failed to create playlist: {e}"))?;
    let playlist_id = playlist_result.id;

    let folder_model = super::entity::playlist_folder::ActiveModel {
        playlist_id: Set(playlist_id),
        folder_path: Set(folder_path.clone()),
        ..Default::default()
    };
    let folder_result = folder_model
        .insert(&*db)
        .await
        .map_err(|e| format!("Failed to record playlist folder: {e}"))?;
    let folder_id = folder_result.id;

    let covers_dir = utils::get_covers_dir(&app)?;
    let _ = std::fs::create_dir_all(&covers_dir);

    let mut imported = 0u32;
    let mut failed = 0u32;
    let mut failed_paths = Vec::new();
    let mut playlist_song_entries = Vec::new();

    for result in scan_results {
        let scanned = match result {
            Ok(s) => s,
            Err(path_err) => {
                failed += 1;
                failed_paths.push(path_err);
                continue;
            }
        };

        let song_id = scanned.model.id.clone();
        let mut model = scanned.model;
        model.cover_path = utils::save_cover(&covers_dir, &song_id, scanned.cover_bytes.as_deref());

        match utils::upsert_song(&*db, &model).await {
            Ok(()) => {
                imported += 1;
                playlist_song_entries.push(song_id);
            }
            Err(e) => {
                failed += 1;
                failed_paths.push(format!("Database write failed: {e}"));
            }
        }
    }

    utils::link_songs_to_playlist(&*db, playlist_id, &playlist_song_entries).await?;
    if !playlist_song_entries.is_empty() {
        utils::link_song_sources(
            &*db,
            playlist_id,
            &playlist_song_entries,
            "folder",
            Some(folder_id),
        )
        .await?;
        db_events::emit_event(
            "playlist_songs",
            "insert",
            serde_json::json!({ "playlistId": playlist_id }),
        );
    }

    Ok(ScanFolderResult {
        playlist_id,
        total_scanned,
        imported,
        failed,
        failed_paths,
    })
}

// ============ Playlist Folders ============

#[tauri::command]
pub async fn get_playlist_folders(
    db: State<'_, DbConnection>,
    playlist_id: i32,
) -> Result<Vec<String>, String> {
    let folders = playlist_folder::Entity::find()
        .filter(playlist_folder::Column::PlaylistId.eq(playlist_id))
        .all(&*db)
        .await
        .map_err(|e| format!("Failed to get playlist folders: {e}"))?
        .into_iter()
        .map(|f| f.folder_path)
        .collect();
    Ok(folders)
}

#[tauri::command]
pub async fn link_playlist_folder(
    db: State<'_, DbConnection>,
    app: tauri::AppHandle,
    playlist_id: i32,
    folder_path: String,
) -> Result<ScanFolderResult, String> {
    use std::sync::{Arc, atomic::AtomicBool};

    let folder = std::path::PathBuf::from(&folder_path);
    if !folder.is_dir() {
        return Err(format!("The path is not a valid folder: {folder_path}"));
    }

    let existing = playlist_folder::Entity::find()
        .filter(playlist_folder::Column::PlaylistId.eq(playlist_id))
        .filter(playlist_folder::Column::FolderPath.eq(&folder_path))
        .one(&*db)
        .await
        .map_err(|e| format!("Failed to check existing folder: {e}"))?;

    if existing.is_some() {
        return Err("This folder is already linked to the playlist".to_string());
    }

    let cancel_token = Arc::new(AtomicBool::new(false));
    let scan_folder = folder.clone();
    let app_handle = app.clone();
    let scan_results = tokio::task::spawn_blocking(move || {
        super::scanner::scan_folder(&scan_folder, &cancel_token, &move |count| {
            let _ = app_handle.emit("scan-folder-progress", count);
        })
    })
    .await
    .map_err(|e| format!("Scan task failed: {e}"))?;

    let total_scanned = scan_results.len() as u32;
    let covers_dir = utils::get_covers_dir(&app)?;
    let _ = std::fs::create_dir_all(&covers_dir);

    let mut imported = 0u32;
    let mut failed = 0u32;
    let mut failed_paths = Vec::new();

    let mut prepared_songs: Vec<(String, song::Model)> = Vec::new();
    for result in scan_results {
        let scanned = match result {
            Ok(s) => s,
            Err(path_err) => {
                failed += 1;
                failed_paths.push(path_err);
                continue;
            }
        };

        let song_id = scanned.model.id.clone();
        let mut model = scanned.model;
        model.cover_path = utils::save_cover(&covers_dir, &song_id, scanned.cover_bytes.as_deref());
        imported += 1;
        prepared_songs.push((song_id, model));
    }

    let result = db
        .transaction::<_, _, String>(|txn| {
            let prepared_songs = prepared_songs.clone();
            let folder_path = folder_path.clone();
            Box::pin(async move {
                let folder_model = playlist_folder::ActiveModel {
                    playlist_id: Set(playlist_id),
                    folder_path: Set(folder_path),
                    ..Default::default()
                };
                let folder_result = folder_model
                    .insert(txn)
                    .await
                    .map_err(|e| format!("Failed to record playlist folder: {e}"))?;
                let folder_id = folder_result.id;

                let existing_song_ids: HashSet<String> = playlist_songs::Entity::find()
                    .filter(playlist_songs::Column::PlaylistId.eq(playlist_id))
                    .all(txn)
                    .await
                    .map_err(|e| format!("Failed to query existing songs: {e}"))?
                    .into_iter()
                    .map(|ps| ps.song_id)
                    .collect();

                let mut new_song_ids = Vec::new();
                let mut all_scanned_ids = Vec::new();
                let mut txn_failures = Vec::new();

                for (song_id, model) in &prepared_songs {
                    match utils::upsert_song(txn, model).await {
                        Ok(()) => {
                            all_scanned_ids.push(song_id.clone());
                            if !existing_song_ids.contains(song_id) {
                                new_song_ids.push(song_id.clone());
                            }
                        }
                        Err(e) => {
                            txn_failures.push(format!("Database write failed: {e}"));
                        }
                    }
                }

                if !new_song_ids.is_empty() {
                    utils::link_songs_to_playlist(txn, playlist_id, &new_song_ids).await?;
                }

                utils::link_song_sources(
                    txn,
                    playlist_id,
                    &all_scanned_ids,
                    "folder",
                    Some(folder_id),
                )
                .await?;

                utils::touch_playlist(txn, playlist_id).await?;

                Ok((new_song_ids, txn_failures))
            })
        })
        .await
        .map_err(|e| match e {
            sea_orm::TransactionError::Connection(e) => {
                format!("Transaction connection error: {e}")
            }
            sea_orm::TransactionError::Transaction(e) => e,
        })?;

    let (new_song_ids, txn_failures) = result;
    let txn_failure_count = txn_failures.len() as u32;
    imported -= txn_failure_count;
    failed += txn_failure_count;
    failed_paths.extend(txn_failures);

    if !new_song_ids.is_empty() {
        db_events::emit_event(
            "playlist_songs",
            "insert",
            serde_json::json!({ "playlistId": playlist_id }),
        );
    }

    Ok(ScanFolderResult {
        playlist_id,
        total_scanned,
        imported,
        failed,
        failed_paths,
    })
}

#[tauri::command]
pub async fn unlink_playlist_folder(
    db: State<'_, DbConnection>,
    playlist_id: i32,
    folder_path: String,
) -> Result<(), String> {
    let affected_song_ids = db
        .transaction::<_, _, String>(|txn| {
            Box::pin(async move {
                let folder_record = playlist_folder::Entity::find()
                    .filter(playlist_folder::Column::PlaylistId.eq(playlist_id))
                    .filter(playlist_folder::Column::FolderPath.eq(&folder_path))
                    .one(txn)
                    .await
                    .map_err(|e| format!("Failed to find folder: {e}"))?
                    .ok_or_else(|| "Folder not found in this playlist".to_string())?;

                let folder_id = folder_record.id;

                let sources_to_remove: Vec<playlist_song_sources::Model> =
                    playlist_song_sources::Entity::find()
                        .filter(playlist_song_sources::Column::PlaylistId.eq(playlist_id))
                        .filter(playlist_song_sources::Column::SourceType.eq("folder"))
                        .filter(playlist_song_sources::Column::SourceId.eq(folder_id))
                        .all(txn)
                        .await
                        .map_err(|e| format!("Failed to query sources: {e}"))?;

                let affected_song_ids: Vec<String> = sources_to_remove
                    .iter()
                    .map(|s| s.song_id.clone())
                    .collect();

                playlist_song_sources::Entity::delete_many()
                    .filter(playlist_song_sources::Column::PlaylistId.eq(playlist_id))
                    .filter(playlist_song_sources::Column::SourceType.eq("folder"))
                    .filter(playlist_song_sources::Column::SourceId.eq(folder_id))
                    .exec(txn)
                    .await
                    .map_err(|e| format!("Failed to delete folder sources: {e}"))?;

                if !affected_song_ids.is_empty() {
                    let still_has_source: HashSet<String> = playlist_song_sources::Entity::find()
                        .filter(playlist_song_sources::Column::PlaylistId.eq(playlist_id))
                        .filter(playlist_song_sources::Column::SongId.is_in(&affected_song_ids))
                        .all(txn)
                        .await
                        .map_err(|e| format!("Failed to check remaining sources: {e}"))?
                        .into_iter()
                        .map(|s| s.song_id)
                        .collect();

                    for song_id in &affected_song_ids {
                        if still_has_source.contains(song_id) {
                            continue;
                        }

                        playlist_songs::Entity::delete_many()
                            .filter(playlist_songs::Column::PlaylistId.eq(playlist_id))
                            .filter(playlist_songs::Column::SongId.eq(song_id))
                            .exec(txn)
                            .await
                            .map_err(|e| format!("Failed to remove song from playlist: {e}"))?;

                        match utils::cleanup_orphaned_songs(txn, std::slice::from_ref(song_id))
                            .await
                        {
                            Ok(deleted) if !deleted.is_empty() => {
                                tracing::info!(
                                    "[unlink_folder] Cleaned up orphaned song: {deleted:?}"
                                );
                            }
                            Err(e) => {
                                warn!("[unlink_folder] Failed to cleanup orphaned song: {e}")
                            }
                            _ => {}
                        }
                    }
                }

                let active: playlist_folder::ActiveModel = folder_record.into();
                active
                    .delete(txn)
                    .await
                    .map_err(|e| format!("Failed to delete folder: {e}"))?;

                utils::touch_playlist(txn, playlist_id).await?;

                Ok(affected_song_ids)
            })
        })
        .await
        .map_err(|e| match e {
            sea_orm::TransactionError::Connection(e) => {
                format!("Transaction connection error: {e}")
            }
            sea_orm::TransactionError::Transaction(e) => e,
        })?;

    if !affected_song_ids.is_empty() {
        db_events::emit_event(
            "playlist_songs",
            "delete",
            serde_json::json!({ "playlistId": playlist_id }),
        );
    }

    Ok(())
}
