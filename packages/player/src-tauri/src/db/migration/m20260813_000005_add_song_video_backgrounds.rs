use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(SongVideoBackgrounds::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(SongVideoBackgrounds::SongId)
                            .string()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(SongVideoBackgrounds::AssetId)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SongVideoBackgrounds::MimeType)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SongVideoBackgrounds::DurationMs)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SongVideoBackgrounds::Width)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SongVideoBackgrounds::Height)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SongVideoBackgrounds::FitMode)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SongVideoBackgrounds::InPointMs)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SongVideoBackgrounds::OutPointMs)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SongVideoBackgrounds::LoopEnabled)
                            .boolean()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SongVideoBackgrounds::SyncOnSeek)
                            .boolean()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SongVideoBackgrounds::UpdatedAt)
                            .big_integer()
                            .not_null(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_song_video_background_song")
                            .from(SongVideoBackgrounds::Table, SongVideoBackgrounds::SongId)
                            .to(Songs::Table, Songs::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .check(
                        Expr::col(SongVideoBackgrounds::MimeType)
                            .is_in(["video/mp4", "video/webm"]),
                    )
                    .check(
                        Expr::col(SongVideoBackgrounds::FitMode)
                            .is_in(["cover", "contain", "fill"]),
                    )
                    .check(Expr::col(SongVideoBackgrounds::DurationMs).gt(0))
                    .check(Expr::col(SongVideoBackgrounds::Width).gt(0))
                    .check(Expr::col(SongVideoBackgrounds::Height).gt(0))
                    .check(Expr::col(SongVideoBackgrounds::InPointMs).gte(0))
                    .check(
                        Expr::col(SongVideoBackgrounds::OutPointMs)
                            .gt(Expr::col(SongVideoBackgrounds::InPointMs)),
                    )
                    .check(
                        Expr::col(SongVideoBackgrounds::OutPointMs)
                            .lte(Expr::col(SongVideoBackgrounds::DurationMs)),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_song_video_background_asset")
                    .table(SongVideoBackgrounds::Table)
                    .col(SongVideoBackgrounds::AssetId)
                    .if_not_exists()
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(SongVideoBackgrounds::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum SongVideoBackgrounds {
    Table,
    SongId,
    AssetId,
    MimeType,
    DurationMs,
    Width,
    Height,
    FitMode,
    InPointMs,
    OutPointMs,
    LoopEnabled,
    SyncOnSeek,
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
    use crate::db::migration::m20260614_000001_init;

    async fn scalar_i64(db: &sea_orm::DatabaseConnection, sql: &str) -> i64 {
        db.query_one(Statement::from_string(DbBackend::Sqlite, sql))
            .await
            .expect("query should succeed")
            .expect("query should return one row")
            .try_get("", "value")
            .expect("value should be an integer")
    }

    #[tokio::test]
    async fn migration_is_idempotent_enforces_checks_and_cascades_with_song() {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("in-memory SQLite should open");
        let manager = SchemaManager::new(&db);
        m20260614_000001_init::Migration
            .up(&manager)
            .await
            .expect("base songs table should initialize");
        Migration
            .up(&manager)
            .await
            .expect("video background table should initialize");
        Migration
            .up(&manager)
            .await
            .expect("video background migration should be idempotent");

        assert_eq!(
            scalar_i64(
                &db,
                "SELECT COUNT(*) AS value FROM sqlite_master
                 WHERE type = 'table' AND name = 'song_video_backgrounds'",
            )
            .await,
            1
        );
        assert_eq!(
            scalar_i64(
                &db,
                "SELECT COUNT(*) AS value FROM sqlite_master
                 WHERE type = 'index' AND name = 'idx_song_video_background_asset'",
            )
            .await,
            1
        );

        db.execute_unprepared(
            "INSERT INTO songs
             (id, file_path, song_name, song_artists, song_album, duration, lyric_format, lyric)
             VALUES ('song-1', 'song.flac', 'Song', 'Artist', 'Album', 1.0, 'lrc', '')",
        )
        .await
        .expect("song fixture should insert");
        db.execute_unprepared(
            "INSERT INTO song_video_backgrounds
             (song_id, asset_id, mime_type, duration_ms, width, height, fit_mode,
              in_point_ms, out_point_ms, loop_enabled, sync_on_seek, updated_at)
             VALUES
             ('song-1', 'asset.mp4', 'video/mp4', 1000, 1920, 1080, 'cover',
              0, 1000, 1, 1, 1)",
        )
        .await
        .expect("valid background fixture should insert");

        assert!(
            db.execute_unprepared(
                "UPDATE song_video_backgrounds SET fit_mode = 'crop' WHERE song_id = 'song-1'",
            )
            .await
            .is_err()
        );
        assert!(
            db.execute_unprepared(
                "UPDATE song_video_backgrounds SET out_point_ms = 1001
                 WHERE song_id = 'song-1'",
            )
            .await
            .is_err()
        );

        db.execute_unprepared("DELETE FROM songs WHERE id = 'song-1'")
            .await
            .expect("song should delete");
        assert_eq!(
            scalar_i64(&db, "SELECT COUNT(*) AS value FROM song_video_backgrounds",).await,
            0,
            "song deletion should cascade to its video background mapping"
        );
    }
}
