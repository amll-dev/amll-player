use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        if !manager
            .has_column("song_background_overrides", "video_base_renderer_mode")
            .await?
        {
            manager
                .alter_table(
                    Table::alter()
                        .table(SongBackgroundOverrides::Table)
                        .add_column(
                            ColumnDef::new(SongBackgroundOverrides::VideoBaseRendererMode)
                                .string()
                                .not_null()
                                .default("css-bg"),
                        )
                        .to_owned(),
                )
                .await?;
        }

        if !manager
            .has_column("song_background_overrides", "video_base_css_background")
            .await?
        {
            manager
                .alter_table(
                    Table::alter()
                        .table(SongBackgroundOverrides::Table)
                        .add_column(
                            ColumnDef::new(SongBackgroundOverrides::VideoBaseCssBackground)
                                .string()
                                .not_null()
                                .default("#000000"),
                        )
                        .to_owned(),
                )
                .await?;
        }

        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        // SQLite cannot safely drop these columns on all supported versions.
        // The schema is ensured idempotently outside the legacy migration ledger.
        Ok(())
    }
}

#[derive(DeriveIden)]
enum SongBackgroundOverrides {
    Table,
    VideoBaseRendererMode,
    VideoBaseCssBackground,
}

#[cfg(test)]
mod tests {
    use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};

    use super::*;
    use crate::db::migration::{
        m20260614_000001_init, m20260813_000005_add_song_video_backgrounds,
        m20260820_000006_add_song_background_overrides,
    };

    async fn scalar_string(db: &sea_orm::DatabaseConnection, sql: &str) -> String {
        db.query_one(Statement::from_string(DbBackend::Sqlite, sql))
            .await
            .expect("query should succeed")
            .expect("query should return one row")
            .try_get("", "value")
            .expect("value should be a string")
    }

    #[tokio::test]
    async fn migration_adds_video_base_defaults_without_overwriting_existing_settings() {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("in-memory SQLite should open");
        let manager = SchemaManager::new(&db);
        m20260614_000001_init::Migration
            .up(&manager)
            .await
            .expect("songs table should initialize");
        m20260813_000005_add_song_video_backgrounds::Migration
            .up(&manager)
            .await
            .expect("video table should initialize");
        m20260820_000006_add_song_background_overrides::Migration
            .up(&manager)
            .await
            .expect("override table should initialize");
        db.execute_unprepared(
            "INSERT INTO songs
             (id, file_path, song_name, song_artists, song_album, duration, lyric_format, lyric)
             VALUES ('song-1', 'song.flac', 'Song', 'Artist', 'Album', 180, 'lrc', '');
             INSERT INTO song_background_overrides
             (song_id, override_enabled, renderer_mode, dual_layer, video_opacity, updated_at)
             VALUES ('song-1', 1, 'video', 0, 0.75, 123);",
        )
        .await
        .expect("legacy override fixture should insert");

        Migration
            .up(&manager)
            .await
            .expect("video base columns should initialize");
        Migration
            .up(&manager)
            .await
            .expect("repeat migration should be idempotent");

        assert!(
            manager
                .has_column("song_background_overrides", "video_base_renderer_mode",)
                .await
                .expect("column query should succeed")
        );
        assert!(
            manager
                .has_column("song_background_overrides", "video_base_css_background",)
                .await
                .expect("column query should succeed")
        );
        assert_eq!(
            scalar_string(
                &db,
                "SELECT video_base_renderer_mode AS value
                 FROM song_background_overrides WHERE song_id = 'song-1'",
            )
            .await,
            "css-bg",
        );
        assert_eq!(
            scalar_string(
                &db,
                "SELECT video_base_css_background AS value
                 FROM song_background_overrides WHERE song_id = 'song-1'",
            )
            .await,
            "#000000",
        );
        assert_eq!(
            scalar_string(
                &db,
                "SELECT CAST(dual_layer AS TEXT) || ':' || CAST(video_opacity AS TEXT) AS value
                 FROM song_background_overrides WHERE song_id = 'song-1'",
            )
            .await,
            "0:0.75",
            "adding video base settings must preserve an existing dual-layer choice",
        );
    }
}
