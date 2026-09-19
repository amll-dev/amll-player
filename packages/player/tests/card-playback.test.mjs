import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { flush, setup, song, testAtoms } from "./helpers/play-queue.mjs";

const playlistSource = readFileSync(new URL("../src/components/PlaylistCard/index.tsx", import.meta.url), "utf8");
const songSource = readFileSync(new URL("../src/components/SongCard/index.tsx", import.meta.url), "utf8");
const playlistHandler = playlistSource.match(/const playPlaylist = async \(shuffle: boolean\) => \{([\s\S]*?)\n\t\};/)?.[0];
assert.ok(playlistHandler);
const createHandler = new Function("queueManager", "db", "playlist", `${stripTypeScriptTypes(playlistHandler)}; return playPlaylist;`);

for (const shuffle of [false, true]) {
	test(`歌单卡片菜单以指定顺序直接播放（随机=${shuffle}）`, async (context) => {
		context.mock.method(Math, "random", () => 0);
		const { manager, store, messages } = setup(context);
		if (!shuffle) manager.toggleShuffleOn();
		const songs = [song("a"), song("b"), song("c")];
		const play = createHandler(manager, { playlists: { getSongs: async (id) => {
			assert.equal(id, 42);
			return songs;
		} } }, { id: 42 });
		await play(shuffle);
		await flush();
		assert.equal(store.get(testAtoms.isShuffleActive), shuffle);
		assert.equal(manager.getPlaylistId(), 42);
		assert.equal(messages().length, 1);
		assert.equal(messages()[0].song.songId, shuffle ? "b" : "a");
		assert.deepEqual(manager.getPlayList().map((item) => item.id).sort(), ["a", "b", "c"]);
	});
}

test("空歌单不会打断当前播放或改变随机模式", async (context) => {
	const { manager, store, messages } = setup(context);
	manager.setQueue([song("existing")], 7);
	await flush();
	const play = createHandler(manager, { playlists: { getSongs: async () => [] } }, { id: 42 });
	await play(true);
	await flush();
	assert.equal(messages().length, 1);
	assert.equal(manager.getPlaylistId(), 7);
	assert.equal(manager.getCurrentSong().id, "existing");
	assert.equal(store.get(testAtoms.isShuffleActive), false);
});

test("播放管理器尚未就绪时不读取歌单", async () => {
	const play = createHandler(null, { playlists: { getSongs: () => assert.fail("不应读取") } }, { id: 42 });
	await play(false);
});

test("双击歌曲卡片只替换一次队列并播放对应歌曲", async (context) => {
	const { manager, messages } = setup(context);
	const body = songSource.match(/onDoubleClick=\{\(\) => \{([\s\S]*?)\}\}/)?.[1];
	assert.ok(body);
	new Function("queueManager", "song", body)(manager, song("selected"));
	await flush();
	assert.equal(messages().length, 1);
	assert.equal(messages()[0].song.songId, "selected");
	assert.deepEqual(manager.getPlayList().map((item) => item.id), ["selected"]);
	new Function("queueManager", "song", body)(null, song("ignored"));
});
