use sea_orm_migration::prelude::*;

pub const PLAYLIST_SONG_UNIQUE_INDEX: &str = "uq_playlist_songs_playlist_song";
pub const MANUAL_SOURCE_UNIQUE_INDEX: &str = "uq_playlist_song_sources_manual";

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let connection = manager.get_connection();

        if !manager
            .has_index("playlist_songs", PLAYLIST_SONG_UNIQUE_INDEX)
            .await?
        {
            // Preserve the relation that appears earliest in the playlist. Its
            // numeric id is only used as a deterministic tie-breaker.
            connection
                .execute_unprepared(
                    "DELETE FROM playlist_songs AS duplicate
                     WHERE EXISTS (
                         SELECT 1
                         FROM playlist_songs AS preferred
                         WHERE preferred.playlist_id = duplicate.playlist_id
                           AND preferred.song_id = duplicate.song_id
                           AND (
                               preferred.added_at < duplicate.added_at
                               OR (
                                   preferred.added_at = duplicate.added_at
                                   AND preferred.id < duplicate.id
                               )
                           )
                     )",
                )
                .await?;
            connection
                .execute_unprepared(&format!(
                    "CREATE UNIQUE INDEX {PLAYLIST_SONG_UNIQUE_INDEX}
                     ON playlist_songs (playlist_id, song_id)"
                ))
                .await?;
        }

        if !manager
            .has_index("playlist_song_sources", MANUAL_SOURCE_UNIQUE_INDEX)
            .await?
        {
            // SQLite treats NULL values as distinct in a normal UNIQUE index,
            // so legacy manual(NULL) rows need a dedicated partial index.
            connection
                .execute_unprepared(
                    "DELETE FROM playlist_song_sources
                     WHERE source_type = 'manual'
                       AND source_id IS NULL
                       AND id NOT IN (
                           SELECT MIN(id)
                           FROM playlist_song_sources
                           WHERE source_type = 'manual'
                             AND source_id IS NULL
                           GROUP BY playlist_id, song_id
                       )",
                )
                .await?;
            connection
                .execute_unprepared(&format!(
                    "CREATE UNIQUE INDEX {MANUAL_SOURCE_UNIQUE_INDEX}
                     ON playlist_song_sources (playlist_id, song_id)
                     WHERE source_type = 'manual' AND source_id IS NULL"
                ))
                .await?;
        }

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(&format!(
                "DROP INDEX IF EXISTS {MANUAL_SOURCE_UNIQUE_INDEX};
                 DROP INDEX IF EXISTS {PLAYLIST_SONG_UNIQUE_INDEX};"
            ))
            .await?;
        Ok(())
    }
}
