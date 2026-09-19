import { registerHooks } from "node:module";
import { atom, createStore } from "jotai";

globalThis.window = globalThis;
export const testAtoms = {
	isShuffleActive: atom(false),
	musicPlaying: atom(false),
	musicPlayingPosition: atom(0),
	repeatMode: atom(0),
};
globalThis.__playQueueTestAtoms = testAtoms;
const reactFullStub = `
const atoms = globalThis.__playQueueTestAtoms;
export const isShuffleActiveAtom = atoms.isShuffleActive;
export const musicPlayingAtom = atoms.musicPlaying;
export const musicPlayingPositionAtom = atoms.musicPlayingPosition;
export const repeatModeAtom = atoms.repeatMode;
export const RepeatMode = { Off: 0, All: 1, One: 2 };
`;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@applemusic-like-lyrics/react-full") {
			return {
				url: `data:text/javascript,${encodeURIComponent(reactFullStub)}`,
				shortCircuit: true,
			};
		}
		return nextResolve(specifier, context);
	},
});

const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
const { PlayQueueManager, persistedQueueStateAtom } = await import(
	"../../src/utils/play-queue-manager.ts"
);
export { persistedQueueStateAtom };

export function song(id) {
	return {
		id,
		filePath: `${id}.flac`,
		songName: id,
		songArtists: "",
		songAlbum: "",
		duration: 180,
		lyricFormat: "",
		lyric: "",
	};
}

export function setup(context, { songs = [], saved, database, audio } = {}) {
	const calls = [];
	mockIPC((command, payload) => {
		if (command === "plugin:event|listen") return 1;
		if (command === "get_songs_by_ids") return database?.(payload) ?? songs;
		if (command !== "local_player_send_msg")
			throw new Error(`Unexpected IPC: ${command}`);
		calls.push(payload.msg.data);
		return audio?.(payload.msg.data);
	});
	const store = createStore();
	if (saved) store.set(persistedQueueStateAtom, saved);
	const manager = new PlayQueueManager(store);
	context.after(async () => {
		manager.dispose();
		await flush();
		clearMocks();
	});
	return {
		manager,
		store,
		calls,
		messages: (type = "playAudio") =>
			calls.filter((call) => call.type === type),
	};
}

export async function flush() {
	await new Promise((resolve) => setImmediate(resolve));
}

export function persisted(ids, currentIndex = 0, position = 0) {
	return {
		songIds: ids,
		originalSongIds: ids,
		currentIndex,
		position,
		repeatMode: 0,
		shuffleActive: false,
		playlistId: null,
	};
}
