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

test("恢复请求发送失败后清除待恢复进度，不再发送跳转", async (context) => {
	const failure = new Error("IPC failed");
	const { manager, messages } = setup(context, {
		saved: persisted(["a"], 0, 33),
		songs: [song("a")],
		audio: (message) => {
			if (message.type === "playAudio") throw failure;
		},
	});
	const result = await manager.restore();
	await assert.rejects(
		manager.restoreCurrentPaused(result.revision, result.position),
		failure,
	);
	assert.equal(manager.takeRestorePosition("a"), undefined);
	assert.equal(messages("seekAudio").length, 0);
});

function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

for (const withSongId of [true, false]) {
	test(`恢复${withSongId ? "带歌曲 ID" : "旧版数字索引"}的队列时，前序缺歌不会改变当前歌曲`, async (context) => {
		const saved = persisted(["a", "b", "c"], 1, 36);
		if (withSongId) saved.currentSongId = "b";
		const { manager, store } = setup(context, {
			saved,
			songs: [song("b"), song("c")],
		});
		const result = await manager.restore();
		assert.equal(result.restored, true);
		assert.equal(result.position, 36);
		assert.equal(manager.getCurrentSong().id, "b");
		assert.equal(manager.getCurrentIndex(), 0);
		assert.equal(store.get(testAtoms.musicPlayingPosition), 36_000);
	});
}

for (const remaining of [["a", "c", "d"], ["a"]]) {
	test(`当前歌曲缺失时选择${remaining.length > 1 ? "最近后继" : "最近前驱"}，从头开始`, async (context) => {
		const saved = {
			...persisted(["a", "b", "c", "d"], 1, 56),
			currentSongId: "b",
		};
		const { manager } = setup(context, { saved, songs: remaining.map(song) });
		const result = await manager.restore();
		assert.equal(result.restored, true);
		assert.equal(manager.getCurrentSong().id, remaining.length > 1 ? "c" : "a");
		assert.equal(result.position, 0);
	});
}

test("恢复只发送一次暂停起播请求，再跳转进度，并同步循环随机模式", async (context) => {
	const saved = {
		...persisted(["a"], 0, 42),
		shuffleActive: true,
		repeatMode: 2,
	};
	const { manager, calls, messages } = setup(context, {
		saved,
		songs: [song("a")],
	});
	const result = await manager.restore();
	const token = await manager.restoreCurrentPaused(
		result.revision,
		result.position,
	);
	assert.equal(manager.isCurrentRevision(token), true);
	assert.deepEqual(
		calls.map((call) => call.type),
		["updatePlayMode", "playAudio", "seekAudio"],
	);
	assert.deepEqual(messages("updatePlayMode")[0], {
		type: "updatePlayMode",
		isShuffling: true,
		repeatMode: "one",
	});
	assert.equal(messages()[0].startPaused, true);
	assert.ok(messages()[0].playbackId);
	assert.equal(messages("seekAudio")[0].position, 42);
	assert.equal(messages("pauseAudio").length, 0);
});

test("数据库尚未返回时选新歌曲，旧队列不会覆盖用户的选择", async (context) => {
	const database = deferred();
	const { manager, messages } = setup(context, {
		saved: persisted(["a"]),
		database: () => database.promise,
	});
	const restoring = manager.restore();
	manager.replaceQueueAndPlay(song("new"));
	database.resolve([song("a")]);
	assert.equal((await restoring).restored, false);
	await flush();
	assert.equal(manager.getCurrentSong().id, "new");
	assert.equal(messages().length, 1);
	assert.equal(messages()[0].startPaused, false);
});

test("卸载后返回的数据库结果不再恢复队列", async (context) => {
	const database = deferred();
	const { manager, messages, store } = setup(context, {
		saved: persisted(["a"]),
		database: () => database.promise,
	});
	const restoring = manager.restore();
	manager.dispose();
	database.resolve([song("a")]);
	assert.equal((await restoring).restored, false);
	assert.equal(manager.getCurrentSong(), null);
	assert.equal(messages().length, 0);
	assert.deepEqual(store.get(persistedQueueStateAtom).songIds, ["a"]);
});

test("读库期间切换循环和随机，保留原队列并采用新模式", async (context) => {
	const database = deferred();
	const { manager, store } = setup(context, {
		saved: persisted(["a", "b", "c"], 1, 24),
		database: () => database.promise,
	});
	const restoring = manager.restore();
	manager.setRepeatMode(1);
	manager.toggleShuffle();
	assert.deepEqual(store.get(persistedQueueStateAtom).songIds, ["a", "b", "c"]);
	assert.equal(store.get(persistedQueueStateAtom).position, 24);
	database.resolve([song("a"), song("b"), song("c")]);
	const result = await restoring;
	assert.equal(result.restored, true);
	assert.equal(manager.getCurrentSong().id, "b");
	assert.equal(manager.getRepeatMode(), 1);
	assert.equal(manager.isShuffleActive(), true);
	assert.notEqual(
		await manager.restoreCurrentPaused(result.revision, result.position),
		null,
	);
});

test("队列读回后切换模式，仍能恢复当前歌曲和进度", async (context) => {
	const { manager, messages } = setup(context, {
		saved: persisted(["a", "b"], 1, 24),
		songs: [song("a"), song("b")],
	});
	const result = await manager.restore();
	manager.setRepeatMode(1);
	manager.toggleShuffle();
	assert.notEqual(
		await manager.restoreCurrentPaused(result.revision, result.position),
		null,
	);
	assert.equal(messages()[0].song.songId, "b");
	assert.equal(messages("seekAudio")[0].position, 24);
});

for (const [name, act] of [
	["点歌", (manager) => manager.playAt(1)],
	["删歌", (manager) => manager.removeSong("b")],
	["添加歌曲", (manager) => manager.addToQueue(song("c"))],
	["停止", (manager) => manager.setExternalStopped()],
	["播放暂停或跳转", (manager) => manager.cancelRestore()],
	["卸载", (manager) => manager.dispose()],
]) {
	test(`恢复返回后${name}，过期的恢复令牌不能再次起播`, async (context) => {
		const { manager, messages } = setup(context, {
			saved: persisted(["a", "b"], 0, 12),
			songs: [song("a"), song("b")],
		});
		const result = await manager.restore();
		act(manager);
		await flush();
		const count = messages().length;
		assert.equal(
			await manager.restoreCurrentPaused(result.revision, result.position),
			null,
		);
		await flush();
		assert.equal(messages().length, count);
		assert.equal(messages("seekAudio").length, 0);
	});
}

test("恢复播放请求还在等待时切歌，不会把旧进度跳到新歌曲", async (context) => {
	const play = deferred();
	const { manager, messages } = setup(context, {
		saved: persisted(["a", "b"], 0, 55),
		songs: [song("a"), song("b")],
		audio: (message) =>
			message.type === "playAudio" && message.startPaused
				? play.promise
				: undefined,
	});
	const result = await manager.restore();
	const restoring = manager.restoreCurrentPaused(
		result.revision,
		result.position,
	);
	await flush();
	manager.playAt(1);
	play.resolve();
	assert.equal(await restoring, null);
	await flush();
	assert.equal(messages("seekAudio").length, 0);
	assert.equal(manager.getCurrentSong().id, "b");
});

test("迟到的加载事件仍能取到恢复进度，而且只消费一次", async (context) => {
	const { manager } = setup(context, {
		saved: persisted(["a"], 0, 33),
		songs: [song("a")],
	});
	const result = await manager.restore();
	await manager.restoreCurrentPaused(result.revision, result.position);
	assert.equal(manager.takeRestorePosition("other"), undefined);
	assert.equal(manager.takeRestorePosition("a"), 33);
	assert.equal(manager.takeRestorePosition("a"), undefined);
});

test("恢复后用户手动跳转，晚到的加载事件采用用户的新进度", async (context) => {
	const { manager } = setup(context, {
		saved: persisted(["a"], 0, 33),
		songs: [song("a")],
	});
	const result = await manager.restore();
	const token = await manager.restoreCurrentPaused(
		result.revision,
		result.position,
	);
	manager.cancelRestore(64);
	assert.equal(manager.isCurrentRevision(token), false);
	assert.equal(manager.takeRestorePosition("a"), 64);
});
