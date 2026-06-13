import { PlayIcon } from "@radix-ui/react-icons";
import { Avatar, Box, Flex, type FlexProps, Inset } from "@radix-ui/themes";
import { useVirtualizer } from "@tanstack/react-virtual";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useAtomValue } from "jotai";
import { type FC, type HTMLProps, useEffect, useRef } from "react";
import { Trans } from "react-i18next";
import { queueManagerAtom } from "../../states/appAtoms.ts";
import type { Song } from "../../utils/db-client.ts";
import {
	queueCurrentIndexAtom,
	queuePlaylistAtom,
} from "../../utils/play-queue-manager.ts";
import styles from "./index.module.css";

const PlaylistSongItem: FC<
	{
		song: Song;
		index: number;
	} & HTMLProps<HTMLDivElement>
> = ({ song, className, index, ...props }) => {
	const playlistIndex = useAtomValue(queueCurrentIndexAtom);
	const queueManager = useAtomValue(queueManagerAtom);

	const cover = song.coverPath ? convertFileSrc(song.coverPath) : "";
	const name = song.songName || "未知歌曲";
	const artists = song.songArtists || "未知艺术家";

	return (
		<div className={className} {...props}>
			<button
				type="button"
				className={styles.playlistSongItem}
				onDoubleClick={() => {
					queueManager?.playAt(index);
				}}
				aria-label={`播放 ${name} - ${artists}`}
			>
				<Avatar size="4" fallback={<div />} src={cover} />
				<div className={styles.musicInfo}>
					<div className={styles.name}>{name}</div>
					<div className={styles.artists}>{artists}</div>
				</div>
				{playlistIndex === index && <PlayIcon />}
			</button>
		</div>
	);
};

export const NowPlaylistCard: FC<FlexProps> = (props) => {
	const playlist = useAtomValue(queuePlaylistAtom);
	const playlistIndex = useAtomValue(queueCurrentIndexAtom);
	const playlistContainerRef = useRef<HTMLDivElement>(null);

	const rowVirtualizer = useVirtualizer({
		count: playlist.length,
		getScrollElement: () => playlistContainerRef.current,
		estimateSize: () => 55,
		overscan: 5,
	});

	useEffect(() => {
		if (
			rowVirtualizer &&
			playlistIndex >= 0 &&
			playlistIndex < playlist.length
		) {
			rowVirtualizer.scrollToIndex(playlistIndex, { align: "center" });
		}
	}, [playlistIndex, rowVirtualizer, playlist.length]);

	return (
		<Flex
			direction="column"
			maxWidth="400px"
			maxHeight="500px"
			style={{
				height: "50vh",
				width: "max(10vw, 50vh)",
				backdropFilter: "blur(1em)",
				backgroundColor: "var(--black-a8)",
			}}
			{...props}
		>
			<Box py="3" px="4">
				<Trans i18nKey="playbar.playlist.title">当前播放列表</Trans>
			</Box>
			<Inset
				clip="padding-box"
				side="bottom"
				pb="current"
				style={{ overflowY: "auto" }}
				ref={playlistContainerRef}
			>
				<div
					style={{
						height: `${rowVirtualizer.getTotalSize()}px`,
						width: "100%",
						position: "relative",
					}}
				>
					{rowVirtualizer.getVirtualItems().map((virtualItem) => {
						const song = playlist[virtualItem.index];
						if (!song) return null;
						return (
							<PlaylistSongItem
								key={virtualItem.key}
								style={{
									position: "absolute",
									top: 0,
									left: 0,
									width: "100%",
									height: `${virtualItem.size}px`,
									transform: `translateY(${virtualItem.start}px)`,
								}}
								song={song}
								index={virtualItem.index}
							/>
						);
					})}
				</div>
			</Inset>
		</Flex>
	);
};
