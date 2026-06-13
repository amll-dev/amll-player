import { convertFileSrc } from "@tauri-apps/api/core";
import { LRUCache } from "lru-cache";
import { useLayoutEffect, useState } from "react";
import type { Song } from "./db-client.ts";
import { getVideoThumbnail } from "./video-thumbnail.ts";

const thumbnailCache = new LRUCache<string, string>({
	max: 50,
	dispose: (url) => {
		URL.revokeObjectURL(url);
	},
});

export const useSongCover = (song?: Song) => {
	const [songImgUrl, setSongImgUrl] = useState<string>("");

	useLayoutEffect(() => {
		if (!song?.coverPath) {
			setSongImgUrl("");
			return;
		}

		// 目前的设计中，后端 SeaORM 歌曲封面的路径有 4 个来源:
		// 1. read_local_music_metadata 始终使用 jpg 作为后缀
		// 2. 用户手动上传的封面则用 infer crate 自动判断封面或视频并使用 mp4 或 jpg 作为后缀，
		//    包括歌曲封面和歌单封面
		// 3. 从 dexie 迁移导入时，使用前端的 mime type
		// 所以可以确保封面路径总是 jpg 或 mp4 文件，方便判断封面是图片或者视频
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
				setSongImgUrl(url);
			})
			.catch((err) => {
				console.warn("提取视频略缩图失败:", err);
				setSongImgUrl("");
			});
	}, [song]);

	return songImgUrl;
};
