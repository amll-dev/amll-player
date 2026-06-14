use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, PaginatorTrait as _, QueryFilter, Set};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU32, Ordering},
};
use tauri::{AppHandle, Emitter, State};

use crate::db::DbConnection;
use crate::db::entity::{playlist_folder, playlist_song_sources, playlist_songs, song};
use crate::db::utils;
use crate::db::utils::*;
use crate::db_events;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshResult {
    pub added: u32,
    pub updated: u32,
    pub removed: u32,
    pub failed: u32,
}

struct DiffResult {
    pub paths_to_scan: Vec<String>,
    pub paths_to_update: Vec<String>,
    pub removed_ids: Vec<String>,
    pub existing_by_path: HashMap<String, song::Model>,
}

fn calculate_playlist_diff(
    scanned_files: Vec<crate::db::scanner::QuickFileEntry>,
    existing_songs: Vec<song::Model>,
) -> DiffResult {
    let scanned_by_path: HashMap<_, _> = scanned_files
        .into_iter()
        .map(|e| (e.file_path.clone(), e))
        .collect();

    let existing_by_path: HashMap<_, _> = existing_songs
        .into_iter()
        .map(|s| (s.file_path.clone(), s))
        .collect();

    let mut result = DiffResult {
        paths_to_scan: Vec::new(),
        paths_to_update: Vec::new(),
        removed_ids: Vec::new(),
        existing_by_path: existing_by_path.clone(),
    };

    for (path, entry) in &scanned_by_path {
        if let Some(existing) = existing_by_path.get(path) {
            let db_mtime = existing.modified_at.unwrap_or(0);
            if entry.modified_at > db_mtime {
                result.paths_to_update.push(path.clone());
            }
        } else {
            result.paths_to_scan.push(path.clone());
        }
    }

    for (path, existing) in existing_by_path {
        if !scanned_by_path.contains_key(&path) {
            result.removed_ids.push(existing.id);
        }
    }

    result
}

async fn execute_quick_scan(
    app: &AppHandle,
    folders: Vec<String>,
) -> Result<Vec<crate::db::scanner::QuickFileEntry>, String> {
    let cancel_token = Arc::new(AtomicBool::new(false));
    let app_handle = app.clone();

    tokio::task::spawn_blocking(move || {
        let mut all_results = Vec::new();
        let count = AtomicU32::new(0);
        for folder in folders {
            let results = crate::db::scanner::scan_folder_quick(&folder, &cancel_token, &|_n| {
                let c = count.fetch_add(1, Ordering::Relaxed) + 1;
                let _ = app_handle.emit("scan-folder-progress", c);
            });
            all_results.extend(results);
        }
        all_results
    })
    .await
    .map_err(|e| format!("Failed to quick scan: {e}"))
}

async fn process_and_upsert_changed_files(
    db: &DbConnection,
    app: &AppHandle,
    paths_to_process: Vec<String>,
    existing_by_path: &HashMap<String, song::Model>,
    is_new: bool,
) -> Result<(u32, u32, Vec<String>), String> {
    let app_handle = app.clone();
    let paths_for_scan = paths_to_process.clone();

    let full_results = tokio::task::spawn_blocking(move || {
        let count = AtomicU32::new(0);
        paths_for_scan
            .iter()
            .map(|path| {
                let result = crate::db::scanner::process_file_single(Path::new(path));
                let c = count.fetch_add(1, Ordering::Relaxed) + 1;
                let _ = app_handle.emit("scan-folder-progress", c);
                result
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| format!("Failed to process files: {e}"))?;

    let covers_dir = get_covers_dir(app)?;
    let _ = std::fs::create_dir_all(&covers_dir);

    let mut success_count = 0u32;
    let mut failed_count = 0u32;
    let mut new_song_ids = Vec::new();

    for result in full_results {
        let scanned = match result {
            Ok(s) => s,
            Err(e) => {
                failed_count += 1;
                tracing::warn!("File parsing failed during refresh: {e}");
                continue;
            }
        };

        let song_id = scanned.model.id.clone();
        let mut model = scanned.model;
        model.cover_path = save_cover(&covers_dir, &song_id, scanned.cover_bytes.as_deref());

        if is_new {
            match upsert_song(db, &model).await {
                Ok(()) => {
                    success_count += 1;
                    new_song_ids.push(song_id);
                }
                Err(_) => failed_count += 1,
            }
        } else if let Some(existing) = existing_by_path.get(&model.file_path) {
            let final_cover = model.cover_path.take().or(existing.cover_path.clone());

            let mut active: song::ActiveModel = model.into();

            active.id = Set(existing.id.clone());
            active.cover_path = Set(final_cover);

            if active.update(db).await.is_ok() {
                success_count += 1;
            } else {
                failed_count += 1;
            }
        }
    }

    Ok((success_count, failed_count, new_song_ids))
}

async fn remove_missing_playlist_songs(
    db: &DbConnection,
    playlist_id: i32,
    removed_ids: &[String],
) -> Result<u32, String> {
    if removed_ids.is_empty() {
        return Ok(0);
    }

    playlist_song_sources::Entity::delete_many()
        .filter(playlist_song_sources::Column::PlaylistId.eq(playlist_id))
        .filter(playlist_song_sources::Column::SongId.is_in(removed_ids))
        .filter(playlist_song_sources::Column::SourceType.eq("folder"))
        .exec(db)
        .await
        .map_err(|e| format!("Failed to remove missing song sources: {e}"))?;

    let mut actually_removed = 0u32;
    for song_id in removed_ids {
        let remaining_sources = playlist_song_sources::Entity::find()
            .filter(playlist_song_sources::Column::PlaylistId.eq(playlist_id))
            .filter(playlist_song_sources::Column::SongId.eq(song_id))
            .count(db)
            .await
            .map_err(|e| format!("Failed to count remaining sources: {e}"))?;

        if remaining_sources == 0 {
            playlist_songs::Entity::delete_many()
                .filter(playlist_songs::Column::PlaylistId.eq(playlist_id))
                .filter(playlist_songs::Column::SongId.eq(song_id))
                .exec(db)
                .await
                .map_err(|e| format!("Failed to remove playlist song: {e}"))?;

            let _ = cleanup_orphaned_songs(db, std::slice::from_ref(song_id)).await;
            actually_removed += 1;
        }
    }

    Ok(actually_removed)
}

#[tauri::command]
pub async fn refresh_playlist(
    db: State<'_, DbConnection>,
    app: AppHandle,
    playlist_id: i32,
) -> Result<RefreshResult, String> {
    let folders: Vec<String> = playlist_folder::Entity::find()
        .filter(playlist_folder::Column::PlaylistId.eq(playlist_id))
        .all(&*db)
        .await
        .map_err(|e| format!("Failed to find playlist folder: {e}"))?
        .into_iter()
        .map(|f| f.folder_path)
        .collect();

    if folders.is_empty() {
        return Err("This playlist has no associated folder and cannot be refreshed".to_string());
    }

    let existing_playlist_songs = playlist_songs::Entity::find()
        .filter(playlist_songs::Column::PlaylistId.eq(playlist_id))
        .all(&*db)
        .await
        .map_err(|e| format!("Failed to find songs in playlist: {e}"))?;

    let existing_song_ids: Vec<String> = existing_playlist_songs
        .into_iter()
        .map(|ps| ps.song_id)
        .collect();
    let existing_songs = if existing_song_ids.is_empty() {
        Vec::new()
    } else {
        song::Entity::find()
            .filter(song::Column::Id.is_in(&existing_song_ids))
            .all(&*db)
            .await
            .map_err(|e| format!("Failed to find song details: {e}"))?
    };

    let scanned_files = execute_quick_scan(&app, folders).await?;

    let diff = calculate_playlist_diff(scanned_files, existing_songs);

    let mut result = RefreshResult {
        added: 0,
        updated: 0,
        removed: 0,
        failed: 0,
    };

    if !diff.paths_to_scan.is_empty() {
        let (added, failed, new_ids) = process_and_upsert_changed_files(
            &db,
            &app,
            diff.paths_to_scan,
            &diff.existing_by_path,
            true,
        )
        .await?;

        let new_only: Vec<String> = new_ids
            .into_iter()
            .filter(|id| !diff.existing_by_path.values().any(|s| &s.id == id))
            .collect();

        link_songs_to_playlist(&*db, playlist_id, &new_only).await?;

        let folder_models = playlist_folder::Entity::find()
            .filter(playlist_folder::Column::PlaylistId.eq(playlist_id))
            .all(&*db)
            .await
            .map_err(|e| format!("Failed to find playlist folders: {e}"))?;

        for song_id in &new_only {
            if let Some(existing_song) = song::Entity::find_by_id(song_id)
                .one(&*db)
                .await
                .map_err(|e| format!("Failed to find song: {e}"))?
            {
                let path_lower = existing_song.file_path.to_lowercase();
                for folder in &folder_models {
                    let folder_lower = folder.folder_path.to_lowercase();
                    if path_lower.starts_with(&folder_lower) {
                        utils::link_song_sources(
                            &*db,
                            playlist_id,
                            std::slice::from_ref(song_id),
                            "folder",
                            Some(folder.id),
                        )
                        .await?;
                    }
                }
            }
        }

        result.added += added;
        result.failed += failed;
    }

    if !diff.paths_to_update.is_empty() {
        let (updated, failed, _) = process_and_upsert_changed_files(
            &db,
            &app,
            diff.paths_to_update,
            &diff.existing_by_path,
            false,
        )
        .await?;
        result.updated += updated;
        result.failed += failed;
    }

    if !diff.removed_ids.is_empty() {
        result.removed = remove_missing_playlist_songs(&db, playlist_id, &diff.removed_ids).await?;
    }

    touch_playlist(&*db, playlist_id).await?;
    db_events::emit_event(
        "playlist_songs",
        "refresh",
        serde_json::json!({ "playlistId": playlist_id }),
    );

    Ok(result)
}
