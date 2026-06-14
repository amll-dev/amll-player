use sea_orm::{
    ActiveModelTrait as _, ActiveValue::Set, ColumnTrait as _, ConnectionTrait, EntityTrait as _,
    PaginatorTrait as _, QueryFilter as _,
};
use tauri::{AppHandle, Manager as _, path::BaseDirectory};

use crate::db::entity::{playlist, playlist_song_sources, playlist_songs, song};

pub fn save_cover(
    covers_dir: &std::path::Path,
    song_id: &str,
    cover_bytes: Option<&[u8]>,
) -> Option<String> {
    let bytes = cover_bytes?;
    if bytes.is_empty() {
        return None;
    }
    let cover_file = covers_dir.join(format!("{song_id}.jpg"));
    match std::fs::write(&cover_file, bytes) {
        Ok(()) => Some(cover_file.to_string_lossy().to_string()),
        Err(_) => None,
    }
}

pub fn get_covers_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .resolve("covers", BaseDirectory::AppData)
        .map_err(|e| format!("Failed to resolve covers dir: {e}"))
}

pub async fn cleanup_orphaned_songs(
    db: &impl ConnectionTrait,
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

pub async fn upsert_song(
    db: &impl ConnectionTrait,
    model: &song::Model,
) -> Result<(), sea_orm::DbErr> {
    let active: song::ActiveModel = model.clone().into();
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
                    song::Column::ModifiedAt,
                ])
                .to_owned(),
        )
        .exec(db)
        .await?;
    Ok(())
}

pub async fn link_songs_to_playlist(
    db: &impl ConnectionTrait,
    playlist_id: i32,
    song_ids: &[String],
) -> Result<(), String> {
    if song_ids.is_empty() {
        return Ok(());
    }
    let now = chrono::Utc::now().timestamp_millis();
    let entries: Vec<playlist_songs::ActiveModel> = song_ids
        .iter()
        .enumerate()
        .map(|(i, song_id)| playlist_songs::ActiveModel {
            playlist_id: Set(playlist_id),
            song_id: Set(song_id.clone()),
            added_at: Set(now + i as i64),
            ..Default::default()
        })
        .collect();
    playlist_songs::Entity::insert_many(entries)
        .exec(db)
        .await
        .map_err(|e| format!("Failed to link songs to playlist: {e}"))?;
    Ok(())
}

pub async fn touch_playlist(db: &impl ConnectionTrait, playlist_id: i32) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    if let Some(p) = playlist::Entity::find_by_id(playlist_id)
        .one(db)
        .await
        .map_err(|e| format!("Failed to find playlist: {e}"))?
    {
        let mut active: playlist::ActiveModel = p.into();
        active.update_time = Set(now);
        active
            .update(db)
            .await
            .map_err(|e| format!("Failed to update playlist: {e}"))?;
    }
    Ok(())
}

pub async fn link_song_sources(
    db: &impl ConnectionTrait,
    playlist_id: i32,
    song_ids: &[String],
    source_type: &str,
    source_id: Option<i32>,
) -> Result<(), String> {
    for song_id in song_ids {
        let existing = playlist_song_sources::Entity::find()
            .filter(playlist_song_sources::Column::PlaylistId.eq(playlist_id))
            .filter(playlist_song_sources::Column::SongId.eq(song_id))
            .filter(playlist_song_sources::Column::SourceType.eq(source_type))
            .filter(playlist_song_sources::Column::SourceId.eq(source_id))
            .one(db)
            .await
            .map_err(|e| format!("Failed to check existing source: {e}"))?;

        if existing.is_some() {
            continue;
        }

        let model = playlist_song_sources::ActiveModel {
            playlist_id: Set(playlist_id),
            song_id: Set(song_id.clone()),
            source_type: Set(source_type.to_string()),
            source_id: Set(source_id),
            ..Default::default()
        };
        model
            .insert(db)
            .await
            .map_err(|e| format!("Failed to insert song source: {e}"))?;
    }
    Ok(())
}
