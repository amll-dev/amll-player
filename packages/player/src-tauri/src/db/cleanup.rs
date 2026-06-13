use std::collections::HashSet;
use std::path::Path;

use sea_orm::EntityTrait;
use serde::Serialize;
use tauri::{AppHandle, State};
use tracing::{info, warn};

use crate::db::DbConnection;
use crate::db::entity::{playlist, song};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverGcResult {
    pub total_scanned: u32,
    pub deleted: u32,
    pub errors: Vec<String>,
}

async fn collect_referenced_covers(
    db: &sea_orm::DatabaseConnection,
) -> Result<HashSet<String>, String> {
    let mut referenced = HashSet::new();

    for s in song::Entity::find()
        .all(db)
        .await
        .map_err(|e| format!("Failed to query songs: {e}"))?
    {
        if let Some(ref path) = s.cover_path
            && let Some(name) = Path::new(path).file_name()
        {
            referenced.insert(name.to_string_lossy().to_string());
        }
    }

    for p in playlist::Entity::find()
        .all(db)
        .await
        .map_err(|e| format!("Failed to query playlists: {e}"))?
    {
        if let Some(ref path) = p.cover_path
            && let Some(name) = Path::new(path).file_name()
        {
            referenced.insert(name.to_string_lossy().to_string());
        }
    }

    Ok(referenced)
}

pub async fn run_cover_gc(
    db: &sea_orm::DatabaseConnection,
    app: &AppHandle,
) -> Result<CoverGcResult, String> {
    let covers_dir = crate::get_covers_dir(app)?;

    if !covers_dir.exists() {
        return Ok(CoverGcResult {
            total_scanned: 0,
            deleted: 0,
            errors: Vec::new(),
        });
    }

    let referenced = collect_referenced_covers(db).await?;

    let mut total_scanned = 0u32;
    let mut deleted = 0u32;
    let mut errors = Vec::new();

    let entries = std::fs::read_dir(&covers_dir)
        .map_err(|e| format!("Failed to read covers directory: {e}"))?;

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                warn!("[CoverGC] Failed to read directory entry: {e}");
                continue;
            }
        };

        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(e) => {
                warn!("[CoverGC] Failed to get file type: {e}");
                continue;
            }
        };

        if !file_type.is_file() {
            continue;
        }

        total_scanned += 1;
        let file_name = entry.file_name().to_string_lossy().to_string();

        if !referenced.contains(&file_name) {
            let path = entry.path();
            match std::fs::remove_file(&path) {
                Ok(()) => {
                    info!("[CoverGC] Deleted orphaned cover: {}", path.display());
                    deleted += 1;
                }
                Err(e) => {
                    warn!("[CoverGC] Failed to delete {}: {e}", path.display());
                    errors.push(path.to_string_lossy().to_string());
                }
            }
        }
    }

    info!("[CoverGC] Completed: scanned {total_scanned}, deleted {deleted} orphaned covers",);

    Ok(CoverGcResult {
        total_scanned,
        deleted,
        errors,
    })
}

#[tauri::command]
pub async fn cleanup_orphaned_covers(
    db: State<'_, DbConnection>,
    app: AppHandle,
) -> Result<CoverGcResult, String> {
    run_cover_gc(&db, &app).await
}
