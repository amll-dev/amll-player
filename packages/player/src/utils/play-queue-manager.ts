import {
	isShuffleActiveAtom,
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

	constructor(store: JotaiStore) {
		this.store = store;
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
			currentIndex: this.currentIndex,
			repeatMode: this.repeatMode,
			shuffleActive: this.shuffleActive,
			playlistId: this.playlistId,
			position: positionMs / 1000,
		});
	}

	/** 组件卸载时调用，把最新状态写入 localStorage */
	dispose(): void {
		this.persistState();
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

	private playSongAt(index: number): void {
		if (index < 0 || index >= this.playList.length) return;
		this.currentIndex = index;
		this.syncToAtoms();
		const song = this.playList[index];
		emitAudioThread("playAudio", {
			song: {
				songId: song.id,
				filePath: song.filePath,
			},
		});
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
	advanceForAutoEnd(): void {
		if (this.playList.length === 0) return;

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
	//#endregion

	//#region 模式切换
	setRepeatMode(mode: RepeatMode): void {
		this.repeatMode = mode;
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

		this.originalList = this.originalList.filter((s) => s.id !== songId);
		this.playList.splice(removeIndex, 1);

		if (removeIndex < this.currentIndex) {
			this.currentIndex--;
		} else if (removeIndex === this.currentIndex) {
			if (this.playList.length === 0) {
				this.currentIndex = -1;
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
	async restore(): Promise<{ restored: boolean; position: number }> {
		const persisted = this.store.get(persistedQueueStateAtom);
		if (!persisted || persisted.songIds.length === 0)
			return { restored: false, position: 0 };

		try {
			const allSongIds = [
				...new Set([...persisted.songIds, ...persisted.originalSongIds]),
			];
			const songs = await db.songs.getByIds(allSongIds);
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
			this.repeatMode = persisted.repeatMode;
			this.shuffleActive = persisted.shuffleActive;
			this.playlistId = persisted.playlistId;

			// 恢复 currentIndex，做边界检查
			this.currentIndex = Math.min(
				persisted.currentIndex,
				this.playList.length - 1,
			);
			if (this.currentIndex < 0) this.currentIndex = 0;

			this.syncToAtoms();
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
