import type { LyricLine } from "@applemusic-like-lyrics/core";

// Display timing is independent of the unchanged line and metadata animations.
export const TASKBAR_LYRIC_SCROLL_LEAD_MS = 500;
export const TASKBAR_FIRST_LYRIC_LEAD_MS = 700;

export type LyricJumpState = {
	lastIndex: number;
	jumpId: number;
};

export function findCurrentLyricIndex(
	lines: LyricLine[],
	position: number,
): number {
	let low = 0;
	let high = lines.length - 1;
	let index = -1;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const lineTime = lines[mid].startTime;
		if (lineTime <= position) {
			index = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return index;
}

export function findDisplayedLyricIndex(
	lines: LyricLine[],
	position: number,
): number {
	const currentIndex = findCurrentLyricIndex(lines, position);
	if (currentIndex < 0) {
		const firstLine = lines[0];
		return firstLine &&
			position >= Math.max(0, firstLine.startTime - TASKBAR_FIRST_LYRIC_LEAD_MS)
			? 0
			: -1;
	}
	const currentLine = lines[currentIndex];
	const nextLine = lines[currentIndex + 1];
	if (
		!currentLine ||
		!nextLine ||
		nextLine.startTime - position > TASKBAR_LYRIC_SCROLL_LEAD_MS
	) {
		return currentIndex;
	}

	// Only use the silent gap for the transition. A stale line end must not
	// hide words that are still being sung; unknown endings keep normal timing.
	let endTime = Number.isFinite(currentLine.endTime)
		? currentLine.endTime
		: currentLine.startTime;
	for (const word of currentLine.words ?? []) {
		if (
			Number.isFinite(word.startTime) &&
			Number.isFinite(word.endTime) &&
			word.startTime >= 0 &&
			word.endTime > word.startTime
		) {
			endTime = Math.max(endTime, word.endTime);
		}
	}
	return endTime > currentLine.startTime && position >= endTime
		? currentIndex + 1
		: currentIndex;
}

export function findMetadataLyricIndex(
	previousMusicId: string | null,
	nextMusicId: string,
	lines: LyricLine[],
	position: number,
): number {
	if (previousMusicId !== null && previousMusicId !== nextMusicId) {
		return -1;
	}
	return findDisplayedLyricIndex(lines, position);
}

export function reconcileMetadataTimeline(
	previousIndex: number,
	previousJumpState: LyricJumpState,
	currentLyricIndex: number,
	trackChanged: boolean,
	lyricLineCount: number,
): { currentLyricIndex: number; jumpState: LyricJumpState } {
	if (trackChanged) {
		return {
			currentLyricIndex,
			jumpState: { lastIndex: currentLyricIndex, jumpId: 0 },
		};
	}

	if (previousIndex >= 0 && previousIndex < lyricLineCount) {
		return {
			currentLyricIndex: previousIndex,
			jumpState: previousJumpState,
		};
	}

	return {
		currentLyricIndex,
		jumpState: {
			lastIndex: currentLyricIndex,
			jumpId: previousJumpState.jumpId,
		},
	};
}

export function taskbarContentGroupKey(
	musicId: string,
	displayAsMetadata: boolean,
	jumpId: number,
): string {
	const content = displayAsMetadata ? "metadata" : "lyrics";
	return `${content}-${musicId}-${displayAsMetadata ? 0 : jumpId}`;
}
