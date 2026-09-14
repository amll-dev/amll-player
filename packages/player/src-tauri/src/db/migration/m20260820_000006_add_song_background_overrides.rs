use sea_orm::ConnectionTrait;
use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let table_already_existed = manager.has_table("song_background_overrides").await?;
        let enabled_column_already_existed = table_already_existed
            && manager
                .has_column("song_background_overrides", "override_enabled")
                .await?;

        manager
            .create_table(
                Table::create()
                    .table(SongBackgroundOverrides::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(SongBackgroundOverrides::SongId)
                            .string()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(SongBackgroundOverrides::OverrideEnabled)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .col(
                        ColumnDef::new(SongBackgroundOverrides::RendererMode)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SongBackgroundOverrides::DualLayer)
                            .boolean()
                            .not_null()
                            .default(true),
                    )
                    .col(
                        ColumnDef::new(SongBackgroundOverrides::VideoOpacity)
                            .double()
                            .not_null()
                            .default(0.4),
                    )
                    .col(
                        ColumnDef::new(SongBackgroundOverrides::UpdatedAt)
                            .big_integer()
                            .not_null(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_song_background_override_song")
                            .from(
                                SongBackgroundOverrides::Table,
                                SongBackgroundOverrides::SongId,
                            )
                            .to(Songs::Table, Songs::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .check(
                        Expr::col(SongBackgroundOverrides::RendererMode)
                            .is_in(["mesh", "pixi", "css-bg", "video"]),
                    )
                    .check(Expr::col(SongBackgroundOverrides::VideoOpacity).gte(0.0))
                    .check(Expr::col(SongBackgroundOverrides::VideoOpacity).lte(1.0))
                    .to_owned(),
            )
            .await?;

        // Repair the short-lived preview schema, whose row presence represented
        // "enabled". Existing preview rows therefore migrate as enabled.
        if table_already_existed && !enabled_column_already_existed {
            manager
                .alter_table(
                    Table::alter()
                        .table(SongBackgroundOverrides::Table)
                        .add_column(
                            ColumnDef::new(SongBackgroundOverrides::OverrideEnabled)
                                .boolean()
                                .not_null()
                                .default(true),
                        )
                        .to_owned(),
                )
                .await?;
        }

        // Run this every time so videos created by an older build during a
        // downgrade are adopted after upgrading again. A disabled row remains
        // present, so INSERT OR IGNORE cannot accidentally re-enable it.
        manager
            .get_connection()
            .execute_unprepared(
                "INSERT OR IGNORE INTO song_background_overrides
                 (song_id, override_enabled, renderer_mode, dual_layer,
                  video_opacity, updated_at)
                 SELECT song_id, 1, 'video', 1, 0.4, updated_at
                 FROM song_video_backgrounds",
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(
                Table::drop()
                    .table(SongBackgroundOverrides::Table)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum SongBackgroundOverrides {
    Table,
    SongId,
    OverrideEnabled,
    RendererMode,
    DualLayer,
    VideoOpacity,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum Songs {
    Table,
    Id,
}

#[cfg(test)]
mod tests {
    use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};

    use super::*;
    use crate::db::migration::{
        m20260614_000001_init, m20260813_000005_add_song_video_backgrounds,
    };

    async fn scalar_i64(db: &sea_orm::DatabaseConnection, sql: &str) -> i64 {
        db.query_one(Statement::from_string(DbBackend::Sqlite, sql))
            .await
            .expect("query should succeed")
            .expect("query should return one row")
            .try_get("", "value")
            .expect("value should be an integer")
    }

    #[tokio::test]
    async fn migration_backfills_videos_without_reenabling_explicit_opt_outs() {
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
        db.execute_unprepared(
            "INSERT INTO songs
             (id, file_path, song_name, song_artists, song_album, duration, lyric_format, lyric)
             VALUES ('song-1', 'song.flac', 'Song', 'Artist', 'Album', 180, 'lrc', '');
             INSERT INTO song_video_backgrounds
             (song_id, asset_id, mime_type, duration_ms, width, height, fit_mode,
              in_point_ms, out_point_ms, loop_enabled, sync_on_seek, updated_at)
             VALUES ('song-1', 'asset.mp4', 'video/mp4', 10000, 1920, 1080,
                     'cover', 0, 10000, 1, 1, 123);",
        )
        .await
        .expect("video fixture should insert");

        Migration
            .up(&manager)
            .await
            .expect("override table should initialize");
        assert_eq!(
            scalar_i64(
                &db,
                "SELECT COUNT(*) AS value FROM song_background_overrides
                  WHERE song_id = 'song-1' AND renderer_mode = 'video'
                    AND override_enabled = 1
                    AND dual_layer = 1 AND video_opacity = 0.4",
            )
            .await,
            1,
        );

        db.execute_unprepared(
            "UPDATE song_background_overrides
             SET override_enabled = 0 WHERE song_id = 'song-1'",
        )
        .await
        .expect("override should disable");
        Migration
            .up(&manager)
            .await
            .expect("repeat migration should be idempotent");
        assert_eq!(
            scalar_i64(
                &db,
                "SELECT COUNT(*) AS value FROM song_background_overrides",
            )
            .await,
            1,
            "an intentional opt-out must not be backfilled again",
        );
        assert_eq!(
            scalar_i64(
                &db,
                "SELECT override_enabled AS value FROM song_background_overrides
                 WHERE song_id = 'song-1'",
            )
            .await,
            0,
        );

        db.execute_unprepared(
            "INSERT INTO songs
             (id, file_path, song_name, song_artists, song_album, duration, lyric_format, lyric)
             VALUES ('song-2', 'song-2.flac', 'Song 2', 'Artist', 'Album', 180, 'lrc', '');
             INSERT INTO song_video_backgrounds
             (song_id, asset_id, mime_type, duration_ms, width, height, fit_mode,
              in_point_ms, out_point_ms, loop_enabled, sync_on_seek, updated_at)
             VALUES ('song-2', 'asset-2.mp4', 'video/mp4', 10000, 1920, 1080,
                     'cover', 0, 10000, 1, 1, 456);",
        )
        .await
        .expect("downgraded build video fixture should insert");
        Migration
            .up(&manager)
            .await
            .expect("repeat migration should adopt newly added legacy video");
        assert_eq!(
            scalar_i64(
                &db,
                "SELECT COUNT(*) AS value FROM song_background_overrides
                 WHERE song_id = 'song-2' AND override_enabled = 1
                   AND renderer_mode = 'video'",
            )
            .await,
            1,
        );

        assert!(
            db.execute_unprepared(
                "INSERT INTO song_background_overrides
                 (song_id, renderer_mode, dual_layer, video_opacity, updated_at)
                 VALUES ('song-1', 'invalid', 0, 1.0, 1)",
            )
            .await
            .is_err()
        );
        assert!(
            db.execute_unprepared(
                "INSERT INTO song_background_overrides
                 (song_id, renderer_mode, dual_layer, video_opacity, updated_at)
                 VALUES ('song-1', 'mesh', 0, 1.5, 1)",
            )
            .await
            .is_err()
        );

        db.execute_unprepared("DELETE FROM songs WHERE id = 'song-1';")
            .await
            .expect("song deletion should cascade");
        assert_eq!(
            scalar_i64(
                &db,
                "SELECT COUNT(*) AS value FROM song_background_overrides
                 WHERE song_id = 'song-1'",
            )
            .await,
            0,
        );
    }

    #[tokio::test]
    async fn migration_repairs_preview_table_without_enabled_column() {
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
        db.execute_unprepared(
            "CREATE TABLE song_background_overrides (
                 song_id TEXT PRIMARY KEY NOT NULL,
                 renderer_mode TEXT NOT NULL,
                 dual_layer BOOLEAN NOT NULL DEFAULT 0,
                 video_opacity REAL NOT NULL DEFAULT 1.0,
                 updated_at BIGINT NOT NULL
             );
             INSERT INTO song_background_overrides
             (song_id, renderer_mode, dual_layer, video_opacity, updated_at)
             VALUES ('preview-song', 'mesh', 0, 1.0, 1);",
        )
        .await
        .expect("preview table should initialize");

        Migration
            .up(&manager)
            .await
            .expect("preview table should repair");
        assert!(
            manager
                .has_column("song_background_overrides", "override_enabled")
                .await
                .expect("column query should succeed")
        );
        assert_eq!(
            scalar_i64(
                &db,
                "SELECT override_enabled AS value FROM song_background_overrides
                 WHERE song_id = 'preview-song'",
            )
            .await,
            1,
        );
    }
}
