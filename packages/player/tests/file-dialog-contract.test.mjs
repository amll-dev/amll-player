import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const readProjectFile = (path) =>
	readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));

function collectTypeScriptFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = `${directory}/${entry.name}`;
		if (entry.isDirectory()) return collectTypeScriptFiles(path);
		return /\.tsx?$/.test(entry.name) ? [path] : [];
	});
}

const helper = readProjectFile("../src/utils/file-dialog.ts");
const nativePicker = readProjectFile("../src-tauri/src/file_dialog.rs");
const nativeEntry = readProjectFile("../src-tauri/src/lib.rs");
const playlist = readProjectFile("../src/pages/playlist/index.tsx");
const newPlaylist = readProjectFile(
	"../src/components/NewPlaylistButton/index.tsx",
);
const extension = readProjectFile("../src/pages/settings/extension.tsx");

test("所有应用文件选择入口统一经过安全 helper", () => {
	const directImports = collectTypeScriptFiles(sourceRoot)
		.filter(
			(path) => !path.replaceAll("\\", "/").endsWith("/utils/file-dialog.ts"),
		)
		.filter((path) =>
			readFileSync(path, "utf8").includes("@tauri-apps/plugin-dialog"),
		);
	assert.deepEqual(directImports, []);

	assert.match(playlist, /openFileDialog\(\{[\s\S]*multiple:\s*true/);
	assert.match(playlist, /directory:\s*true,[\s\S]*multiple:\s*false/);
	assert.match(playlist, /onClick=\{\(\) => void onUploadPlaylistCover\(\)\}/);
	assert.match(newPlaylist, /openFileDialog\(\{[\s\S]*directory:\s*true/);
	assert.match(extension, /openFileDialog\(\{[\s\S]*multiple:\s*true/);
});

test("Windows helper 使用 ownerless 命令并阻止重复原生对话框", () => {
	assert.match(helper, /platform\(\) !== "windows"/);
	assert.match(helper, /openPluginDialog\(options\)/);
	assert.match(helper, /windowsDialogInFlight/);
	assert.match(
		helper,
		/invoke<string\[\] \| null>\([\s\S]*CMD_PICK_FILES_OWNERLESS/,
	);
	assert.match(helper, /finally[\s\S]*windowsDialogInFlight = false/);
});

test("Rust picker 保持 ownerless、callback、超时和取消语义", () => {
	assert.match(nativePicker, /app\.dialog\(\)\.file\(\)/);
	assert.match(nativePicker, /tokio::sync::oneshot::channel/);
	assert.match(nativePicker, /dialog\.pick_file\(/);
	assert.match(nativePicker, /dialog\.pick_files\(/);
	assert.match(nativePicker, /dialog\.pick_folder\(/);
	assert.match(nativePicker, /dialog\.pick_folders\(/);
	assert.match(
		nativePicker,
		/tokio::time::timeout\(FILE_DIALOG_TIMEOUT, receiver\)/,
	);
	assert.match(nativePicker, /window\s*\.set_enabled\(false\)/);
	assert.match(nativePicker, /window\.set_enabled\(true\)/);
	assert.match(nativePicker, /window\.try_fs_scope\(\)/);
	assert.match(nativePicker, /allow_file\(&path\)/);
	assert.match(nativePicker, /path\.simplified\(\)\.to_string\(\)/);
	assert.doesNotMatch(nativePicker, /blocking_pick_|set_parent|\.recv\s*\(/);
	assert.match(nativeEntry, /file_dialog::pick_files_ownerless/);
});
