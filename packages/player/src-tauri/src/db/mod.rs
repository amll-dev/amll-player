pub mod cleanup;
pub mod commands;
pub mod entity;
pub mod import;
pub mod migrate;
pub mod migration;
pub mod refresh;
pub mod rhythm;
pub mod rhythm_precache;
pub mod scanner;
pub mod song_background_override;
pub mod utils;
pub mod video_background;

use sea_orm::{Database, DatabaseConnection};
use tauri::AppHandle;
use tauri::Manager;
use tauri::path::BaseDirectory;

pub type DbConnection = DatabaseConnection;

pub async fn init_database(app: &AppHandle) -> Result<DatabaseConnection, String> {
    let db_path = app
        .path()
        .resolve("amll-player.db", BaseDirectory::AppData)
        .map_err(|e| format!("Failed to resolve database path: {e}"))?;

    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create database directory: {e}"))?;
    }

    let db_url = format!("sqlite:{}?mode=rwc", db_path.display());

    let db = Database::connect(&db_url)
        .await
        .map_err(|e| format!("Failed to connect to database: {e}"))?;

    migration::run_migrations(&db)
        .await
        .map_err(|e| format!("Failed to run migrations: {e}"))?;

    Ok(db)
}
