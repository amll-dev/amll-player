use async_trait::async_trait;
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

use crate::db_events;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "songs")]
#[serde(rename_all = "camelCase")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
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
    pub cover_path: Option<String>,
    pub modified_at: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::playlist_songs::Entity")]
    PlaylistSongs,
    #[sea_orm(has_one = "super::song_rhythm_analysis::Entity")]
    RhythmAnalysis,
    #[sea_orm(has_one = "super::song_video_background::Entity")]
    VideoBackground,
    #[sea_orm(has_one = "super::song_background_override::Entity")]
    BackgroundOverride,
}

impl Related<super::playlist_songs::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::PlaylistSongs.def()
    }
}

impl Related<super::song_rhythm_analysis::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::RhythmAnalysis.def()
    }
}

impl Related<super::song_video_background::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::VideoBackground.def()
    }
}

impl Related<super::song_background_override::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::BackgroundOverride.def()
    }
}

#[async_trait]
impl ActiveModelBehavior for ActiveModel {
    async fn after_save<C>(model: Model, _db: &C, insert: bool) -> Result<Model, DbErr>
    where
        C: ConnectionTrait,
    {
        let action = if insert { "insert" } else { "update" };
        db_events::emit_event("songs", action, serde_json::json!(model.id));
        Ok(model)
    }

    async fn after_delete<C>(self, _db: &C) -> Result<Self, DbErr>
    where
        C: ConnectionTrait,
    {
        if let sea_orm::ActiveValue::Set(ref id) | sea_orm::ActiveValue::Unchanged(ref id) = self.id
        {
            db_events::emit_event("songs", "delete", serde_json::json!(id));
        }
        Ok(self)
    }
}
