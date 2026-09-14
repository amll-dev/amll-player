export interface TimedLyricWord {
	word: string;
	startTime: number;
	endTime: number;
}

export const DEFAULT_TASKBAR_WORD_FADE_WIDTH = 0.5;

export function normalizeTaskbarWordFadeWidth(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_TASKBAR_WORD_FADE_WIDTH;
	return Math.min(10, Math.max(0.0001, value));
}

function hasValidTiming(word: TimedLyricWord): boolean {
	return (
		Number.isFinite(word.startTime) &&
		Number.isFinite(word.endTime) &&
		word.startTime >= 0 &&
		word.endTime > word.startTime
	);
}

export function hasUsableWordTimings(
	words?: readonly TimedLyricWord[],
): words is readonly TimedLyricWord[] {
	if (!words) return false;

	const meaningfulWords = words.filter((word) => word.word.trim().length > 0);
	if (meaningfulWords.length < 2) return false;
	if (!meaningfulWords.every(hasValidTiming)) return false;

	return meaningfulWords.every(
		(word, index) =>
			index === 0 || word.startTime >= meaningfulWords[index - 1].startTime,
	);
}

export function getTimedWordProgress(
	word: TimedLyricWord,
	position: number,
): number {
	if (!Number.isFinite(position) || !hasValidTiming(word)) return 0;

	return Math.max(
		0,
		Math.min(1, (position - word.startTime) / (word.endTime - word.startTime)),
	);
}
