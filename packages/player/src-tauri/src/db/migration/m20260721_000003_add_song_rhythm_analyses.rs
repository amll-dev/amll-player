use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(SongRhythmAnalyses::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(SongRhythmAnalyses::SongId)
                            .string()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(SongRhythmAnalyses::AnalyzerVersion)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SongRhythmAnalyses::SourceModifiedAt)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SongRhythmAnalyses::SourceFileSize)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SongRhythmAnalyses::AnalyzedAt)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SongRhythmAnalyses::PayloadJson)
                            .text()
                            .not_null(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_song_rhythm_analysis_song")
                            .from(SongRhythmAnalyses::Table, SongRhythmAnalyses::SongId)
                            .to(Songs::Table, Songs::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(
                Table::drop()
                    .table(SongRhythmAnalyses::Table)
                    .to_owned(),
            )
            .await?;
        Ok(())
    }
}

#[derive(DeriveIden)]
enum SongRhythmAnalyses {
    Table,
    SongId,
    AnalyzerVersion,
    SourceModifiedAt,
    SourceFileSize,
    AnalyzedAt,
    PayloadJson,
}

#[derive(DeriveIden)]
enum Songs {
    Table,
    Id,
}
