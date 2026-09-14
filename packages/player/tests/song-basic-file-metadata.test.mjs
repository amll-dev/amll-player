import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const i18next = require("i18next");
const ICU = require("i18next-icu").default;

const readProjectFile = (relativePath) =>
	readFileSync(new URL(relativePath, import.meta.url), "utf8").replaceAll(
		"\r\n",
		"\n",
	);

const basic = readProjectFile("../src/pages/song/basic.tsx");
const audioQualityDialog = readProjectFile(
	"../src/components/AudioQualityDialog/index.tsx",
);
const playerClient = readProjectFile("../src/utils/player.ts");
const rust = readProjectFile("../src-tauri/src/music_info.rs");
const tauriLib = readProjectFile("../src-tauri/src/lib.rs");
const locales = ["en-US", "ja-JP", "vi-VN", "zh-CN", "zh-TW"];

test("歌曲基本页通过无副作用命令读取原文件标签和文件信息", () => {
	assert.match(
		playerClient,
		/invoke\("read_local_music_file_metadata", \{ filePath \}\)/,
	);
	assert.ok(
		tauriLib.includes("music_info::read_local_music_file_metadata,"),
		"原始文件元数据命令必须注册到 Tauri handler",
	);

	const commandStart = rust.indexOf(
		"pub async fn read_local_music_file_metadata(",
	);
	const commandEnd = rust.indexOf(
		"async fn copy_cover_from_path(",
		commandStart,
	);
	assert.notEqual(commandStart, -1, "缺少只读文件元数据命令");
	assert.notEqual(commandEnd, -1, "无法确定只读命令边界");
	const command = rust.slice(commandStart, commandEnd);
	for (const token of [
		"tokio::task::spawn_blocking",
		"std::fs::metadata(&path)",
		"AudioReader::new(file)",
		"reader.source_info()",
		"reader.metadata()",
		"file_metadata.len()",
	]) {
		assert.ok(command.includes(token), `只读命令缺少 ${token}`);
	}
	assert.doesNotMatch(
		command,
		/std::fs::(?:write|copy)|get_covers_dir|db::|save_cover|read_to_string/,
		"基本页读取原始信息时不得保存封面、写数据库或加载旁车歌词",
	);
	for (const token of [
		"MAX_FILE_METADATA_TAGS",
		"MAX_FILE_METADATA_KEY_CHARS",
		"MAX_FILE_METADATA_VALUE_CHARS",
		"sanitize_file_metadata_tags(reader.metadata())",
		"JS_MAX_SAFE_INTEGER",
		"JS_DATE_MAX_MILLISECONDS",
	]) {
		assert.ok(
			rust.includes(token),
			`原文件元数据读取必须包含边界保护 ${token}`,
		);
	}
	assert.match(
		rust,
		/source_info\.bit_rate <= JS_MAX_SAFE_INTEGER as i64/,
		"码率跨 IPC 前必须限制在 JavaScript 安全整数范围内",
	);
	for (const hiddenTag of ["title", "artist", "lyrics", "coverart"]) {
		assert.match(
			rust,
			new RegExp(`is_hidden_file_metadata_key[\\s\\S]*?"${hiddenTag}"`),
			`后端必须过滤不应传入界面的标签 ${hiddenTag}`,
		);
	}
});

test("歌曲基本页显示原始标签且不重复页头名称和作者", () => {
	assert.match(basic, /readLocalMusicFileMetadata\(sourcePath\)/);
	assert.match(basic, /loadedFileMetadata\.sourcePath === song\?\.filePath/);
	assert.doesNotMatch(basic, /song\?\.songName|song\?\.songArtists/);
	assert.doesNotMatch(basic, /db\.songs\.(?:update|upsert)/);

	for (const key of [
		"album",
		"albumArtist",
		"genre",
		"recordingDate",
		"trackNumber",
		"discNumber",
		"composer",
		"lyricist",
		"publisher",
		"copyright",
		"encoder",
	]) {
		assert.ok(basic.includes(`key: "${key}"`), `缺少规范化标签 ${key}`);
	}
	for (const hiddenTag of ["title", "artist", "lyrics"]) {
		assert.match(
			basic,
			new RegExp(`HIDDEN_TAG_KEYS[\\s\\S]*?"${hiddenTag}"`),
			`必须过滤已显示或不适合展开的标签 ${hiddenTag}`,
		);
	}
	for (const field of ["fileSize", "modifiedAt"]) {
		assert.ok(basic.includes(`fileMetadata.${field}`), `缺少文件字段 ${field}`);
	}
});

test("音频解码信息弹窗显示位深且歌曲基本页不再重复技术信息", () => {
	assert.match(audioQualityDialog, /bitsPerSample\?: number/);
	assert.match(audioQualityDialog, /amll\.audioQuality\.bitDepth/);
	assert.match(audioQualityDialog, /`\$\{bitDepth\} bit`/);
	assert.equal(
		(audioQualityDialog.match(/<DataList\.Label>/g) ?? []).length,
		5,
		"五项音频字段都应使用相同的 DataList.Label 样式",
	);
	assert.doesNotMatch(
		basic,
		/hasTechnicalInformation|page\.song\.basic\.(?:technicalInformation|codec|bitRate|sampleRate|bitDepth|bitValue|channels|sampleFormat)|formatBitRate|formatSampleRate/,
		"歌曲基本页不得重复显示音频解码信息",
	);
});
test("歌曲基本信息新增文案在全部内置语言中完整一致", () => {
	const requiredKeys = [
		"album",
		"albumArtist",
		"composer",
		"copyFilePath",
		"copyright",
		"discNumber",
		"encoder",
		"fileMetadataError",
		"fileModifiedAt",
		"fileSize",
		"genre",
		"loadingFileMetadata",
		"lyricist",
		"noFileMetadata",
		"originalFileMetadata",
		"publisher",
		"recordingDate",
		"trackNumber",
	];
	const basicKeySets = locales.map((locale) => {
		const translation = JSON.parse(
			readProjectFile(`../locales/${locale}/translation.json`),
		);
		const values = translation.page.song.basic;
		for (const key of requiredKeys) {
			assert.equal(
				typeof values[key],
				"string",
				`${locale} 缺少 page.song.basic.${key}`,
			);
			assert.ok(values[key].trim(), `${locale} 的 ${key} 不能为空`);
		}
		assert.doesNotMatch(
			values.fileMetadataError,
			/\{\{/,
			`${locale} 必须使用 ICU 占位符`,
		);
		assert.equal(
			typeof translation.amll.audioQuality.bitDepth,
			"string",
			`${locale} 缺少 amll.audioQuality.bitDepth`,
		);
		assert.ok(
			translation.amll.audioQuality.bitDepth.trim(),
			`${locale} 的 amll.audioQuality.bitDepth 不能为空`,
		);
		return Object.keys(values).sort();
	});
	for (const keySet of basicKeySets.slice(1)) {
		assert.deepEqual(keySet, basicKeySets[0]);
	}
});

test("歌曲基本信息的 ICU 错误文案能够正确插值", async () => {
	const translation = JSON.parse(
		readProjectFile("../locales/zh-CN/translation.json"),
	);
	const instance = i18next.createInstance();
	await instance.use(ICU).init({
		lng: "zh-CN",
		fallbackLng: false,
		resources: { "zh-CN": { translation } },
		interpolation: { escapeValue: false },
	});
	assert.equal(
		instance.t("page.song.basic.fileMetadataError", { message: "读取失败" }),
		"无法读取原始音乐文件信息：读取失败",
	);
});
