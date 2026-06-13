import { convertFileSrc } from "@tauri-apps/api/core";
import classNames from "classnames";
import { type FC, type HTMLProps, useEffect, useState } from "react";
import { db } from "../../utils/db-client.ts";
import { useDbQuery } from "../../utils/use-db-query.ts";
import styles from "./index.module.css";

export const PlaylistCover: FC<
	{
		playlistId: number;
	} & HTMLProps<HTMLDivElement>
> = ({ playlistId, className, ...props }) => {
	const [playlistImgs, setPlaylistImgs] = useState([] as string[]);

	const { data: playlist } = useDbQuery(
		() => db.playlists.get(playlistId),
		[playlistId],
		undefined,
		["playlists"],
	);

	const { data: songs } = useDbQuery(
		async () => {
			if (playlist && !playlist.songIds?.length) return [];
			if (!playlist) return [];
			const allSongs = await db.songs.getByIds(playlist.songIds);
			return allSongs.filter(
				(s) => s.coverPath && !s.coverPath.endsWith(".mp4"),
			);
		},
		[playlist],
		[],
		["songs"],
	);

	useEffect(() => {
		if (playlist?.coverPath) {
			setPlaylistImgs([convertFileSrc(playlist.coverPath)]);
			return;
		}
		if (songs && songs.length > 0) {
			const imgs = songs
				.slice(0, 4)
				// biome-ignore lint/style/noNonNullAssertion: filter() 检查了 coverPath 的存在
				.map((s) => convertFileSrc(s.coverPath!));
			setPlaylistImgs(imgs);
		} else {
			setPlaylistImgs([]);
		}
	}, [songs, playlist]);

	return (
		<div
			className={classNames(styles.playlistCover, "img-border", className)}
			{...props}
		>
			{playlistImgs.map((img) => (
				<div
					key={img}
					style={{
						backgroundImage: `url(${img})`,
					}}
				/>
			))}
		</div>
	);
};
