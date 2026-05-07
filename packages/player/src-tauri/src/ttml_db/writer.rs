use anyhow::{Context, Result};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use tracing::info;

use super::model::TtmlEntry;

const BLOCK_MAGIC: [u8; 4] = *b"ttml";

#[derive(Clone)]
pub struct TtmlDbWriter {
    file_path: PathBuf,
}

impl TtmlDbWriter {
    pub fn new(file_path: PathBuf) -> Self {
        Self { file_path }
    }

    fn serialize_payload(entries: &[TtmlEntry]) -> Result<(Vec<u8>, u32)> {
        if entries.is_empty() {
            return Ok((Vec::new(), 0));
        }

        let entries_vec = entries.to_vec();

        let payload_bytes = rkyv::to_bytes::<_, 256>(&entries_vec)
            .context("Failed to serialize TTML entries")?
            .into_vec();

        let payload_len =
            u32::try_from(payload_bytes.len()).context("Payload size exceeds u32 limit (4GB)")?;

        Ok((payload_bytes, payload_len))
    }

    pub fn append_entries(&self, entries: &[TtmlEntry]) -> Result<()> {
        if entries.is_empty() {
            return Ok(());
        }

        let (payload_bytes, payload_len) = Self::serialize_payload(entries)?;

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.file_path)
            .with_context(|| {
                format!(
                    "Failed to open DB file for appending: {}",
                    self.file_path.display()
                )
            })?;

        file.write_all(&BLOCK_MAGIC)?;
        file.write_all(&payload_len.to_le_bytes())?;
        file.write_all(&payload_bytes)?;
        file.sync_all()?;

        info!(
            "Appended {} entries to database, payload size: {} bytes",
            entries.len(),
            payload_len
        );

        Ok(())
    }

    pub fn overwrite_entries(&self, entries: &[TtmlEntry]) -> Result<()> {
        let (payload_bytes, payload_len) = Self::serialize_payload(entries)?;

        let parent_dir = self
            .file_path
            .parent()
            .unwrap_or_else(|| std::path::Path::new(""));
        let file_name = self.file_path.file_name().unwrap_or_default();
        let mut temp_path = parent_dir.to_path_buf();
        temp_path.push(format!(".{}.tmp", file_name.to_string_lossy()));

        {
            let mut temp_file = File::create(&temp_path)
                .with_context(|| format!("Failed to create temp file: {}", temp_path.display()))?;

            if !entries.is_empty() {
                temp_file.write_all(&BLOCK_MAGIC)?;
                temp_file.write_all(&payload_len.to_le_bytes())?;
                temp_file.write_all(&payload_bytes)?;
            }
            temp_file.sync_all()?;
        }

        if let Err(e) = std::fs::rename(&temp_path, &self.file_path) {
            let _ = std::fs::remove_file(&temp_path);
            anyhow::bail!(
                "Overwrite failed during rename from {} to {}: {}",
                temp_path.display(),
                self.file_path.display(),
                e
            );
        }

        info!(
            "Overwrote database with {} entries, payload size: {} bytes",
            entries.len(),
            payload_len
        );

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    #[test]
    fn test_append_entries() {
        let temp_file = NamedTempFile::new().unwrap();
        let writer = TtmlDbWriter::new(temp_file.path().to_path_buf());

        let entries = vec![
            TtmlEntry {
                file_path: "test1.ttml".to_string(),
                title: "Song 1".to_string(),
                artist: "Artist 1".to_string(),
                album: "Album 1".to_string(),
                author_ids: "".to_string(),
                author_names: "".to_string(),
                lyric_text: "Lyrics 1".to_string(),
                bg_vocal_text: "".to_string(),
                raw_ttml: "<tt>test1</tt>".to_string(),
            },
            TtmlEntry {
                file_path: "test2.ttml".to_string(),
                title: "Song 2".to_string(),
                artist: "Artist 2".to_string(),
                album: "Album 2".to_string(),
                author_ids: "".to_string(),
                author_names: "".to_string(),
                lyric_text: "Lyrics 2".to_string(),
                bg_vocal_text: "".to_string(),
                raw_ttml: "<tt>test2</tt>".to_string(),
            },
        ];

        assert!(writer.append_entries(&entries).is_ok());

        let metadata = std::fs::metadata(temp_file.path()).unwrap();
        assert!(metadata.len() > 0);
    }
}
