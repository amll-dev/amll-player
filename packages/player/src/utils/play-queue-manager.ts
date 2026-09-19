import {
	isShuffleActiveAtom,
	musicPlayingAtom,
	musicPlayingPositionAtom,
	RepeatMode,
	repeatModeAtom,
} from "@applemusic-like-lyrics/react-full";
import { atom, type createStore, type PrimitiveAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { Song } from "./db-client.ts";
import { db } from "./db-client.ts";
import { emitAudioThread } from "./player.ts";

type JotaiStore = ReturnType<typeof createStore>;

//#region 持久化数据结构
interface PersistedQueueState {
	/** playList 中的 songId 序列 */
	songIds: string[];
	/** originalList 中的 songId 序列（用于 shuffle 恢复） */
	originalSongIds: string[];
	currentIndex: number;
	/** 当前歌曲 ID，避免库中删歌后数字索引错位。 */
	currentSongId?: string | null;
	repeatMode: RepeatMode;
	shuffleActive: boolean;
	playlistId: number | null;
	/** 当前歌曲的播放位置（秒） */
	position: number;
}

const EMPTY_PERSISTED_STATE: PersistedQueueState = {
	songIds: [],
	originalSongIds: [],
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

export class PlayQueueManager {
	private store: JotaiStore;
	private originalList: Song[] = [];
	private playList: Song[] = [];
	private currentIndex = -1;
	private repeatMode: RepeatMode = RepeatMode.Off;
	private shuffleActive = false;
	private playlistId: number | null = null;
	private currentPlaybackId = "";
	private queueRevision = 0;
	private queueEditRevision = 0;
	private disposed = false;
	private hasQueueState = false;
	private playModeRevision = 0;
	private pendingRestore: {
		revision: number;
		songId: string;
		position: number;
	} | null = null;

	constructor(store: JotaiStore) {
		this.store = store;
	}

	//#region 辅助方法
	private syncToAtoms(): void {
		this.hasQueueState = true;
		this.store.set(queuePlaylistAtom, [...this.playList]);
		this.store.set(queueCurrentIndexAtom, this.currentIndex);
		this.syncPlayModeToAtoms();
		this.store.set(queuePlaylistIdAtom, this.playlistId);
		this.persistState();
	}

	private syncPlayModeToAtoms(): void {
		this.store.set(queueRepeatModeAtom, this.repeatMode);
		this.store.set(queueShuffleActiveAtom, this.shuffleActive);
		this.store.set(repeatModeAtom, this.repeatMode);
		this.store.set(isShuffleActiveAtom, this.shuffleActive);
	}

	/** 尚未读回歌曲时，只保存模式，不用空列表覆盖原队列。 */
	private persistInitialPlayMode(): void {
		this.store.set(persistedQueueStateAtom, {
			...this.store.get(persistedQueueStateAtom),
			repeatMode: this.repeatMode,
			shuffleActive: this.shuffleActive,
		});
		this.syncPlayModeToAtoms();
		this.syncPlayModeToMediaControls();
	}

	/** 将当前队列状态写入 localStorage */
	private persistState(): void {
		if (!this.hasQueueState) return;
		const positionMs = this.store.get(musicPlayingPositionAtom);
		this.store.set(persistedQueueStateAtom, {
			songIds: this.playList.map((s) => s.id),
			originalSongIds: this.originalList.map((s) => s.id),
			currentIndex: this.currentIndex,
			currentSongId: this.getCurrentSong()?.id ?? null,
			repeatMode: this.repeatMode,
			shuffleActive: this.shuffleActive,
			playlistId: this.playlistId,
			position: positionMs / 1000,
		});
	}

	/** 组件卸载时调用，把最新状态写入 localStorage */
	dispose(): void {
		this.disposed = true;
		this.cancelRestore();
		this.persistState();
	}

	/** 播放、跳转等用户操作优先于尚未完成的启动恢复。 */
	cancelRestore(position?: number): void {
		const pending = this.pendingRestore;
		const preservePosition =
			position !== undefined &&
			pending &&
			pending.songId === this.getCurrentSong()?.id &&
			this.isCurrentRevision(pending.revision);
		this.queueRevision++;
		// 手动跳转也要交给晚到的 LoadAudio，避免它再把进度清零。
		this.pendingRestore = preservePosition
			? { ...pending, revision: this.queueRevision, position }
			: null;
	}

	isCurrentRevision(revision: number): boolean {
		return !this.disposed && revision === this.queueRevision;
	}

	/** LoadAudio 晚于 IPC 返回时，也保留恢复进度；每次加载只取一次。 */
	takeRestorePosition(songId: string): number | undefined {
		const restore = this.pendingRestore;
		if (
			!restore ||
			restore.songId !== songId ||
			!this.isCurrentRevision(restore.revision)
		)
			return;
		this.pendingRestore = null;
		return restore.position;
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

	private async playSongAt(
		index: number,
		startPaused = false,
	): Promise<boolean> {
		if (this.disposed || index < 0 || index >= this.playList.length)
			return false;
		this.cancelRestore();
		const revision = this.queueRevision;
		this.currentIndex = index;
		this.syncToAtoms();
		const song = this.playList[index];
		this.currentPlaybackId = crypto.randomUUID();
		await emitAudioThread("playAudio", {
			song: {
				songId: song.id,
				filePath: song.filePath,
			},
			playbackId: this.currentPlaybackId,
			startPaused,
		});
		return !this.disposed && revision === this.queueRevision;
	}

	/** 恢复请求与跳转共用修订号，切歌后不再给新歌曲跳转旧进度。 */
	async restoreCurrentPaused(
		revision: number,
		position: number,
	): Promise<number | null> {
		const currentSong = this.getCurrentSong();
		if (!this.isCurrentRevision(revision) || !currentSong) return null;
		const started = this.playSongAt(this.currentIndex, true);
		const playbackRevision = this.queueRevision;
		this.pendingRestore = {
			revision: playbackRevision,
			songId: currentSong.id,
			position,
		};
		try {
			if (!(await started) || !this.isCurrentRevision(playbackRevision))
				return null;
			if (position > 0) {
				await emitAudioThread("seekAudio", { position });
			}
			return this.isCurrentRevision(playbackRevision) ? playbackRevision : null;
		} catch (error) {
			if (this.isCurrentRevision(playbackRevision)) this.cancelRestore();
			throw error;
		}
	}

	/** 在 playList 中查找 songId 的索引 */
	private findInPlayList(songId: string): number {
		return this.playList.findIndex((s) => s.id === songId);
	}
	//#endregion

	//#region 队列设置
	/**
	 * 设置完整播放队列并开始播放第一首
	 * @param songs - Song[]（来自后端 DB）
	 * @param playlistId - 来源播放列表 ID（可选）
	 */
	setQueue(songs: Song[], playlistId?: number): void {
		if (songs.length === 0) return;
		this.originalList = [...songs];
		this.playlistId = playlistId ?? null;

		if (this.shuffleActive) {
			this.playList = shuffleArray(songs);
		} else {
			this.playList = [...songs];
		}

		this.playSongAt(0);
	}

	/**
	 * 用单首歌替换整个队列并播放
	 */
	replaceQueueAndPlay(song: Song): void {
		this.originalList = [song];
		this.playList = [song];
		this.playlistId = null;
		this.playSongAt(0);
	}

	/**
	 * 将歌曲添加到队尾
	 */
	addToQueue(song: Song): void {
		if (this.originalList.some((s) => s.id === song.id)) return;
		this.cancelRestore();

		this.originalList.push(song);

		if (this.shuffleActive) {
			// 随机模式下，插入到当前播放位置的下一位
			const insertAt = this.currentIndex + 1;
			this.playList.splice(insertAt, 0, song);
		} else {
			this.playList.push(song);
		}

		this.syncToAtoms();
	}

	/** 添加到实际队尾；随机播放时也不插到当前歌曲之后。 */
	enqueueTail(song: Song): void {
		if (this.disposed || this.originalList.some((s) => s.id === song.id))
			return;
		if (this.playList.length === 0) {
			this.replaceQueueAndPlay(song);
			return;
		}
		// 队列编辑只使旧读库结果失效，不取消当前歌曲的暂停恢复。
		this.queueEditRevision++;
		this.originalList.push(song);
		this.playList.push(song);
		this.syncToAtoms();
	}

	/** 放到当前歌曲之后；已在队列中时移动原有项，不替换其元数据。 */
	enqueueNext(song: Song): void {
		if (this.disposed) return;
		if (this.playList.length === 0 || this.currentIndex < 0) {
			this.replaceQueueAndPlay(song);
			return;
		}
		const currentSongId = this.getCurrentSong()?.id;
		if (!currentSongId || currentSongId === song.id) return;

		this.queueEditRevision++;
		const existingIndex = this.findInPlayList(song.id);
		let queuedSong = song;
		if (existingIndex >= 0) {
			const [existingSong] = this.playList.splice(existingIndex, 1);
			queuedSong = existingSong;
			// 旧队列可能含重复 ID，按位置保留正在播放的那一项。
			if (existingIndex < this.currentIndex) this.currentIndex--;
		} else {
			this.originalList.push(song);
		}
		this.playList.splice(this.currentIndex + 1, 0, queuedSong);
		if (!this.shuffleActive) {
			this.originalList = [...this.playList];
		}
		this.syncToAtoms();
	}
	//#endregion

	//#region 播放控制
	/** 跳转到指定索引播放 */
	playAt(index: number): void {
		this.playSongAt(index);
	}

	/** 用户手动点击下一首（无视单曲循环） */
	advanceForUser(): void {
		if (this.playList.length === 0) return;
		const nextIndex = (this.currentIndex + 1) % this.playList.length;
		this.playSongAt(nextIndex);
	}

	/** 用户手动点击下一首（无视单曲循环） */
	retreatForUser(): void {
		if (this.playList.length === 0) return;
		const prevIndex =
			this.currentIndex - 1 < 0
				? this.playList.length - 1
				: this.currentIndex - 1;
		this.playSongAt(prevIndex);
	}

	/**
	 * 歌曲自然播放结束时调用
	 * - 单曲循环：重播当前歌曲
	 * - 顺序/随机：播放下一首
	 * - 列表播放完毕（非循环）：停止
	 */
	advanceForAutoEnd(endedSongId: string, endedPlaybackId: string): void {
		if (this.playList.length === 0) return;
		if (!this.currentPlaybackId || endedPlaybackId !== this.currentPlaybackId)
			return;
		if (endedSongId !== this.getCurrentSong()?.id) return;
		// 一个播放请求的结束事件只消费一次，包括列表末尾。
		this.currentPlaybackId = "";

		if (this.repeatMode === RepeatMode.One) {
			this.playSongAt(this.currentIndex);
			return;
		}

		const nextIndex = this.currentIndex + 1;
		if (nextIndex >= this.playList.length) {
			if (this.repeatMode === RepeatMode.All) {
				// 列表循环：回到第一首
				this.playSongAt(0);
				return;
			}

			// RepeatMode.Off
			emitAudioThread("pauseAudio");
			return;
		}

		this.playSongAt(nextIndex);
	}

	/** 系统停止后，迟到的结束事件不再触发下一首。 */
	setExternalStopped(): void {
		this.cancelRestore();
		this.currentPlaybackId = "";
		this.store.set(musicPlayingAtom, false);
		this.store.set(musicPlayingPositionAtom, 0);
	}
	//#endregion

	//#region 模式切换
	setRepeatMode(mode: RepeatMode): void {
		this.playModeRevision++;
		this.repeatMode = mode;
		if (!this.hasQueueState) {
			this.persistInitialPlayMode();
			return;
		}
		this.syncToAtoms();
		this.syncPlayModeToMediaControls();
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
		this.playModeRevision++;
		const currentSongId =
			this.currentIndex >= 0 ? this.playList[this.currentIndex]?.id : undefined;

		this.shuffleActive = !this.shuffleActive;
		if (!this.hasQueueState) {
			this.persistInitialPlayMode();
			return;
		}

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
	 * 从队列中移除一首歌
	 */
	removeSong(songId: string): void {
		const removeIndex = this.playList.findIndex((s) => s.id === songId);
		if (removeIndex === -1) return;
		this.cancelRestore();

		this.originalList = this.originalList.filter((s) => s.id !== songId);
		this.playList.splice(removeIndex, 1);

		if (removeIndex < this.currentIndex) {
			this.currentIndex--;
		} else if (removeIndex === this.currentIndex) {
			if (this.playList.length === 0) {
				this.currentIndex = -1;
				this.setExternalStopped();
				emitAudioThread("stopAudio");
			} else if (this.currentIndex >= this.playList.length) {
				this.currentIndex = 0;
			}
			if (this.currentIndex >= 0) {
				this.playSongAt(this.currentIndex);
				return;
			}
		}

		this.syncToAtoms();
	}
	//#endregion

	//#region 恢复队列
	/**
	 * 从 localStorage 恢复队列状态
	 *
	 * 需要从后端 DB 批量查询 songId → Song 映射
	 * @returns 恢复结果，包含是否成功及持久化的播放位置（秒）
	 */
	async restore(): Promise<
		| { restored: false; position: number }
		| { restored: true; position: number; revision: number }
	> {
		if (this.disposed) return { restored: false, position: 0 };
		const revision = ++this.queueRevision;
		const editRevision = this.queueEditRevision;
		const persisted = this.store.get(persistedQueueStateAtom);
		if (!persisted || persisted.songIds.length === 0)
			return { restored: false, position: 0 };
		const modeRevision = this.playModeRevision;
		if (!this.hasQueueState) {
			this.repeatMode = persisted.repeatMode;
			this.shuffleActive = persisted.shuffleActive;
			this.syncPlayModeToAtoms();
		}

		try {
			const allSongIds = [
				...new Set([...persisted.songIds, ...persisted.originalSongIds]),
			];
			const songs = await db.songs.getByIds(allSongIds);
			if (
				this.disposed ||
				revision !== this.queueRevision ||
				editRevision !== this.queueEditRevision
			) {
				return { restored: false, position: 0 };
			}
			const songMap = new Map(songs.map((s) => [s.id, s]));

			// 恢复 playList
			this.playList = persisted.songIds
				.map((id) => songMap.get(id))
				.filter((s): s is Song => s !== undefined);

			// 恢复 originalList
			this.originalList = persisted.originalSongIds
				.map((id) => songMap.get(id))
				.filter((s): s is Song => s !== undefined);

			// 如果 originalList 因为某些歌曲被删除而为空，用 playList 兜底
			if (this.originalList.length === 0) {
				this.originalList = [...this.playList];
			}

			if (this.playList.length === 0) return { restored: false, position: 0 };

			// 恢复状态
			if (modeRevision === this.playModeRevision) {
				this.repeatMode = persisted.repeatMode;
				this.shuffleActive = persisted.shuffleActive;
			} else if (this.shuffleActive !== persisted.shuffleActive) {
				this.playList = this.shuffleActive
					? shuffleArray(this.originalList)
					: [...this.originalList];
			}
			this.playlistId = persisted.playlistId;

			// 旧数据只有数字索引时，也先在未过滤的旧列表中找回歌曲 ID。
			const savedSongId =
				persisted.currentSongId ?? persisted.songIds[persisted.currentIndex];
			let currentIndex = savedSongId ? this.findInPlayList(savedSongId) : -1;
			if (currentIndex < 0 && savedSongId) {
				const anchor = persisted.songIds.indexOf(savedSongId);
				if (anchor >= 0) {
					// 缺失当前歌曲时，先找最近的后继，再找前驱。
					const neighbors = [
						...persisted.songIds.slice(anchor + 1),
						...persisted.songIds.slice(0, anchor).reverse(),
					];
					for (const id of neighbors) {
						currentIndex = this.findInPlayList(id);
						if (currentIndex >= 0) break;
					}
				}
			}
			this.currentIndex = currentIndex >= 0 ? currentIndex : 0;
			const position =
				this.getCurrentSong()?.id === savedSongId &&
				Number.isFinite(persisted.position)
					? Math.max(0, persisted.position)
					: 0;
			this.store.set(musicPlayingPositionAtom, position * 1000);

			this.syncToAtoms();
			this.syncPlayModeToMediaControls();
			return { restored: true, position, revision };
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
