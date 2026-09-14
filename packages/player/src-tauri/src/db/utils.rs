use sea_orm::{
    ActiveModelTrait as _, ActiveValue::Set, ColumnTrait as _, ConnectionTrait, EntityTrait as _,
    PaginatorTrait as _, QueryFilter as _,
};
use tauri::{AppHandle, Manager as _, path::BaseDirectory};

use crate::db::entity::{
    playlist, playlist_song_sources, playlist_songs, song, song_background_override,
    song_video_background,
};

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
            let had_video_background = song_video_background::Entity::find_by_id(song_id)
                .one(db)
                .await
                .map_err(|e| format!("Failed to find orphaned song video background: {e}"))?
                .is_some();
            let had_background_override = song_background_override::Entity::find_by_id(song_id)
                .one(db)
                .await
                .map_err(|e| format!("Failed to find orphaned song background override: {e}"))?
                .is_some();
            let cover_path = s.cover_path.clone();

            let active: song::ActiveModel = s.into();
            active
                .delete(db)
                .await
                .map_err(|e| format!("Failed to delete orphaned song: {e}"))?;

            // The song statement atomically cascades rhythm/video/override rows,
            // so a later failure cannot leave a surviving song with lost data.
            if let Some(cover_path) = cover_path
                && !cover_path.is_empty()
            {
                let _ = std::fs::remove_file(cover_path);
            }
            if had_video_background {
                crate::db_events::emit_event(
                    "song_video_backgrounds",
                    "delete",
                    serde_json::json!(song_id),
                );
            }
            if had_background_override {
                crate::db_events::emit_event(
                    "song_background_overrides",
                    "delete",
                    serde_json::json!(song_id),
                );
            }
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

#[cfg(test)]
mod tests {
    use sea_orm::{Database, EntityTrait};

    use super::*;
    use crate::db::migration;

    #[tokio::test]
    async fn orphan_song_cleanup_cascades_background_records_with_song() {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("in-memory SQLite should open");
        migration::run_migrations(&db)
            .await
            .expect("database migrations should run");
        let song_id = "orphan-with-video";
        song::Entity::insert(song::ActiveModel {
            id: Set(song_id.to_owned()),
            file_path: Set("song.flac".to_owned()),
            song_name: Set("Song".to_owned()),
            song_artists: Set("Artist".to_owned()),
            song_album: Set("Album".to_owned()),
            duration: Set(1.0),
            lyric_format: Set("lrc".to_owned()),
            lyric: Set(String::new()),
            translated_lrc: Set(None),
            roman_lrc: Set(None),
            cover_path: Set(None),
            modified_at: Set(None),
        })
        .exec(&db)
        .await
        .expect("song fixture should insert");
        song_video_background::Entity::insert(song_video_background::ActiveModel {
            song_id: Set(song_id.to_owned()),
            asset_id: Set("abcdef0123456789abcdef0123456789-1.mp4".to_owned()),
            mime_type: Set("video/mp4".to_owned()),
            duration_ms: Set(1_000),
            width: Set(1280),
            height: Set(720),
            fit_mode: Set("cover".to_owned()),
            in_point_ms: Set(0),
            out_point_ms: Set(1_000),
            loop_enabled: Set(false),
            sync_on_seek: Set(true),
            updated_at: Set(1),
        })
        .exec(&db)
        .await
        .expect("video background fixture should insert");
        song_background_override::Entity::insert(song_background_override::ActiveModel {
            song_id: Set(song_id.to_owned()),
            override_enabled: Set(true),
            renderer_mode: Set("video".to_owned()),
            dual_layer: Set(true),
            video_opacity: Set(0.4),
            video_base_renderer_mode: Set("css-bg".to_owned()),
            video_base_css_background: Set("#000000".to_owned()),
            renderer_options: Set(None),
            updated_at: Set(1),
        })
        .exec(&db)
        .await
        .expect("background override fixture should insert");

        assert_eq!(
            cleanup_orphaned_songs(&db, &[song_id.to_owned()])
                .await
                .expect("orphan cleanup should succeed"),
            vec![song_id.to_owned()]
        );
        assert!(
            song_video_background::Entity::find_by_id(song_id)
                .one(&db)
                .await
                .expect("mapping query should succeed")
                .is_none()
        );
        assert!(
            song::Entity::find_by_id(song_id)
                .one(&db)
                .await
                .expect("song query should succeed")
                .is_none()
        );
        assert!(
            song_background_override::Entity::find_by_id(song_id)
                .one(&db)
                .await
                .expect("override query should succeed")
                .is_none()
        );
    }
}
