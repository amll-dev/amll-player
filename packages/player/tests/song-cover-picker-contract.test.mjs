import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const metadata = readFileSync(
	new URL("../src/pages/song/metadata.tsx", import.meta.url),
	"utf8",
);
const playerClient = readFileSync(
	new URL("../src/utils/player.ts", import.meta.url),
	"utf8",
);
const rust = readFileSync(
	new URL("../src-tauri/src/music_info.rs", import.meta.url),
	"utf8",
);
const tauriLib = readFileSync(
	new URL("../src-tauri/src/lib.rs", import.meta.url),
	"utf8",
);

test("歌曲封面选择器不绑定透明主窗口且不阻塞 Tauri 事件循环", () => {
	assert.doesNotMatch(metadata, /@tauri-apps\/plugin-dialog|\bopen\s*\(\s*\{/);
	assert.match(metadata, /pickAndSaveSongCover\(/);
	assert.match(
		playerClient,
		/invoke\("pick_and_save_song_cover",\s*\{[\s\S]*?songId,[\s\S]*?title,[\s\S]*?mediaFilterName,[\s\S]*?allFilesFilterName,/,
	);
	assert.ok(
		tauriLib.includes("music_info::pick_and_save_song_cover,"),
		"歌曲封面选择命令必须注册到 Tauri handler",
	);

	const pickerStart = rust.indexOf("pub async fn pick_and_save_song_cover(");
	assert.notEqual(pickerStart, -1, "缺少歌曲封面选择命令");
	const picker = rust.slice(pickerStart);
	for (const token of [
		"let (sender, receiver) = tokio::sync::oneshot::channel();",
		"dialog.pick_file(move |selected| {",
		"copy_cover_from_path(song_id, source_path, app).await?",
	]) {
		assert.ok(picker.includes(token), `歌曲封面选择器缺少 ${token}`);
	}
	assert.match(picker, /app\s*\.dialog\(\)\s*\.file\(\)/);
	assert.match(picker, /let selected = receiver\s*\.await/);
	assert.doesNotMatch(
		picker,
		/\bset_parent\s*\(|\bblocking_pick_files?\s*\(|\b(?:rx|receiver)\.recv(?:_timeout)?\s*\(/,
	);
});

test("歌曲封面选择防止重复打开并在取消或失败后恢复按钮", () => {
	for (const token of [
		"if (song === undefined || coverPickerBusyRef.current) return;",
		"coverPickerBusyRef.current = true;",
		"setIsPickingCover(true);",
		"if (!coverPath) return;",
		"finally {",
		"coverPickerBusyRef.current = false;",
		"setIsPickingCover(false);",
		"disabled={isPickingCover}",
		"loading={isPickingCover}",
	]) {
		assert.ok(metadata.includes(token), `封面按钮缺少状态契约 ${token}`);
	}
	assert.match(
		rust,
		/async fn copy_cover_from_path\([\s\S]*?tokio::task::spawn_blocking\(move \|\| \{[\s\S]*?std::fs::copy\(&source, &cover_file\)/,
	);
});

test("元数据页移除重复歌词导入并将封面与重读操作并排显示", () => {
	assert.doesNotMatch(
		metadata,
		/importLyricFromFile|getLyricFormatFromExtension|page\.song\.metadata\.importLyricFromFile/,
	);
	assert.match(
		metadata,
		/<Flex mt="4" gap="2" wrap="wrap">[\s\S]*?onClick=\{uploadCoverAsImage\}[\s\S]*?onClick=\{readMetadataFromFile\}[\s\S]*?<\/Flex>/,
	);
});
