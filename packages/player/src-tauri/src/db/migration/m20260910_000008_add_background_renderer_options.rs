use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        if !manager
            .has_column("song_background_overrides", "renderer_options")
            .await?
        {
            manager
                .alter_table(
                    Table::alter()
                        .table(Alias::new("song_background_overrides"))
                        .add_column(ColumnDef::new(Alias::new("renderer_options")).json().null())
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        // Persistent user settings are retained for downgrade compatibility.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{
        entity::song_background_override,
        migration::{
            m20260614_000001_init, m20260813_000005_add_song_video_backgrounds,
            m20260820_000006_add_song_background_overrides,
            m20260820_000007_add_video_base_background,
        },
    };
    use sea_orm::{ConnectionTrait, Database, EntityTrait};

    #[tokio::test]
    async fn legacy_rows_inherit_globals_and_repeat_migration_preserves_options() {
        let db = Database::connect("sqlite::memory:").await.unwrap();
        let manager = SchemaManager::new(&db);
        m20260614_000001_init::Migration.up(&manager).await.unwrap();
        m20260813_000005_add_song_video_backgrounds::Migration
            .up(&manager)
            .await
            .unwrap();
        m20260820_000006_add_song_background_overrides::Migration
            .up(&manager)
            .await
            .unwrap();
        m20260820_000007_add_video_base_background::Migration
            .up(&manager)
            .await
            .unwrap();
        db.execute_unprepared(
            "INSERT INTO songs
            (id, file_path, song_name, song_artists, song_album, duration, lyric_format, lyric)
            VALUES ('old','old.flac','Old','','',180,'lrc','');
            INSERT INTO song_background_overrides
            (song_id, override_enabled, renderer_mode, dual_layer, video_opacity, updated_at)
            VALUES ('old',0,'pixi',0,0.7,123);",
        )
        .await
        .unwrap();
        Migration.up(&manager).await.unwrap();
        let old = song_background_override::Entity::find_by_id("old")
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert!(old.renderer_options.is_none());
        assert!(!old.override_enabled);
        assert_eq!(old.renderer_mode, "pixi");
        assert_eq!(old.video_opacity, 0.7);
        assert_eq!(old.updated_at, 123);
        db.execute_unprepared("UPDATE song_background_overrides SET renderer_options = '{\"fps\":144}' WHERE song_id = 'old'").await.unwrap();
        Migration.up(&manager).await.unwrap();
        let after = song_background_override::Entity::find_by_id("old")
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(after.renderer_options, Some(serde_json::json!({"fps":144})));
        assert_eq!(after.updated_at, 123);
    }
}
