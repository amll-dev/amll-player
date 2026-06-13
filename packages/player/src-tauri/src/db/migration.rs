use sea_orm::{ConnectionTrait, Schema};

use super::DbConnection;

pub async fn run_migrations(db: &DbConnection) -> Result<(), sea_orm::DbErr> {
    create_playlists_table(db).await?;
    create_songs_table(db).await?;
    create_playlist_songs_table(db).await?;
    Ok(())
}

async fn create_playlists_table(db: &DbConnection) -> Result<(), sea_orm::DbErr> {
    let builder = db.get_database_backend();
    let schema = Schema::new(builder);
    let mut stmt = schema.create_table_from_entity(super::entity::PlaylistEntity);
    stmt.if_not_exists();
    db.execute(builder.build(&stmt)).await?;
    Ok(())
}

async fn create_songs_table(db: &DbConnection) -> Result<(), sea_orm::DbErr> {
    let builder = db.get_database_backend();
    let schema = Schema::new(builder);
    let mut stmt = schema.create_table_from_entity(super::entity::SongEntity);
    stmt.if_not_exists();
    db.execute(builder.build(&stmt)).await?;
    Ok(())
}

async fn create_playlist_songs_table(db: &DbConnection) -> Result<(), sea_orm::DbErr> {
    let builder = db.get_database_backend();
    let schema = Schema::new(builder);
    let mut stmt = schema.create_table_from_entity(super::entity::PlaylistSongsEntity);
    stmt.if_not_exists();
    db.execute(builder.build(&stmt)).await?;
    Ok(())
}
