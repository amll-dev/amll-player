import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_TASKBAR_WORD_FADE_WIDTH,
	getTimedWordProgress,
	hasUsableWordTimings,
	normalizeTaskbarWordFadeWidth,
} from "../src/pages/taskbar-lyric/word-progress.ts";

const readProjectFile = (path) =>
	readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

test("逐字进度按单词时间计算并限制在 0 到 1", () => {
	const word = { word: "测试", startTime: 1_000, endTime: 2_000 };

	assert.equal(getTimedWordProgress(word, 500), 0);
	assert.equal(getTimedWordProgress(word, 1_500), 0.5);
	assert.equal(getTimedWordProgress(word, 2_500), 1);
	assert.equal(getTimedWordProgress(word, Number.NaN), 0);
	assert.equal(
		getTimedWordProgress({ ...word, endTime: word.startTime }, 1_500),
		0,
	);
});

test("只对至少两个可靠逐字时间片启用效果", () => {
	assert.equal(
		hasUsableWordTimings([
			{ word: "一", startTime: 1_000, endTime: 1_400 },
			{ word: " ", startTime: 0, endTime: 0 },
			{ word: "句", startTime: 1_400, endTime: 2_000 },
		]),
		true,
	);
	assert.equal(
		hasUsableWordTimings([
			{ word: "整行歌词", startTime: 1_000, endTime: 4_000 },
		]),
		false,
		"普通 LRC 的单个整行时间片不能误判为逐字歌词",
	);
	assert.equal(
		hasUsableWordTimings([
			{ word: "错误", startTime: 1_000, endTime: 1_000 },
			{ word: "时间", startTime: 1_400, endTime: 2_000 },
		]),
		false,
	);
	assert.equal(
		hasUsableWordTimings([
			{ word: "倒序", startTime: 2_000, endTime: 2_400 },
			{ word: "时间", startTime: 1_000, endTime: 1_400 },
		]),
		false,
	);
});

test("逐字渐变宽度与主歌词设置保持一致并限制异常输入", () => {
	assert.equal(DEFAULT_TASKBAR_WORD_FADE_WIDTH, 0.5);
	assert.equal(normalizeTaskbarWordFadeWidth(0.8), 0.8);
	assert.equal(normalizeTaskbarWordFadeWidth(0), 0.0001);
	assert.equal(normalizeTaskbarWordFadeWidth(20), 10);
	assert.equal(normalizeTaskbarWordFadeWidth(Number.NaN), 0.5);
});

test("任务栏开关通过主窗口桥接并在重开页面后重放", () => {
	const atoms = readProjectFile("../src/states/appAtoms.ts");
	const settings = readProjectFile("../src/pages/settings/player.tsx");
	const bridge = readProjectFile(
		"../src/components/TaskbarLyricBridge/index.tsx",
	);
	const types = readProjectFile(
		"../src/components/TaskbarLyricBridge/types.ts",
	);
	const taskbar = readProjectFile("../src/pages/taskbar-lyric/index.tsx");

	assert.match(
		atoms,
		/taskbarLyricWordProgressAtom = atomWithStorage\(\s*"amll-player\.taskbarLyricWordProgress",\s*false/,
	);
	assert.match(
		settings,
		/configAtom=\{taskbarLyricWordProgressAtom\}[\s\S]*taskbarLyric\.wordProgress\.label/,
	);
	assert.match(types, /WORD_PROGRESS_EVENT = "taskbar-lyric:word-progress"/);
	assert.match(
		bridge,
		/wordProgress: \{[\s\S]*enabled: false,[\s\S]*fadeWidth: 0\.5,[\s\S]*emit\(WORD_PROGRESS_EVENT, stateCache\.current\.wordProgress\)/,
	);
	assert.match(bridge, /lyricWordFadeWidthAtom/);
	assert.match(
		bridge,
		/enabled: taskbarLyricWordProgress,[\s\S]*fadeWidth: lyricWordFadeWidth/,
	);
	assert.match(
		bridge,
		/REQUEST_UPDATE_EVENT[\s\S]*emit\(WORD_PROGRESS_EVENT, stateCache\.current\.wordProgress\)/,
	);
	assert.match(
		taskbar,
		/listen<TaskbarLyricWordProgressPayload>\([\s\S]*WORD_PROGRESS_EVENT[\s\S]*UPDATE_WORD_PROGRESS/,
	);
});

test("播放和暂停跳转都直接推送原始毫秒位置", () => {
	const taskbar = readProjectFile("../src/pages/taskbar-lyric/index.tsx");

	assert.match(
		taskbar,
		/positionRef\.current = pos;\s*publishPosition\(pos\);/,
	);
	assert.match(
		taskbar,
		/positionRef\.current = currentPos;\s*publishPosition\(currentPos\);/,
	);
	assert.match(
		taskbar,
		/words=\{item\.words\}[\s\S]*wordProgressEnabled=\{wordProgressEnabled\}[\s\S]*wordFadeWidth=\{wordFadeWidth\}[\s\S]*subscribePosition/,
	);
});

test("逐字填色以单层遮罩更新并保留原始字重渲染", () => {
	const component = readProjectFile(
		"../src/pages/taskbar-lyric/LyricScroll.tsx",
	);
	const style = readProjectFile("../src/pages/taskbar-lyric/index.module.css");

	assert.match(component, /hasUsableWordTimings\(words\)/);
	assert.match(
		component,
		/element\.style\.setProperty\(\s*"--taskbar-word-progress"/,
	);
	assert.match(
		component,
		/element\.style\.setProperty\(\s*"--taskbar-word-fade-offset"/,
	);
	assert.match(
		component,
		/wordProgressValuesRef\.current\[index\] === percentage/,
	);
	assert.match(component, /subscribePosition\?\.\(updateWordProgress\)/);
	assert.doesNotMatch(component, /wordProgressHighlight/);
	assert.doesNotMatch(component, /progressState/);
	assert.match(
		style,
		/\.wordProgressWord \{[\s\S]*--taskbar-word-progress: 0%/,
	);
	assert.match(
		style,
		/\.wordProgressWord \{[\s\S]*--taskbar-word-fade-width: 0\.5em[\s\S]*color: var\(--text-primary\)/,
	);
	assert.match(
		style,
		/\.wordProgressWord \{[\s\S]*mask-image: linear-gradient\([\s\S]*to right/,
	);
	assert.match(
		style,
		/\.container\[data-orientation="vertical"\] \.wordProgressWord \{[\s\S]*mask-image: linear-gradient\([\s\S]*to bottom/,
	);
	assert.match(style, /var\(--taskbar-word-fade-width\)/);
	assert.match(style, /--taskbar-word-pending-alpha:\s*0\.7/);
	assert.match(
		style,
		/data-theme="light"[\s\S]*--taskbar-word-pending-alpha:\s*0\.6/,
	);
	assert.match(style, /rgb\(0 0 0 \/ var\(--taskbar-word-pending-alpha\)\)/);
	assert.doesNotMatch(style, /wordProgressHighlight/);
	assert.doesNotMatch(style, /data-progress-state/);
	assert.doesNotMatch(style, /mask-image:\s*none/);
	assert.doesNotMatch(style, /background-clip:\s*text/);
	assert.doesNotMatch(style, /-webkit-text-fill-color:\s*transparent/);
	assert.doesNotMatch(style, /wordProgressPending/);
	assert.doesNotMatch(style, /\.wordProgressWord[^}]*font-weight/);
});

test("全部语言都包含逐字进度设置文案", () => {
	for (const locale of ["en-US", "ja-JP", "vi-VN", "zh-CN", "zh-TW"]) {
		const translation = JSON.parse(
			readProjectFile(`../locales/${locale}/translation.json`),
		);
		const wording = translation.page.settings.taskbarLyric.wordProgress;

		assert.equal(typeof wording.label, "string", `${locale} 缺少 label`);
		assert.equal(
			typeof wording.description,
			"string",
			`${locale} 缺少 description`,
		);
	}
});
