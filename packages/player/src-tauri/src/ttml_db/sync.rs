use anyhow::{Context, Result};
use futures::{StreamExt as _, stream};
use reqwest::Client;
use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use tempfile::NamedTempFile;
use tracing::{info, warn};
use zip::read::ZipArchive;

use super::model::{IndexEntry, RemoteVersion, SyncResult, SyncStatus, TtmlEntry};
use super::reader::TtmlDbReader;
use super::writer::TtmlDbWriter;

const MIRROR_BASE: &str = "https://amlldb.bikonoo.com";
const INCREMENTAL_THRESHOLD: usize = 200;
const CONCURRENT_WORKERS: usize = 20;

pub struct LyricSyncer {
    data_dir: PathBuf,
    writer: TtmlDbWriter,
    reader: Option<TtmlDbReader>,
    client: Client,
}

impl LyricSyncer {
    pub fn new(data_dir: PathBuf) -> Self {
        let index_file = data_dir.join("index.bin");
        let writer = TtmlDbWriter::new(index_file.clone());
        let reader = TtmlDbReader::new(&index_file).ok();

        // On Android, reqwest's default TLS backend is rustls-platform-verifier, which needs
        // JNI_OnLoad to store the JavaVM. Tauri does not call JNI_OnLoad for companion crates,
        // so we override the TLS config with a pre-built rustls config using WebPKI roots.
        #[cfg(target_os = "android")]
        let client = {
            let mut root_store = rustls::RootCertStore::empty();
            root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            let tls_config = rustls::ClientConfig::builder()
                .with_root_certificates(root_store)
                .with_no_client_auth();
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .use_preconfigured_tls(tls_config)
                .build()
                .unwrap_or_else(|_| reqwest::Client::new())
        };

        #[cfg(not(target_os = "android"))]
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        Self {
            data_dir,
            writer,
            reader,
            client,
        }
    }

    pub async fn sync(&mut self) -> Result<SyncResult> {
        let remote_version = self
            .fetch_remote_version()
            .await
            .context("Failed to fetch remote version during sync")?;
        let local_commit = self.get_local_commit();

        info!(
            "Local commit: {:?}, Remote commit: {}",
            local_commit.as_deref().unwrap_or("None"),
            &remote_version.commit[..7.min(remote_version.commit.len())]
        );

        if local_commit.as_deref() == Some(remote_version.commit.as_str()) {
            let local_count = self.get_local_count();
            if local_count > 0 {
                info!("Lyrics database is up to date, skipping sync.");
                return Ok(SyncResult {
                    status: SyncStatus::Skipped,
                    count: None,
                    error: None,
                    strategy: None,
                });
            }
        }

        let local_files = self
            .reader
            .as_ref()
            .map(|r| r.get_all_file_paths())
            .unwrap_or_default();

        info!("Local file count: {}", local_files.len());

        drop(self.reader.take());

        let result = if local_files.is_empty() {
            info!("No local data, performing full sync.");
            self.perform_full_sync().await?
        } else {
            info!("Attempting incremental sync.");
            match self.perform_incremental_sync(&local_files).await {
                Ok(result) => result,
                Err(e) => {
                    warn!("Incremental sync failed: {}, falling back to full sync", e);
                    self.perform_full_sync().await?
                }
            }
        };

        if result.status == SyncStatus::Updated {
            let _ = self.save_local_commit(&remote_version);
        }

        Ok(result)
    }

    async fn fetch_remote_version(&self) -> Result<RemoteVersion> {
        let url = format!("{}/raw-lyrics/version.json", MIRROR_BASE);
        info!("Fetching remote version from: {}", url);

        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .context("Failed to fetch remote version")?;

        if !resp.status().is_success() {
            anyhow::bail!("HTTP error: {}", resp.status());
        }

        resp.json::<RemoteVersion>()
            .await
            .context("Failed to parse remote version")
    }

    fn get_local_commit(&self) -> Option<String> {
        let version_file = self.data_dir.join("version.json");
        if let Ok(content) = std::fs::read_to_string(&version_file)
            && let Ok(version) = serde_json::from_str::<RemoteVersion>(&content)
        {
            return Some(version.commit);
        }
        None
    }

    fn save_local_commit(&self, version: &RemoteVersion) -> Result<(), String> {
        let version_file = self.data_dir.join("version.json");
        let content = serde_json::to_string_pretty(version)
            .map_err(|e| format!("Failed to serialize version: {e}"))?;
        std::fs::write(&version_file, content)
            .map_err(|e| format!("Failed to write version file: {e}"))?;
        Ok(())
    }

    fn get_local_count(&self) -> usize {
        self.reader
            .as_ref()
            .map(|r| r.get_entry_count())
            .unwrap_or(0)
    }

    async fn perform_full_sync(&self) -> Result<SyncResult> {
        let url = format!("{}/raw-lyrics/raw-lyrics.zip", MIRROR_BASE);
        info!("Downloading full lyrics archive from: {}", url);

        let mut resp = self
            .client
            .get(&url)
            .send()
            .await
            .context("Failed to download zip")?;

        if !resp.status().is_success() {
            anyhow::bail!("HTTP error downloading zip: {}", resp.status());
        }

        let mut temp_file = NamedTempFile::new().context("Failed to create temp file")?;

        let mut downloaded_bytes = 0;
        while let Some(chunk) = resp.chunk().await.context("Failed to read chunk")? {
            temp_file
                .write_all(&chunk)
                .context("Failed to write to temp file")?;
            downloaded_bytes += chunk.len();
        }

        info!("Downloaded {downloaded_bytes} bytes to temp file, parsing zip archive...",);

        temp_file
            .seek(SeekFrom::Start(0))
            .context("Failed to seek temp file")?;

        let writer_clone = self.writer.clone();

        let sync_result = tokio::task::spawn_blocking(move || -> Result<SyncResult> {
            let mut archive =
                ZipArchive::new(temp_file.as_file()).context("Failed to open zip archive")?;

            let mut parsed_entries = Vec::new();
            let mut errors = 0;

            for i in 0..archive.len() {
                let mut file = archive.by_index(i).context("Failed to read zip entry")?;

                if file.name().ends_with(".ttml") && !file.is_dir() {
                    let mut content = String::new();
                    if let Err(e) = file.read_to_string(&mut content) {
                        warn!("Failed to read {}: {}", file.name(), e);
                        errors += 1;
                        continue;
                    }

                    match ttml_processor::parse_ttml(&content) {
                        Ok(result) => {
                            let entry =
                                TtmlEntry::from_result(file.name().to_string(), content, result);
                            parsed_entries.push(entry);
                        }
                        Err(e) => {
                            warn!("Failed to parse {}: {:?}", file.name(), e);
                            errors += 1;
                        }
                    }
                }
            }

            info!(
                "Parsed {} entries from zip archive ({} errors)",
                parsed_entries.len(),
                errors
            );

            if parsed_entries.is_empty() {
                return Ok(SyncResult {
                    status: SyncStatus::Empty,
                    count: Some(0),
                    error: None,
                    strategy: Some("full".to_string()),
                });
            }

            writer_clone
                .overwrite_entries(&parsed_entries)
                .context("Failed to write database")?;

            Ok(SyncResult {
                status: SyncStatus::Updated,
                count: Some(parsed_entries.len()),
                error: None,
                strategy: Some("full".to_string()),
            })
        })
        .await
        .context("Blocking task panicked")??;

        Ok(sync_result)
    }

    async fn perform_incremental_sync(&self, local_files: &HashSet<String>) -> Result<SyncResult> {
        let url = format!("{}/metadata/raw-lyrics-index.jsonl", MIRROR_BASE);
        info!("Downloading remote index from: {url}");

        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .context("Failed to download index")?;

        if !resp.status().is_success() {
            anyhow::bail!(format!("HTTP error downloading index: {}", resp.status()));
        }

        let index_text = resp.text().await.context("Failed to read index text")?;

        let remote_files: HashSet<String> = index_text
            .lines()
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| match serde_json::from_str::<IndexEntry>(line) {
                Ok(entry) => Some(entry.raw_lyric_file),
                Err(e) => {
                    warn!("Failed to parse index line: {e}");
                    None
                }
            })
            .collect();

        info!(
            "Remote files: {}, Local files: {}",
            remote_files.len(),
            local_files.len()
        );

        let to_download: Vec<String> = remote_files.difference(local_files).cloned().collect();

        info!("Files to download: {}", to_download.len());

        if to_download.len() > INCREMENTAL_THRESHOLD {
            info!(
                "Too many files to download ({} > {}), use full sync",
                to_download.len(),
                INCREMENTAL_THRESHOLD
            );
            anyhow::bail!("Too many files to download".to_string());
        }

        if to_download.is_empty() {
            info!("No new files to download.");
            return Ok(SyncResult {
                status: SyncStatus::Skipped,
                count: Some(0),
                error: None,
                strategy: Some("incremental".to_string()),
            });
        }

        info!("Downloading for {} files...", to_download.len());

        let client = self.client.clone();
        let mirror_base = MIRROR_BASE.to_string();

        let entries: Vec<TtmlEntry> = stream::iter(to_download)
            .map(|file_name| {
                let client = client.clone();
                let mirror_base = mirror_base.clone();

                async move {
                    let url = format!("{}/raw-lyrics/{}", mirror_base, file_name);
                    match client.get(&url).send().await {
                        Ok(resp) if resp.status().is_success() => match resp.text().await {
                            Ok(content) => match ttml_processor::parse_ttml(&content) {
                                Ok(result) => {
                                    Some(TtmlEntry::from_result(file_name, content, result))
                                }
                                Err(e) => {
                                    warn!("Failed to parse {file_name}: {e:?}");
                                    None
                                }
                            },
                            Err(e) => {
                                warn!("Failed to read text {file_name}: {e}");
                                None
                            }
                        },
                        Ok(resp) => {
                            warn!("HTTP error {}: {}", file_name, resp.status());
                            None
                        }
                        Err(e) => {
                            warn!("Download failed {file_name}: {e}");
                            None
                        }
                    }
                }
            })
            .buffer_unordered(CONCURRENT_WORKERS)
            .filter_map(|entry_opt| async move { entry_opt })
            .collect()
            .await;

        info!(
            "Successfully downloaded and parsed {} entries",
            entries.len()
        );

        if entries.is_empty() {
            return Ok(SyncResult {
                status: SyncStatus::Empty,
                count: Some(0),
                error: None,
                strategy: Some("incremental".to_string()),
            });
        }

        self.writer
            .append_entries(&entries)
            .context("Failed to append entries")?;

        Ok(SyncResult {
            status: SyncStatus::Updated,
            count: Some(entries.len()),
            error: None,
            strategy: Some("incremental".to_string()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_version_management() {
        let temp_dir = tempdir().unwrap();
        let syncer = LyricSyncer::new(temp_dir.path().to_path_buf());

        assert!(syncer.get_local_commit().is_none());

        let version = RemoteVersion {
            build_date: "2024-01-01".to_string(),
            commit: "abc123".to_string(),
            file_count: 100,
            timestamp: 1704067200,
        };
        syncer.save_local_commit(&version).unwrap();

        let local_commit = syncer.get_local_commit();
        assert_eq!(local_commit.as_deref(), Some("abc123"));
    }
}
