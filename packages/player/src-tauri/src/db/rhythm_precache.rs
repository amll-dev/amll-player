use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::Path,
    sync::Mutex,
};

use amll_player_core::{RHYTHM_ANALYZER_VERSION, RhythmAnalysis};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::OwnedSemaphorePermit;
use tracing::warn;

use crate::db::{
    DbConnection,
    entity::{song, song_rhythm_analysis},
    rhythm::{
        RhythmAnalysisState, SourceSignature, analyze_and_store, load_valid_cached_analysis,
        source_signature,
    },
};

pub const RHYTHM_PRECACHE_PROGRESS_EVENT: &str = "rhythm-precache-progress";
const PAYLOAD_VALIDATION_BATCH_SIZE: usize = 64;

/// 推送给前端进度提示的快照。total 只统计本轮真正需要(重新)分析的歌曲,
/// 缓存完好的歌不会出现在计数里。
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RhythmPrecacheProgress {
    pub active: bool,
    pub total: u32,
    pub done: u32,
    pub failed: u32,
    pub current_song_name: Option<String>,
}

#[derive(Default)]
struct PrecacheQueue {
    pending: VecDeque<String>,
    queued: HashSet<String>,
    worker_running: bool,
    total: u32,
    done: u32,
    failed: u32,
    current_song_name: Option<String>,
}

impl PrecacheQueue {
    fn enqueue(&mut self, song_id: String) -> bool {
        if !self.queued.insert(song_id.clone()) {
            return false;
        }
        self.pending.push_back(song_id);
        self.total += 1;
        true
    }

    fn dequeue(&mut self) -> Option<String> {
        // queued 同时覆盖等待中和分析中的歌曲，完成前都不能再次入队。
        self.pending.pop_front()
    }

    fn complete(&mut self, song_id: &str, succeeded: bool) {
        self.queued.remove(song_id);
        if succeeded {
            self.done += 1;
        } else {
            self.failed += 1;
        }
    }
}

#[derive(Default)]
pub struct RhythmPrecacheState {
    queue: Mutex<PrecacheQueue>,
}

struct CachedAnalysisIndexEntry {
    analyzer_version: i32,
    source_modified_at: i64,
    source_file_size: i64,
}

impl CachedAnalysisIndexEntry {
    fn has_matching_signature(&self, signature: SourceSignature, expected_version: i32) -> bool {
        self.analyzer_version == expected_version
            && self.source_modified_at == signature.modified_at
            && self.source_file_size == signature.file_size
    }
}

fn payload_has_current_rhythm_and_loudness(payload_json: &str) -> bool {
    serde_json::from_str::<RhythmAnalysis>(payload_json).is_ok_and(|analysis| {
        analysis.analyzer_version == RHYTHM_ANALYZER_VERSION
            && analysis.has_current_loudness_analysis()
    })
}

impl RhythmPrecacheState {
    fn snapshot(&self) -> RhythmPrecacheProgress {
        let queue = self
            .queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        RhythmPrecacheProgress {
            active: queue.worker_running,
            total: queue.total,
            done: queue.done,
            failed: queue.failed,
            current_song_name: queue.current_song_name.clone(),
        }
    }
}

fn emit_progress(app: &AppHandle) {
    let state = app.state::<RhythmPrecacheState>();
    let progress = state.snapshot();
    if let Err(error) = app.emit(RHYTHM_PRECACHE_PROGRESS_EVENT, &progress) {
        warn!("failed to emit rhythm precache progress: {error}");
    }
}

/// 扫描曲库,把缓存缺失、分析器版本过期或源文件已变化的歌曲加入后台
/// 分析队列,并在需要时启动 worker。导入完成与应用启动时都会调用;
/// 分析器版本升级后由启动扫描自动重建全库缓存。
#[tauri::command]
pub async fn start_rhythm_precache(
    app: AppHandle,
    db: State<'_, DbConnection>,
    state: State<'_, RhythmPrecacheState>,
) -> Result<RhythmPrecacheProgress, String> {
    // 预扫只需要歌曲编号和本地路径，不加载歌词、翻译等大文本列。
    let songs: Vec<(String, String)> = song::Entity::find()
        .select_only()
        .column(song::Column::Id)
        .column(song::Column::FilePath)
        .into_tuple()
        .all(&*db)
        .await
        .map_err(|e| format!("Failed to list songs for rhythm precache: {e}"))?;
    // 先只取签名列，避免把全库分析 JSON 一次性载入内存。
    let cached_rows: Vec<(String, i32, i64, i64)> = song_rhythm_analysis::Entity::find()
        .select_only()
        .column(song_rhythm_analysis::Column::SongId)
        .column(song_rhythm_analysis::Column::AnalyzerVersion)
        .column(song_rhythm_analysis::Column::SourceModifiedAt)
        .column(song_rhythm_analysis::Column::SourceFileSize)
        .into_tuple()
        .all(&*db)
        .await
        .map_err(|e| format!("Failed to list rhythm caches: {e}"))?;
    let cache_index: HashMap<String, CachedAnalysisIndexEntry> = cached_rows
        .into_iter()
        .map(
            |(song_id, analyzer_version, source_modified_at, source_file_size)| {
                (
                    song_id,
                    CachedAnalysisIndexEntry {
                        analyzer_version,
                        source_modified_at,
                        source_file_size,
                    },
                )
            },
        )
        .collect();
    let expected_version = i32::try_from(RHYTHM_ANALYZER_VERSION)
        .map_err(|_| "Rhythm analyzer version is out of range".to_string())?;

    // 每首歌都要 stat 一次源文件，放到阻塞线程完成。签名已匹配的缓存
    // 还要检查 payload，本阶段只收集编号，稍后分批读取与解析。
    let (mut needing, payload_candidates) = tokio::task::spawn_blocking(move || {
        let mut needing = Vec::new();
        let mut payload_candidates = Vec::new();
        for (song_id, file_path) in songs {
            // 文件暂不可读(已删除/移动/外置盘未挂载):预扫一律不重试,
            // 否则无缓存的坏路径会每轮入队、每轮失败。交给播放路径按需处理。
            let Ok(signature) = source_signature(Path::new(&file_path)) else {
                continue;
            };
            match cache_index.get(&song_id) {
                Some(cached) if cached.has_matching_signature(signature, expected_version) => {
                    payload_candidates.push(song_id);
                }
                _ => needing.push(song_id),
            }
        }
        (needing, payload_candidates)
    })
    .await
    .map_err(|e| format!("Rhythm precache scan task failed: {e}"))?;

    // payload 可能包含完整节拍序列，固定小批次读取，既复用权威 serde
    // 结构校验，又避免大型曲库在预扫时一次性占用过多内存。
    for song_ids in payload_candidates.chunks(PAYLOAD_VALIDATION_BATCH_SIZE) {
        let payload_rows: Vec<(String, String)> = song_rhythm_analysis::Entity::find()
            .select_only()
            .column(song_rhythm_analysis::Column::SongId)
            .column(song_rhythm_analysis::Column::PayloadJson)
            .filter(song_rhythm_analysis::Column::SongId.is_in(song_ids.iter().cloned()))
            .into_tuple()
            .all(&*db)
            .await
            .map_err(|e| format!("Failed to validate rhythm cache payloads: {e}"))?;
        let valid_ids = tokio::task::spawn_blocking(move || {
            payload_rows
                .into_iter()
                .filter_map(|(song_id, payload_json)| {
                    payload_has_current_rhythm_and_loudness(&payload_json).then_some(song_id)
                })
                .collect::<HashSet<_>>()
        })
        .await
        .map_err(|e| format!("Rhythm cache payload validation task failed: {e}"))?;
        needing.extend(
            song_ids
                .iter()
                .filter(|song_id| !valid_ids.contains(*song_id))
                .cloned(),
        );
    }

    let mut spawn_worker = false;
    {
        let mut queue = state
            .queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !queue.worker_running && queue.pending.is_empty() {
            // 新一轮扫描重新计数,让进度提示只反映本轮批次。
            queue.total = 0;
            queue.done = 0;
            queue.failed = 0;
        }
        for song_id in needing {
            queue.enqueue(song_id);
        }
        if !queue.worker_running && !queue.pending.is_empty() {
            queue.worker_running = true;
            spawn_worker = true;
        }
    }
    if spawn_worker {
        let worker_app = app.clone();
        tauri::async_runtime::spawn(async move {
            run_worker(worker_app).await;
        });
    }
    emit_progress(&app);
    Ok(state.snapshot())
}

/// 前端挂载时用来补拉当前进度,避免错过 worker 已经发出的事件。
#[tauri::command]
pub fn get_rhythm_precache_progress(
    state: State<'_, RhythmPrecacheState>,
) -> RhythmPrecacheProgress {
    state.snapshot()
}

async fn run_worker(app: AppHandle) {
    loop {
        // 播放路径的分析请求在场时后台完全静默,把解码线程让给当前歌曲。
        app.state::<RhythmAnalysisState>()
            .wait_for_foreground_idle()
            .await;

        let next_song_id = {
            let state = app.state::<RhythmPrecacheState>();
            let mut queue = state
                .queue
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match queue.dequeue() {
                Some(song_id) => Some(song_id),
                None => {
                    queue.worker_running = false;
                    queue.current_song_name = None;
                    None
                }
            }
        };
        let Some(song_id) = next_song_id else {
            emit_progress(&app);
            return;
        };

        let song_name = {
            let db = app.state::<DbConnection>();
            song::Entity::find_by_id(song_id.clone())
                .one(&*db)
                .await
                .ok()
                .flatten()
                .map(|entry| entry.song_name)
        };
        {
            let state = app.state::<RhythmPrecacheState>();
            let mut queue = state
                .queue
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            queue.current_song_name = song_name.or_else(|| Some(song_id.clone()));
        }
        emit_progress(&app);

        let result = precache_song(&app, &song_id).await;
        {
            let state = app.state::<RhythmPrecacheState>();
            let mut queue = state
                .queue
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            queue.complete(&song_id, result.is_ok());
            queue.current_song_name = None;
        }
        if let Err(error) = result {
            warn!("rhythm precache failed for song {song_id}: {error}");
        }
        emit_progress(&app);
    }
}

async fn precache_song(app: &AppHandle, song_id: &str) -> Result<(), String> {
    let analysis_state = app.state::<RhythmAnalysisState>();
    let _permit = acquire_background_permit(&analysis_state).await?;
    let db = app.state::<DbConnection>();
    // 权威复查:播放路径或上一轮扫描可能已经补好缓存。
    if load_valid_cached_analysis(&db, song_id, true)
        .await?
        .is_some()
    {
        return Ok(());
    }
    analyze_and_store(&db, song_id).await.map(|_| ())
}

async fn acquire_background_permit(
    state: &RhythmAnalysisState,
) -> Result<OwnedSemaphorePermit, String> {
    acquire_background_permit_with_hook(state, || {}).await
}

async fn acquire_background_permit_with_hook(
    state: &RhythmAnalysisState,
    mut before_acquire: impl FnMut(),
) -> Result<OwnedSemaphorePermit, String> {
    loop {
        state.wait_for_foreground_idle().await;
        before_acquire();
        let permit = state
            .semaphore()
            .acquire_owned()
            .await
            .map_err(|_| "Rhythm analysis queue has been closed".to_string())?;
        // 前台可能在上一次空闲检查与获取许可之间登记。此时立即交还
        // 许可并重新等待，避免后台解码抢在当前播放歌曲之前启动。
        if state.has_foreground_pending() {
            drop(permit);
            continue;
        }
        return Ok(permit);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::{
        sync::{mpsc, oneshot},
        time::{Duration, timeout},
    };

    fn current_payload() -> serde_json::Value {
        serde_json::json!({
            "analyzerVersion": RHYTHM_ANALYZER_VERSION,
            "durationMs": 0,
            "globalBpm": null,
            "confidence": 0.0,
            "beats": [],
            "onsets": [],
            "tempoSegments": [],
            "energyEnvelope": [],
            "loudness": {
                "analyzerVersion": amll_player_core::LOUDNESS_ANALYZER_VERSION,
                "integratedLoudnessLufs": null,
                "samplePeak": 0.0
            }
        })
    }

    fn cached_entry() -> CachedAnalysisIndexEntry {
        CachedAnalysisIndexEntry {
            analyzer_version: i32::try_from(RHYTHM_ANALYZER_VERSION).unwrap(),
            source_modified_at: 1_234,
            source_file_size: 5_678,
        }
    }

    fn matching_signature() -> SourceSignature {
        SourceSignature {
            modified_at: 1_234,
            file_size: 5_678,
        }
    }

    #[test]
    fn current_rhythm_and_loudness_payload_skips_precache() {
        assert!(cached_entry().has_matching_signature(
            matching_signature(),
            i32::try_from(RHYTHM_ANALYZER_VERSION).unwrap()
        ));
        assert!(payload_has_current_rhythm_and_loudness(
            &current_payload().to_string()
        ));
    }

    #[test]
    fn missing_or_stale_loudness_payload_requires_precache() {
        let mut missing_loudness = current_payload();
        missing_loudness.as_object_mut().unwrap().remove("loudness");
        assert!(!payload_has_current_rhythm_and_loudness(
            &missing_loudness.to_string()
        ));

        let mut stale_loudness = current_payload();
        stale_loudness["loudness"]["analyzerVersion"] =
            serde_json::json!(amll_player_core::LOUDNESS_ANALYZER_VERSION.saturating_sub(1));
        assert!(!payload_has_current_rhythm_and_loudness(
            &stale_loudness.to_string()
        ));
    }

    #[test]
    fn stale_or_damaged_rhythm_payload_requires_precache() {
        let mut stale_rhythm = current_payload();
        stale_rhythm["analyzerVersion"] =
            serde_json::json!(RHYTHM_ANALYZER_VERSION.saturating_sub(1));
        assert!(!payload_has_current_rhythm_and_loudness(
            &stale_rhythm.to_string()
        ));
        assert!(!payload_has_current_rhythm_and_loudness("{}"));
        assert!(!payload_has_current_rhythm_and_loudness("not-json"));
    }

    #[test]
    fn stale_index_signature_requires_precache_even_with_current_payload() {
        let mut cached = cached_entry();
        cached.analyzer_version -= 1;
        assert!(!cached.has_matching_signature(
            matching_signature(),
            i32::try_from(RHYTHM_ANALYZER_VERSION).unwrap()
        ));

        let cached = cached_entry();
        assert!(!cached.has_matching_signature(
            SourceSignature {
                modified_at: matching_signature().modified_at + 1,
                ..matching_signature()
            },
            i32::try_from(RHYTHM_ANALYZER_VERSION).unwrap()
        ));
    }

    #[test]
    fn in_flight_song_stays_deduplicated_until_completion() {
        let mut queue = PrecacheQueue::default();
        assert!(queue.enqueue("song-a".to_string()));
        assert_eq!(queue.dequeue().as_deref(), Some("song-a"));

        assert!(!queue.enqueue("song-a".to_string()));
        assert_eq!(queue.total, 1);

        queue.complete("song-a", true);
        assert_eq!(queue.done, 1);
        assert!(queue.enqueue("song-a".to_string()));
        assert_eq!(queue.total, 2);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn background_rechecks_foreground_after_waiting_for_permit() {
        let state = Arc::new(RhythmAnalysisState::default());
        let blocking_permit = state.semaphore().acquire_owned().await.unwrap();
        let (waiting_tx, mut waiting_rx) = mpsc::unbounded_channel();
        let (background_acquired_tx, background_acquired_rx) = oneshot::channel();
        let (release_background_tx, release_background_rx) = oneshot::channel();
        let background_state = state.clone();

        let background = tokio::spawn(async move {
            let mut first_attempt = true;
            let permit = acquire_background_permit_with_hook(&background_state, || {
                if first_attempt {
                    first_attempt = false;
                    waiting_tx.send(()).unwrap();
                }
            })
            .await
            .unwrap();
            background_acquired_tx.send(()).unwrap();
            let _ = release_background_rx.await;
            drop(permit);
        });

        // 确认后台已经通过第一次空闲检查、正在等待被占用的信号量。
        timeout(Duration::from_secs(5), waiting_rx.recv())
            .await
            .expect("background did not reach the occupied semaphore")
            .expect("background stopped before waiting for the semaphore");
        let foreground_guard = state.enter_foreground_for_test();
        drop(blocking_permit);

        // 后台取得许可后必须复查并交还，前台才能在 guard 存续时取得许可。
        let foreground_permit = timeout(Duration::from_secs(5), state.semaphore().acquire_owned())
            .await
            .expect("background kept the permit after foreground registered")
            .unwrap();
        assert!(!background.is_finished());

        drop(foreground_permit);
        drop(foreground_guard);
        timeout(Duration::from_secs(5), background_acquired_rx)
            .await
            .expect("background did not resume after foreground became idle")
            .unwrap();
        release_background_tx.send(()).unwrap();
        background.await.unwrap();
    }
}
