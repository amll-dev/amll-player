import assert from "node:assert/strict";
import test from "node:test";
import {
	flush,
	persisted,
	persistedQueueStateAtom,
	setup,
	song,
	testAtoms,
} from "./helpers/play-queue.mjs";

const ids = (manager) => manager.getPlayList().map((item) => item.id);
function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("下一首和队尾保留当前播放；移动已有歌曲保留其元数据", async (context) => {
	const { manager, store, messages } = setup(context);
	manager.setQueue([song("a"), song("b"), song("c")], 42);
	manager.playAt(1);
	await flush();
	const playing = messages().at(-1);
	store.set(testAtoms.musicPlayingPosition, 17_000);
	manager.enqueueNext(song("d"));
	manager.enqueueTail(song("e"));
	manager.enqueueNext({
		...song("a"),
		filePath: "stale.flac",
		songName: "stale",
	});
	assert.deepEqual(ids(manager), ["b", "a", "d", "c", "e"]);
	assert.equal(manager.getCurrentSong().id, "b");
	assert.equal(manager.getCurrentIndex(), 0);
	assert.equal(manager.getPlaylistId(), 42);
	assert.equal(manager.getPlayList()[1].filePath, "a.flac");
	assert.equal(manager.getPlayList()[1].songName, "a");
	assert.equal(store.get(persistedQueueStateAtom).position, 17);
	await flush();
	assert.equal(messages().length, 2);
	manager.advanceForAutoEnd("b", playing.playbackId);
	await flush();
	assert.equal(messages().at(-1).song.songId, "a");
});

test("随机播放也追加到实际队尾，取消随机后保留原顺序和当前歌曲", async (context) => {
	context.mock.method(Math, "random", () => 0);
	const { manager, store, messages } = setup(context);
	manager.setQueue([song("a"), song("b"), song("c")]);
	manager.playAt(1);
	await flush();
	manager.toggleShuffleOn();
	manager.enqueueNext({ ...song("a"), songName: "stale" });
	manager.enqueueTail(song("d"));
	assert.deepEqual(ids(manager), ["b", "a", "c", "d"]);
	assert.equal(manager.getPlayList()[1].songName, "a");
	assert.deepEqual(store.get(persistedQueueStateAtom).originalSongIds, [
		"a",
		"b",
		"c",
		"d",
	]);
	manager.toggleShuffleOff();
	assert.deepEqual(ids(manager), ["a", "b", "c", "d"]);
	assert.equal(manager.getCurrentSong().id, "b");
	assert.equal(manager.getCurrentIndex(), 1);
	await flush();
	assert.equal(messages().length, 2);
});

test("旧队列包含重复 ID 时，移动前面的歌曲仍保留当前项的位置", async (context) => {
	const { manager, messages } = setup(context);
	manager.setQueue([song("a"), song("b"), song("a"), song("c")]);
	manager.playAt(2);
	await flush();
	const playing = messages().at(-1);
	manager.enqueueNext(song("b"));
	assert.deepEqual(ids(manager), ["a", "a", "b", "c"]);
	assert.equal(manager.getCurrentIndex(), 1);
	manager.advanceForAutoEnd("a", playing.playbackId);
	await flush();
	assert.equal(manager.getCurrentSong().id, "b");
});

for (const method of ["enqueueNext", "enqueueTail"]) {
	test(`${method}: 空队列只起播一次`, async (context) => {
		const { manager, messages } = setup(context);
		manager[method](song("a"));
		await flush();
		assert.deepEqual(ids(manager), ["a"]);
		assert.equal(messages().length, 1);
		assert.equal(messages()[0].song.songId, "a");
		assert.equal(messages()[0].startPaused, false);
	});

	test(`${method}: 卸载后不再编辑或起播`, async (context) => {
		const { manager, messages } = setup(context);
		manager.dispose();
		manager[method](song("a"));
		await flush();
		assert.deepEqual(ids(manager), []);
		assert.equal(messages().length, 0);
	});

	test(`${method}: 空队列入队后，晚到的恢复结果不能覆盖新歌曲`, async (context) => {
		const database = deferred();
		const { manager, messages } = setup(context, {
			saved: persisted(["saved"], 0, 33),
			database: () => database.promise,
		});
		const restoring = manager.restore();
		manager[method](song("new"));
		database.resolve([song("saved")]);
		assert.equal((await restoring).restored, false);
		await flush();
		assert.deepEqual(ids(manager), ["new"]);
		assert.equal(messages().length, 1);
		assert.equal(messages()[0].startPaused, false);
		assert.equal(messages("seekAudio").length, 0);
	});

	test(`${method}: 晚到的读库结果不能覆盖非空队列中的新编辑`, async (context) => {
		const database = deferred();
		const { manager, store, messages } = setup(context, {
			database: () => database.promise,
		});
		manager.setQueue([song("a"), song("b")]);
		await flush();
		store.set(persistedQueueStateAtom, persisted(["saved"]));
		const restoring = manager.restore();
		manager[method](song("new"));
		const edited = ids(manager);
		database.resolve([song("saved")]);
		assert.equal((await restoring).restored, false);
		assert.deepEqual(ids(manager), edited);
		assert.equal(manager.getCurrentSong().id, "a");
		await flush();
		assert.equal(messages().length, 1);
	});

	test(`${method}: 不产生编辑的重复操作不会打断读库恢复`, async (context) => {
		const database = deferred();
		const { manager, store } = setup(context, {
			database: () => database.promise,
		});
		manager.setQueue([song("a"), song("b")]);
		await flush();
		store.set(persistedQueueStateAtom, persisted(["saved"]));
		const restoring = manager.restore();
		manager[method](song(method === "enqueueNext" ? "a" : "b"));
		database.resolve([song("saved")]);
		assert.equal((await restoring).restored, true);
	});

	for (const stage of ["before-play", "pending-play"]) {
		test(`${method}: ${stage} 时编辑队列仍恢复当前歌曲的暂停进度`, async (context) => {
			const play = deferred();
			const { manager, store, messages } = setup(context, {
				saved: persisted(["a", "b"], 0, 33),
				songs: [song("a"), song("b")],
				audio: (message) =>
					message.type === "playAudio" ? play.promise : undefined,
			});
			const result = await manager.restore();
			if (stage === "before-play") manager[method](song("new"));
			const restoring = manager.restoreCurrentPaused(
				result.revision,
				result.position,
			);
			await flush();
			if (stage === "pending-play") manager[method](song("new"));
			play.resolve();
			const token = await restoring;
			assert.equal(manager.isCurrentRevision(token), true);
			assert.equal(manager.getCurrentSong().id, "a");
			assert.equal(messages().length, 1);
			assert.equal(messages()[0].startPaused, true);
			assert.equal(messages("seekAudio").length, 1);
			assert.equal(messages("seekAudio")[0].position, 33);
			assert.equal(manager.takeRestorePosition("a"), 33);
			assert.equal(manager.takeRestorePosition("a"), undefined);
			assert.equal(store.get(persistedQueueStateAtom).position, 33);
		});
	}

	test(`${method}: 列表已播完时不自行起播，也不再接受已消费的结束通知`, async (context) => {
		const { manager, messages } = setup(context);
		manager.replaceQueueAndPlay(song("a"));
		await flush();
		const playing = messages()[0];
		manager.advanceForAutoEnd("a", playing.playbackId);
		manager[method](song("b"));
		manager.advanceForAutoEnd("a", playing.playbackId);
		await flush();
		assert.equal(messages().length, 1);
		assert.equal(messages("pauseAudio").length, 1);
	});
}
