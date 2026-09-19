import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	flush,
	persisted,
	setup,
	song,
	testAtoms,
} from "./helpers/play-queue.mjs";
import { emitAudioThread } from "../src/utils/player.ts";

const contextSource = readFileSync(
	new URL("../src/components/LocalMusicContext/index.tsx", import.meta.url),
	"utf8",
);
const playButton = new Function(
	"queueManager",
	"emitAudioThread",
	contextSource.match(
		/onPlayOrResumeAtom,\s*toEmit\(\(\) => \{([\s\S]*?)\}\),/,
	)[1],
);

test("当前加载失败后保留队列，再点播放会重新加载并生成新编号", async (context) => {
	const { manager, store, messages } = setup(context);
	manager.setQueue([song("a"), song("b")]);
	await flush();
	const failed = messages()[0];
	store.set(testAtoms.musicPlaying, true);
	assert.equal(manager.handlePlaybackLoadFailure(failed.playbackId), true);
	assert.equal(store.get(testAtoms.musicPlaying), false);
	assert.deepEqual(
		manager.getPlayList().map((s) => s.id),
		["a", "b"],
	);
	playButton(manager, emitAudioThread);
	await flush();
	assert.equal(messages().length, 2);
	assert.equal(messages()[1].song.songId, "a");
	assert.notEqual(messages()[1].playbackId, failed.playbackId);
	assert.equal(messages("resumeOrPauseAudio").length, 0);
	assert.equal(manager.handlePlaybackLoadFailure(failed.playbackId), false);
});

test("正常播放按钮仍发送暂停或继续命令", async (context) => {
	const { manager, messages } = setup(context);
	manager.replaceQueueAndPlay(song("a"));
	await flush();
	playButton(manager, emitAudioThread);
	await flush();
	assert.equal(messages().length, 1);
	assert.equal(messages("resumeOrPauseAudio").length, 1);
});

test("同一首歌的旧失败通知不影响新的播放实例", async (context) => {
	const { manager, store, messages } = setup(context);
	manager.replaceQueueAndPlay(song("a"));
	await flush();
	const first = messages()[0];
	manager.playAt(0);
	await flush();
	store.set(testAtoms.musicPlaying, true);
	assert.equal(manager.handlePlaybackLoadFailure(first.playbackId), false);
	assert.equal(manager.handlePlaybackLoadFailure(""), false);
	assert.equal(store.get(testAtoms.musicPlaying), true);
	assert.equal(manager.retryFailedPlayback(), false);
	assert.equal(messages().length, 2);
});

test("恢复加载失败会取消迟到的跳转和待恢复进度", async (context) => {
	let finishLoad;
	const { manager, messages } = setup(context, {
		saved: persisted(["a"], 0, 35),
		songs: [song("a")],
		audio: (message) =>
			message.type === "playAudio"
				? new Promise((resolve) => {
						finishLoad = resolve;
					})
				: undefined,
	});
	const restored = await manager.restore();
	const pending = manager.restoreCurrentPaused(
		restored.revision,
		restored.position,
	);
	await flush();
	assert.equal(
		manager.handlePlaybackLoadFailure(messages()[0].playbackId),
		true,
	);
	finishLoad();
	assert.equal(await pending, null);
	assert.equal(manager.takeRestorePosition("a"), undefined);
	assert.equal(messages("seekAudio").length, 0);
});

for (const action of ["newQueue", "stop", "dispose"]) {
	test(`失败后${action}不会再次重试旧歌曲`, async (context) => {
		const { manager, messages } = setup(context);
		manager.replaceQueueAndPlay(song("a"));
		await flush();
		const failedId = messages()[0].playbackId;
		manager.handlePlaybackLoadFailure(failedId);
		if (action === "newQueue") manager.setQueue([song("b")]);
		if (action === "stop") manager.setExternalStopped();
		if (action === "dispose") manager.dispose();
		assert.equal(manager.retryFailedPlayback(), false);
		assert.equal(manager.handlePlaybackLoadFailure(failedId), false);
		await flush();
		assert.equal(messages().length, action === "newQueue" ? 2 : 1);
	});
}
