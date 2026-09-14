use sea_orm::{
    ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, Set, TransactionTrait,
    sea_query::{Expr, OnConflict},
};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::DbConnection;
use crate::db::entity::{song, song_background_override};
use crate::db_events;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundRendererOptions {
    pub fps: u32,
    pub animation_intensity: f64,
    pub render_scale: f64,
    pub static_mode: bool,
    pub css_background: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSongBackgroundOverridePayload {
    pub song_id: String,
    pub renderer_mode: String,
    pub dual_layer: bool,
    pub video_opacity: f64,
    pub video_base_renderer_mode: String,
    pub video_base_css_background: String,
    #[serde(default)]
    pub renderer_options: Option<BackgroundRendererOptions>,
}

fn validate_payload(payload: &SaveSongBackgroundOverridePayload) -> Result<(), String> {
    if !matches!(
        payload.renderer_mode.as_str(),
        "mesh" | "pixi" | "css-bg" | "video"
    ) {
        return Err("Invalid song background renderer mode".into());
    }
    if !payload.video_opacity.is_finite()
        || payload.video_opacity < 0.0
        || payload.video_opacity > 1.0
    {
        return Err("Song video background opacity must be between 0 and 1".into());
    }
    if !matches!(
        payload.video_base_renderer_mode.as_str(),
        "mesh" | "pixi" | "css-bg"
    ) {
        return Err("Invalid song video base renderer mode".into());
    }
    let css_background = payload.video_base_css_background.trim();
    if css_background.is_empty() || css_background.len() > 1_024 {
        return Err("Song video base CSS background must contain 1 to 1024 bytes".into());
    }
    if let Some(options) = &payload.renderer_options {
        if !(1..=1000).contains(&options.fps)
            || !options.animation_intensity.is_finite()
            || !(0.0..=2.0).contains(&options.animation_intensity)
            || !options.render_scale.is_finite()
            || !(0.01..=10.0).contains(&options.render_scale)
        {
            return Err("Invalid song background renderer options".into());
        }
        let css = options.css_background.trim();
        if css.is_empty() || css.len() > 1024 {
            return Err("Song CSS background must contain 1 to 1024 bytes".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn get_song_background_override(
    song_id: String,
    db: State<'_, DbConnection>,
) -> Result<Option<song_background_override::Model>, String> {
    song_background_override::Entity::find_by_id(song_id)
        .one(&*db)
        .await
        .map_err(|error| format!("Failed to get song background override: {error}"))
}

#[tauri::command]
pub async fn save_song_background_override(
    payload: SaveSongBackgroundOverridePayload,
    db: State<'_, DbConnection>,
) -> Result<song_background_override::Model, String> {
    save_override(&db, payload).await
}

async fn save_override(
    db: &DatabaseConnection,
    payload: SaveSongBackgroundOverridePayload,
) -> Result<song_background_override::Model, String> {
    validate_payload(&payload)?;
    let transaction = db
        .begin()
        .await
        .map_err(|error| format!("Failed to begin song background override save: {error}"))?;
    song::Entity::find_by_id(&payload.song_id)
        .one(&transaction)
        .await
        .map_err(|error| format!("Failed to find song: {error}"))?
        .ok_or_else(|| format!("Song {} not found", payload.song_id))?;

    // Omitted options from older clients must not erase previously saved settings.
    let renderer_options = if let Some(options) = &payload.renderer_options {
        Some(serde_json::to_value(options).map_err(|error| error.to_string())?)
    } else {
        song_background_override::Entity::find_by_id(&payload.song_id)
            .one(&transaction)
            .await
            .map_err(|error| error.to_string())?
            .and_then(|existing| existing.renderer_options)
    };
    let model = song_background_override::ActiveModel {
        song_id: Set(payload.song_id.clone()),
        override_enabled: Set(true),
        renderer_mode: Set(payload.renderer_mode),
        dual_layer: Set(payload.dual_layer),
        video_opacity: Set(payload.video_opacity),
        video_base_renderer_mode: Set(payload.video_base_renderer_mode),
        video_base_css_background: Set(payload.video_base_css_background),
        renderer_options: Set(renderer_options),
        updated_at: Set(chrono::Utc::now().timestamp_millis()),
    };
    song_background_override::Entity::insert(model)
        .on_conflict(
            OnConflict::column(song_background_override::Column::SongId)
                .update_columns([
                    song_background_override::Column::OverrideEnabled,
                    song_background_override::Column::RendererMode,
                    song_background_override::Column::DualLayer,
                    song_background_override::Column::VideoOpacity,
                    song_background_override::Column::VideoBaseRendererMode,
                    song_background_override::Column::VideoBaseCssBackground,
                    song_background_override::Column::RendererOptions,
                    song_background_override::Column::UpdatedAt,
                ])
                .to_owned(),
        )
        .exec(&transaction)
        .await
        .map_err(|error| format!("Failed to save song background override: {error}"))?;
    let saved = song_background_override::Entity::find_by_id(&payload.song_id)
        .one(&transaction)
        .await
        .map_err(|error| format!("Failed to read saved song background override: {error}"))?
        .ok_or_else(|| "Saved song background override could not be read back".to_string())?;
    transaction
        .commit()
        .await
        .map_err(|error| format!("Failed to commit song background override: {error}"))?;
    db_events::emit_event(
        "song_background_overrides",
        "upsert",
        serde_json::json!(&saved.song_id),
    );
    Ok(saved)
}

#[tauri::command]
pub async fn delete_song_background_override(
    song_id: String,
    db: State<'_, DbConnection>,
) -> Result<(), String> {
    disable_override(&db, song_id).await
}

async fn disable_override(db: &DatabaseConnection, song_id: String) -> Result<(), String> {
    let result = song_background_override::Entity::update_many()
        .col_expr(
            song_background_override::Column::OverrideEnabled,
            Expr::value(false),
        )
        .col_expr(
            song_background_override::Column::UpdatedAt,
            Expr::value(chrono::Utc::now().timestamp_millis()),
        )
        .filter(song_background_override::Column::SongId.eq(&song_id))
        .exec(&*db)
        .await
        .map_err(|error| format!("Failed to disable song background override: {error}"))?;
    if result.rows_affected > 0 {
        db_events::emit_event(
            "song_background_overrides",
            "upsert",
            serde_json::json!(song_id),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> SaveSongBackgroundOverridePayload {
        SaveSongBackgroundOverridePayload {
            song_id: "song-1".into(),
            renderer_mode: "video".into(),
            dual_layer: true,
            video_opacity: 0.4,
            video_base_renderer_mode: "css-bg".into(),
            video_base_css_background: "#000000".into(),
            renderer_options: None,
        }
    }

    #[test]
    fn payload_validation_accepts_video_composition_defaults() {
        validate_payload(&payload()).expect("video composition defaults should be valid");
    }

    #[test]
    fn payload_validation_rejects_video_as_a_base_renderer_and_blank_css() {
        let mut invalid_renderer = payload();
        invalid_renderer.video_base_renderer_mode = "video".into();
        assert!(validate_payload(&invalid_renderer).is_err());

        let mut blank_css = payload();
        blank_css.video_base_css_background = "   ".into();
        assert!(validate_payload(&blank_css).is_err());
    }

    fn options() -> BackgroundRendererOptions {
        BackgroundRendererOptions {
            fps: 120,
            animation_intensity: 0.65,
            render_scale: 0.5,
            static_mode: true,
            css_background: "linear-gradient(red, blue)".into(),
        }
    }

    #[test]
    fn renderer_options_validate_ranges_and_legacy_payloads() {
        let legacy = serde_json::json!({"songId":"song-1", "rendererMode":"mesh",
            "dualLayer":true, "videoOpacity":0.4, "videoBaseRendererMode":"css-bg",
            "videoBaseCssBackground":"#000000"});
        let mut value: SaveSongBackgroundOverridePayload = serde_json::from_value(legacy).unwrap();
        assert!(value.renderer_options.is_none());
        value.renderer_options = Some(options());
        assert!(validate_payload(&value).is_ok());
        for invalid in [0, 1001] {
            value.renderer_options.as_mut().unwrap().fps = invalid;
            assert!(validate_payload(&value).is_err());
        }
        value.renderer_options = Some(options());
        for invalid in [f64::NAN, f64::INFINITY, -0.01, 2.01] {
            value.renderer_options.as_mut().unwrap().animation_intensity = invalid;
            assert!(validate_payload(&value).is_err());
        }
        value.renderer_options = Some(options());
        for invalid in [f64::NAN, 0.0, 10.01] {
            value.renderer_options.as_mut().unwrap().render_scale = invalid;
            assert!(validate_payload(&value).is_err());
        }
        value.renderer_options = Some(options());
        for invalid in [" ".to_string(), "a".repeat(1025)] {
            value.renderer_options.as_mut().unwrap().css_background = invalid;
            assert!(validate_payload(&value).is_err());
        }
    }

    #[tokio::test]
    async fn renderer_options_survive_migrations_disable_and_legacy_saves_per_song() {
        use sea_orm::{ConnectionTrait, Database};
        let db = Database::connect("sqlite::memory:").await.unwrap();
        crate::db::migration::run_migrations(&db).await.unwrap();
        db.execute_unprepared("INSERT INTO songs
            (id, file_path, song_name, song_artists, song_album, duration, lyric_format, lyric)
            VALUES ('song-1','a.flac','A','','',180,'lrc',''), ('song-2','b.flac','B','','',180,'lrc','');
            INSERT INTO song_background_overrides
            (song_id, override_enabled, renderer_mode, dual_layer, video_opacity, updated_at)
            VALUES ('song-2',0,'pixi',0,0.7,123);").await.unwrap();
        let mut value = payload();
        value.renderer_options = Some(options());
        let saved = save_override(&db, value).await.unwrap();
        assert_eq!(
            saved.renderer_options,
            Some(serde_json::to_value(options()).unwrap())
        );
        disable_override(&db, "song-1".into()).await.unwrap();
        let disabled = song_background_override::Entity::find_by_id("song-1")
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert!(!disabled.override_enabled);
        assert_eq!(disabled.renderer_options, saved.renderer_options);
        let reenabled = save_override(&db, payload()).await.unwrap();
        assert!(reenabled.override_enabled);
        assert_eq!(reenabled.renderer_options, saved.renderer_options);
        crate::db::migration::run_migrations(&db).await.unwrap();
        let second = song_background_override::Entity::find_by_id("song-2")
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert!(second.renderer_options.is_none());
        assert!(!second.override_enabled);
        assert_eq!(second.renderer_mode, "pixi");
        assert_eq!(second.video_opacity, 0.7);
        let first = song_background_override::Entity::find_by_id("song-1")
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.renderer_options, saved.renderer_options);
    }
}
