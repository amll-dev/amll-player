use base64::Engine;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, Set, TransactionTrait as _};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tracing::{info, warn};

use crate::db::DbConnection;
use crate::db::entity::{playlist, playlist_songs, song};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateSongItem {
    pub id: String,
    pub file_path: String,
    pub song_name: String,
    pub song_artists: String,
    pub song_album: String,
    pub duration: f64,
    pub lyric_format: String,
    pub lyric: String,
    pub translated_lrc: Option<String>,
    pub roman_lrc: Option<String>,
    pub cover_base64: Option<String>,
    pub cover_type: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigratePlaylistItem {
    pub id: i32,
    pub name: String,
    pub create_time: i64,
    pub update_time: i64,
    pub play_time: i64,
    pub song_ids: Vec<String>,
    pub cover_base64: Option<String>,
    pub cover_type: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateBatchResult {
    pub imported: u32,
    pub failed: u32,
    pub failed_ids: Vec<String>,
}

fn get_covers_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    use tauri::path::BaseDirectory;
    app.path()
        .resolve("covers", BaseDirectory::AppData)
        .map_err(|e| format!("Failed to resolve covers dir: {e}"))
}

fn type_to_ext(cover_type: &str) -> &str {
    if cover_type.starts_with("video") {
        "mp4"
    } else {
        "jpg"
    }
}

fn save_cover(
    app: &AppHandle,
    id: &str,
    prefix: &str,
    base64_data: &str,
    cover_type: Option<&str>,
) -> Result<Option<String>, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| format!("Failed to decode base64 cover for {id}: {e}"))?;

    if bytes.is_empty() {
        return Ok(None);
    }

    let covers_dir = get_covers_dir(app)?;
    std::fs::create_dir_all(&covers_dir)
        .map_err(|e| format!("Failed to create covers dir: {e}"))?;

    let ext = cover_type.map(type_to_ext).unwrap_or("jpg");
    let filename = format!("{prefix}{id}.{ext}");
    let file_path = covers_dir.join(&filename);

    std::fs::write(&file_path, &bytes)
        .map_err(|e| format!("Failed to write cover file for {id}: {e}"))?;

    Ok(Some(file_path.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn migrate_songs_batch(
    db: State<'_, DbConnection>,
    app: AppHandle,
    songs: Vec<MigrateSongItem>,
) -> Result<MigrateBatchResult, String> {
    let mut imported = 0u32;
    let mut failed = 0u32;
    let mut failed_ids = Vec::new();

    for item in songs {
        let song_id = item.id.clone();

        let cover_path = match (&item.cover_base64, &item.cover_type) {
            (Some(b64), ct) => match save_cover(&app, &song_id, "", b64, ct.as_deref()) {
                Ok(path) => path,
                Err(e) => {
                    warn!("[Migration] Failed to save cover for song {song_id}: {e}");
                    failed_ids.push(song_id);
                    failed += 1;
                    continue;
                }
            },
            (None, _) => None,
        };

        let active = song::ActiveModel {
            id: Set(item.id),
            file_path: Set(item.file_path),
            song_name: Set(item.song_name),
            song_artists: Set(item.song_artists),
            song_album: Set(item.song_album),
            duration: Set(item.duration),
            lyric_format: Set(item.lyric_format),
            lyric: Set(item.lyric),
            translated_lrc: Set(item.translated_lrc),
            roman_lrc: Set(item.roman_lrc),
            cover_path: Set(cover_path),
        };

        match song::Entity::insert(active)
            .on_conflict(
                sea_orm::sea_query::OnConflict::column(song::Column::Id)
                    .update_columns([
                        song::Column::FilePath,
                        song::Column::SongName,
                        song::Column::SongArtists,
                        song::Column::SongAlbum,
                        song::Column::Duration,
                        song::Column::LyricFormat,
                        song::Column::Lyric,
                        song::Column::TranslatedLrc,
                        song::Column::RomanLrc,
                        song::Column::CoverPath,
                    ])
                    .to_owned(),
            )
            .exec(&*db)
            .await
        {
            Ok(_) => {
                imported += 1;
            }
            Err(e) => {
                warn!("[Migration] Failed to upsert song {song_id}: {e}");
                failed_ids.push(song_id);
                failed += 1;
            }
        }
    }

    info!(
        "[Migration] Songs migrated: imported={imported}, failed={}",
        failed_ids.len()
    );

    if imported > 0 {
        crate::db_events::emit_event("songs", "batch_insert", serde_json::json!(null));
    }

    Ok(MigrateBatchResult {
        imported,
        failed,
        failed_ids,
    })
}

#[tauri::command]
pub async fn migrate_playlists_batch(
    db: State<'_, DbConnection>,
    app: AppHandle,
    playlists: Vec<MigratePlaylistItem>,
) -> Result<MigrateBatchResult, String> {
    let mut imported = 0u32;
    let mut failed = 0u32;
    let mut failed_ids = Vec::new();

    for item in playlists {
        let playlist_id = item.id;

        let cover_path = match (&item.cover_base64, &item.cover_type) {
            (Some(b64), ct) => {
                match save_cover(
                    &app,
                    &playlist_id.to_string(),
                    "playlist_",
                    b64,
                    ct.as_deref(),
                ) {
                    Ok(path) => path,
                    Err(e) => {
                        warn!("[Migration] Failed to save cover for playlist {playlist_id}: {e}");
                        failed_ids.push(playlist_id.to_string());
                        failed += 1;
                        continue;
                    }
                }
            }
            (None, _) => None,
        };

        let txn = db
            .begin()
            .await
            .map_err(|e| format!("Failed to begin transaction for playlist {playlist_id}: {e}"))?;

        let playlist_active = playlist::ActiveModel {
            id: Set(item.id),
            name: Set(item.name),
            create_time: Set(item.create_time),
            update_time: Set(item.update_time),
            play_time: Set(item.play_time),
            cover_path: Set(cover_path),
        };

        match playlist::Entity::insert(playlist_active)
            .on_conflict(
                sea_orm::sea_query::OnConflict::column(playlist::Column::Id)
                    .update_columns([
                        playlist::Column::Name,
                        playlist::Column::CreateTime,
                        playlist::Column::UpdateTime,
                        playlist::Column::PlayTime,
                        playlist::Column::CoverPath,
                    ])
                    .to_owned(),
            )
            .exec(&txn)
            .await
        {
            Ok(_) => {}
            Err(e) => {
                warn!("[Migration] Failed to upsert playlist {playlist_id}: {e}");
                let _ = txn.rollback().await;
                failed_ids.push(playlist_id.to_string());
                failed += 1;
                continue;
            }
        }

        playlist_songs::Entity::delete_many()
            .filter(playlist_songs::Column::PlaylistId.eq(playlist_id))
            .exec(&txn)
            .await
            .map_err(|e| {
                format!("Failed to clear playlist_songs for playlist {playlist_id}: {e}")
            })?;

        if !item.song_ids.is_empty() {
            let now = chrono::Utc::now().timestamp_millis();
            let new_entries: Vec<playlist_songs::ActiveModel> = item
                .song_ids
                .into_iter()
                .map(|song_id| playlist_songs::ActiveModel {
                    playlist_id: Set(playlist_id),
                    song_id: Set(song_id),
                    added_at: Set(now),
                    ..Default::default()
                })
                .collect();

            if let Err(e) = playlist_songs::Entity::insert_many(new_entries)
                .exec(&txn)
                .await
            {
                warn!(
                    "[Migration] Failed to insert playlist_songs for playlist {playlist_id}: {e}"
                );
                let _ = txn.rollback().await;
                failed_ids.push(playlist_id.to_string());
                failed += 1;
                continue;
            }
        }

        if let Err(e) = txn.commit().await {
            warn!("[Migration] Failed to commit transaction for playlist {playlist_id}: {e}");
            failed_ids.push(playlist_id.to_string());
            failed += 1;
            continue;
        }

        imported += 1;
    }

    info!(
        "[Migration] Playlists migrated: imported={imported}, failed={}",
        failed_ids.len()
    );

    if imported > 0 {
        crate::db_events::emit_event("playlists", "batch_insert", serde_json::json!(null));
        crate::db_events::emit_event("playlist_songs", "batch_insert", serde_json::json!(null));
    }

    Ok(MigrateBatchResult {
        imported,
        failed,
        failed_ids,
    })
}
