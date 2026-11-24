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
 * 无分组时直接排序；有分组时先排组内，再以「组内第一首」在所选排序字段上的值
 * 排序分组（例如添加时间正序时，最早加入的歌曲所在的组排在最前），最后拍平。
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

	const orderedGroups = [...groups.entries()]
		.map(([label, group]) => ({ label, group: group.sort(compareEntries) }))
		.sort((a, b) => {
			const firstA = a.group[0];
			const firstB = b.group[0];
			const result = compareSongs(
				firstA.song,
				firstB.song,
				options.sortKey,
				firstA.index,
				firstB.index,
			);
			if (result !== 0) return result * direction;
			// 组内首曲在排序字段上相同时，按组名兜底，保证顺序稳定
			return compareText(a.label, b.label);
		});

	return orderedGroups.flatMap(({ group }) =>
		group.map((entry) => entry.song),
	);
}
