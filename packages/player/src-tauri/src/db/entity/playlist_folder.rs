use async_trait::async_trait;
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

use crate::db_events;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "playlist_folders")]
#[serde(rename_all = "camelCase")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub playlist_id: i32,
    pub folder_path: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::playlist::Entity",
        from = "Column::PlaylistId",
        to = "super::playlist::Column::Id"
    )]
    Playlist,
}

impl Related<super::playlist::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Playlist.def()
    }
}

#[async_trait]
impl ActiveModelBehavior for ActiveModel {
    async fn after_save<C>(model: Model, _db: &C, insert: bool) -> Result<Model, DbErr>
    where
        C: ConnectionTrait,
    {
        let action = if insert { "insert" } else { "update" };
        db_events::emit_event(
            "playlist_folders",
            action,
            serde_json::json!({ "playlistId": model.playlist_id }),
        );
        Ok(model)
    }

    async fn after_delete<C>(self, _db: &C) -> Result<Self, DbErr>
    where
        C: ConnectionTrait,
    {
        if let sea_orm::ActiveValue::Set(ref playlist_id)
        | sea_orm::ActiveValue::Unchanged(ref playlist_id) = self.playlist_id
        {
            db_events::emit_event(
                "playlist_folders",
                "delete",
                serde_json::json!({ "playlistId": playlist_id }),
            );
        }
        Ok(self)
    }
}
