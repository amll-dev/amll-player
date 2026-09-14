import type { LyricLine } from "@applemusic-like-lyrics/core";
import type { BackgroundTrayMenuState } from "../../components/TrayBridge/types.ts";
import { findCurrentLyricIndex } from "../taskbar-lyric/lyric-timeline.ts";

export interface TrayPlayerText {
	title: string;
	secondary: string;
	showingLyric: boolean;
}

export function getReachedTrayLyric(
	lines: LyricLine[],
	position: number,
): string {
	const lyricIndex = findCurrentLyricIndex(lines, position);
	return lyricIndex >= 0
		? lines[lyricIndex].words
				.map((word) => word.word)
				.join("")
				.trim()
		: "";
}

export function resolveTrayPlayerText(
	state: BackgroundTrayMenuState,
): TrayPlayerText {
	if (!state.canControl) {
		return {
			title: state.labels.appName,
			secondary: state.labels.unknownSong,
			showingLyric: false,
		};
	}

	const title = state.musicName.trim() || state.labels.unknownSong;
	const artist = state.artist.trim() || state.labels.unknownArtist;
	const lyric = state.lyric.trim();
	const showingLyric = !state.taskbarLyricEnabled && lyric.length > 0;

	return showingLyric
		? {
				title: `${title} - ${artist}`,
				secondary: lyric,
				showingLyric: true,
			}
		: {
				title,
				secondary: artist,
				showingLyric: false,
			};
}
