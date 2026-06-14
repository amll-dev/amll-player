pub mod m20260614_000001_init;
pub mod m20260614_000002_add_modified_at_and_playlist_song_sources;

use sea_orm_migration::prelude::*;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20260614_000001_init::Migration),
            Box::new(m20260614_000002_add_modified_at_and_playlist_song_sources::Migration),
        ]
    }
}
