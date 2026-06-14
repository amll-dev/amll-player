use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Playlists::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Playlists::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(Playlists::Name).string().not_null())
                    .col(
                        ColumnDef::new(Playlists::CreateTime)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Playlists::UpdateTime)
                            .big_integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(Playlists::PlayTime).big_integer().not_null())
                    .col(ColumnDef::new(Playlists::CoverPath).string().null())
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(Songs::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(Songs::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(Songs::FilePath).string().not_null())
                    .col(ColumnDef::new(Songs::SongName).string().not_null())
                    .col(ColumnDef::new(Songs::SongArtists).string().not_null())
                    .col(ColumnDef::new(Songs::SongAlbum).string().not_null())
                    .col(ColumnDef::new(Songs::Duration).double().not_null())
                    .col(ColumnDef::new(Songs::LyricFormat).string().not_null())
                    .col(ColumnDef::new(Songs::Lyric).string().not_null())
                    .col(ColumnDef::new(Songs::TranslatedLrc).string().null())
                    .col(ColumnDef::new(Songs::RomanLrc).string().null())
                    .col(ColumnDef::new(Songs::CoverPath).string().null())
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(PlaylistSongs::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(PlaylistSongs::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(PlaylistSongs::PlaylistId)
                            .integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(PlaylistSongs::SongId).string().not_null())
                    .col(
                        ColumnDef::new(PlaylistSongs::AddedAt)
                            .big_integer()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(PlaylistFolders::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(PlaylistFolders::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(PlaylistFolders::PlaylistId)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PlaylistFolders::FolderPath)
                            .string()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(PlaylistFolders::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(PlaylistSongs::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(Songs::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(Playlists::Table).to_owned())
            .await?;
        Ok(())
    }
}

#[derive(DeriveIden)]
enum Playlists {
    Table,
    Id,
    Name,
    CreateTime,
    UpdateTime,
    PlayTime,
    CoverPath,
}

#[derive(DeriveIden)]
enum Songs {
    Table,
    Id,
    FilePath,
    SongName,
    SongArtists,
    SongAlbum,
    Duration,
    LyricFormat,
    Lyric,
    TranslatedLrc,
    RomanLrc,
    CoverPath,
}

#[derive(DeriveIden)]
enum PlaylistSongs {
    Table,
    Id,
    PlaylistId,
    SongId,
    AddedAt,
}

#[derive(DeriveIden)]
enum PlaylistFolders {
    Table,
    Id,
    PlaylistId,
    FolderPath,
}
