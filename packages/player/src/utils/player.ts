import { invoke } from "@tauri-apps/api/core";
import { type EventCallback, listen } from "@tauri-apps/api/event";
import chalk from "chalk";
import { uid } from "uid";

export interface AudioThreadEventMessage<T> {
	callbackId: string;
	data: T;
}

export interface AudioQuality {
	sampleRate?: number;
	bitsPerCodedSample?: number;
	bitsPerSample?: number;
	channels?: number;
	sampleFormat?: string;
	codec?: string;
}

export interface AudioInfo {
	name: string;
	artist: string;
	album: string;
	lyric: string;
	duration: number;
	position: number;
}

export type SongData =
	| {
			type: "local";
			filePath: string;
			origOrder: number;
	  }
	| {
			type: "custom";
			id: string;
			songJsonData: string;
			origOrder: number;
	  };

export type AudioThreadMessageMap = {
	resumeAudio: undefined;
	pauseAudio: undefined;
	resumeOrPauseAudio: undefined;
	seekAudio: {
		position: number;
	};
	playAudio: {
		song: SongData;
	};
	setVolume: {
		volume: number;
	};
	setVolumeRelative: {
		volume: number;
	};
	setAudioOutput: {
		name: string;
	};
	setFFTRange: {
		fromFreq: number;
		toFreq: number;
	};
	setMediaControlsEnabled: {
		enabled: boolean;
	};
	close: undefined;
};

export type AudioThreadMessageKeys = keyof AudioThreadMessageMap;

export type AudioThreadMessagePayloadMap = {
	[T in AudioThreadMessageKeys]: AudioThreadMessageMap[T] extends undefined
		? { type: T }
		: { type: T } & AudioThreadMessageMap[T];
};

export type AudioThreadMessage =
	AudioThreadMessagePayloadMap[AudioThreadMessageKeys];

export type AudioThreadEvent =
	| {
			type: "playPosition";
			data: { position: number };
	  }
	| {
			type: "loadProgress";
			data: { position: number };
	  }
	| {
			type: "loadAudio";
			data: {
				musicId: string;
				musicInfo: AudioInfo;
				quality: AudioQuality;
			};
	  }
	| {
			type: "loadingAudio";
			data: { musicId: string };
	  }
	| {
			type: "audioPlayFinished";
			data: { musicId: string };
	  }
	| {
			type: "trackEnded";
	  }
	| {
			type: "hardwareMediaCommand";
			data: { command: string };
	  }
	| {
			type: "playStatus";
			data: { isPlaying: boolean };
	  }
	| {
			type: "loadError";
			data: { error: string };
	  }
	| {
			type: "playError";
			data: { error: string };
	  }
	| {
			type: "volumeChanged";
			data: { volume: number };
	  }
	| {
			type: "fftData";
			data: { data: number[] };
	  };

const msgTasks = new Map<string, (value: AudioThreadEvent) => void>();
const eventListeners = new Set<
	EventCallback<AudioThreadEventMessage<AudioThreadEvent>>
>();

let isInitialized = false;

export async function initAudioThread() {
	if (isInitialized) {
		return;
	}
	isInitialized = true;

	console.log(
		chalk.bgHex("#FF7700").hex("#FFFFFF")(" BACKEND  "),
		"后台线程连接初始化中",
	);

	await listen<AudioThreadEventMessage<AudioThreadEvent>>(
		"plugin:player-core-event",
		(evt) => {
			const resolve = msgTasks.get(evt.payload.callbackId);
			if (resolve) {
				msgTasks.delete(evt.payload.callbackId);
				resolve(evt.payload.data);
			}

			eventListeners.forEach((listener) => {
				try {
					listener(evt);
				} catch (e) {
					console.error("Error in audio event listener callback:", e);
				}
			});
		},
	);
	console.log(
		chalk.bgHex("#FF7700").hex("#FFFFFF")(" BACKEND "),
		"后台线程连接初始化完成",
	);
}

export const listenAudioThreadEvent = (
	handler: EventCallback<AudioThreadEventMessage<AudioThreadEvent>>,
): Promise<() => void> => {
	eventListeners.add(handler);
	const unlisten = () => {
		eventListeners.delete(handler);
	};
	return Promise.resolve(unlisten);
};

export async function resolveContentUri(filePath: string): Promise<string> {
	return await invoke("resolve_content_uri", { filePath });
}

export async function readLocalMusicMetadata(filePath: string): Promise<{
	name: string;
	artist: string;
	album: string;
	lyricFormat: string;
	lyric: string;
	cover: number[];
	duration: number;
}> {
	return await invoke("read_local_music_metadata", { filePath });
}

export async function restartApp(): Promise<never> {
	return await invoke("restart_app");
}

export async function emitAudioThread<T extends keyof AudioThreadMessageMap>(
	msgType: T,
	...args: AudioThreadMessageMap[T] extends undefined
		? []
		: [data: AudioThreadMessageMap[T]]
): Promise<void> {
	const id = uid(32) + Date.now();

	const payloadData = args[0]
		? { type: msgType, ...args[0] }
		: { type: msgType };

	await invoke("local_player_send_msg", {
		msg: {
			callbackId: id,
			data: payloadData,
		},
	});
}

export function emitAudioThreadRet<T extends keyof AudioThreadMessageMap>(
	msgType: T,
	...args: AudioThreadMessageMap[T] extends undefined
		? []
		: [data: AudioThreadMessageMap[T]]
): Promise<AudioThreadEvent> {
	const id = `${uid(32)}-${Date.now()}`;
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			msgTasks.delete(id);
			reject(new Error(`等待 ${msgType} 的回应超时`));
		}, 5000);

		msgTasks.set(id, (val) => {
			clearTimeout(timeout);
			resolve(val);
		});

		const payloadData = args[0]
			? { type: msgType, ...args[0] }
			: { type: msgType };

		invoke("local_player_send_msg", {
			msg: { callbackId: id, data: payloadData },
		}).catch((err) => {
			clearTimeout(timeout);
			msgTasks.delete(id);
			reject(err);
		});
	});
}
