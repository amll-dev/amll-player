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
	/** 每个待播项在 originalSongIds 中的位置，区分同一歌曲的重复项 */
	playOrder?: number[];
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
		const originalIndices = new Map(
			this.originalList.map((song, index) => [song, index]),
		);
		this.store.set(persistedQueueStateAtom, {
			songIds: this.playList.map((s) => s.id),
			originalSongIds: this.originalList.map((s) => s.id),
			playOrder: this.playList.map(
				(song) => originalIndices.get(song) as number,
			),
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

	//#endregion

	//#region 队列设置
	/**
	 * 设置完整播放队列并开始播放，可指定原始歌单中的起播位置
	 * @param songs - Song[]（来自后端 DB）
	 * @param playlistId - 来源播放列表 ID（可选）
	 * @param startIndex - 原始歌单中的起播索引，省略时按当前播放模式选择首曲
	 */
	setQueue(songs: Song[], playlistId?: number, startIndex?: number): void {
		if (songs.length === 0 || (startIndex !== undefined && !songs[startIndex]))
			return;
		// 每个待播项使用独立对象；同一首歌曲可以出现多次。
		const entries = songs.map((song) => ({ ...song }));
		this.originalList = entries;
		this.playlistId = playlistId ?? null;

		if (this.shuffleActive) {
			this.playList =
				startIndex === undefined
					? shuffleArray(entries)
					: [
							entries[startIndex],
							...shuffleArray(
								entries.filter((_, index) => index !== startIndex),
							),
						];
		} else {
			this.playList = [...entries];
		}

		this.playSongAt(this.shuffleActive ? 0 : (startIndex ?? 0));
	}

	/**
	 * 用单首歌替换整个队列并播放
	 */
	replaceQueueAndPlay(song: Song): void {
		song = { ...song };
		this.originalList = [song];
		this.playList = [song];
		this.playlistId = null;
		this.playSongAt(0);
	}

	/**
	 * 导入歌曲到当前队列，保留随机模式下插到下一首的行为
	 */
	addToQueue(song: Song): void {
		if (this.originalList.some((s) => s.id === song.id)) return;

		song = { ...song };
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

	/** 下一首播放：新增一个待播项，允许重复，不打断当前播放。 */
	enqueueNext(song: Song): void {
		if (this.playList.length === 0) {
			this.replaceQueueAndPlay(song);
			return;
		}
		song = { ...song };
		this.originalList.push(song);
		this.playList.splice(this.currentIndex + 1, 0, song);
		this.syncToAtoms();
	}

	/** 新增一个待播项到实际队尾（包括随机模式），允许重复。 */
	enqueueTail(song: Song): void {
		if (this.playList.length === 0) {
			this.replaceQueueAndPlay(song);
			return;
		}
		song = { ...song };
		this.originalList.push(song);
		this.playList.push(song);
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
		const currentSong = this.getCurrentSong();

		this.shuffleActive = !this.shuffleActive;

		if (this.shuffleActive) {
			this.playList = shuffleArray(this.originalList);
		} else {
			this.playList = [...this.originalList];
		}

		if (currentSong) {
			const newIndex = this.playList.indexOf(currentSong);
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
	 * 从队列中移除歌曲的所有待播项，包括手动添加的重复项
	 */
	removeSong(songId: string): void {
		const currentRemoved = this.getCurrentSong()?.id === songId;
		let removedBeforeCurrent = 0;
		const remaining = this.playList.filter((song, index) => {
			if (song.id !== songId) return true;
			if (index < this.currentIndex) removedBeforeCurrent++;
			return false;
		});
		if (remaining.length === this.playList.length) return;

		this.originalList = this.originalList.filter((song) => song.id !== songId);
		this.playList = remaining;
		this.currentIndex -= removedBeforeCurrent;

		if (currentRemoved) {
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

			const originalEntries = persisted.originalSongIds.map((id) => {
				const song = songMap.get(id);
				return song ? { ...song } : undefined;
			});
			this.originalList = originalEntries.filter(
				(s): s is Song => s !== undefined,
			);
			if (persisted.playOrder) {
				this.playList = persisted.playOrder
					.map((index) => originalEntries[index])
					.filter((s): s is Song => s !== undefined);
			} else {
				// 旧存档按同一歌曲的出现顺序逐项匹配，仍保留独立的待播项。
				const remainingEntries = new Map<string, Song[]>();
				for (const entry of this.originalList) {
					const matches = remainingEntries.get(entry.id);
					if (matches) matches.push(entry);
					else remainingEntries.set(entry.id, [entry]);
				}
				this.playList = persisted.songIds.flatMap((id) => {
					const existing = remainingEntries.get(id)?.shift();
					if (existing) return [existing];
					const song = songMap.get(id);
					if (!song) return [];
					const entry = { ...song };
					this.originalList.push(entry);
					return [entry];
				});
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
