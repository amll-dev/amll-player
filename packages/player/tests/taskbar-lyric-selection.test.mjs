import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const taskbarLyricHtml = readFileSync(
	fileURLToPath(new URL("../taskbar-lyric.html", import.meta.url)),
	"utf8",
);

test("任务栏歌词入口禁止浏览器选中文本", () => {
	const taskbarDocumentStyle = taskbarLyricHtml.match(
		/html,\s*body\s*\{[\s\S]*?\}/,
	)?.[0];

	assert.ok(taskbarDocumentStyle);
	assert.match(taskbarDocumentStyle, /\n\s*user-select:\s*none;/);
	assert.match(taskbarDocumentStyle, /-webkit-user-select:\s*none;/);
});
