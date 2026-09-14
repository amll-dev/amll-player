import {
	musicArtistsAtom,
	musicCoverAtom,
	musicCoverIsVideoAtom,
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
import { listen } from "@tauri-apps/api/event";
import { platform } from "@tauri-apps/plugin-os";
import { useAtom, useAtomValue } from "jotai";
import { type FC, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getReachedTrayLyric } from "../../pages/tray-player/text.ts";
import {
	enableTaskbarLyricAtom,
	windowCloseBehaviorAtom,
} from "../../states/appAtoms.ts";
import { getVideoThumbnail } from "../../utils/video-thumbnail.ts";
import { WINDOW_CLOSE_BEHAVIOR_ALWAYS_TRAY } from "../../utils/window-lifecycle.ts";
import {
	BACKGROUND_TRAY_COMMAND_EVENT,
	type BackgroundTrayCommandPayload,
	type BackgroundTrayCover,
	CMD_UPDATE_BACKGROUND_TRAY_MENU,
} from "./types.ts";

const TRAY_COVER_SIZE = 16;
const TRAY_DISPLAY_COVER_SIZE = 192;
const EMPTY_COVER =
	"data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

interface RasterizedTrayCover {
	mediaKey: string;
	cover: BackgroundTrayCover;
	displayCover: string;
}

async function rasterizeTrayCover(
	source: string,
	isVideo: boolean,
): Promise<Omit<RasterizedTrayCover, "mediaKey">> {
	const blob = isVideo
		? await getVideoThumbnail(source)
		: await fetch(source).then((response) => {
				if (!response.ok) {
					throw new Error(`Failed to load tray cover: ${response.status}`);
				}
				return response.blob();
			});
	const bitmap = await createImageBitmap(blob);
	try {
		const displayCanvas = document.createElement("canvas");
		displayCanvas.width = TRAY_DISPLAY_COVER_SIZE;
		displayCanvas.height = TRAY_DISPLAY_COVER_SIZE;
		const displayContext = displayCanvas.getContext("2d");
		if (!displayContext) throw new Error("Unable to rasterize the tray cover.");

		const sourceSize = Math.min(bitmap.width, bitmap.height);
		const sourceX = (bitmap.width - sourceSize) / 2;
		const sourceY = (bitmap.height - sourceSize) / 2;
		displayContext.drawImage(
			bitmap,
			sourceX,
			sourceY,
			sourceSize,
			sourceSize,
			0,
			0,
			TRAY_DISPLAY_COVER_SIZE,
			TRAY_DISPLAY_COVER_SIZE,
		);

		const trayCanvas = document.createElement("canvas");
		trayCanvas.width = TRAY_COVER_SIZE;
		trayCanvas.height = TRAY_COVER_SIZE;
		const context = trayCanvas.getContext("2d", { willReadFrequently: true });
		if (!context) throw new Error("Unable to rasterize the tray cover.");
		context.drawImage(
			displayCanvas,
			0,
			0,
			TRAY_DISPLAY_COVER_SIZE,
			TRAY_DISPLAY_COVER_SIZE,
			0,
			0,
			TRAY_COVER_SIZE,
			TRAY_COVER_SIZE,
		);
		return {
			cover: {
				rgba: Array.from(
					context.getImageData(0, 0, TRAY_COVER_SIZE, TRAY_COVER_SIZE).data,
				),
				width: TRAY_COVER_SIZE,
				height: TRAY_COVER_SIZE,
			},
			displayCover: displayCanvas.toDataURL("image/webp", 0.9),
		};
	} finally {
		bitmap.close();
	}
}

export const TrayBridge: FC = () => {
	const { t } = useTranslation();
	const isWindows = platform() === "windows";
	const windowCloseBehavior = useAtomValue(windowCloseBehaviorAtom);
	const alwaysTray = windowCloseBehavior === WINDOW_CLOSE_BEHAVIOR_ALWAYS_TRAY;
	const musicId = useAtomValue(musicIdAtom);
	const musicName = useAtomValue(musicNameAtom);
	const musicArtists = useAtomValue(musicArtistsAtom);
	const musicLyricLines = useAtomValue(musicLyricLinesAtom);
	const musicPlaying = useAtomValue(musicPlayingAtom);
	const musicPlayingPosition = useAtomValue(musicPlayingPositionAtom);
	const musicCover = useAtomValue(musicCoverAtom);
	const musicCoverIsVideo = useAtomValue(musicCoverIsVideoAtom);
	const onRequestPrevSong = useAtomValue(onRequestPrevSongAtom).onEmit;
	const onPlayOrResume = useAtomValue(onPlayOrResumeAtom).onEmit;
	const onRequestNextSong = useAtomValue(onRequestNextSongAtom).onEmit;
	const [taskbarLyricEnabled, setTaskbarLyricEnabled] = useAtom(
		enableTaskbarLyricAtom,
	);
	const [cover, setCover] = useState<RasterizedTrayCover | null>(null);
	const coverMediaKey = musicId
		? `${musicId}\u0000${musicCover}\u0000${musicCoverIsVideo ? "video" : "image"}`
		: "";
	const activeCover = cover?.mediaKey === coverMediaKey ? cover : null;
	const trayLyric = useMemo(
		() => getReachedTrayLyric(musicLyricLines, musicPlayingPosition),
		[musicLyricLines, musicPlayingPosition],
	);

	useEffect(() => {
		let cancelled = false;
		setCover(null);
		if (!isWindows || !musicId || !musicCover || musicCover === EMPTY_COVER)
			return;

		const mediaKey = coverMediaKey;
		void rasterizeTrayCover(musicCover, musicCoverIsVideo)
			.then((nextCover) => {
				if (!cancelled) setCover({ ...nextCover, mediaKey });
			})
			.catch((error) => {
				if (!cancelled) {
					console.warn("生成托盘歌曲封面失败，将使用应用图标", error);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [coverMediaKey, isWindows, musicCover, musicCoverIsVideo, musicId]);

	useEffect(() => {
		if (!isWindows) return;
		const artist = musicArtists
			.map((item) => item.name.trim())
			.filter(Boolean)
			.join(", ");
		void invoke(CMD_UPDATE_BACKGROUND_TRAY_MENU, {
			state: {
				alwaysTray,
				musicName,
				artist,
				lyric: trayLyric,
				playing: musicPlaying,
				canControl: Boolean(musicId),
				taskbarLyricEnabled,
				cover: activeCover?.cover ?? null,
				displayCover: activeCover?.displayCover ?? "",
				labels: {
					appName: "AMLL Player",
					unknownSong: t("playbar.playlist.unknownSong", "未知歌曲"),
					unknownArtist: t("playbar.playlist.unknownArtist", "未知艺术家"),
					noLyrics: t("amll.tray.noLyrics", "暂无歌词"),
					previous: t("amll.contextMenu.rewindSong", "上一首"),
					play: t("amll.contextMenu.play", "播放"),
					pause: t("amll.tray.pause", "暂停"),
					next: t("amll.contextMenu.forwardSong", "下一首"),
					taskbarLyric: t("amll.tray.taskbarLyric", "任务栏歌词"),
					showWindow: t("amll.tray.showWindow", "显示窗口"),
					exit: t("amll.tray.exit", "退出"),
				},
			},
		}).catch((error) => {
			console.error("同步系统托盘菜单失败", error);
		});
	}, [
		activeCover,
		alwaysTray,
		isWindows,
		musicArtists,
		musicId,
		musicName,
		musicPlaying,
		t,
		taskbarLyricEnabled,
		trayLyric,
	]);

	useEffect(() => {
		if (!isWindows) return;
		const unlistenPromise = listen<BackgroundTrayCommandPayload>(
			BACKGROUND_TRAY_COMMAND_EVENT,
			(event) => {
				switch (event.payload.command) {
					case "previous":
						onRequestPrevSong?.();
						break;
					case "toggle-playback":
						onPlayOrResume?.();
						break;
					case "next":
						onRequestNextSong?.();
						break;
					case "toggle-taskbar-lyric":
						setTaskbarLyricEnabled((enabled) => !enabled);
						break;
				}
			},
		);
		return () => {
			void unlistenPromise.then((unlisten) => unlisten());
		};
	}, [
		isWindows,
		onPlayOrResume,
		onRequestNextSong,
		onRequestPrevSong,
		setTaskbarLyricEnabled,
	]);

	return null;
};
