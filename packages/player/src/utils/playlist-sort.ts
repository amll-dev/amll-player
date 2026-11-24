import type { Song } from "./db-client.ts";

/** 可选的排序依据 */
export type PlaylistSortKey =
	| "addedAt"
	| "songName"
	| "songArtists"
	| "songAlbum"
	| "fileName"
	| "duration";

/** 排序方向 */
export type PlaylistSortOrder = "asc" | "desc";

/** 分组依据 */
export type PlaylistGroupKey = "none" | "album" | "artist";

export interface PlaylistViewOptions {
	sortKey: PlaylistSortKey;
	sortOrder: PlaylistSortOrder;
	groupKey: PlaylistGroupKey;
}

export const DEFAULT_PLAYLIST_VIEW_OPTIONS: PlaylistViewOptions = {
	sortKey: "addedAt",
	sortOrder: "asc",
	groupKey: "none",
};

const collator = new Intl.Collator(undefined, {
	numeric: true,
	sensitivity: "base",
});

const compareText = (a: string, b: string) => collator.compare(a, b);

/** 取路径中的文件名，兼容 Windows 反斜杠与 POSIX 斜杠 */
export const getSongFileName = (song: Song): string => {
	const segments = song.filePath.split(/[\\/]/);
	return segments[segments.length - 1] || song.filePath;
};

const getGroupLabel = (song: Song, groupKey: PlaylistGroupKey): string => {
	switch (groupKey) {
		case "album":
			return song.songAlbum.trim();
		case "artist":
			return song.songArtists.trim();
		default:
			return "";
	}
};

const compareSongs = (
	a: Song,
	b: Song,
	key: PlaylistSortKey,
	aIndex: number,
	bIndex: number,
): number => {
	switch (key) {
		case "addedAt":
			return aIndex - bIndex;
		case "fileName":
			return compareText(getSongFileName(a), getSongFileName(b));
		case "duration":
			return a.duration - b.duration;
		case "songName":
			return compareText(a.songName, b.songName);
		case "songArtists":
			return compareText(a.songArtists, b.songArtists);
		case "songAlbum":
			return compareText(a.songAlbum, b.songAlbum);
	}
};

interface SongEntry {
	song: Song;
	/** 后端返回的原始下标，即添加时间顺序 */
	index: number;
}

/**
 * 按添加时间、歌名、歌手、专辑、文件名或时长排序，并可选按专辑/歌手分组。
 *
 * `songs` 必须按添加时间升序传入（`db.playlists.getSongs` 的返回顺序）。
 * 无分组时直接排序；有分组时先按组名排序分组，再在组内排序，最后拍平。
 */
export function sortPlaylistSongs(
	songs: Song[],
	options: PlaylistViewOptions,
): Song[] {
	const direction = options.sortOrder === "asc" ? 1 : -1;

	const compareEntries = (a: SongEntry, b: SongEntry): number => {
		const result = compareSongs(
			a.song,
			b.song,
			options.sortKey,
			a.index,
			b.index,
		);
		// 同值时保持添加顺序，避免每次刷新顺序抖动
		return result !== 0 ? result * direction : a.index - b.index;
	};

	const entries: SongEntry[] = songs.map((song, index) => ({ song, index }));

	if (options.groupKey === "none") {
		return entries.sort(compareEntries).map((entry) => entry.song);
	}

	const groups = new Map<string, SongEntry[]>();
	for (const entry of entries) {
		const label = getGroupLabel(entry.song, options.groupKey);
		const group = groups.get(label);
		if (group) {
			group.push(entry);
		} else {
			groups.set(label, [entry]);
		}
	}

	// 没有分组信息的歌曲始终排在最后，不随排序方向翻转
	const compareGroupLabels = (a: string, b: string): number => {
		if (!a && !b) return 0;
		if (!a) return 1;
		if (!b) return -1;
		return compareText(a, b) * direction;
	};

	return [...groups.entries()]
		.sort(([labelA], [labelB]) => compareGroupLabels(labelA, labelB))
		.flatMap(([, group]) =>
			group.sort(compareEntries).map((entry) => entry.song),
		);
}
