import {
	isShuffleActiveAtom,
	musicPlayingAtom,
	musicPlayingPositionAtom,
	RepeatMode,
	repeatModeAtom,
} from "@applemusic-like-lyrics/react-full";
import { atom, type createStore, type PrimitiveAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import {
	enableGaplessPlaybackAtom,
	enableLoudnessNormalizationAtom,
} from "../states/appAtoms.ts";
import {
	db,
	getCurrentTrackLoudness,
	type RhythmAnalysis,
	type Song,
	type TrackLoudnessAnalysis,
} from "./db-client.ts";
import { emitAudioThread } from "./player.ts";

type JotaiStore = ReturnType<typeof createStore>;

interface TrackLoudnessPreparation {
	loudness: TrackLoudnessAnalysis | null;
	suppressAutomaticUpdate: boolean;
}

interface PreparedGaplessCandidate {
	index: number;
	songId: string;
	playbackId: string;
}

//#region 持久化数据结构
interface PersistedQueueState {
	/** playList 中的 songId 序列 */
	songIds: string[];
	/** originalList 中的 songId 序列（用于 shuffle 恢复） */
	originalSongIds: string[];
	/** 当前歌曲 ID；旧版本数据缺少此字段时回退到 currentIndex */
	currentSongId?: string | null;
	currentIndex: number;
	repeatMode: RepeatMode;
	shuffleActive: boolean;
	playlistId: number | null;
	/** 当前歌曲的播放位置（秒） */
	position: number;
}

const EMPTY_PERSISTED_STATE: PersistedQueueState = {
	songIds: [],
	originalSongIds: [],
	currentSongId: null,
	currentIndex: -1,
	repeatMode: RepeatMode.Off,
	shuffleActive: false,
	playlistId: null,
	position: 0,
};

/** 持久化存储 atom（localStorage） */
export const persistedQueueStateAtom = atomWithStorage<PersistedQueueState>(
	"amll-player.playQueue",
	EMPTY_PERSISTED_STATE,
	undefined,
	{ getOnInit: true },
);
//#endregion

//#region 派生 Atom（只读，供 UI 消费）
export const queuePlaylistAtom: PrimitiveAtom<Song[]> = atom<Song[]>([]);
export const queueCurrentIndexAtom: PrimitiveAtom<number> = atom(0);
export const queueRepeatModeAtom: PrimitiveAtom<RepeatMode> = atom<RepeatMode>(
	RepeatMode.Off,
);
export const queueShuffleActiveAtom: PrimitiveAtom<boolean> = atom(false);
export const queuePlaylistIdAtom: PrimitiveAtom<number | null> = atom<
	number | null
>(null);
export interface QueueLoudnessUpdatePolicy {
	musicId: string;
	suppressAutomaticUpdate: boolean;
}
export const queueLoudnessUpdatePolicyAtom =
	atom<QueueLoudnessUpdatePolicy | null>(null);
export function shouldSuppressAutomaticLoudnessUpdate(
	policy: QueueLoudnessUpdatePolicy | null,
	musicId: string,
	enabled: boolean,
): boolean {
	return (
		enabled && policy?.musicId === musicId && policy.suppressAutomaticUpdate
	);
}
/** 当前播放的歌曲（派生） */
export const queueCurrentSongAtom = atom<Song | null>((get) => {
	const playlist = get(queuePlaylistAtom);
	const index = get(queueCurrentIndexAtom);
	return playlist[index] ?? null;
});
/** 队列是否有数据（用于判断是否需要恢复） */
export const queueHasDataAtom = atom<boolean>((get) => {
	return get(queuePlaylistAtom).length > 0;
});
//#endregion

/** Fisher-Yates 洗牌算法 */
function shuffleArray<T>(arr: readonly T[]): T[] {
	const result = [...arr];
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[result[i], result[j]] = [result[j], result[i]];
	}
	return result;
}

function dedupeSongsById(songs: readonly Song[]): Song[] {
	const seen = new Set<string>();
	return songs.filter((song) => {
		if (seen.has(song.id)) return false;
		seen.add(song.id);
		return true;
	});
}

export class PlayQueueManager {
	private store: JotaiStore;
	private originalList: Song[] = [];
	private playList: Song[] = [];
	private currentIndex = -1;
	private repeatMode: RepeatMode = RepeatMode.Off;
	private shuffleActive = false;
	private playlistId: number | null = null;
	private currentPlaybackId: string | null = null;
	private expectedPlaybackId: string | null = null;
	private playRequestGeneration = 0;
	private playRequestPending = false;
	private desiredPlaying: boolean;
	private currentPlaybackEnded = false;
	private audioDispatchChain: Promise<void> = Promise.resolve();
	private queueRevision = 0;
	private gaplessRequestGeneration = 0;
	private preparedGaplessCandidate: PreparedGaplessCandidate | null = null;
	private gaplessBackendActive = false;
	private disposed = false;

	constructor(store: JotaiStore) {
		this.store = store;
		this.desiredPlaying = store.get(musicPlayingAtom);
	}

	//#region 辅助方法
	private syncToAtoms(): void {
		this.store.set(queuePlaylistAtom, [...this.playList]);
		this.store.set(queueCurrentIndexAtom, this.currentIndex);
		this.store.set(queueRepeatModeAtom, this.repeatMode);
		this.store.set(queueShuffleActiveAtom, this.shuffleActive);
		this.store.set(queuePlaylistIdAtom, this.playlistId);
		this.store.set(repeatModeAtom, this.repeatMode);
		this.store.set(isShuffleActiveAtom, this.shuffleActive);
		this.persistState();
	}

	/** 将当前队列状态写入 localStorage */
	private persistState(): void {
		const positionMs = this.store.get(musicPlayingPositionAtom);
		this.store.set(persistedQueueStateAtom, {
			songIds: this.playList.map((s) => s.id),
			originalSongIds: this.originalList.map((s) => s.id),
			currentSongId: this.getCurrentSong()?.id ?? null,
			currentIndex: this.currentIndex,
			repeatMode: this.repeatMode,
			shuffleActive: this.shuffleActive,
			playlistId: this.playlistId,
			position: positionMs / 1000,
		});
	}

	/** 组件卸载时调用，把最新状态写入 localStorage */
	dispose(): void {
		if (this.disposed) return;
		const shouldClearGapless = this.gaplessBackendActive;
		try {
			this.persistState();
		} finally {
			this.disposed = true;
			this.queueRevision++;
			this.playRequestGeneration++;
			this.playRequestPending = false;
			this.expectedPlaybackId = null;
			this.gaplessRequestGeneration++;
			this.preparedGaplessCandidate = null;
			this.gaplessBackendActive = false;
			this.store.set(queueLoudnessUpdatePolicyAtom, null);

			if (shouldClearGapless) {
				const clearDispatch = this.audioDispatchChain.then(() =>
					emitAudioThread("setGaplessNext", { next: null }),
				);
				this.audioDispatchChain = clearDispatch.catch((error) => {
					console.warn("[Gapless] Failed to clear the prepared track", error);
				});
			}
		}
	}

	private syncPlayModeToMediaControls(): void {
		const repeatMode =
			this.repeatMode === RepeatMode.All
				? "all"
				: this.repeatMode === RepeatMode.One
					? "one"
					: "off";
		emitAudioThread("updatePlayMode", {
			isShuffling: this.shuffleActive,
			repeatMode,
		});
	}

	private queueAudioDispatch(task: () => Promise<void>): Promise<void> {
		const dispatch = this.audioDispatchChain.then(async () => {
			if (this.disposed) return;
			await task();
		});
		this.audioDispatchChain = dispatch.catch(() => {});
		return dispatch;
	}

	private isCurrentPlayRequest(requestGeneration: number): boolean {
		return !this.disposed && requestGeneration === this.playRequestGeneration;
	}

	private getAutoNextIndex(): number | null {
		if (
			this.currentIndex < 0 ||
			this.currentIndex >= this.playList.length ||
			this.playList.length === 0
		) {
			return null;
		}
		if (this.repeatMode === RepeatMode.One) return this.currentIndex;

		const nextIndex = this.currentIndex + 1;
		if (nextIndex < this.playList.length) return nextIndex;
		return this.repeatMode === RepeatMode.All ? 0 : null;
	}

	private invalidateGaplessCandidate(): void {
		this.gaplessRequestGeneration++;
		this.preparedGaplessCandidate = null;
		if (!this.gaplessBackendActive) return;
		this.gaplessBackendActive = false;
		void this.queueAudioDispatch(async () => {
			await emitAudioThread("setGaplessNext", { next: null });
		}).catch((error) => {
			console.warn("[Gapless] Failed to clear the prepared track", error);
		});
	}

	refreshGaplessCandidate(): void {
		const requestGeneration = ++this.gaplessRequestGeneration;
		this.preparedGaplessCandidate = null;
		if (this.gaplessBackendActive) {
			this.gaplessBackendActive = false;
			void this.queueAudioDispatch(async () => {
				await emitAudioThread("setGaplessNext", { next: null });
			}).catch((error) => {
				console.warn("[Gapless] Failed to reset the prepared track", error);
			});
		}

		if (
			this.disposed ||
			!this.desiredPlaying ||
			this.playRequestPending ||
			this.currentPlaybackEnded ||
			!this.currentPlaybackId ||
			!this.store.get(enableGaplessPlaybackAtom)
		) {
			return;
		}

		const candidateIndex = this.getAutoNextIndex();
		if (candidateIndex === null) return;
		const candidate = this.playList[candidateIndex];
		if (!candidate) return;

		const queueRevision = this.queueRevision;
		const currentPlaybackId = this.currentPlaybackId;
		const playbackId = crypto.randomUUID();
		const normalizationEnabled = this.store.get(
			enableLoudnessNormalizationAtom,
		);
		const isCurrentCandidate = () =>
			!this.disposed &&
			requestGeneration === this.gaplessRequestGeneration &&
			queueRevision === this.queueRevision &&
			currentPlaybackId === this.currentPlaybackId &&
			this.store.get(enableGaplessPlaybackAtom) &&
			this.playList[candidateIndex]?.id === candidate.id;

		void (async () => {
			let loudness: TrackLoudnessAnalysis | null = null;
			if (normalizationEnabled) {
				try {
					loudness = await db.songs.getCachedLoudness(candidate.id);
				} catch (error) {
					if (requestGeneration === this.gaplessRequestGeneration) {
						console.warn(
							"[Gapless] Failed to read cached loudness for the prepared track",
							candidate.id,
							error,
						);
					}
				}
				if (!isCurrentCandidate()) return;

				if (!loudness) {
					try {
						let analysis: RhythmAnalysis;
						try {
							analysis = await db.songs.getOrAnalyzeRhythm(
								candidate.id,
								false,
								true,
								true,
							);
						} catch (error) {
							if (!String(error).includes("DECODER_BUSY")) throw error;
							if (!isCurrentCandidate()) return;
							analysis = await db.songs.getOrAnalyzeRhythm(
								candidate.id,
								false,
								true,
								false,
							);
						}
						if (!isCurrentCandidate()) return;
						loudness = getCurrentTrackLoudness(analysis);
					} catch (error) {
						if (isCurrentCandidate()) {
							console.warn(
								"[Gapless] Failed to analyze loudness for the prepared track",
								candidate.id,
								error,
							);
						}
						return;
					}
					if (!loudness) return;
				}
			}

			if (!isCurrentCandidate()) return;

			await this.queueAudioDispatch(async () => {
				if (!isCurrentCandidate()) return;

				this.preparedGaplessCandidate = {
					index: candidateIndex,
					songId: candidate.id,
					playbackId,
				};
				this.gaplessBackendActive = true;
				await emitAudioThread("setGaplessNext", {
					next: {
						song: {
							songId: candidate.id,
							filePath: candidate.filePath,
						},
						loudnessNormalization: {
							enabled: normalizationEnabled,
							integratedLoudnessLufs:
								normalizationEnabled && loudness
									? (loudness.integratedLoudnessLufs ?? null)
									: null,
							samplePeak:
								normalizationEnabled && loudness ? loudness.samplePeak : null,
						},
						playbackId,
					},
				});
			});
		})().catch((error) => {
			if (requestGeneration === this.gaplessRequestGeneration) {
				const backendMayHaveCandidate = this.gaplessBackendActive;
				this.preparedGaplessCandidate = null;
				this.gaplessBackendActive = false;
				console.warn("[Gapless] Failed to prepare the next track", error);
				if (backendMayHaveCandidate) {
					void this.queueAudioDispatch(async () => {
						await emitAudioThread("setGaplessNext", { next: null });
					}).catch((clearError) => {
						console.warn(
							"[Gapless] Failed to clear the uncertain prepared track",
							clearError,
						);
					});
				}
			}
		});
	}

	private async prepareTrackLoudness(
		songId: string,
		requestGeneration: number,
	): Promise<TrackLoudnessPreparation> {
		let cachedLoudness: TrackLoudnessAnalysis | null = null;
		try {
			cachedLoudness = await db.songs.getCachedLoudness(songId);
		} catch (error) {
			if (this.isCurrentPlayRequest(requestGeneration)) {
				console.warn(
					"[VolumeBalance] Failed to read cached track loudness",
					songId,
					error,
				);
			}
		}

		if (!this.isCurrentPlayRequest(requestGeneration)) {
			return { loudness: null, suppressAutomaticUpdate: false };
		}
		if (cachedLoudness) {
			return { loudness: cachedLoudness, suppressAutomaticUpdate: false };
		}

		try {
			const analysis = await db.songs.getOrAnalyzeRhythm(
				songId,
				false,
				true,
				true,
			);
			if (!this.isCurrentPlayRequest(requestGeneration)) {
				return { loudness: null, suppressAutomaticUpdate: false };
			}
			return {
				loudness: getCurrentTrackLoudness(analysis),
				suppressAutomaticUpdate: false,
			};
		} catch (error) {
			const decoderBusy = String(error).includes("DECODER_BUSY");
			if (!this.isCurrentPlayRequest(requestGeneration)) {
				return { loudness: null, suppressAutomaticUpdate: false };
			}
			if (!decoderBusy) {
				console.warn(
					"[VolumeBalance] Failed to analyze track loudness before playback",
					songId,
					error,
				);
				return { loudness: null, suppressAutomaticUpdate: true };
			}

			console.log(
				"[VolumeBalance] Decoder busy, waiting for pre-play loudness analysis",
				songId,
			);
			try {
				const analysis = await db.songs.getOrAnalyzeRhythm(
					songId,
					false,
					true,
					false,
				);
				if (!this.isCurrentPlayRequest(requestGeneration)) {
					return { loudness: null, suppressAutomaticUpdate: false };
				}
				return {
					loudness: getCurrentTrackLoudness(analysis),
					suppressAutomaticUpdate: false,
				};
			} catch (blockingError) {
				if (!this.isCurrentPlayRequest(requestGeneration)) {
					return { loudness: null, suppressAutomaticUpdate: false };
				}
				console.warn(
					"[VolumeBalance] Failed to analyze track loudness after waiting for the decoder",
					songId,
					blockingError,
				);
				return {
					loudness: null,
					// 真正的分析失败仍禁止本曲中途改变增益。
					suppressAutomaticUpdate: true,
				};
			}
		}
	}

	private async playSongAt(
		index: number,
		startPaused = false,
	): Promise<boolean> {
		if (this.disposed || index < 0 || index >= this.playList.length)
			return false;
		this.queueRevision++;
		this.invalidateGaplessCandidate();
		const requestGeneration = ++this.playRequestGeneration;
		const playbackId = crypto.randomUUID();
		this.expectedPlaybackId = playbackId;
		const song = this.playList[index];
		this.desiredPlaying = !startPaused;
		this.currentPlaybackEnded = false;
		this.playRequestPending = true;
		let started = false;

		try {
			this.currentIndex = index;
			this.syncToAtoms();

			let loudness: TrackLoudnessAnalysis | null = null;
			let suppressAutomaticLoudnessUpdate = false;
			if (this.store.get(enableLoudnessNormalizationAtom)) {
				const preparation = await this.prepareTrackLoudness(
					song.id,
					requestGeneration,
				);
				loudness = preparation.loudness;
				suppressAutomaticLoudnessUpdate = preparation.suppressAutomaticUpdate;
			}

			if (!this.isCurrentPlayRequest(requestGeneration)) return false;

			const resolvedIndex = this.findInPlayList(song.id);
			if (resolvedIndex < 0) return false;
			if (this.currentIndex !== resolvedIndex) {
				this.currentIndex = resolvedIndex;
				this.syncToAtoms();
			}

			const dispatch = this.queueAudioDispatch(async () => {
				if (this.disposed || requestGeneration !== this.playRequestGeneration)
					return;
				const enabled = this.store.get(enableLoudnessNormalizationAtom);
				const shouldStartPaused = !this.desiredPlaying;
				this.currentPlaybackId = playbackId;
				this.store.set(
					queueLoudnessUpdatePolicyAtom,
					enabled && !loudness && suppressAutomaticLoudnessUpdate
						? {
								musicId: song.id,
								suppressAutomaticUpdate: true,
							}
						: null,
				);

				await emitAudioThread("playAudio", {
					song: {
						songId: song.id,
						filePath: song.filePath,
					},
					loudnessNormalization: {
						enabled,
						integratedLoudnessLufs:
							enabled && loudness
								? (loudness.integratedLoudnessLufs ?? null)
								: null,
						samplePeak: enabled && loudness ? loudness.samplePeak : null,
					},
					playbackId,
					startPaused: shouldStartPaused,
				});
				if (requestGeneration !== this.playRequestGeneration) return;
				started = true;
			});
			await dispatch;
			return started;
		} catch (error) {
			console.warn(
				"[PlayQueueManager] Failed to prepare or start song",
				song.id,
				error,
			);
			return false;
		} finally {
			if (requestGeneration === this.playRequestGeneration) {
				this.playRequestPending = false;
				if (started) this.refreshGaplessCandidate();
			}
		}
	}

	async playCurrentForRestore(): Promise<boolean> {
		return this.playSongAt(this.currentIndex, !this.desiredPlaying);
	}

	isPlaybackRequested(): boolean {
		return !this.disposed && this.desiredPlaying;
	}

	togglePlayback(): void {
		this.setPlaybackState(!this.desiredPlaying);
	}

	setPlaybackState(shouldPlay: boolean): void {
		this.desiredPlaying = shouldPlay;
		if (shouldPlay && this.currentPlaybackEnded) {
			this.currentPlaybackEnded = false;
			void this.playSongAt(this.currentIndex);
			return;
		}
		void this.queueAudioDispatch(async () => {
			await emitAudioThread(shouldPlay ? "resumeAudio" : "pauseAudio");
		}).catch((error) => {
			console.warn(
				`[PlayQueueManager] Failed to ${shouldPlay ? "resume" : "pause"} playback`,
				error,
			);
		});
		if (shouldPlay && !this.preparedGaplessCandidate) {
			this.refreshGaplessCandidate();
		}
	}

	setExternalPlaybackState(shouldPlay: boolean): void {
		this.desiredPlaying = shouldPlay;
		if (shouldPlay && this.currentPlaybackEnded) {
			this.currentPlaybackEnded = false;
			void this.playSongAt(this.currentIndex);
			return;
		}
		void this.queueAudioDispatch(async () => {
			await emitAudioThread(shouldPlay ? "resumeAudio" : "pauseAudio");
		}).catch((error) => {
			console.warn(
				`[PlayQueueManager] Failed to confirm external ${
					shouldPlay ? "resume" : "pause"
				} state`,
				error,
			);
		});
		if (shouldPlay && !this.preparedGaplessCandidate) {
			this.refreshGaplessCandidate();
		}
	}

	setExternalStopped(): void {
		this.desiredPlaying = false;
		this.currentPlaybackEnded = this.currentIndex >= 0;
		this.currentPlaybackId = null;
		this.expectedPlaybackId = null;
		this.playRequestGeneration++;
		this.playRequestPending = false;
		this.invalidateGaplessCandidate();
		void this.queueAudioDispatch(async () => {
			await emitAudioThread("stopAudio");
		}).catch((error) => {
			console.warn(
				"[PlayQueueManager] Failed to confirm external stop state",
				error,
			);
		});
	}

	handlePlaybackLoadFailure(playbackId: string): boolean {
		if (this.disposed || !playbackId || playbackId !== this.expectedPlaybackId)
			return false;
		this.desiredPlaying = false;
		this.currentPlaybackEnded = this.currentIndex >= 0;
		this.currentPlaybackId = null;
		this.expectedPlaybackId = null;
		this.playRequestGeneration++;
		this.playRequestPending = false;
		this.invalidateGaplessCandidate();
		return true;
	}

	/** 在 playList 中查找 songId 的索引 */
	private findInPlayList(songId: string): number {
		return this.playList.findIndex((s) => s.id === songId);
	}

	private stopAndClearQueue(): void {
		this.queueRevision++;
		this.playRequestGeneration++;
		this.playRequestPending = false;
		this.desiredPlaying = false;
		this.currentPlaybackEnded = false;
		this.currentPlaybackId = null;
		this.expectedPlaybackId = null;
		this.originalList = [];
		this.playList = [];
		this.currentIndex = -1;
		this.playlistId = null;
		this.store.set(queueLoudnessUpdatePolicyAtom, null);
		this.syncToAtoms();
		this.invalidateGaplessCandidate();

		void this.queueAudioDispatch(async () => {
			await emitAudioThread("stopAudio");
		}).catch((error) => {
			console.warn("[PlayQueueManager] Failed to stop an empty queue", error);
		});
	}
	//#endregion

	//#region 队列设置
	/**
	 * 设置完整播放队列并开始播放指定歌曲
	 * @param songs - Song[]（来自后端 DB）
	 * @param playlistId - 来源播放列表 ID（可选）
	 * @param startIndex - 需要直接开始播放的原始歌曲索引；不传时从实际队列首项开始
	 */
	setQueue(songs: Song[], playlistId?: number, startIndex?: number): void {
		if (this.disposed || songs.length === 0) return;
		const requestedSongId =
			startIndex !== undefined &&
			Number.isInteger(startIndex) &&
			startIndex >= 0 &&
			startIndex < songs.length
				? songs[startIndex]?.id
				: undefined;
		const uniqueSongs = dedupeSongsById(songs);
		if (uniqueSongs.length === 0) return;
		this.originalList = uniqueSongs;
		this.playlistId = playlistId ?? null;

		if (this.shuffleActive) {
			this.playList = shuffleArray(uniqueSongs);
			if (requestedSongId) {
				const requestedIndex = this.findInPlayList(requestedSongId);
				if (requestedIndex > 0) {
					this.playList = [
						...this.playList.slice(requestedIndex),
						...this.playList.slice(0, requestedIndex),
					];
				}
			}
		} else {
			this.playList = [...uniqueSongs];
		}

		const resolvedStartIndex = requestedSongId
			? this.findInPlayList(requestedSongId)
			: -1;
		void this.playSongAt(resolvedStartIndex >= 0 ? resolvedStartIndex : 0);
	}

	/**
	 * 用单首歌替换整个队列并播放
	 */
	replaceQueueAndPlay(song: Song): void {
		if (this.disposed) return;
		this.originalList = [song];
		this.playList = [song];
		this.playlistId = null;
		void this.playSongAt(0);
	}

	/**
	 * 将歌曲添加到队尾
	 */
	enqueueTail(song: Song): void {
		if (this.disposed || this.originalList.some((s) => s.id === song.id))
			return;
		if (this.playList.length === 0) {
			this.replaceQueueAndPlay(song);
			return;
		}
		this.queueRevision++;

		this.originalList.push(song);
		this.playList.push(song);
		this.syncToAtoms();
		this.refreshGaplessCandidate();
	}

	/** 向后兼容旧调用；随机模式下仍沿用插入当前歌曲之后的原有行为。 */
	addToQueue(song: Song): void {
		if (this.disposed || this.originalList.some((s) => s.id === song.id))
			return;
		if (!this.shuffleActive) {
			this.enqueueTail(song);
			return;
		}
		if (this.playList.length === 0) {
			this.replaceQueueAndPlay(song);
			return;
		}

		this.queueRevision++;
		this.originalList.push(song);
		const insertAt = Math.min(this.currentIndex + 1, this.playList.length);
		this.playList.splice(insertAt, 0, song);
		this.syncToAtoms();
		this.refreshGaplessCandidate();
	}

	/**
	 * 将歌曲放到当前歌曲之后；若已存在于队列中则移动现有项目。
	 */
	enqueueNext(song: Song): void {
		if (this.disposed) return;
		if (this.playList.length === 0 || this.currentIndex < 0) {
			this.replaceQueueAndPlay(song);
			return;
		}

		const currentSongId = this.getCurrentSong()?.id;
		if (!currentSongId || currentSongId === song.id) return;

		this.queueRevision++;
		const existingIndex = this.findInPlayList(song.id);
		let queuedSong = song;
		if (existingIndex >= 0) {
			const [existingSong] = this.playList.splice(existingIndex, 1);
			if (!existingSong) return;
			queuedSong = existingSong;
		} else {
			this.originalList.push(song);
		}

		this.currentIndex = this.findInPlayList(currentSongId);
		const insertAt = Math.min(this.currentIndex + 1, this.playList.length);
		this.playList.splice(insertAt, 0, queuedSong);

		if (!this.shuffleActive) {
			this.originalList = [...this.playList];
		}
		this.currentIndex = this.findInPlayList(currentSongId);
		this.syncToAtoms();
		this.refreshGaplessCandidate();
	}
	//#endregion

	//#region 播放控制
	/** 跳转到指定索引播放 */
	playAt(index: number): void {
		void this.playSongAt(index);
	}

	/** 用户手动点击下一首（无视单曲循环） */
	advanceForUser(): void {
		if (this.playList.length === 0) return;
		const nextIndex = (this.currentIndex + 1) % this.playList.length;
		void this.playSongAt(nextIndex);
	}

	/** 用户手动点击下一首（无视单曲循环） */
	retreatForUser(): void {
		if (this.playList.length === 0) return;
		const prevIndex =
			this.currentIndex - 1 < 0
				? this.playList.length - 1
				: this.currentIndex - 1;
		void this.playSongAt(prevIndex);
	}

	/**
	 * 歌曲自然播放结束时调用
	 * - 单曲循环：重播当前歌曲
	 * - 顺序/随机：播放下一首
	 * - 列表播放完毕（非循环）：停止
	 */
	advanceForAutoEnd(
		endedSongId: string,
		endedPlaybackId: string,
		transition?: {
			gapless?: boolean;
			nextPlaybackId?: string | null;
			nextMusicId?: string | null;
		},
	): void {
		if (this.disposed || this.playList.length === 0 || this.playRequestPending)
			return;
		if (this.getCurrentSong()?.id !== endedSongId) return;
		if (this.currentPlaybackId !== endedPlaybackId) return;

		const prepared = this.preparedGaplessCandidate;
		const autoNextIndex = this.getAutoNextIndex();
		const canAdoptGaplessTransition =
			this.desiredPlaying &&
			!this.currentPlaybackEnded &&
			this.store.get(enableGaplessPlaybackAtom) &&
			transition?.gapless &&
			transition.nextPlaybackId &&
			transition.nextMusicId &&
			prepared?.playbackId === transition.nextPlaybackId &&
			prepared.songId === transition.nextMusicId &&
			autoNextIndex === prepared.index &&
			this.playList[prepared.index]?.id === prepared.songId;

		if (canAdoptGaplessTransition && prepared) {
			this.queueRevision++;
			this.gaplessRequestGeneration++;
			this.preparedGaplessCandidate = null;
			this.gaplessBackendActive = false;
			this.currentIndex = prepared.index;
			this.currentPlaybackId = prepared.playbackId;
			this.expectedPlaybackId = prepared.playbackId;
			this.currentPlaybackEnded = false;
			this.store.set(musicPlayingPositionAtom, 0);
			this.syncToAtoms();
			this.refreshGaplessCandidate();
			return;
		}

		if (!this.desiredPlaying) {
			this.currentPlaybackEnded = true;
			this.invalidateGaplessCandidate();
			return;
		}

		if (this.repeatMode === RepeatMode.One) {
			void this.playSongAt(this.currentIndex);
			return;
		}

		const nextIndex = this.currentIndex + 1;
		if (nextIndex >= this.playList.length) {
			if (this.repeatMode === RepeatMode.All) {
				// 列表循环：回到第一首
				void this.playSongAt(0);
				return;
			}

			// RepeatMode.Off
			this.desiredPlaying = false;
			this.currentPlaybackEnded = true;
			this.invalidateGaplessCandidate();
			void this.queueAudioDispatch(async () => {
				await emitAudioThread("pauseAudio");
			}).catch((error) => {
				console.warn(
					"[PlayQueueManager] Failed to finalize completed queue",
					error,
				);
			});
			return;
		}

		void this.playSongAt(nextIndex);
	}
	//#endregion

	//#region 模式切换
	setRepeatMode(mode: RepeatMode): void {
		if (this.disposed) return;
		this.queueRevision++;
		this.repeatMode = mode;
		this.syncToAtoms();
		this.syncPlayModeToMediaControls();
		this.refreshGaplessCandidate();
	}

	cycleRepeatMode(): void {
		const nextMode: RepeatMode =
			this.repeatMode === RepeatMode.Off
				? RepeatMode.All
				: this.repeatMode === RepeatMode.All
					? RepeatMode.One
					: RepeatMode.Off;
		this.setRepeatMode(nextMode);
	}

	toggleShuffle(): void {
		if (this.disposed) return;
		this.queueRevision++;
		const currentSongId =
			this.currentIndex >= 0 ? this.playList[this.currentIndex]?.id : undefined;

		this.shuffleActive = !this.shuffleActive;

		if (this.shuffleActive) {
			this.playList = shuffleArray(this.originalList);
		} else {
			this.playList = [...this.originalList];
		}

		if (currentSongId) {
			const newIndex = this.findInPlayList(currentSongId);
			if (newIndex !== -1) {
				this.currentIndex = newIndex;
			}
		}

		this.syncToAtoms();
		this.syncPlayModeToMediaControls();
		this.refreshGaplessCandidate();
	}

	toggleShuffleOn(): void {
		if (this.shuffleActive) return;
		this.toggleShuffle();
	}

	toggleShuffleOff(): void {
		if (!this.shuffleActive) return;
		this.toggleShuffle();
	}
	//#endregion

	//#region 队列修改
	/**
	 * 移动当前队列中的歌曲；只改变播放队列，不写回来源歌单。
	 */
	moveSong(fromIndex: number, toIndex: number): void {
		if (
			this.disposed ||
			!Number.isInteger(fromIndex) ||
			!Number.isInteger(toIndex) ||
			fromIndex < 0 ||
			fromIndex >= this.playList.length ||
			toIndex < 0 ||
			toIndex >= this.playList.length ||
			fromIndex === toIndex
		) {
			return;
		}

		const currentSongId = this.getCurrentSong()?.id;
		const [song] = this.playList.splice(fromIndex, 1);
		if (!song) return;
		this.queueRevision++;
		this.playList.splice(toIndex, 0, song);

		if (!this.shuffleActive) {
			this.originalList = [...this.playList];
		}
		this.currentIndex = currentSongId ? this.findInPlayList(currentSongId) : -1;
		this.syncToAtoms();
		this.refreshGaplessCandidate();
	}

	/**
	 * 从队列中移除一首歌
	 */
	removeSong(songId: string): void {
		if (this.disposed) return;
		const removeIndex = this.playList.findIndex((s) => s.id === songId);
		if (removeIndex === -1) return;
		this.queueRevision++;

		this.originalList = this.originalList.filter((s) => s.id !== songId);
		this.playList.splice(removeIndex, 1);

		if (this.playList.length === 0) {
			this.stopAndClearQueue();
			return;
		}

		if (removeIndex < this.currentIndex) {
			this.currentIndex--;
		} else if (removeIndex === this.currentIndex) {
			const wasPlaying = this.desiredPlaying;
			this.currentIndex = Math.min(removeIndex, this.playList.length - 1);
			void this.playSongAt(this.currentIndex, !wasPlaying);
			return;
		}

		this.syncToAtoms();
		this.refreshGaplessCandidate();
	}

	/**
	 * 清空当前歌曲之后的待播项目，保留播放历史与当前歌曲。
	 */
	clearUpcoming(): void {
		if (
			this.disposed ||
			this.currentIndex < 0 ||
			this.currentIndex >= this.playList.length - 1
		) {
			return;
		}

		this.queueRevision++;
		const retainedIds = new Set(
			this.playList.slice(0, this.currentIndex + 1).map((song) => song.id),
		);
		this.playList = this.playList.slice(0, this.currentIndex + 1);
		this.originalList = this.originalList.filter((song) =>
			retainedIds.has(song.id),
		);
		this.syncToAtoms();
		this.refreshGaplessCandidate();
	}
	//#endregion

	//#region 恢复队列
	/**
	 * 从 localStorage 恢复队列状态
	 *
	 * 需要从后端 DB 批量查询 songId → Song 映射
	 * @returns 恢复结果，包含是否成功及持久化的播放位置（秒）
	 */
	async restore(): Promise<{ restored: boolean; position: number }> {
		if (this.disposed) return { restored: false, position: 0 };
		const restoreRevision = this.queueRevision;
		const persisted = this.store.get(persistedQueueStateAtom);
		if (!persisted || persisted.songIds.length === 0)
			return { restored: false, position: 0 };

		try {
			const allSongIds = [
				...new Set([...persisted.songIds, ...persisted.originalSongIds]),
			];
			const songs = await db.songs.getByIds(allSongIds);
			if (this.disposed || restoreRevision !== this.queueRevision) {
				return { restored: false, position: 0 };
			}
			const songMap = new Map(songs.map((s) => [s.id, s]));

			// 恢复 playList
			this.playList = dedupeSongsById(
				persisted.songIds
					.map((id) => songMap.get(id))
					.filter((s): s is Song => s !== undefined),
			);

			// 恢复 originalList
			this.originalList = dedupeSongsById(
				persisted.originalSongIds
					.map((id) => songMap.get(id))
					.filter((s): s is Song => s !== undefined),
			);

			// 如果 originalList 因为某些歌曲被删除而为空，用 playList 兜底
			if (this.originalList.length === 0) {
				this.originalList = [...this.playList];
			}

			if (this.playList.length === 0) return { restored: false, position: 0 };

			// 恢复状态
			this.repeatMode = persisted.repeatMode;
			this.shuffleActive = persisted.shuffleActive;
			this.playlistId = persisted.playlistId;

			// 优先按歌曲 ID 恢复，避免前序歌曲缺失后数字索引发生偏移。
			let currentSongIndex = persisted.currentSongId
				? this.findInPlayList(persisted.currentSongId)
				: -1;
			if (currentSongIndex < 0 && persisted.currentSongId) {
				const persistedCurrentIndex = persisted.songIds.indexOf(
					persisted.currentSongId,
				);
				if (persistedCurrentIndex >= 0) {
					// 当前歌曲本身已被删除时，以旧位置为锚：
					// 优先恢复到最近的后继，没有后继时再选择最近的前驱。
					for (
						let index = persistedCurrentIndex + 1;
						index < persisted.songIds.length;
						index++
					) {
						currentSongIndex = this.findInPlayList(persisted.songIds[index]);
						if (currentSongIndex >= 0) break;
					}
					if (currentSongIndex < 0) {
						for (let index = persistedCurrentIndex - 1; index >= 0; index--) {
							currentSongIndex = this.findInPlayList(persisted.songIds[index]);
							if (currentSongIndex >= 0) break;
						}
					}
				}
			}
			if (currentSongIndex >= 0) {
				this.currentIndex = currentSongIndex;
			} else {
				// 兼容旧版本仅保存 currentIndex 的数据。
				this.currentIndex = Math.min(
					persisted.currentIndex,
					this.playList.length - 1,
				);
				if (this.currentIndex < 0) this.currentIndex = 0;
			}

			this.syncToAtoms();
			this.refreshGaplessCandidate();
			return { restored: true, position: persisted.position ?? 0 };
		} catch (err) {
			console.error("[PlayQueueManager] 恢复队列失败:", err);
			return { restored: false, position: 0 };
		}
	}

	//#region 查询
	getCurrentSong(): Song | null {
		return this.playList[this.currentIndex] ?? null;
	}

	getPlayList(): Song[] {
		return [...this.playList];
	}

	getCurrentIndex(): number {
		return this.currentIndex;
	}

	getRepeatMode(): RepeatMode {
		return this.repeatMode;
	}

	isShuffleActive(): boolean {
		return this.shuffleActive;
	}

	getPlaylistId(): number | null {
		return this.playlistId;
	}
	//#endregion
}
