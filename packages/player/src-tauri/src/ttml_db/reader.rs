use anyhow::Result;
use memmap2::Mmap;
use rkyv::Archived;
use std::collections::HashSet;
use std::fs::File;
use tracing::{info, warn};

use super::model::{LyricSearchResult, SearchFilter, TtmlEntry};

const BLOCK_MAGIC: [u8; 4] = *b"ttml";

pub struct TtmlDbReader {
    mmap: Mmap,
}

impl TtmlDbReader {
    pub fn new(file_path: &std::path::Path) -> Result<Self> {
        let file = File::open(file_path)?;
        let mmap = unsafe { Mmap::map(&file)? };

        info!(
            "Mapped database file: {} ({} bytes)",
            file_path.display(),
            mmap.len()
        );

        Ok(Self { mmap })
    }

    pub fn get_all_file_paths(&self) -> HashSet<String> {
        let mut paths = HashSet::new();

        for entry in self.iter_entries() {
            paths.insert(entry.file_path.to_string());
        }

        info!("Found {} local file paths", paths.len());
        paths
    }

    pub fn search(&self, filters: &[SearchFilter]) -> Vec<LyricSearchResult> {
        let mut results = Vec::new();
        let lower_keywords: Vec<String> =
            filters.iter().map(|f| f.keyword.to_lowercase()).collect();

        for entry in self.iter_entries() {
            let mut matches = false;
            let mut matched_line_preview = Vec::new();

            for (i, filter) in filters.iter().enumerate() {
                let field_value: &str = match filter.field.as_str() {
                    "title" => &entry.title,
                    "artist" => &entry.artist,
                    "album" => &entry.album,
                    "lyric_text" => &entry.lyric_text,
                    "bg_vocal_text" => &entry.bg_vocal_text,
                    _ => {
                        warn!("Unknown search field: {}", filter.field);
                        continue;
                    }
                };

                // 考虑到词库中带有大小写的非 ASCII 字符非常少见（拉丁字母、德语、
                // 土耳其语、法语等歌词），只大小写不敏感地匹配 ASCII 字符足够了
                if contains_ignore_ascii_case(field_value, &filters[i].keyword) {
                    matches = true;

                    if filter.field == "lyric_text" || filter.field == "bg_vocal_text" {
                        matched_line_preview =
                            extract_matched_lines(field_value, &lower_keywords[i], 1);
                    }

                    break;
                }
            }

            if matches {
                results.push(LyricSearchResult {
                    file_path: entry.file_path.to_string(),
                    title: entry.title.to_string(),
                    artist: entry.artist.to_string(),
                    album: entry.album.to_string(),
                    matched_line_preview,
                });
            }
        }

        results
    }

    pub fn get_lyric_detail(&self, file_path: &str) -> Option<String> {
        for entry in self.iter_entries() {
            if entry.file_path == file_path {
                return Some(entry.raw_ttml.to_string());
            }
        }
        None
    }

    pub fn get_entry_count(&self) -> usize {
        self.iter_entries().count()
    }

    fn iter_entries(&self) -> TtmlEntryIterator<'_> {
        TtmlEntryIterator {
            mmap: &self.mmap,
            cursor: 0,
            current_block_entries: &[],
        }
    }
}

fn contains_ignore_ascii_case(haystack: &str, needle: &str) -> bool {
    let haystack_bytes = haystack.as_bytes();
    let needle_bytes = needle.as_bytes();

    if needle_bytes.is_empty() {
        return true;
    }
    if haystack_bytes.len() < needle_bytes.len() {
        return false;
    }

    haystack_bytes
        .windows(needle_bytes.len())
        .any(|window| window.eq_ignore_ascii_case(needle_bytes))
}

fn extract_matched_lines(text: &str, keyword: &str, context_lines: usize) -> Vec<String> {
    if keyword.is_empty() {
        return Vec::new();
    }

    let lines: Vec<&str> = text.lines().collect();
    let mut result = Vec::new();

    let mut last_added_index: Option<usize> = None;

    for i in 0..lines.len() {
        if contains_ignore_ascii_case(lines[i], keyword) {
            let start = i.saturating_sub(context_lines);
            let end = (i + context_lines + 1).min(lines.len());

            let actual_start = match last_added_index {
                Some(last_idx) => start.max(last_idx + 1),
                None => start,
            };

            if actual_start < end {
                result.extend(lines[actual_start..end].iter().map(|line| line.to_string()));
                last_added_index = Some(end - 1);
            }
        }
    }

    result
}

struct TtmlEntryIterator<'a> {
    mmap: &'a Mmap,
    cursor: usize,
    current_block_entries: &'a [Archived<TtmlEntry>],
}

impl<'a> Iterator for TtmlEntryIterator<'a> {
    type Item = &'a Archived<TtmlEntry>;

    fn next(&mut self) -> Option<Self::Item> {
        if let Some((first, rest)) = self.current_block_entries.split_first() {
            self.current_block_entries = rest;
            return Some(first);
        }

        let total_size = self.mmap.len();

        loop {
            if self.cursor + 8 > total_size {
                if self.cursor < total_size {
                    warn!("Incomplete block at offset {}, skipping", self.cursor);
                }
                return None;
            }

            let magic = &self.mmap[self.cursor..self.cursor + 4];
            if magic != BLOCK_MAGIC {
                warn!("Invalid magic at offset {}, stopping", self.cursor);
                return None;
            }
            self.cursor += 4;

            let mut len_bytes = [0u8; 4];
            len_bytes.copy_from_slice(&self.mmap[self.cursor..self.cursor + 4]);
            let payload_len = u32::from_le_bytes(len_bytes) as usize;
            self.cursor += 4;

            if self.cursor + payload_len > total_size {
                warn!(
                    "Incomplete payload at offset {}, expected {} bytes, stopping",
                    self.cursor, payload_len
                );
                return None;
            }

            let payload = &self.mmap[self.cursor..self.cursor + payload_len];
            self.cursor += payload_len;

            // safety: 歌词索引文件是我们自己生成的，并且有魔数验证
            let archived_entries: &rkyv::Archived<Vec<TtmlEntry>> =
                unsafe { rkyv::archived_root::<Vec<TtmlEntry>>(payload) };

            self.current_block_entries = archived_entries.as_ref();

            if let Some((first, rest)) = self.current_block_entries.split_first() {
                self.current_block_entries = rest;
                return Some(first);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ttml_db::writer::TtmlDbWriter;
    use tempfile::NamedTempFile;

    #[test]
    fn test_read_entries() {
        let temp_file = NamedTempFile::new().unwrap();
        let writer = TtmlDbWriter::new(temp_file.path().to_path_buf());

        let entries = vec![TtmlEntry {
            file_path: "test1.ttml".to_string(),
            title: "Song 1".to_string(),
            artist: "Artist 1".to_string(),
            album: "Album 1".to_string(),
            author_ids: "".to_string(),
            author_names: "".to_string(),
            lyric_text: "Lyrics 1".to_string(),
            bg_vocal_text: "".to_string(),
            raw_ttml: "<tt>test1</tt>".to_string(),
        }];

        writer.append_entries(&entries).unwrap();

        let reader = TtmlDbReader::new(temp_file.path()).unwrap();
        let paths = reader.get_all_file_paths();
        assert_eq!(paths.len(), 1);
        assert!(paths.contains("test1.ttml"));
    }

    #[test]
    fn test_multiple_entries_in_block() {
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
            TtmlEntry {
                file_path: "test3.ttml".to_string(),
                title: "Song 3".to_string(),
                artist: "Artist 3".to_string(),
                album: "Album 3".to_string(),
                author_ids: "".to_string(),
                author_names: "".to_string(),
                lyric_text: "Lyrics 3".to_string(),
                bg_vocal_text: "".to_string(),
                raw_ttml: "<tt>test3</tt>".to_string(),
            },
        ];

        writer.append_entries(&entries).unwrap();

        let reader = TtmlDbReader::new(temp_file.path()).unwrap();
        let paths = reader.get_all_file_paths();
        assert_eq!(paths.len(), 3);
        assert!(paths.contains("test1.ttml"));
        assert!(paths.contains("test2.ttml"));
        assert!(paths.contains("test3.ttml"));
    }
}
