import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const readProjectFile = (path) =>
	readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

test("播放和暂停路径常驻同一 SVG 并支持中途反向", () => {
	const component = readProjectFile(
		"../src/components/AnimatedPlayPauseIcon/index.tsx",
	);
	const style = readProjectFile(
		"../src/components/AnimatedPlayPauseIcon/style.css",
	);

	assert.match(component, /data-play-pause-icon/);
	assert.match(component, /data-play-icon/);
	assert.match(component, /data-pause-icon/);
	assert.match(component, /data-playing=\{playing \? "true" : "false"\}/);
	assert.match(component, /width="38"/);
	assert.match(component, /height="38"/);
	assert.match(style, /transform 260ms cubic-bezier\(0\.22, 1, 0\.36, 1\)/);
	assert.match(style, /rotate\(90deg\) scale\(0\.76\)/);
	assert.match(style, /rotate\(-90deg\) scale\(0\.76\)/);
	assert.match(style, /prefers-reduced-motion: reduce/);
});

test("底部播放栏和任务栏歌词共用旋转切换图标", () => {
	const nowPlayingBar = readProjectFile(
		"../src/components/NowPlayingBar/index.tsx",
	);
	const taskbarLyric = readProjectFile("../src/pages/taskbar-lyric/index.tsx");

	assert.equal(
		nowPlayingBar.match(/<AnimatedPlayPauseIcon/g)?.length,
		2,
		"底部播放栏的桌面和窄屏按钮都应使用动画图标",
	);
	assert.equal(
		taskbarLyric.match(/<AnimatedPlayPauseIcon/g)?.length,
		1,
		"任务栏歌词应使用同一动画图标",
	);
});

test("全屏歌词依赖补丁保留同一 SVG 的双路径状态", () => {
	const patch = readProjectFile(
		"../../../patches/@applemusic-like-lyrics__react-full@0.4.2.patch",
	);
	const installedModule = readProjectFile(
		"../node_modules/@applemusic-like-lyrics/react-full/dist/amll-react-framework.mjs",
	);

	for (const source of [patch, installedModule]) {
		assert.match(source, /data-play-pause-icon/);
		assert.match(source, /data-playing/);
		assert.match(source, /data-play-icon/);
		assert.match(source, /data-pause-icon/);
		assert.match(source, /width: 38/);
		assert.match(source, /height: 38/);
	}
	assert.match(patch, /dist\/amll-react-framework\.cjs/);
	assert.match(patch, /dist\/amll-react-framework\.mjs/);
});
