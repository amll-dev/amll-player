import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
	new URL("../src/pages/song/metadata.tsx", import.meta.url),
	"utf8",
);
const body = source.match(
	/const uploadCoverAsImage = useCallback\(async \(\) => \{([\s\S]*?)\n\t\}, \[song, t\]\);/,
)?.[1];
assert.ok(body, "应能定位实际封面上传回调");

function setup(overrides = {}) {
	const busy = { current: false };
	const states = [];
	const updates = [];
	const errors = [];
	const env = {
		song: { id: "song-1" },
		coverPickerBusyRef: busy,
		setIsPickingCover: (value) => states.push(value),
		t: (_key, fallback) => fallback,
		openFileDialog: async () => "/selected/cover.png",
		saveCoverFromPath: async () => "/covers/song-1.png",
		db: { songs: { update: async (...args) => updates.push(args) } },
		console: { error: (...args) => errors.push(args) },
		...overrides,
	};
	const upload = new Function(
		...Object.keys(env),
		`return async () => {${body}}`,
	)(...Object.values(env));
	return { upload, busy, states, updates, errors };
}

test("封面保存完成前阻止重复提交，完成后可以再次选择", async () => {
	let opened = 0;
	let finishSave;
	const saving = new Promise((resolve) => {
		finishSave = resolve;
	});
	const ctx = setup({
		openFileDialog: async () => {
			opened += 1;
			return "/selected/video.mp4";
		},
		saveCoverFromPath: async (songId, path) => {
			assert.equal(songId, "song-1");
			assert.equal(path, "/selected/video.mp4");
			return saving;
		},
	});
	const first = ctx.upload();
	await Promise.resolve();
	await ctx.upload();
	assert.equal(opened, 1);
	assert.equal(ctx.busy.current, true);
	assert.deepEqual(ctx.updates, []);
	finishSave("/covers/song-1.mp4");
	await first;
	assert.deepEqual(ctx.updates, [
		["song-1", { coverPath: "/covers/song-1.mp4" }],
	]);
	assert.equal(ctx.busy.current, false);
	assert.deepEqual(ctx.states, [true, false]);
	await ctx.upload();
	assert.equal(opened, 2);
});

test("取消或选择、复制、数据库保存失败后都释放忙碌状态", async () => {
	for (const stage of ["cancel", "picker", "copy", "database"]) {
		let saved = 0;
		const fail = async () => {
			throw new Error(stage);
		};
		const ctx = setup({
			openFileDialog:
				stage === "picker"
					? fail
					: async () => (stage === "cancel" ? null : "/cover.png"),
			saveCoverFromPath:
				stage === "copy"
					? fail
					: async () => {
							saved += 1;
							return "/saved.png";
						},
			...(stage === "database" ? { db: { songs: { update: fail } } } : {}),
		});
		await ctx.upload();
		assert.equal(ctx.busy.current, false, stage);
		assert.deepEqual(ctx.states, [true, false], stage);
		assert.equal(ctx.errors.length, stage === "cancel" ? 0 : 1, stage);
		assert.deepEqual(ctx.updates, [], stage);
		assert.equal(saved, stage === "database" ? 1 : 0, stage);
		await ctx.upload();
		assert.deepEqual(ctx.states, [true, false, true, false], stage);
	}
});
