import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

function loadPicker({ platform = "windows", invoke, openPluginDialog }) {
	const source = readFileSync(
		new URL("../src/utils/file-dialog.ts", import.meta.url),
		"utf8",
	);
	const body = stripTypeScriptTypes(
		source.replace(/^import[\s\S]*?from "[^"]+";\r?\n/gm, ""),
	).replace(/^export /gm, "");
	return new Function(
		"invoke",
		"platform",
		"openPluginDialog",
		`${body}\nreturn openFileDialog;`,
	)(invoke, () => platform, openPluginDialog);
}

test("Windows 单选、多选和取消保留原插件的返回形状", async () => {
	const results = [["C:/music/a.flac"], ["a.flac", "b.flac"], null, []];
	const calls = [];
	const pick = loadPicker({
		invoke: async (command, payload) => {
			calls.push({ command, payload });
			return results.shift();
		},
	});
	const options = { directory: true, recursive: true, multiple: false };
	assert.equal(await pick(options), "C:/music/a.flac");
	assert.deepEqual(calls[0], {
		command: "pick_files_ownerless",
		payload: { options },
	});
	assert.deepEqual(await pick({ multiple: true }), ["a.flac", "b.flac"]);
	assert.equal(await pick({ multiple: false }), null);
	assert.equal(await pick({ multiple: false }), null);
});

test("Windows 同时只打开一个选择框，取消后可以重新打开", async () => {
	let finish;
	let calls = 0;
	const pick = loadPicker({
		invoke: () => {
			calls++;
			return new Promise((resolve) => {
				finish = resolve;
			});
		},
	});
	const first = pick({ multiple: false });
	assert.equal(await pick({ multiple: true }), null);
	assert.equal(calls, 1);
	finish(null);
	assert.equal(await first, null);
	const reopened = pick({ multiple: false });
	assert.equal(calls, 2);
	finish(["new.flac"]);
	assert.equal(await reopened, "new.flac");
});

test("原生命令失败后释放调用状态并向调用者返回错误", async () => {
	let calls = 0;
	const error = new Error("picker failed");
	const pick = loadPicker({
		invoke: async () => {
			if (++calls === 1) throw error;
			return ["recovered.flac"];
		},
	});
	await assert.rejects(pick({}), (actual) => actual === error);
	assert.equal(await pick({}), "recovered.flac");
	assert.equal(calls, 2);
});

test("非 Windows 平台将选择参数和结果原样交给插件", async () => {
	for (const platform of ["linux", "macos", "android", "ios"]) {
		const options = { multiple: true, filters: [] };
		const result = ["content://music/1", "content://music/2"];
		const pick = loadPicker({
			platform,
			invoke: () => assert.fail("non-Windows must use the plugin"),
			openPluginDialog: async (actual) => {
				assert.equal(actual, options);
				return result;
			},
		});
		assert.equal(await pick(options), result);
	}
});
