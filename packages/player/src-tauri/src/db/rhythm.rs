use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use amll_player_core::{
    RHYTHM_ANALYZER_VERSION, RhythmAnalysis, TrackLoudnessAnalysis, analyze_rhythm_file,
};
use sea_orm::{ActiveValue::Set, EntityTrait, sea_query::OnConflict};
use tauri::State;
use tokio::sync::{Notify, Semaphore};
use tracing::warn;

use crate::{
    db::{
        DbConnection,
        entity::{song, song_rhythm_analysis},
    },
    db_events,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SourceSignature {
    pub(crate) modified_at: i64,
    pub(crate) file_size: i64,
}

pub struct RhythmAnalysisState {
    semaphore: Arc<Semaphore>,
    foreground_pending: Arc<AtomicUsize>,
    foreground_idle: Arc<Notify>,
    latest_request: Mutex<LatestRhythmRequest>,
}

#[derive(Default)]
struct LatestRhythmRequest {
    request_id: u64,
    song_id: String,
}

impl Default for RhythmAnalysisState {
    fn default() -> Self {
        Self {
            semaphore: Arc::new(Semaphore::new(1)),
            foreground_pending: Arc::new(AtomicUsize::new(0)),
            foreground_idle: Arc::new(Notify::new()),
            latest_request: Mutex::new(LatestRhythmRequest::default()),
        }
    }
}

impl RhythmAnalysisState {
    /// 预缓存 worker 借此让路:任何播放路径的分析请求仍在进行时,
    /// 后台队列都不会启动新的分析。
    pub fn has_foreground_pending(&self) -> bool {
        self.foreground_pending.load(Ordering::Acquire) > 0
    }

    pub(crate) fn semaphore(&self) -> Arc<Semaphore> {
        self.semaphore.clone()
    }

    pub(crate) async fn wait_for_foreground_idle(&self) {
        loop {
            let notified = self.foreground_idle.notified();
            if !self.has_foreground_pending() {
                return;
            }
            notified.await;
        }
    }

    #[cfg(test)]
    pub(crate) fn enter_foreground_for_test(&self) -> impl Drop + 'static {
        ForegroundGuard::enter(
            self.foreground_pending.clone(),
            self.foreground_idle.clone(),
        )
    }

    fn register_request(&self, song_id: &str) -> u64 {
        let mut latest = self
            .latest_request
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        latest.request_id = latest.request_id.wrapping_add(1);
        latest.song_id.clear();
        latest.song_id.push_str(song_id);
        latest.request_id
    }

    fn request_is_superseded(&self, request_id: u64, song_id: &str) -> bool {
        let latest = self
            .latest_request
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        latest.request_id != request_id && latest.song_id != song_id
    }
}

/// 播放路径请求的存续计数;Drop 保证任何返回路径都会递减。
struct ForegroundGuard {
    counter: Arc<AtomicUsize>,
    idle: Arc<Notify>,
}

impl ForegroundGuard {
    fn enter(counter: Arc<AtomicUsize>, idle: Arc<Notify>) -> Self {
        counter.fetch_add(1, Ordering::AcqRel);
        Self { counter, idle }
    }
}

impl Drop for ForegroundGuard {
    fn drop(&mut self) {
        if self.counter.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.idle.notify_one();
        }
    }
}

pub(crate) fn source_signature(path: &Path) -> Result<SourceSignature, String> {
    let metadata = std::fs::metadata(path)
        .map_err(|e| format!("Failed to read audio file metadata {}: {e}", path.display()))?;
    let modified_at = metadata
        .modified()
        .unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    Ok(SourceSignature {
        modified_at: i64::try_from(modified_at).map_err(|_| {
            format!(
                "Audio file modification time is out of range: {}",
                path.display()
            )
        })?,
        file_size: i64::try_from(metadata.len())
            .map_err(|_| format!("Audio file is too large: {}", path.display()))?,
    })
}

async fn remove_cached_row(db: &DbConnection, song_id: &str) -> Result<(), String> {
    let result = song_rhythm_analysis::Entity::delete_by_id(song_id.to_owned())
        .exec(db)
        .await
        .map_err(|e| format!("Failed to delete song rhythm analysis: {e}"))?;

    if result.rows_affected > 0 {
        db_events::emit_event("song_rhythm_analyses", "delete", serde_json::json!(song_id));
    }

    Ok(())
}

pub(crate) async fn load_valid_cached_analysis(
    db: &DbConnection,
    song_id: &str,
    require_loudness: bool,
) -> Result<Option<RhythmAnalysis>, String> {
    let Some(cached) = song_rhythm_analysis::Entity::find_by_id(song_id)
        .one(db)
        .await
        .map_err(|e| format!("Failed to get cached song rhythm analysis: {e}"))?
    else {
        return Ok(None);
    };

    let Some(song) = song::Entity::find_by_id(song_id)
        .one(db)
        .await
        .map_err(|e| format!("Failed to get song for rhythm analysis: {e}"))?
    else {
        remove_cached_row(db, song_id).await?;
        return Ok(None);
    };

    let signature = match source_signature(Path::new(&song.file_path)) {
        Ok(signature) => signature,
        Err(error) => {
            remove_cached_row(db, song_id).await?;
            return Err(error);
        }
    };

    let expected_version = i32::try_from(RHYTHM_ANALYZER_VERSION)
        .map_err(|_| "Rhythm analyzer version is out of range".to_string())?;
    if cached.analyzer_version != expected_version
        || cached.source_modified_at != signature.modified_at
        || cached.source_file_size != signature.file_size
    {
        remove_cached_row(db, song_id).await?;
        return Ok(None);
    }

    match serde_json::from_str::<RhythmAnalysis>(&cached.payload_json) {
        Ok(analysis)
            if analysis.analyzer_version == RHYTHM_ANALYZER_VERSION
                && (!require_loudness || analysis.has_current_loudness_analysis()) =>
        {
            Ok(Some(analysis))
        }
        Ok(analysis) if analysis.analyzer_version == RHYTHM_ANALYZER_VERSION => Ok(None),
        Ok(_) => {
            remove_cached_row(db, song_id).await?;
            Ok(None)
        }
        Err(error) => {
            warn!("Discarding invalid rhythm cache for song {song_id}: {error}");
            remove_cached_row(db, song_id).await?;
            Ok(None)
        }
    }
}

async fn store_analysis(
    db: &DbConnection,
    song_id: &str,
    signature: SourceSignature,
    analysis: &RhythmAnalysis,
) -> Result<(), String> {
    let analyzer_version = i32::try_from(RHYTHM_ANALYZER_VERSION)
        .map_err(|_| "Rhythm analyzer version is out of range".to_string())?;
    let payload_json = serde_json::to_string(analysis)
        .map_err(|e| format!("Failed to serialize song rhythm analysis: {e}"))?;
    let model = song_rhythm_analysis::ActiveModel {
        song_id: Set(song_id.to_owned()),
        analyzer_version: Set(analyzer_version),
        source_modified_at: Set(signature.modified_at),
        source_file_size: Set(signature.file_size),
        analyzed_at: Set(chrono::Utc::now().timestamp_millis()),
        payload_json: Set(payload_json),
    };

    song_rhythm_analysis::Entity::insert(model)
        .on_conflict(
            OnConflict::column(song_rhythm_analysis::Column::SongId)
                .update_columns([
                    song_rhythm_analysis::Column::AnalyzerVersion,
                    song_rhythm_analysis::Column::SourceModifiedAt,
                    song_rhythm_analysis::Column::SourceFileSize,
                    song_rhythm_analysis::Column::AnalyzedAt,
                    song_rhythm_analysis::Column::PayloadJson,
                ])
                .to_owned(),
        )
        .exec(db)
        .await
        .map_err(|e| format!("Failed to cache song rhythm analysis: {e}"))?;

    db_events::emit_event("song_rhythm_analyses", "upsert", serde_json::json!(song_id));
    Ok(())
}

#[tauri::command]
pub async fn get_cached_song_rhythm(
    db: State<'_, DbConnection>,
    song_id: String,
) -> Result<Option<RhythmAnalysis>, String> {
    load_valid_cached_analysis(&*db, &song_id, false).await
}

#[tauri::command]
pub async fn get_cached_song_loudness(
    db: State<'_, DbConnection>,
    song_id: String,
) -> Result<Option<TrackLoudnessAnalysis>, String> {
    Ok(load_valid_cached_analysis(&*db, &song_id, false)
        .await?
        .and_then(|analysis| analysis.loudness)
        .filter(TrackLoudnessAnalysis::is_current))
}

#[tauri::command]
pub async fn delete_song_rhythm(
    db: State<'_, DbConnection>,
    song_id: String,
) -> Result<(), String> {
    remove_cached_row(&*db, &song_id).await
}

#[tauri::command]
pub async fn get_or_analyze_song_rhythm(
    db: State<'_, DbConnection>,
    state: State<'_, RhythmAnalysisState>,
    song_id: String,
    force: Option<bool>,
    require_loudness: Option<bool>,
    non_blocking: Option<bool>,
) -> Result<RhythmAnalysis, String> {
    let request_id = state.register_request(&song_id);
    let _foreground = ForegroundGuard::enter(
        state.foreground_pending.clone(),
        state.foreground_idle.clone(),
    );
    let force = force.unwrap_or(false);
    let require_loudness = require_loudness.unwrap_or(false);
    let non_blocking = non_blocking.unwrap_or(false);
    if !force
        && let Some(analysis) = load_valid_cached_analysis(&*db, &song_id, require_loudness).await?
    {
        return Ok(analysis);
    }

    let _permit = if non_blocking {
        state
            .semaphore
            .clone()
            .try_acquire_owned()
            .map_err(|_| "DECODER_BUSY".to_string())?
    } else {
        state
            .semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "Rhythm analysis queue has been closed".to_string())?
    };

    // 等待期间同一首歌的请求可能已经完成分析,先吃缓存再谈让位。
    if !force
        && let Some(analysis) = load_valid_cached_analysis(&*db, &song_id, require_loudness).await?
    {
        return Ok(analysis);
    }

    // Rapid skips must not leave the currently playing song behind a queue of
    // obsolete analyses. A running decode is allowed to finish; an older request
    // that was still waiting only yields when the newest request belongs to a
    // *different* song, so the two playback-path callers (pre-play loudness and
    // rhythm visuals) for the same song no longer cancel each other.
    if state.request_is_superseded(request_id, &song_id) {
        return Err("Rhythm analysis request was superseded by a newer song".to_string());
    }

    analyze_and_store(&db, &song_id).await
}

/// 解码整轨、校验源文件签名并写入缓存。调用方需自行持有分析信号量,
/// 播放路径命令与后台预缓存 worker 共用这段流程。
pub(crate) async fn analyze_and_store(
    db: &DbConnection,
    song_id: &str,
) -> Result<RhythmAnalysis, String> {
    let song = song::Entity::find_by_id(song_id.to_owned())
        .one(db)
        .await
        .map_err(|e| format!("Failed to get song for rhythm analysis: {e}"))?
        .ok_or_else(|| format!("Song {song_id} not found"))?;
    let source_path = song.file_path;
    let path = std::path::PathBuf::from(&source_path);
    let signature_before = source_signature(&path)?;
    let analysis_path = path.clone();
    let analysis = tokio::task::spawn_blocking(move || analyze_rhythm_file(analysis_path))
        .await
        .map_err(|e| format!("Rhythm analysis task failed: {e}"))?
        .map_err(|e| format!("Failed to analyze song rhythm: {e}"))?;
    let signature_after = source_signature(&path)?;

    if signature_before != signature_after {
        remove_cached_row(db, song_id).await?;
        return Err(format!(
            "Audio file changed while rhythm analysis was running: {}",
            path.display()
        ));
    }
    if analysis.analyzer_version != RHYTHM_ANALYZER_VERSION {
        return Err(format!(
            "Rhythm analyzer returned version {}, expected {}",
            analysis.analyzer_version, RHYTHM_ANALYZER_VERSION
        ));
    }

    // Do not recreate an orphan or cache data for a path changed during analysis.
    let song_after = song::Entity::find_by_id(song_id.to_owned())
        .one(db)
        .await
        .map_err(|e| format!("Failed to verify song after rhythm analysis: {e}"))?
        .ok_or_else(|| format!("Song {song_id} was removed during rhythm analysis"))?;
    if song_after.file_path != source_path {
        return Err(format!(
            "Song {song_id} changed path during rhythm analysis"
        ));
    }

    store_analysis(db, song_id, signature_after, &analysis).await?;
    Ok(analysis)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;

    #[test]
    fn latest_request_publishes_id_and_song_as_one_state() {
        let state = Arc::new(RhythmAnalysisState::default());
        let barrier = Arc::new(Barrier::new(33));
        let handles = (0..32)
            .map(|index| {
                let state = state.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let song_id = format!("song-{index}");
                    barrier.wait();
                    let request_id = state.register_request(&song_id);
                    (request_id, song_id)
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let registrations = handles
            .into_iter()
            .map(|handle| handle.join().expect("registration thread panicked"))
            .collect::<Vec<_>>();
        let latest = state
            .latest_request
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let published = registrations
            .iter()
            .find(|(request_id, _)| *request_id == latest.request_id)
            .expect("latest request id was not returned by any registration");

        assert_eq!(latest.song_id, published.1);
    }

    #[test]
    fn same_song_waiters_do_not_supersede_each_other() {
        let state = RhythmAnalysisState::default();
        let first = state.register_request("same-song");
        let second = state.register_request("same-song");

        assert!(!state.request_is_superseded(first, "same-song"));
        assert!(!state.request_is_superseded(second, "same-song"));

        state.register_request("new-song");
        assert!(state.request_is_superseded(first, "same-song"));
    }

    #[tokio::test]
    async fn idle_waiter_wakes_after_last_foreground_request_finishes() {
        let state = Arc::new(RhythmAnalysisState::default());
        let first = ForegroundGuard::enter(
            state.foreground_pending.clone(),
            state.foreground_idle.clone(),
        );
        let second = ForegroundGuard::enter(
            state.foreground_pending.clone(),
            state.foreground_idle.clone(),
        );
        let waiting_state = state.clone();
        let waiter = tokio::spawn(async move {
            waiting_state.wait_for_foreground_idle().await;
        });
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());

        drop(first);
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());

        drop(second);
        tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
            .await
            .expect("idle waiter was not notified")
            .expect("idle waiter task failed");
    }
}
