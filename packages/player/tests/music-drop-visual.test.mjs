import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const readProjectFile = (path) =>
	readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const context = readProjectFile("../src/components/MusicDropContext/index.tsx");
const style = readProjectFile(
	"../src/components/MusicDropContext/index.module.css",
);
const visual = readProjectFile("../src/components/MusicDropVisual/index.tsx");
const mainPage = readProjectFile("../src/pages/main/index.tsx");
const playlistCard = readProjectFile(
	"../src/components/PlaylistCard/index.tsx",
);
const playlistPage = readProjectFile("../src/pages/playlist/index.tsx");
const localeCodes = ["en-US", "ja-JP", "vi-VN", "zh-CN", "zh-TW"];

test("拖放反馈使用局部语义覆盖层而不是整页蓝色描边", () => {
	assert.doesNotMatch(style, /outline:\s*3px/);
	assert.doesNotMatch(style, /position:\s*fixed/);
	assert.match(style, /data-music-drop-visual/);
	assert.match(style, /data-music-drop-visual-content/);
	assert.match(style, /pointer-events:\s*none/);
	assert.match(style, /\.activeDropTarget\s*>/);
	assert.match(style, /opacity 150ms ease/);
	assert.match(style, /prefers-reduced-motion: reduce/);
	assert.match(visual, /PlusCircledIcon/);
});

test("拖放提示在所有内置语言中都有翻译", () => {
	for (const localeCode of localeCodes) {
		const translations = JSON.parse(
			readProjectFile(`../locales/${localeCode}/translation.json`),
		);
		assert.deepEqual(Object.keys(translations.musicDrop).sort(), [
			"addToCurrentPlaylistHint",
			"addToPlaylistHint",
			"createPlaylistHint",
			"homeFolderOnlyHint",
			"playlistFilesAndFoldersHint",
		]);
	}
});

test("首页空白区域保留文件夹建歌单能力并显示明确限制", () => {
	assert.match(mainPage, /data-music-drop-create-playlist=""/);
	assert.match(mainPage, /variant="create-playlist"/);
	assert.match(mainPage, /首页仅接受单个文件夹/);
	assert.match(context, /createPlaylistFromFolder/);
	assert.match(context, /首页空白处一次只接受一个音乐文件夹/);
});

test("歌单卡片和详情页保留投放范围并显示局部反馈", () => {
	assert.match(playlistCard, /data-music-drop-playlist-id=\{playlist\.id\}/);
	assert.match(playlistCard, /variant="playlist"/);
	assert.match(playlistPage, /className=\{styles\.dropListTarget\}/);
	assert.match(playlistPage, /data-music-drop-playlist-id=\{param\.id\}/);
	assert.match(playlistPage, /variant="playlist-detail"/);
	assert.equal(
		playlistPage.match(/data-music-drop-playlist-id/g)?.length,
		1,
		"歌单详情应保留一个整页投放目标，并在歌曲列表显示局部反馈",
	);
});
