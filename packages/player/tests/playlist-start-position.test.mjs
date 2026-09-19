import assert from "node:assert/strict";
import test from "node:test";
import { flush, persisted, setup, song } from "./helpers/play-queue.mjs";

test("从指定歌曲起播只发送一次播放请求", async (context) => {
	const { manager, messages } = setup(context);
	const songs = [song("a"), song("b"), song("c")];
	manager.setQueue(songs, 42, 1);
	await flush();
	assert.equal(messages().length, 1);
	assert.equal(messages()[0].song.songId, "b");
	assert.equal(manager.getCurrentIndex(), 1);
	assert.equal(manager.getPlaylistId(), 42);
	assert.deepEqual(manager.getPlayList(), songs);
});

test("随机播放指定项后，其他随机歌曲仍全部位于后续队列", async (context) => {
	context.mock.method(Math, "random", () => 0);
	const { manager, messages } = setup(context);
	manager.toggleShuffleOn();
	manager.setQueue([song("a"), song("b"), song("c")], 42, 2);
	await flush();
	assert.equal(messages().length, 1);
	assert.equal(manager.getCurrentIndex(), 0);
	assert.deepEqual(
		manager.getPlayList().map((item) => item.id),
		["c", "a", "b"],
	);
	for (let index = 0; index < 3; index++) {
		const request = messages().at(-1);
		manager.advanceForAutoEnd(request.song.songId, request.playbackId);
		await flush();
	}
	assert.deepEqual(
		messages().map((request) => request.song.songId),
		["c", "a", "b"],
	);
});

test("没有指定起播项时保留随机首项，不固定为歌单第一首", async (context) => {
	context.mock.method(Math, "random", () => 0);
	const { manager, messages } = setup(context);
	manager.toggleShuffleOn();
	manager.setQueue([song("a"), song("b"), song("c")], 42);
	await flush();
	assert.equal(messages().length, 1);
	assert.equal(messages()[0].song.songId, "b");
	manager.toggleShuffleOff();
	assert.deepEqual(
		manager.getPlayList().map((item) => item.id),
		["a", "b", "c"],
	);
	assert.equal(manager.getCurrentSong().id, "b");
});

for (const shuffle of [false, true]) {
	test(`无效起播索引回退到实际队列首项（随机=${shuffle}）`, async (context) => {
		context.mock.method(Math, "random", () => 0);
		const { manager, messages } = setup(context);
		if (shuffle) manager.toggleShuffleOn();
		for (const index of [-1, 3, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			const before = messages().length;
			manager.setQueue([song("a"), song("b"), song("c")], 42, index);
			await flush();
			assert.equal(messages().length, before + 1);
			assert.equal(messages().at(-1).song.songId, shuffle ? "b" : "a");
			assert.equal(manager.getCurrentIndex(), 0);
		}
	});

	test(`指定重复 ID 的歌曲项时保留该项及其元数据（随机=${shuffle}）`, async (context) => {
		context.mock.method(Math, "random", () => 0);
		const { manager, messages } = setup(context);
		const selected = { ...song("a"), filePath: "selected.flac" };
		if (shuffle) manager.toggleShuffleOn();
		manager.setQueue([song("a"), song("b"), selected, song("c")], 42, 2);
		await flush();
		assert.equal(messages().length, 1);
		assert.equal(messages()[0].song.filePath, "selected.flac");
		assert.equal(manager.getCurrentSong(), selected);
		assert.equal(manager.getPlayList().length, 4);
	});
}

test("同一歌曲对象重复出现时，也按指定位置旋转随机队列", async (context) => {
	context.mock.method(Math, "random", () => 0);
	const { manager, messages } = setup(context);
	const repeated = song("a");
	manager.toggleShuffleOn();
	manager.setQueue([repeated, song("b"), repeated, song("c")], 42, 2);
	await flush();
	assert.equal(messages().length, 1);
	assert.deepEqual(
		manager.getPlayList().map((item) => item.id),
		["a", "c", "a", "b"],
	);
});

test("指定起播的新队列不会被迟到的恢复结果覆盖", async (context) => {
	let finishRead;
	const { manager, messages } = setup(context, {
		saved: persisted(["old"], 0, 18),
		database: () =>
			new Promise((resolve) => {
				finishRead = resolve;
			}),
	});
	const restoring = manager.restore();
	await flush();
	manager.setQueue([song("a"), song("b")], 42, 1);
	finishRead([song("old")]);
	await restoring;
	await flush();
	assert.equal(messages().length, 1);
	assert.equal(manager.getCurrentSong().id, "b");
	assert.equal(messages("seekAudio").length, 0);
});

test("空队列和已释放的管理器不会因为指定起播项发出播放请求", async (context) => {
	const { manager, messages } = setup(context);
	manager.setQueue([], 42, 1);
	manager.dispose();
	manager.setQueue([song("a"), song("b")], 42, 1);
	await flush();
	assert.equal(messages().length, 0);
});
