import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	findCurrentLyricIndex,
	findDisplayedLyricIndex,
	findMetadataLyricIndex,
	reconcileMetadataTimeline,
	TASKBAR_FIRST_LYRIC_LEAD_MS,
	TASKBAR_LYRIC_SCROLL_LEAD_MS,
	taskbarContentGroupKey,
} from "../src/pages/taskbar-lyric/lyric-timeline.ts";
import { getTimedWordProgress } from "../src/pages/taskbar-lyric/word-progress.ts";

const taskbarSource = readFileSync(
	fileURLToPath(
		new URL("../src/pages/taskbar-lyric/index.tsx", import.meta.url),
	),
	"utf8",
);
const bridgeSource = readFileSync(
	fileURLToPath(
		new URL("../src/components/TaskbarLyricBridge/index.tsx", import.meta.url),
	),
	"utf8",
);

const lines = [{ startTime: 500 }, { startTime: 2_000 }, { startTime: 4_000 }];

test("暂停时再次同步元数据仍按缓存进度恢复当前歌词", () => {
	assert.equal(findMetadataLyricIndex("song-a", "song-a", lines, 3_000), 1);
	assert.match(
		taskbarSource,
		/const previousMusicId = musicIdRef\.current[\s\S]*musicIdRef\.current = evt\.payload\.musicId[\s\S]*currentLyricIndex: findMetadataLyricIndex\([\s\S]*positionRef\.current,\s*\)/,
	);
});

test("真实演唱行索引仍只按开始时间计算", () => {
	for (const [index, line] of lines.entries()) {
		for (const lead of [300, 100, 1]) {
			assert.equal(
				findCurrentLyricIndex(lines, line.startTime - lead),
				index - 1,
			);
		}
		assert.equal(findCurrentLyricIndex(lines, line.startTime), index);
		assert.equal(findCurrentLyricIndex(lines, line.startTime + 1), index);
	}
});

test("暂停同步和前后跳转使用同一换行时间边界", () => {
	for (const position of [1_700, 1_999, 2_000, 4_000, 3_999, 499, 500]) {
		assert.equal(
			findMetadataLyricIndex("song-a", "song-a", lines, position),
			findDisplayedLyricIndex(lines, position),
		);
	}
	assert.match(
		taskbarSource,
		/findDisplayedLyricIndex\(\s*lyricLinesRef\.current,\s*pos,?\s*\)/,
	);
	assert.match(
		taskbarSource,
		/findDisplayedLyricIndex\(\s*lyricLinesRef\.current,\s*currentPos,?\s*\)/,
	);
});

test("普通换行使用 500ms 预滚动窗口", () => {
	const lyrics = [
		{ startTime: 500, endTime: 1_000, words: [] },
		{ startTime: 3_000, endTime: 4_000, words: [] },
	];
	const threshold = 3_000 - TASKBAR_LYRIC_SCROLL_LEAD_MS;
	assert.equal(TASKBAR_LYRIC_SCROLL_LEAD_MS, 500);
	assert.equal(findDisplayedLyricIndex(lyrics, 1_000), 0);
	assert.equal(findDisplayedLyricIndex(lyrics, 2_300), 0);
	assert.equal(findDisplayedLyricIndex(lyrics, threshold - 1), 0);
	assert.equal(findDisplayedLyricIndex(lyrics, threshold), 1);
	assert.equal(findDisplayedLyricIndex(lyrics, 2_999), 1);
	assert.equal(findCurrentLyricIndex(lyrics, threshold), 0);
});

test("间隙短于或等于预滚动窗口时也必须等上一行结束", () => {
	for (const gap of [0, 200, TASKBAR_LYRIC_SCROLL_LEAD_MS]) {
		const endTime = 2_000 - gap;
		const lyrics = [
			{ startTime: 500, endTime, words: [] },
			{ startTime: 2_000, endTime: 3_000, words: [] },
		];
		assert.equal(findDisplayedLyricIndex(lyrics, endTime - 1), 0);
		assert.equal(findDisplayedLyricIndex(lyrics, endTime), 1);
	}
});

test("重叠歌词不预滚动，下一行开始时仍正常切换", () => {
	const lyrics = [
		{ startTime: 500, endTime: 2_200, words: [] },
		{ startTime: 2_000, endTime: 3_000, words: [] },
	];
	assert.equal(findDisplayedLyricIndex(lyrics, 1_999), 0);
	assert.equal(findDisplayedLyricIndex(lyrics, 2_000), 1);
});

test("可靠词尾可补足行结束时间，并防止行结束过早截断最后一个字", () => {
	for (const endTime of [undefined, Number.NaN, 0, 500, 1_000]) {
		const lyrics = [
			{
				startTime: 500,
				endTime,
				words: [
					{ word: "还在唱", startTime: 800, endTime: 1_900 },
					{ word: "", startTime: 0, endTime: Number.NaN },
				],
			},
			{ startTime: 2_000, endTime: 3_000, words: [] },
		];
		assert.equal(findDisplayedLyricIndex(lyrics, 1_899), 0);
		assert.equal(findDisplayedLyricIndex(lyrics, 1_900), 1);
	}
});

test("没有可靠结束时间时不提前普通换行，末行保持显示", () => {
	for (const endTime of [
		undefined,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		0,
		500,
	]) {
		const lyrics = [
			{
				startTime: 500,
				endTime,
				words: [
					{ word: "无效", startTime: 500, endTime: Number.POSITIVE_INFINITY },
					{ word: "无效", startTime: 700, endTime: 600 },
				],
			},
			{ startTime: 2_000, endTime: 3_000, words: [] },
		];
		assert.equal(findDisplayedLyricIndex(lyrics, 1_999), 0);
		assert.equal(findDisplayedLyricIndex(lyrics, 3_500), 1);
	}
	assert.equal(findDisplayedLyricIndex([], 3_000), -1);
});

test("前奏标题进入首句单独提前 700ms，逐字高亮仍等待实际开始", () => {
	const word = { word: "第一句", startTime: 3_000, endTime: 4_000 };
	const lyrics = [{ startTime: 3_000, endTime: 4_000, words: [word] }];
	assert.equal(TASKBAR_FIRST_LYRIC_LEAD_MS, 700);
	assert.equal(findDisplayedLyricIndex(lyrics, 2_299), -1);
	assert.equal(findDisplayedLyricIndex(lyrics, 2_300), 0);
	assert.equal(findDisplayedLyricIndex(lyrics, 2_999), 0);
	assert.equal(findCurrentLyricIndex(lyrics, 2_999), -1);
	assert.equal(getTimedWordProgress(word, 2_300), 0);
	assert.equal(getTimedWordProgress(word, 3_500), 0.5);
});

test("短前奏从零点准备首句，不产生负时间提前或空列表歌词", () => {
	for (const startTime of [0, 200, 700]) {
		const lyrics = [{ startTime, endTime: 2_000, words: [] }];
		assert.equal(findDisplayedLyricIndex(lyrics, 0), 0);
		assert.equal(findDisplayedLyricIndex(lyrics, -1), -1);
	}
	assert.equal(findDisplayedLyricIndex([], 0), -1);
});

test("首句预滚动支持暂停恢复和拖回前奏，跨曲不复用旧进度", () => {
	const lyrics = [{ startTime: 3_000, endTime: 4_000, words: [] }];
	for (const position of [2_300, 2_000, 2_299, 2_300, 3_000]) {
		const expected = position >= 2_300 ? 0 : -1;
		assert.equal(findDisplayedLyricIndex(lyrics, position), expected);
		assert.equal(
			findMetadataLyricIndex("song-a", "song-a", lyrics, position),
			expected,
		);
		assert.equal(
			findMetadataLyricIndex(null, "song-a", lyrics, position),
			expected,
		);
	}
	assert.equal(findMetadataLyricIndex("song-a", "song-b", lyrics, 2_300), -1);
});

test("预滚动、暂停元数据恢复和前后跳转共用显示行规则", () => {
	const lyrics = [
		{ startTime: 500, endTime: 1_000, words: [] },
		{ startTime: 2_000, endTime: 3_000, words: [] },
	];
	const threshold = 2_000 - TASKBAR_LYRIC_SCROLL_LEAD_MS;
	for (const position of [threshold, 1_000, threshold - 1, threshold, 2_000]) {
		const expected = position >= threshold ? 1 : 0;
		assert.equal(findDisplayedLyricIndex(lyrics, position), expected);
		assert.equal(
			findMetadataLyricIndex("song-a", "song-a", lyrics, position),
			expected,
		);
		assert.equal(
			findMetadataLyricIndex(null, "song-a", lyrics, position),
			expected,
		);
	}
	assert.equal(
		findMetadataLyricIndex("song-a", "song-b", lyrics, threshold),
		-1,
	);
});

test("预滚动不提前逐字高亮，并保留原有换行弹簧参数", () => {
	const word = { word: "下一句", startTime: 2_000, endTime: 3_000 };
	assert.equal(
		getTimedWordProgress(word, 2_000 - TASKBAR_LYRIC_SCROLL_LEAD_MS),
		0,
	);
	assert.equal(getTimedWordProgress(word, 1_999), 0);
	assert.equal(getTimedWordProgress(word, 2_500), 0.5);
	assert.match(
		taskbarSource,
		/transition=\{\{\s*type: "spring",\s*stiffness: 250,\s*damping: 30,\s*mass: 0\.8,\s*\}\}/,
	);
	assert.match(
		taskbarSource,
		/getCurrentPosition=\{\(\) => positionRef\.current\}/,
	);
	assert.doesNotMatch(taskbarSource, /publishPosition\([^)]*\+/);
});

test("新歌元数据不会复用上一首的播放位置", () => {
	assert.equal(findMetadataLyricIndex("song-a", "song-b", lines, 3_000), -1);
	assert.equal(findMetadataLyricIndex(null, "song-b", lines, 3_000), 1);
});

test("同曲封面等元数据更新不会重置歌词动画代次", () => {
	const previous = { lastIndex: 8, jumpId: 3 };

	assert.deepEqual(reconcileMetadataTimeline(8, previous, 9, false, 12), {
		currentLyricIndex: 8,
		jumpState: previous,
	});
	assert.deepEqual(reconcileMetadataTimeline(8, previous, -1, true, 12), {
		currentLyricIndex: -1,
		jumpState: { lastIndex: -1, jumpId: 0 },
	});
	assert.deepEqual(reconcileMetadataTimeline(-1, previous, 1, false, 3), {
		currentLyricIndex: 1,
		jumpState: { lastIndex: 1, jumpId: 3 },
	});
	assert.deepEqual(reconcileMetadataTimeline(8, previous, 1, false, 3), {
		currentLyricIndex: 1,
		jumpState: { lastIndex: 1, jumpId: 3 },
	});
	assert.match(
		taskbarSource,
		/const trackChanged = previousMusicId !== evt\.payload\.musicId/,
	);
});

test("普通切句和副歌词有无变化不会重建外层歌词组", () => {
	const lyricKey = taskbarContentGroupKey("song-a", false, 4);
	assert.equal(taskbarContentGroupKey("song-a", false, 4), lyricKey);
	assert.notEqual(taskbarContentGroupKey("song-a", false, 5), lyricKey);
	assert.notEqual(taskbarContentGroupKey("song-b", false, 4), lyricKey);
	assert.notEqual(taskbarContentGroupKey("song-a", true, 4), lyricKey);
	assert.equal(
		taskbarContentGroupKey("song-a", true, 9),
		taskbarContentGroupKey("song-a", true, 0),
	);
	assert.match(
		taskbarSource,
		/const groupKey = taskbarContentGroupKey\(\s*musicId,\s*displayAsMetadata,\s*jumpState\.jumpId/,
	);
});

test("长句切换短句时容器延后收窄以保留退场上滑", () => {
	assert.match(taskbarSource, /const LYRIC_EXIT_EXTENT_HOLD_MS = 360/);
	assert.match(
		taskbarSource,
		/measured >= current[\s\S]*collapsedShrinkTimerRef\.current = window\.setTimeout/,
	);
	assert.match(
		taskbarSource,
		/if \(isHovered\) return;[\s\S]*\[isHovered, layoutExtents, musicId, orientation\]/,
	);
});

test("进度事件即使被节流也会先更新请求快照并在暂停时立即发送", () => {
	const positionEffect = bridgeSource.match(
		/useEffect\(\(\) => \{([\s\S]*?)\}, \[musicPlaying, musicPlayingPosition\]\);/,
	)?.[1];

	assert.ok(positionEffect, "应能找到任务栏歌词进度同步逻辑");
	assert.ok(
		positionEffect.indexOf("stateCache.current.position = payload") <
			positionEffect.indexOf(
				"if (musicPlaying && now - lastEmitTime.current < 200) return",
			),
		"最新进度必须在节流返回前写入请求快照",
	);
	assert.match(
		positionEffect,
		/if \(musicPlaying && now - lastEmitTime\.current < 200\) return/,
	);
});

test("歌词尚未开始或列表为空时保持曲目信息态", () => {
	assert.equal(findCurrentLyricIndex(lines, 100), -1);
	assert.equal(findCurrentLyricIndex([], 3_000), -1);
	assert.match(
		taskbarSource,
		/const isMetadataMode =\s*currentLyricIndex < 0 \|\| !hasLyrics \|\| !currentLine/,
	);
});
