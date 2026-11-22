import type { LyricLine as CoreLyricLine } from "@applemusic-like-lyrics/core";
import {
	type LyricLine,
	parseEslrc,
	parseLrc,
	parseLys,
	parseQrc,
	parseSPL,
	parseYrc,
} from "@applemusic-like-lyrics/lyric";
import chalk from "chalk";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { languageAtom } from "../states/appAtoms";
import { handleTTMLParsing } from "../utils/ttml-parser";

const LYRIC_LOG_TAG = chalk.bgHex("#FF4444").hex("#FFFFFF")(" LYRIC ");

type TransLine = {
	[K in keyof CoreLyricLine]: CoreLyricLine[K] extends string ? K : never;
}[keyof CoreLyricLine];

function pairLyric(line: LyricLine, lines: CoreLyricLine[], key: TransLine) {
	if (
		line.words
			.map((v) => v.word)
			.join("")
			.trim().length === 0
	)
		return;
	interface PairedLine {
		startTime: number;
		lineText: string;
		origIndex: number;
		original: CoreLyricLine;
	}
	const processed: PairedLine[] = lines.map((v, i) => ({
		startTime: Math.min(v.startTime, ...v.words.map((v) => v.startTime)),
		origIndex: i,
		lineText: v.words
			.map((v) => v.word)
			.join("")
			.trim(),
		original: v,
	}));
	let nearestLine: PairedLine | undefined;
	for (const coreLine of processed) {
		if (coreLine.lineText.length > 0) {
			if (coreLine.startTime === line.words[0].startTime) {
				nearestLine = coreLine;
				break;
			}
			if (
				nearestLine &&
				Math.abs(nearestLine.startTime - line.words[0].startTime) >
					Math.abs(coreLine.startTime - line.words[0].startTime)
			) {
				nearestLine = coreLine;
			} else if (nearestLine === undefined) {
				nearestLine = coreLine;
			}
		}
	}
	if (nearestLine) {
		const joined = line.words.map((w) => w.word).join("");
		if (nearestLine.original[key].length > 0)
			nearestLine.original[key] += joined;
		else nearestLine.original[key] = joined;
	}
}

/**
 * 按 SPL 标准合并翻译行：同一时间戳的第一句为主歌词，其后的都是翻译（支持多行翻译）
 *
 * parseSPL 已经按时间稳定排序，并为省略时间戳的翻译行补上了主歌词的时间戳，
 * 所以同时间戳的行在这里一定相邻
 *
 * @see https://moriafly.com/standards/spl.html
 */
function foldSplTranslationLines(lines: LyricLine[]): LyricLine[] {
	const result: LyricLine[] = [];
	for (const line of lines) {
		const prev = result[result.length - 1];
		if (prev && prev.startTime === line.startTime) {
			const text = line.words
				.map((w) => w.word)
				.join("")
				.trim();
			if (text.length > 0)
				prev.translatedLyric = prev.translatedLyric
					? `${prev.translatedLyric} / ${text}`
					: text;
			continue;
		}
		result.push({ ...line });
	}
	return result;
}

interface LyricParserResult {
	lyricLines: CoreLyricLine[];
	hasLyrics: boolean;
	metadata: [string, string[]][];
}

export const useLyricParser = (
	lyricStr?: string,
	format?: string,
	translatedLrc?: string,
	romanLrc?: string,
): LyricParserResult => {
	const displayLanguage = useAtomValue(languageAtom);

	return useMemo(() => {
		if (!lyricStr || !format) {
			return { lyricLines: [], hasLyrics: false, metadata: [] };
		}

		try {
			let parsedLyricLines: LyricLine[] = [];
			let parsedMetadata: [string, string[]][] = [];

			switch (format) {
				case "lrc": {
					parsedLyricLines = parseLrc(lyricStr);
					console.log(LYRIC_LOG_TAG, "解析出 LyRiC 歌词", parsedLyricLines);
					break;
				}
				case "eslrc": {
					parsedLyricLines = parseEslrc(lyricStr);
					console.log(LYRIC_LOG_TAG, "解析出 ESLyRiC 歌词", parsedLyricLines);
					break;
				}
				case "spl": {
					parsedLyricLines = foldSplTranslationLines(parseSPL(lyricStr));
					console.log(
						LYRIC_LOG_TAG,
						"解析出 Salt Player Lyrics 歌词",
						parsedLyricLines,
					);
					break;
				}
				case "yrc": {
					parsedLyricLines = parseYrc(lyricStr);
					console.log(LYRIC_LOG_TAG, "解析出 YRC 歌词", parsedLyricLines);
					break;
				}
				case "qrc": {
					parsedLyricLines = parseQrc(lyricStr);
					console.log(LYRIC_LOG_TAG, "解析出 QRC 歌词", parsedLyricLines);
					break;
				}
				case "lys": {
					parsedLyricLines = parseLys(lyricStr);
					console.log(
						LYRIC_LOG_TAG,
						"解析出 Lyricify Syllable 歌词",
						parsedLyricLines,
					);
					break;
				}
				case "ttml": {
					const ttmlResult = handleTTMLParsing(lyricStr, displayLanguage);
					parsedLyricLines = ttmlResult.lines;
					parsedMetadata = ttmlResult.metadata;
					console.log(LYRIC_LOG_TAG, "解析出 TTML 歌词", ttmlResult);
					break;
				}
				default: {
					return { lyricLines: [], hasLyrics: false, metadata: [] };
				}
			}

			const compatibleLyricLines: CoreLyricLine[] = parsedLyricLines.map(
				(line) => ({
					...line,
					words: line.words.map((word) => ({
						...word,
						obscene: false,
					})),
				}),
			);

			if (translatedLrc) {
				try {
					const translatedLyricLines = parseLrc(translatedLrc);
					for (const line of translatedLyricLines) {
						pairLyric(
							{
								...line,
								words: line.words.map((word) => ({
									...word,
									obscene: false,
								})),
							},
							compatibleLyricLines,
							"translatedLyric",
						);
					}
					console.log(LYRIC_LOG_TAG, "已匹配翻译歌词");
				} catch (err) {
					console.warn(LYRIC_LOG_TAG, "解析翻译歌词时出现错误", err);
				}
			}

			if (romanLrc) {
				try {
					const romanLyricLines = parseLrc(romanLrc);
					for (const line of romanLyricLines) {
						pairLyric(
							{
								...line,
								words: line.words.map((word) => ({
									...word,
									obscene: false,
								})),
							},
							compatibleLyricLines,
							"romanLyric",
						);
					}
					console.log(LYRIC_LOG_TAG, "已匹配音译歌词");
				} catch (err) {
					console.warn(LYRIC_LOG_TAG, "解析音译歌词时出现错误", err);
				}
			}

			return {
				lyricLines: compatibleLyricLines,
				hasLyrics: compatibleLyricLines.length > 0,
				metadata: parsedMetadata,
			};
		} catch (e) {
			console.warn("解析歌词时出现错误", e);
			return { lyricLines: [], hasLyrics: false, metadata: [] };
		}
	}, [lyricStr, format, translatedLrc, romanLrc, displayLanguage]);
};
