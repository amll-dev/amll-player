use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let has_column = manager.has_column("songs", "modified_at").await?;

        if !has_column {
            manager
                .alter_table(
                    Table::alter()
                        .table(Songs::Table)
                        .add_column(ColumnDef::new(Songs::ModifiedAt).big_integer().null())
                        .to_owned(),
                )
                .await?;
        }

        manager
            .create_table(
                Table::create()
                    .table(PlaylistSongSources::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(PlaylistSongSources::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(PlaylistSongSources::PlaylistId)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PlaylistSongSources::SongId)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PlaylistSongSources::SourceType)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PlaylistSongSources::SourceId)
                            .integer()
                            .null(),
                    )
                    .index(
                        Index::create()
                            .unique()
                            .col(PlaylistSongSources::PlaylistId)
                            .col(PlaylistSongSources::SongId)
                            .col(PlaylistSongSources::SourceType)
                            .col(PlaylistSongSources::SourceId)
                            .name("uq_playlist_song_source"),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .get_connection()
            .execute_unprepared(
                "INSERT OR IGNORE INTO playlist_song_sources (playlist_id, song_id, source_type, source_id)
                 SELECT playlist_id, song_id, 'manual', NULL FROM playlist_songs",
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(PlaylistSongSources::Table).to_owned())
            .await?;

        let has_column = manager.has_column("songs", "modified_at").await?;

        if has_column {
            manager
                .alter_table(
                    Table::alter()
                        .table(Songs::Table)
                        .drop_column(Songs::ModifiedAt)
                        .to_owned(),
                )
                .await?;
        }

        Ok(())
    }
}

#[derive(DeriveIden)]
enum Songs {
    Table,
    ModifiedAt,
}

#[derive(DeriveIden)]
enum PlaylistSongSources {
    Table,
    Id,
    PlaylistId,
    SongId,
    SourceType,
    SourceId,
}
