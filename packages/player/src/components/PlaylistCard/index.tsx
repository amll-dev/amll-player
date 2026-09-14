import { Card, ContextMenu, Flex, Text } from "@radix-ui/themes";
import { useAtomValue } from "jotai";
import { forwardRef, type PropsWithChildren, useMemo } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { queueManagerAtom } from "../../states/appAtoms.ts";
import { db, type Playlist } from "../../utils/db-client.ts";
import { MusicDropVisual } from "../MusicDropVisual/index.tsx";
import { PlaylistCover } from "../PlaylistCover/index.tsx";

export const PlaylistCard = forwardRef<
	HTMLDivElement,
	PropsWithChildren<{
		playlist: Playlist;
	}>
>(({ playlist, children }, ref) => {
	const { t } = useTranslation();
	const queueManager = useAtomValue(queueManagerAtom);
	const songAmount = playlist.songIds.length;
	const createTime = useMemo(() => {
		const today = new Date();
		const createTime = new Date(playlist.createTime);
		if (today.toDateString() === createTime.toDateString())
			return createTime.toLocaleTimeString();

		return createTime.toLocaleDateString();
	}, [playlist.createTime]);

	const playPlaylist = async (shuffle: boolean) => {
		if (!queueManager) return;
		const songs = await db.playlists.getSongs(playlist.id);
		if (songs.length === 0) return;
		if (shuffle) {
			queueManager.toggleShuffleOn();
		} else {
			queueManager.toggleShuffleOff();
		}
		queueManager.setQueue(songs, playlist.id);
	};

	return (
		<ContextMenu.Root>
			<ContextMenu.Trigger>
				<Card asChild size="2" mb="4" key={playlist.id} ref={ref}>
					<Link
						to={`/playlist/${playlist.id}`}
						data-music-drop-playlist-id={playlist.id}
					>
						<MusicDropVisual
							variant="playlist"
							title={t("musicDrop.addToPlaylistHint", "添加到“{name}”", {
								name: playlist.name,
							})}
							detail={t(
								"musicDrop.playlistFilesAndFoldersHint",
								"支持音乐文件和文件夹",
							)}
						/>
						<Flex align="center" gap="4">
							<PlaylistCover playlistId={playlist.id} />
							<Flex direction="column" gap="1" flexGrow="1">
								<Text>{playlist.name}</Text>
								<Text color="gray" size="2">
									<Flex gap="2">
										{t(
											"page.main.playlistCard.songCount",
											"{songAmount} 首歌曲",
											{
												songAmount,
											},
										)}
										<div>-</div>
										{t(
											"page.main.playlistCard.createTime",
											"创建于 {createTime}",
											{
												createTime,
											},
										)}
									</Flex>
								</Text>
							</Flex>
							{children}
						</Flex>
					</Link>
				</Card>
			</ContextMenu.Trigger>
			<ContextMenu.Content>
				<ContextMenu.Item
					disabled={!queueManager || songAmount === 0}
					onSelect={() => {
						void playPlaylist(false);
					}}
				>
					<Trans i18nKey="page.main.playlistMenu.play">播放此列表</Trans>
				</ContextMenu.Item>
				<ContextMenu.Item
					disabled={!queueManager || songAmount === 0}
					onSelect={() => {
						void playPlaylist(true);
					}}
				>
					<Trans i18nKey="page.main.playlistMenu.playShuffled">
						以乱序播放此列表
					</Trans>
				</ContextMenu.Item>
				<ContextMenu.Separator />
				<ContextMenu.Item
					color="red"
					onSelect={async () => {
						await db.playlists.delete(playlist.id);
					}}
				>
					<Trans i18nKey="page.main.playlistMenu.delete">删除</Trans>
				</ContextMenu.Item>
			</ContextMenu.Content>
		</ContextMenu.Root>
	);
});
