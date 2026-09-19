import assert from "node:assert/strict";
import test from "node:test";
import { flush, persisted, setup, song } from "./helpers/play-queue.mjs";

test("快速切歌后，旧请求和错误歌曲的结束事件不会跳过当前歌曲", async (context) => {
	const { manager, messages } = setup(context);
	manager.setQueue([song("a"), song("b"), song("c")]);
	await flush();
	const first = messages()[0];
	manager.playAt(1);
	await flush();
	const second = messages()[1];
	assert.notEqual(first.playbackId, second.playbackId);
	manager.advanceForAutoEnd("a", first.playbackId);
	manager.advanceForAutoEnd("a", second.playbackId);
	await flush();
	assert.equal(messages().length, 2);
	assert.equal(manager.getCurrentSong().id, "b");
	manager.advanceForAutoEnd("b", second.playbackId);
	await flush();
	assert.equal(messages().length, 3);
	assert.equal(manager.getCurrentSong().id, "c");
});

test("单曲循环每次生成新编号，同一首歌的旧结束事件只能消费一次", async (context) => {
	const { manager, messages } = setup(context);
	manager.setRepeatMode(2);
	manager.replaceQueueAndPlay(song("a"));
	await flush();
	const first = messages()[0];
	manager.advanceForAutoEnd("a", first.playbackId);
	await flush();
	const second = messages()[1];
	assert.notEqual(first.playbackId, second.playbackId);
	manager.advanceForAutoEnd("a", first.playbackId);
	await flush();
	assert.equal(messages().length, 2);
	manager.advanceForAutoEnd("a", second.playbackId);
	await flush();
	assert.equal(messages().length, 3);
});

test("系统停止后，迟到的结束事件不会启动下一首", async (context) => {
	const { manager, messages } = setup(context);
	manager.setQueue([song("a"), song("b")]);
	await flush();
	const first = messages()[0];
	manager.setExternalStopped();
	manager.advanceForAutoEnd("a", first.playbackId);
	await flush();
	assert.equal(messages().length, 1);
	assert.equal(manager.getCurrentSong().id, "a");
});

test("列表播放完后追加歌曲，重复的结束事件不会再次推进", async (context) => {
	const { manager, messages } = setup(context);
	manager.replaceQueueAndPlay(song("a"));
	await flush();
	const first = messages()[0];
	manager.advanceForAutoEnd("a", first.playbackId);
	await flush();
	assert.equal(messages("pauseAudio").length, 1);
	manager.addToQueue(song("b"));
	manager.advanceForAutoEnd("a", first.playbackId);
	await flush();
	assert.equal(messages().length, 1);
	assert.equal(messages("pauseAudio").length, 1);
});

test("移除最后一首会停止音频，重新加入同一首也不接受旧结束事件", async (context) => {
	const { manager, messages } = setup(context);
	manager.replaceQueueAndPlay(song("a"));
	await flush();
	const first = messages()[0];
	manager.removeSong("a");
	await flush();
	assert.equal(messages("stopAudio").length, 1);
	assert.equal(manager.getCurrentSong(), null);
	manager.setQueue([song("a"), song("b")]);
	manager.advanceForAutoEnd("a", first.playbackId);
	await flush();
	assert.equal(messages().length, 2);
	assert.equal(manager.getCurrentSong().id, "a");
});

test("恢复队列通过统一入口播放，结束事件仍能正确推进", async (context) => {
	const { manager, messages } = setup(context, {
		songs: [song("a"), song("b")],
		saved: persisted(["a", "b"]),
	});
	assert.equal((await manager.restore()).restored, true);
	manager.playAt(manager.getCurrentIndex());
	await flush();
	const first = messages()[0];
	assert.match(first.playbackId, /^[\da-f-]{36}$/);
	manager.advanceForAutoEnd("a", first.playbackId);
	await flush();
	assert.equal(manager.getCurrentSong().id, "b");
	assert.equal(messages().length, 2);
});
