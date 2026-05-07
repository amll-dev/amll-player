use rkyv::{Archive, Deserialize, Serialize};
use serde::{Deserialize as SerdeDeserialize, Serialize as SerdeSerialize};

#[derive(Archive, Serialize, Deserialize, Debug, Clone)]
pub struct TtmlEntry {
    pub file_path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub author_ids: String,
    pub author_names: String,
    pub lyric_text: String,
    pub bg_vocal_text: String,
    pub raw_ttml: String,
}

impl TtmlEntry {
    pub fn from_result(
        file_path: String,
        raw_ttml: String,
        result: ttml_processor::model::TTMLResult,
    ) -> Self {
        let meta = result.metadata;
        let flatten = |v: Option<Vec<String>>| v.unwrap_or_default().join(", ");

        let lyric_text = result
            .lines
            .iter()
            .map(|l| l.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");

        let bg_vocal_text = result
            .lines
            .iter()
            .filter_map(|l| l.background_vocal.as_ref())
            .map(|bg| bg.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");

        Self {
            file_path,
            title: flatten(meta.title),
            artist: flatten(meta.artist),
            album: flatten(meta.album),
            author_ids: flatten(meta.author_ids),
            author_names: flatten(meta.author_names),
            lyric_text,
            bg_vocal_text,
            raw_ttml,
        }
    }
}

#[derive(SerdeSerialize, SerdeDeserialize, Debug, Clone)]
pub struct LyricSearchResult {
    pub file_path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub matched_line_preview: Vec<String>,
}

/// 同步状态枚举
#[derive(SerdeSerialize, SerdeDeserialize, Debug, Clone, PartialEq)]
pub enum SyncStatus {
    /// 因版本一致而跳过
    Skipped,
    /// 发现新版本并成功更新
    Updated,
    /// 词库没有数据或者解压出来是空的
    Empty,
    /// 发生了错误
    Failed,
}

/// 同步结果
#[derive(SerdeSerialize, SerdeDeserialize, Debug, Clone)]
pub struct SyncResult {
    pub status: SyncStatus,
    pub count: Option<usize>,
    pub error: Option<String>,
    pub strategy: Option<String>,
}

/// 搜索字段过滤器
#[derive(SerdeSerialize, SerdeDeserialize, Debug, Clone)]
pub struct SearchFilter {
    /// 字段名: "title", "artist", "album", "lyric_text", "bg_vocal_text"
    pub field: String,
    /// 搜索关键字
    pub keyword: String,
}

/// 远程版本信息
#[derive(SerdeSerialize, SerdeDeserialize, Debug, Clone)]
pub struct RemoteVersion {
    pub build_date: String,
    pub commit: String,
    pub file_count: usize,
    pub timestamp: u64,
}

/// 索引条目（用于增量同步）
#[derive(SerdeSerialize, SerdeDeserialize, Debug, Clone)]
pub struct IndexEntry {
    #[serde(rename = "rawLyricFile")]
    pub raw_lyric_file: String,
}
