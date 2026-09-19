import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { shouldPreservePointerFocusMode } from "../src/components/AMLLWrapper/focus-modality.ts";

const makeEvent = (key, code = key, fnPressed = false) => ({
	key,
	code,
	getModifierState: (modifier) => modifier === "Fn" && fnPressed,
});

test("系统音量和媒体按键不会把鼠标焦点切换成键盘描边", () => {
	for (const [key, code] of [
		["AudioVolumeDown", "AudioVolumeDown"],
		["VolumeUp", "VolumeUp"],
		["AudioVolumeMute", ""],
		["MediaPlayPause", "MediaPlayPause"],
		["Unidentified", ""],
	]) {
		assert.equal(shouldPreservePointerFocusMode(makeEvent(key, code)), true);
	}
	assert.equal(
		shouldPreservePointerFocusMode(makeEvent("F2", "F2", true)),
		true,
	);
	assert.equal(shouldPreservePointerFocusMode(makeEvent("F2")), true);
});

test("真实键盘导航和全屏快捷键仍恢复可见焦点", () => {
	for (const key of ["Tab", "Enter", " ", "Escape", "ArrowRight", "Home"]) {
		assert.equal(shouldPreservePointerFocusMode(makeEvent(key)), false);
	}
});

test("全屏歌词按键处理器在清除鼠标焦点状态前过滤系统按键", () => {
	const wrapperSource = readFileSync(
		fileURLToPath(
			new URL("../src/components/AMLLWrapper/index.tsx", import.meta.url),
		),
		"utf8",
	);

	assert.match(
		wrapperSource,
		/!shouldPreservePointerFocusMode\(e\)[\s\S]*delete lyricPageRef\.current\.dataset\.pointerInput/,
	);
	assert.match(wrapperSource, /e\.key === " "/);
	assert.match(wrapperSource, /e\.key === "Escape"/);
});
