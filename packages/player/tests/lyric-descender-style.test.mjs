import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const selector =
	".FmKaba_lyricMainLine span.FmKaba_emphasizeWrapper > span:not(.FmKaba_emphasize)";
const expectedDeclarations = ["margin: -.1em;", "padding: .1em;"];

const patchPath = fileURLToPath(
	new URL(
		"../../../patches/@applemusic-like-lyrics__core@0.5.2.patch",
		import.meta.url,
	),
);
const installedStylePath = fileURLToPath(
	new URL(
		"../node_modules/@applemusic-like-lyrics/core/dist/style.css",
		import.meta.url,
	),
);

function assertDescenderSafetyRule(source, linePrefix = "") {
	const expectedRule = [
		`${linePrefix}${selector} {`,
		...expectedDeclarations.map(
			(declaration) => `${linePrefix}  ${declaration}`,
		),
		`${linePrefix}}`,
	].join("\n");
	assert.ok(source.replaceAll("\r\n", "\n").includes(expectedRule));
}

test("Core 补丁仅为非强调逐词元素保留下行字母绘制余量", () => {
	const patch = readFileSync(patchPath, "utf8");

	// hunk 头的行号/上下文格式随 pnpm patch 重生成而变化,只锚定文件段。
	assert.match(patch, /diff --git a\/dist\/style\.css b\/dist\/style\.css/);
	assertDescenderSafetyRule(patch, "+");
});

test("安装后的 Core 样式已应用逐词下行字母安全区", () => {
	const installedStyle = readFileSync(installedStylePath, "utf8");

	assertDescenderSafetyRule(installedStyle);
});
