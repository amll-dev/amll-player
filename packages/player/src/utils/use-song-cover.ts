import { convertFileSrc } from "@tauri-apps/api/core";
import { useLayoutEffect, useRef, useState } from "react";
import type { Song } from "./db-client.ts";
import { getVideoThumbnail } from "./video-thumbnail.ts";

const thumbnailCache = new Map<string, string>();

export const useSongCover = (song?: Song) => {
	const [songImgUrl, setSongImgUrl] = useState<string>("");
	const revokeRef = useRef<string | null>(null);

	useLayoutEffect(() => {
		if (revokeRef.current) {
			URL.revokeObjectURL(revokeRef.current);
			revokeRef.current = null;
		}

		if (!song?.coverPath) {
			setSongImgUrl("");
			return;
		}

		if (!song.coverPath.endsWith(".mp4")) {
			setSongImgUrl(convertFileSrc(song.coverPath));
			return;
		}

		const cached = thumbnailCache.get(song.coverPath);
		if (cached) {
			setSongImgUrl(cached);
			return;
		}

		setSongImgUrl("");
		const coverPath = song.coverPath;
		const videoSrc = convertFileSrc(coverPath);
		getVideoThumbnail(videoSrc)
			.then((blob) => {
				const url = URL.createObjectURL(blob);
				thumbnailCache.set(coverPath, url);
				revokeRef.current = null;
				setSongImgUrl(url);
			})
			.catch((err) => {
				console.warn("提取视频略缩图失败:", err);
				setSongImgUrl("");
			});
	}, [song]);

	return songImgUrl;
};
