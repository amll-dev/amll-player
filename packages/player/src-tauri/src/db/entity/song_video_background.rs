use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "song_video_backgrounds")]
#[serde(rename_all = "camelCase")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub song_id: String,
    pub asset_id: String,
    pub mime_type: String,
    pub duration_ms: i64,
    pub width: i32,
    pub height: i32,
    pub fit_mode: String,
    pub in_point_ms: i64,
    pub out_point_ms: i64,
    pub loop_enabled: bool,
    pub sync_on_seek: bool,
    pub updated_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::song::Entity",
        from = "Column::SongId",
        to = "super::song::Column::Id",
        on_delete = "Cascade"
    )]
    Song,
}

impl Related<super::song::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Song.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
