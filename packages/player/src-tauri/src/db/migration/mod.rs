pub mod m20260614_000001_init;
pub mod m20260614_000002_add_modified_at_and_playlist_song_sources;
pub mod m20260721_000003_add_song_rhythm_analyses;
pub mod m20260728_000004_add_playlist_import_constraints;
pub mod m20260813_000005_add_song_video_backgrounds;
pub mod m20260820_000006_add_song_background_overrides;
pub mod m20260820_000007_add_video_base_background;
pub mod m20260910_000008_add_background_renderer_options;

use sea_orm::{ConnectionTrait, DatabaseConnection, TransactionTrait};
use sea_orm_migration::prelude::*;

const RHYTHM_MIGRATION_NAME: &str = "m20260721_000003_add_song_rhythm_analyses";

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        // Keep this default ledger frozen at the last schema understood by
        // +1127. Rebuildable/new state must not add versions here, otherwise
        // opening this database with that build becomes a fatal downgrade.
        vec![
            Box::new(m20260614_000001_init::Migration),
            Box::new(m20260614_000002_add_modified_at_and_playlist_song_sources::Migration),
        ]
    }
}

/// Apply the persistent library migrations while keeping their ledger readable
/// by player builds that predate the rebuildable rhythm-analysis cache.
pub async fn run_migrations(db: &DatabaseConnection) -> Result<(), DbErr> {
    let transaction = db.begin().await?;
    let migration_result = async {
        Migrator::install(&transaction).await?;
        let remove_legacy_rhythm_marker = format!(
            "DELETE FROM \"seaql_migrations\" WHERE \"version\" = '{RHYTHM_MIGRATION_NAME}'"
        );
        transaction
            .execute_unprepared(&remove_legacy_rhythm_marker)
            .await?;
        Migrator::up(&transaction, None).await?;

        // Rhythm analyses are a rebuildable cache. Keep this migration
        // idempotent and ensure its schema directly instead of exposing its
        // version in the legacy migration ledger.
        let manager = SchemaManager::new(&transaction);
        m20260721_000003_add_song_rhythm_analyses::Migration
            .up(&manager)
            .await?;

        // These indexes are compatible with the legacy schema, but keeping
        // them out of seaql_migrations lets older player builds reopen the DB.
        m20260728_000004_add_playlist_import_constraints::Migration
            .up(&manager)
            .await?;

        // Song video backgrounds are persistent user state, but their schema is
        // ensured outside the legacy ledger so older builds can still reopen the
        // library database and simply ignore this table.
        m20260813_000005_add_song_video_backgrounds::Migration
            .up(&manager)
            .await?;

        // Per-song renderer overrides are persistent user state and remain out
        // of the frozen legacy ledger for the same downgrade-compatibility
        // reason as video background assets.
        m20260820_000006_add_song_background_overrides::Migration
            .up(&manager)
            .await?;

        // Video mode keeps its own base renderer so per-song composition never
        // mutates or implicitly follows the global lyric background setting.
        m20260820_000007_add_video_base_background::Migration
            .up(&manager)
            .await?;

        m20260910_000008_add_background_renderer_options::Migration
            .up(&manager)
            .await?;

        Ok::<(), DbErr>(())
    }
    .await;

    if let Err(error) = migration_result {
        transaction.rollback().await?;
        return Err(error);
    }

    transaction.commit().await
}

#[cfg(test)]
mod tests {
    use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};

    use super::*;

    const LEGACY_MIGRATION_NAMES: [&str; 2] = [
        "m20260614_000001_init",
        "m20260614_000002_add_modified_at_and_playlist_song_sources",
    ];
    const FUTURE_MIGRATION_NAME: &str = "m20990101_000004_future_schema";

    struct LegacyMigrator;

    #[async_trait::async_trait]
    impl MigratorTrait for LegacyMigrator {
        fn migrations() -> Vec<Box<dyn MigrationTrait>> {
            vec![
                Box::new(m20260614_000001_init::Migration),
                Box::new(m20260614_000002_add_modified_at_and_playlist_song_sources::Migration),
            ]
        }
    }

    /// Reproduces the migration chain shipped by builds that first introduced
    /// rhythm analysis through the default ledger.
    struct TaintedMigrator;

    #[async_trait::async_trait]
    impl MigratorTrait for TaintedMigrator {
        fn migrations() -> Vec<Box<dyn MigrationTrait>> {
            vec![
                Box::new(m20260614_000001_init::Migration),
                Box::new(m20260614_000002_add_modified_at_and_playlist_song_sources::Migration),
                Box::new(m20260721_000003_add_song_rhythm_analyses::Migration),
            ]
        }
    }

    async fn scalar_i64(db: &DatabaseConnection, sql: &str) -> i64 {
        db.query_one(Statement::from_string(DbBackend::Sqlite, sql))
            .await
            .expect("query should succeed")
            .expect("query should return one row")
            .try_get("", "value")
            .expect("value should be an integer")
    }

    async fn migration_versions(db: &DatabaseConnection) -> Vec<String> {
        db.query_all(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT version FROM seaql_migrations ORDER BY version",
        ))
        .await
        .expect("migration versions should be readable")
        .into_iter()
        .map(|row| {
            row.try_get("", "version")
                .expect("migration version should be text")
        })
        .collect()
    }

    async fn assert_legacy_ledger(db: &DatabaseConnection) {
        assert_eq!(
            migration_versions(db).await,
            LEGACY_MIGRATION_NAMES
                .into_iter()
                .map(str::to_owned)
                .collect::<Vec<_>>(),
        );
    }

    async fn assert_rhythm_table_exists(db: &DatabaseConnection) {
        assert_eq!(
            scalar_i64(
                db,
                "SELECT COUNT(*) AS value FROM sqlite_master \
                 WHERE type = 'table' AND name = 'song_rhythm_analyses'",
            )
            .await,
            1,
        );
    }

    async fn insert_song_and_cache(db: &DatabaseConnection) {
        db.execute_unprepared(
            "INSERT INTO songs (id, file_path, song_name, song_artists, song_album, \
             duration, lyric_format, lyric) VALUES \
             ('song-1', 'song.flac', 'Song', 'Artist', 'Album', 180.0, 'lrc', '')",
        )
        .await
        .expect("song fixture should insert");
        db.execute_unprepared(
            "INSERT INTO song_rhythm_analyses \
             (song_id, analyzer_version, source_modified_at, source_file_size, \
              analyzed_at, payload_json) VALUES \
             ('song-1', 1, 100, 200, 300, '{\"beats\":[1.0]}')",
        )
        .await
        .expect("rhythm cache fixture should insert");
    }

    #[tokio::test]
    async fn fresh_database_round_trips_between_new_and_legacy_migrators() {
        let temp_dir = tempfile::tempdir().expect("temporary database directory should exist");
        let database_path = temp_dir.path().join("library.db");
        let database_url = format!(
            "sqlite://{}?mode=rwc",
            database_path.to_string_lossy().replace('\\', "/")
        );

        let db = Database::connect(database_url.as_str())
            .await
            .expect("file-backed SQLite should open");

        run_migrations(&db)
            .await
            .expect("new migrations should initialize a fresh database");
        insert_song_and_cache(&db).await;
        assert_legacy_ledger(&db).await;
        assert_rhythm_table_exists(&db).await;
        assert_eq!(
            scalar_i64(
                &db,
                "SELECT COUNT(*) AS value FROM sqlite_master \
                 WHERE type = 'table' AND name = 'seaql_rhythm_migrations'",
            )
            .await,
            0,
        );
        db.close()
            .await
            .expect("new database connection should close");

        let legacy_db = Database::connect(database_url.as_str())
            .await
            .expect("legacy connection should reopen the database");
        LegacyMigrator::up(&legacy_db, None)
            .await
            .expect("legacy migrator should accept the new database");
        assert_eq!(
            scalar_i64(
                &legacy_db,
                "SELECT COUNT(*) AS value FROM song_rhythm_analyses \
                 WHERE song_id = 'song-1' AND payload_json = '{\"beats\":[1.0]}'",
            )
            .await,
            1,
        );
        legacy_db
            .close()
            .await
            .expect("legacy database connection should close");

        let reopened_db = Database::connect(database_url.as_str())
            .await
            .expect("new connection should reopen the legacy-checked database");
        run_migrations(&reopened_db)
            .await
            .expect("new migrations should remain usable after the legacy migrator");
        assert_legacy_ledger(&reopened_db).await;
        assert_eq!(
            scalar_i64(
                &reopened_db,
                "SELECT COUNT(*) AS value FROM song_rhythm_analyses WHERE song_id = 'song-1'",
            )
            .await,
            1,
        );
        reopened_db
            .close()
            .await
            .expect("reopened database connection should close");
    }

    #[tokio::test]
    async fn legacy_database_upgrade_is_idempotent_and_remains_downgrade_safe() {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("in-memory SQLite should open");

        LegacyMigrator::up(&db, None)
            .await
            .expect("legacy migrations should initialize the database");
        run_migrations(&db)
            .await
            .expect("new migrations should upgrade the legacy database");
        run_migrations(&db)
            .await
            .expect("new migrations should be idempotent");
        LegacyMigrator::up(&db, None)
            .await
            .expect("legacy migrator should still accept the upgraded database");

        assert_legacy_ledger(&db).await;
        assert_rhythm_table_exists(&db).await;
    }

    #[tokio::test]
    async fn tainted_ledger_is_repaired_without_losing_rhythm_cache() {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("in-memory SQLite should open");

        TaintedMigrator::up(&db, None)
            .await
            .expect("tainted migration chain should initialize the database");
        insert_song_and_cache(&db).await;
        assert!(
            migration_versions(&db)
                .await
                .contains(&RHYTHM_MIGRATION_NAME.to_owned())
        );

        run_migrations(&db)
            .await
            .expect("new migrations should repair the tainted ledger");
        run_migrations(&db)
            .await
            .expect("ledger repair should be idempotent");

        assert_legacy_ledger(&db).await;
        assert_eq!(
            scalar_i64(
                &db,
                "SELECT COUNT(*) AS value FROM song_rhythm_analyses \
                 WHERE song_id = 'song-1' AND payload_json = '{\"beats\":[1.0]}'",
            )
            .await,
            1,
        );
        LegacyMigrator::up(&db, None)
            .await
            .expect("legacy migrator should accept the repaired database");
    }

    #[tokio::test]
    async fn unknown_future_marker_is_rejected_without_partial_ledger_repair() {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("in-memory SQLite should open");

        TaintedMigrator::up(&db, None)
            .await
            .expect("tainted migration chain should initialize the database");
        db.execute_unprepared(&format!(
            "INSERT INTO seaql_migrations (version, applied_at) \
             VALUES ('{FUTURE_MIGRATION_NAME}', 1)"
        ))
        .await
        .expect("future migration marker should insert");
        let versions_before = migration_versions(&db).await;

        let error = run_migrations(&db)
            .await
            .expect_err("unknown future migration should remain an error");

        assert!(error.to_string().contains(FUTURE_MIGRATION_NAME));
        assert_eq!(migration_versions(&db).await, versions_before);
        assert!(
            migration_versions(&db)
                .await
                .contains(&RHYTHM_MIGRATION_NAME.to_owned())
        );
    }

    #[tokio::test]
    async fn import_constraints_deduplicate_legacy_rows_and_remain_downgrade_safe() {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("in-memory SQLite should open");
        LegacyMigrator::up(&db, None)
            .await
            .expect("legacy migrations should initialize the database");

        db.execute_unprepared(
            "INSERT INTO playlists
             (id, name, create_time, update_time, play_time)
             VALUES (1, 'Playlist', 0, 0, 0);
             INSERT INTO songs
             (id, file_path, song_name, song_artists, song_album, duration, lyric_format, lyric)
             VALUES ('song-1', 'song.flac', 'Song', '', '', 1.0, '', '');
             INSERT INTO playlist_songs (id, playlist_id, song_id, added_at)
             VALUES (2, 1, 'song-1', 100), (9, 1, 'song-1', 50);
             INSERT INTO playlist_song_sources
             (id, playlist_id, song_id, source_type, source_id)
             VALUES
                 (2, 1, 'song-1', 'manual', NULL),
                 (9, 1, 'song-1', 'manual', NULL);",
        )
        .await
        .expect("duplicate legacy fixtures should insert");

        run_migrations(&db)
            .await
            .expect("new migrations should add import constraints");
        run_migrations(&db)
            .await
            .expect("import constraints should remain idempotent");

        assert_eq!(
            scalar_i64(
                &db,
                "SELECT COUNT(*) AS value FROM playlist_songs
                 WHERE playlist_id = 1 AND song_id = 'song-1'",
            )
            .await,
            1,
        );
        assert_eq!(
            scalar_i64(
                &db,
                "SELECT added_at AS value FROM playlist_songs
                 WHERE playlist_id = 1 AND song_id = 'song-1'",
            )
            .await,
            50,
        );
        assert_eq!(
            scalar_i64(
                &db,
                "SELECT COUNT(*) AS value FROM playlist_song_sources
                 WHERE playlist_id = 1 AND song_id = 'song-1'
                   AND source_type = 'manual' AND source_id IS NULL",
            )
            .await,
            1,
        );
        assert_eq!(
            scalar_i64(
                &db,
                "SELECT COUNT(*) AS value FROM sqlite_master
                 WHERE type = 'index'
                   AND name IN (
                       'uq_playlist_songs_playlist_song',
                       'uq_playlist_song_sources_manual'
                   )",
            )
            .await,
            2,
        );

        assert!(
            db.execute_unprepared(
                "INSERT INTO playlist_songs (playlist_id, song_id, added_at)
                 VALUES (1, 'song-1', 200)",
            )
            .await
            .is_err(),
        );
        assert!(
            db.execute_unprepared(
                "INSERT INTO playlist_song_sources
                 (playlist_id, song_id, source_type, source_id)
                 VALUES (1, 'song-1', 'manual', NULL)",
            )
            .await
            .is_err(),
        );

        assert_legacy_ledger(&db).await;
        LegacyMigrator::up(&db, None)
            .await
            .expect("legacy migrator should accept the constraint-only upgrade");
    }
}
