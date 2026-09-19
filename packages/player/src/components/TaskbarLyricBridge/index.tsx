import {
	lyricWordFadeWidthAtom,
	musicAlbumNameAtom,
	musicArtistsAtom,
	musicCoverAtom,
	musicCoverIsVideoAtom,
	musicDurationAtom,
	musicIdAtom,
	musicLyricLinesAtom,
	musicNameAtom,
	musicPlayingAtom,
	musicPlayingPositionAtom,
	onPlayOrResumeAtom,
	onRequestNextSongAtom,
	onRequestPrevSongAtom,
} from "@applemusic-like-lyrics/react-full";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { useAtomValue } from "jotai";
import { type FC, useEffect, useRef } from "react";
import {
	taskbarLyricAlignSettingAtom,
	taskbarLyricModeSettingAtom,
	taskbarLyricThemeSettingAtom,
	taskbarLyricWordProgressAtom,
} from "../../states/appAtoms";
import {
	ALIGN_EVENT,
	CTRL_NEXT_EVENT,
	CTRL_PLAY_OR_RESUME_EVENT,
	CTRL_PREV_EVENT,
	METADATA_EVENT,
	MODE_EVENT,
	PLAY_STATUS_EVENT,
	POSITION_EVENT,
	REQUEST_UPDATE_EVENT,
	type TaskbarLyricAlignmentPayload,
	type TaskbarLyricMetadataPayload,
	type TaskbarLyricModePayload,
	type TaskbarLyricPlayStatusPayload,
	type TaskbarLyricPositionPayload,
	type TaskbarLyricThemePayload,
	type TaskbarLyricWordProgressPayload,
	THEME_EVENT,
	WORD_PROGRESS_EVENT,
} from "./types";

export const TaskbarLyricBridge: FC = () => {
	const musicId = useAtomValue(musicIdAtom);
	const musicName = useAtomValue(musicNameAtom);
	const musicArtists = useAtomValue(musicArtistsAtom);
	const musicAlbumName = useAtomValue(musicAlbumNameAtom);
	const musicDuration = useAtomValue(musicDurationAtom);
	const musicLyricLines = useAtomValue(musicLyricLinesAtom);
	const musicPlaying = useAtomValue(musicPlayingAtom);
	const musicPlayingPosition = useAtomValue(musicPlayingPositionAtom);
	const musicCover = useAtomValue(musicCoverAtom);
	const musicCoverIsVideo = useAtomValue(musicCoverIsVideoAtom);
	const lastEmitTime = useRef(0);
	const onRequestPrevSong = useAtomValue(onRequestPrevSongAtom).onEmit;
	const onPlayOrResume = useAtomValue(onPlayOrResumeAtom).onEmit;
	const onRequestNextSong = useAtomValue(onRequestNextSongAtom).onEmit;

	const taskbarLyricTheme = useAtomValue(taskbarLyricThemeSettingAtom);
	const taskbarLyricAlign = useAtomValue(taskbarLyricAlignSettingAtom);
	const taskbarLyricMode = useAtomValue(taskbarLyricModeSettingAtom);
	const taskbarLyricWordProgress = useAtomValue(taskbarLyricWordProgressAtom);
	const lyricWordFadeWidth = useAtomValue(lyricWordFadeWidthAtom);

	const stateCache = useRef({
		metadata: {} as TaskbarLyricMetadataPayload,
		playStatus: {} as TaskbarLyricPlayStatusPayload,
		position: {} as TaskbarLyricPositionPayload,
		theme: { theme: "auto" } as TaskbarLyricThemePayload,
		align: { align: "auto" } as TaskbarLyricAlignmentPayload,
		mode: { mode: "auto" } as TaskbarLyricModePayload,
		wordProgress: {
			enabled: false,
			fadeWidth: 0.5,
		} as TaskbarLyricWordProgressPayload,
	});

	useEffect(() => {
		invoke("open_taskbar_lyric").catch(console.error);
		return () => {
			invoke("close_taskbar_lyric").catch(console.error);
		};
	}, []);

	useEffect(() => {
		const payload: TaskbarLyricMetadataPayload = {
			musicId,
			musicName,
			musicArtists,
			musicAlbumName,
			musicDuration,
			lyricLines: musicLyricLines,
			musicCover,
			musicCoverIsVideo,
		};
		stateCache.current.metadata = payload;
		emit(METADATA_EVENT, payload).catch(console.error);
	}, [
		musicId,
		musicName,
		musicArtists,
		musicAlbumName,
		musicDuration,
		musicLyricLines,
		musicCover,
		musicCoverIsVideo,
	]);

	useEffect(() => {
		const payload: TaskbarLyricPlayStatusPayload = { musicPlaying };
		stateCache.current.playStatus = payload;
		emit(PLAY_STATUS_EVENT, payload).catch(console.error);
	}, [musicPlaying]);

	useEffect(() => {
		const payload: TaskbarLyricPositionPayload = {
			position: musicPlayingPosition,
		};
		stateCache.current.position = payload;

		const now = performance.now();
		if (musicPlaying && now - lastEmitTime.current < 200) return;
		lastEmitTime.current = now;

		emit(POSITION_EVENT, payload).catch(console.error);
	}, [musicPlaying, musicPlayingPosition]);

	useEffect(() => {
		stateCache.current.theme = { theme: taskbarLyricTheme };
		emit(THEME_EVENT, stateCache.current.theme).catch(console.error);
	}, [taskbarLyricTheme]);

	useEffect(() => {
		stateCache.current.align = { align: taskbarLyricAlign };
		emit(ALIGN_EVENT, stateCache.current.align).catch(console.error);
	}, [taskbarLyricAlign]);

	useEffect(() => {
		stateCache.current.mode = { mode: taskbarLyricMode };
		emit(MODE_EVENT, stateCache.current.mode).catch(console.error);
	}, [taskbarLyricMode]);

	useEffect(() => {
		stateCache.current.wordProgress = {
			enabled: taskbarLyricWordProgress,
			fadeWidth: lyricWordFadeWidth,
		};
		emit(WORD_PROGRESS_EVENT, stateCache.current.wordProgress).catch(
			console.error,
		);
	}, [lyricWordFadeWidth, taskbarLyricWordProgress]);

	useEffect(() => {
		const unlistenRequest = listen(REQUEST_UPDATE_EVENT, () => {
			if (stateCache.current.metadata.musicName !== undefined) {
				emit(METADATA_EVENT, stateCache.current.metadata).catch(console.error);
				emit(PLAY_STATUS_EVENT, stateCache.current.playStatus).catch(
					console.error,
				);
				emit(POSITION_EVENT, stateCache.current.position).catch(console.error);
				emit(THEME_EVENT, stateCache.current.theme).catch(console.error);
				emit(ALIGN_EVENT, stateCache.current.align).catch(console.error);
				emit(MODE_EVENT, stateCache.current.mode).catch(console.error);
				emit(WORD_PROGRESS_EVENT, stateCache.current.wordProgress).catch(
					console.error,
				);
			}
		});

		return () => {
			unlistenRequest.then((fn) => fn());
		};
	}, []);

	useEffect(() => {
		const unlistenPrev = listen(CTRL_PREV_EVENT, () => {
			onRequestPrevSong?.();
		});
		const unlistenPlayOrResume = listen(CTRL_PLAY_OR_RESUME_EVENT, () => {
			onPlayOrResume?.();
		});
		const unlistenNext = listen(CTRL_NEXT_EVENT, () => {
			onRequestNextSong?.();
		});
		return () => {
			unlistenPrev.then((fn) => fn());
			unlistenPlayOrResume.then((fn) => fn());
			unlistenNext.then((fn) => fn());
		};
	}, [onRequestPrevSong, onPlayOrResume, onRequestNextSong]);

	return null;
};
