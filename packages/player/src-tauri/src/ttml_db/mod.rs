pub mod model;
pub mod reader;
pub mod sync;
pub mod writer;

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::AppHandle;
use tauri::Manager;
use tauri::path::BaseDirectory;
use tokio::sync::RwLock;

use self::reader::TtmlDbReader;

pub type LyricDbReader = Arc<RwLock<Option<TtmlDbReader>>>;

pub fn create_shared_reader() -> LyricDbReader {
    Arc::new(RwLock::new(None))
}

pub fn get_lyric_db_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resolve("lyric-db", BaseDirectory::AppData)
        .map_err(|e| format!("Failed to resolve lyric-db dir: {e}"))
}

pub fn get_index_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let db_dir = get_lyric_db_dir(app)?;
    Ok(db_dir.join("index.bin"))
}

pub async fn refresh_shared_reader(
    reader_state: &LyricDbReader,
    index_file: &Path,
) -> Result<(), String> {
    let new_reader =
        TtmlDbReader::new(index_file).map_err(|e| format!("Failed to create reader: {e}"))?;

    let mut writer = reader_state.write().await;
    *writer = Some(new_reader);

    Ok(())
}

pub async fn get_or_create_reader(
    reader_state: &LyricDbReader,
    index_file: &Path,
) -> Result<(), String> {
    let reader = reader_state.read().await;
    if reader.is_some() {
        return Ok(());
    }
    drop(reader);

    refresh_shared_reader(reader_state, index_file).await
}
