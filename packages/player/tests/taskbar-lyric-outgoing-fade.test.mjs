import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const readProjectFile = (path) =>
	readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

test("上一句歌词使用独立的任务栏全高视口退场", () => {
	const source = readProjectFile("../src/pages/taskbar-lyric/index.tsx");
	const style = readProjectFile("../src/pages/taskbar-lyric/index.module.css");

	assert.match(
		source,
		/className=\{styles\.lyricViewport\}[\s\S]*className=\{styles\.lyricStack\}[\s\S]*<AnimatePresence initial=\{false\}>/,
	);
	assert.match(
		style,
		/\.container\[data-orientation="horizontal"\]:has\([\s\S]*\.textPanel\[data-content="lyrics"\][\s\S]*overflow: visible/,
	);
	assert.match(
		style,
		/\.container\[data-orientation="horizontal"\] \.lyricViewport \{[\s\S]*top: calc\(50% - 50vh\)[\s\S]*height: 100vh[\s\S]*overflow: hidden/,
	);
	assert.match(style, /\.lyricViewport \{[\s\S]*pointer-events: none/);
});

test("歌词视口在任务栏顶部渐隐且保留原有左右遮罩", () => {
	const style = readProjectFile("../src/pages/taskbar-lyric/index.module.css");

	assert.match(
		style,
		/--lyric-top-edge-mask: linear-gradient\([\s\S]*to bottom[\s\S]*transparent 0[\s\S]*black 4px/,
	);
	assert.match(
		style,
		/-webkit-mask-image: var\(--lyric-edge-mask\), var\(--lyric-top-edge-mask\)/,
	);
	assert.match(style, /-webkit-mask-composite: source-in/);
	assert.match(
		style,
		/mask-image: var\(--lyric-edge-mask\), var\(--lyric-top-edge-mask\)/,
	);
	assert.match(style, /mask-composite: intersect/);
});

test("底色容器默认仍裁切，曲目信息不会进入歌词溢出层", () => {
	const source = readProjectFile("../src/pages/taskbar-lyric/index.tsx");
	const style = readProjectFile("../src/pages/taskbar-lyric/index.module.css");

	assert.match(style, /\.container \{[\s\S]*overflow: hidden/);
	assert.match(
		source,
		/\{displayAsMetadata \? \([\s\S]*\{musicName\}[\s\S]*\) : \([\s\S]*styles\.lyricViewport/,
	);
	assert.match(
		style,
		/\.container\[data-orientation="horizontal"\]\[data-single-line="true"\][\s\S]*top: calc\(50% - 0\.6em\)[\s\S]*height: 1\.2em/,
	);
});
