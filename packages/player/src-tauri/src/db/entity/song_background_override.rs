use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "song_background_overrides")]
#[serde(rename_all = "camelCase")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub song_id: String,
    pub override_enabled: bool,
    pub renderer_mode: String,
    pub dual_layer: bool,
    pub video_opacity: f64,
    pub video_base_renderer_mode: String,
    pub video_base_css_background: String,
    pub renderer_options: Option<Json>,
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
