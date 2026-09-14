use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "song_rhythm_analyses")]
#[serde(rename_all = "camelCase")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub song_id: String,
    pub analyzer_version: i32,
    pub source_modified_at: i64,
    pub source_file_size: i64,
    pub analyzed_at: i64,
    pub payload_json: String,
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
