use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, Set,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::State;
use tracing::warn;

use crate::db::DbConnection;
use crate::db::entity::{playlist, playlist_songs, song};
use crate::db_events;

async fn cleanup_orphaned_songs(
    db: &DbConnection,
    song_ids: &[String],
) -> Result<Vec<String>, String> {
    let mut deleted = Vec::new();

    for song_id in song_ids {
        let ref_count = playlist_songs::Entity::find()
            .filter(playlist_songs::Column::SongId.eq(song_id))
            .count(db)
            .await
            .map_err(|e| format!("Failed to count song references: {e}"))?;

        if ref_count > 0 {
            continue;
        }

        if let Some(s) = song::Entity::find_by_id(song_id)
            .one(db)
            .await
            .map_err(|e| format!("Failed to find song: {e}"))?
        {
            if let Some(ref cover_path) = s.cover_path
                && !cover_path.is_empty()
            {
                let _ = std::fs::remove_file(cover_path);
            }

            let active: song::ActiveModel = s.into();
            active
                .delete(db)
                .await
                .map_err(|e| format!("Failed to delete orphaned song: {e}"))?;
            deleted.push(song_id.clone());
        }
    }

    Ok(deleted)
}

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
        match cleanup_orphaned_songs(&db, &song_ids).await {
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

    let mut seen: HashSet<String> = playlist_songs::Entity::find()
        .filter(playlist_songs::Column::PlaylistId.eq(playlist_id))
        .all(&*db)
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
            .exec(&*db)
            .await
            .map_err(|e| format!("Failed to add songs to playlist: {e}"))?;

        db_events::emit_event(
            "playlist_songs",
            "insert",
            serde_json::json!({ "playlistId": playlist_id }),
        );
    }

    if let Some(p) = playlist::Entity::find_by_id(playlist_id)
        .one(&*db)
        .await
        .map_err(|e| format!("Failed to find playlist: {e}"))?
    {
        let mut active: playlist::ActiveModel = p.into();
        active.update_time = Set(now);
        active
            .update(&*db)
            .await
            .map_err(|e| format!("Failed to update playlist: {e}"))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn remove_song_from_playlist(
    db: State<'_, DbConnection>,
    playlist_id: i32,
    song_id: String,
) -> Result<(), String> {
    playlist_songs::Entity::delete_many()
        .filter(playlist_songs::Column::PlaylistId.eq(playlist_id))
        .filter(playlist_songs::Column::SongId.eq(&song_id))
        .exec(&*db)
        .await
        .map_err(|e| format!("Failed to remove song from playlist: {e}"))?;

    db_events::emit_event(
        "playlist_songs",
        "delete",
        serde_json::json!({ "playlistId": playlist_id }),
    );

    match cleanup_orphaned_songs(&db, &[song_id]).await {
        Ok(deleted) if !deleted.is_empty() => {
            tracing::info!("[remove_song_from_playlist] Cleaned up orphaned song: {deleted:?}",);
        }
        Err(e) => warn!("[remove_song_from_playlist] Failed to cleanup orphaned song: {e}"),
        _ => {}
    }

    let now = chrono::Utc::now().timestamp_millis();
    if let Some(p) = playlist::Entity::find_by_id(playlist_id)
        .one(&*db)
        .await
        .map_err(|e| format!("Failed to find playlist: {e}"))?
    {
        let mut active: playlist::ActiveModel = p.into();
        active.update_time = Set(now);
        active
            .update(&*db)
            .await
            .map_err(|e| format!("Failed to update playlist: {e}"))?;
    }

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
        let active = song::ActiveModel {
            id: Set(s.id),
            file_path: Set(s.file_path),
            song_name: Set(s.song_name),
            song_artists: Set(s.song_artists),
            song_album: Set(s.song_album),
            duration: Set(s.duration),
            lyric_format: Set(s.lyric_format),
            lyric: Set(s.lyric),
            translated_lrc: Set(s.translated_lrc),
            roman_lrc: Set(s.roman_lrc),
            cover_path: Set(s.cover_path),
        };

        song::Entity::insert(active)
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
