import {
	ArrowLeftIcon,
	GearIcon,
	OpenInNewWindowIcon,
	Pencil1Icon,
	PlayIcon,
	PlusIcon,
	ReloadIcon,
	TrashIcon,
} from "@radix-ui/react-icons";
import {
	Box,
	Button,
	ContextMenu,
	Dialog,
	Flex,
	Grid,
	Heading,
	IconButton,
	ScrollArea,
	Separator,
	Text,
	TextField,
	Tooltip,
} from "@radix-ui/themes";
import { path } from "@tauri-apps/api";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { platform } from "@tauri-apps/plugin-os";
import { motion, useMotionTemplate, useScroll } from "framer-motion";
import { useAtomValue, useStore } from "jotai";
import md5 from "md5";
import {
	type FC,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Trans, useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { toast } from "react-toastify";
import { ViewportList } from "react-viewport-list";
import { PageContainer } from "../../components/PageContainer/index.tsx";
import { PlaylistCover } from "../../components/PlaylistCover/index.tsx";
import { PlaylistSongCard } from "../../components/PlaylistSongCard/index.tsx";
import { queueManagerAtom } from "../../states/appAtoms.ts";
import { db, type Song } from "../../utils/db-client.ts";
import { queuePlaylistIdAtom } from "../../utils/play-queue-manager.ts";
import {
	readLocalMusicMetadata,
	resolveContentUri,
} from "../../utils/player.ts";
import { useDbQuery } from "../../utils/use-db-query.ts";
import styles from "./index.module.css";

export type Loadable<Value> =
	| {
			state: "loading";
	  }
	| {
			state: "hasError";
			error: unknown;
	  }
	| {
			state: "hasData";
			data: Awaited<Value>;
	  };

const EditablePlaylistName: FC<{
	playlistName: string;
	onPlaylistNameChange: (newName: string) => void;
}> = ({ playlistName, onPlaylistNameChange }) => {
	const [editing, setEditing] = useState(false);
	const [newName, setNewName] = useState(playlistName);

	return (
		<Heading className={styles.title}>
			{!editing && playlistName}
			{!editing && (
				<IconButton
					ml="2"
					style={{
						verticalAlign: "middle",
					}}
					size="1"
					variant="ghost"
					onClick={() => {
						setNewName(playlistName);
						setEditing(true);
					}}
				>
					<Pencil1Icon />
				</IconButton>
			)}
			{editing && (
				<TextField.Root
					value={newName}
					autoFocus
					onChange={(e) => setNewName(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							if (newName !== playlistName) onPlaylistNameChange(newName);
							setEditing(false);
						}
					}}
					onBlur={() => {
						if (newName !== playlistName) onPlaylistNameChange(newName);
						setEditing(false);
					}}
				/>
			)}
		</Heading>
	);
};

const getFolderName = (folderPath: string) => {
	const normalized = folderPath.replace(/\\+$/g, "").replace(/\/+$/g, "");
	return normalized.split(/[\\/]/).pop() || folderPath;
};

const formatDateTime = (value?: number) => {
	if (!value) return "-";
	return new Date(value).toLocaleString();
};

export const Component: FC = () => {
	const param = useParams();
	const { data: playlist } = useDbQuery(
		() => db.playlists.get(Number(param.id)),
		[param.id],
		undefined,
		["playlists", "playlist_songs", "songs"],
	);
	const { t } = useTranslation();
	const playlistViewRef = useRef<HTMLDivElement>(null);
	const playlistViewScroll = useScroll({
		container: playlistViewRef,
	});
	const playlistCoverSize = useMotionTemplate`clamp(6em,calc(12em - ${playlistViewScroll.scrollY}px),12em)`;
	const playlistInfoGapSize = useMotionTemplate`clamp(var(--space-1), calc(var(--space-4) - ${playlistViewScroll.scrollY}px / 5), var(--space-4))`;
	const [failedImports, setFailedImports] = useState<
		{ path: string; error: string }[]
	>([]);
	const [playlistSettingsOpen, setPlaylistSettingsOpen] = useState(false);
	const [settingsPlaylistName, setSettingsPlaylistName] = useState("");
	const [folderToRemove, setFolderToRemove] = useState<string | null>(null);

	const store = useStore();
	const queueManager = useAtomValue(queueManagerAtom);

	const { data: folders } = useDbQuery(
		() => db.playlists.getFolders(Number(param.id)),
		[param.id],
		undefined,
		["playlist_folders", "playlist_song_sources"],
	);
	const isFolderPlaylist = (folders?.length ?? 0) > 0;

	useEffect(() => {
		setSettingsPlaylistName(playlist?.name || "");
	}, [playlist?.name]);

	const saveSettingsPlaylistName = useCallback(async () => {
		if (!playlist) return;
		const name = settingsPlaylistName.trim();
		if (!name || name === playlist.name) {
			setSettingsPlaylistName(playlist.name);
			return;
		}
		await db.playlists.update(Number(param.id), { name });
	}, [param.id, playlist, settingsPlaylistName]);

	const onUploadPlaylistCover = useCallback(async () => {
		const selected = await open({
			multiple: false,
			filters: [
				{
					name: t("page.playlist.cover.mediaFiles", "媒体文件"),
					extensions: ["jpg", "jpeg", "png", "gif", "webp", "mp4"],
				},
			],
		});
		if (selected) {
			await db.playlists.saveCover(Number(param.id), selected);
		}
	}, [param.id, t]);

	const onClearPlaylistCover = useCallback(async () => {
		await db.playlists.clearCover(Number(param.id));
	}, [param.id]);

	const onOpenFolder = useCallback(
		async (folderPath: string) => {
			try {
				await revealItemInDir(folderPath);
			} catch (err) {
				toast.error(
					t(
						"page.playlist.settings.openFolderFailed",
						"打开文件夹失败: {error}",
						{
							error: String(err),
						},
					),
				);
			}
		},
		[t],
	);

	const onAddFolder = useCallback(async () => {
		const selected = await open({
			directory: true,
			multiple: false,
			title: t("page.playlist.settings.selectFolder", "选择要关联的文件夹"),
		});
		if (!selected) return;

		const toastId = toast.loading(
			t("page.playlist.settings.scanningFolder", "正在扫描文件夹…"),
		);

		let scannedCount = 0;
		const unlisten = await listen<number>("scan-folder-progress", (event) => {
			scannedCount = event.payload;
			toast.update(toastId, {
				render: t(
					"page.playlist.settings.scanningProgress",
					"正在扫描… 已找到 {count} 首歌曲",
					{ count: scannedCount },
				),
			});
		});

		try {
			const result = await db.playlists.linkFolder(Number(param.id), selected);
			toast.update(toastId, {
				render: t(
					"page.playlist.settings.linkFolderSuccess",
					"关联成功：导入 {imported} 首歌曲，失败 {failed} 首",
					{ imported: result.imported, failed: result.failed },
				),
				type: result.failed > 0 ? "warning" : "success",
				isLoading: false,
				autoClose: 5000,
			});
		} catch (err) {
			toast.update(toastId, {
				render: t(
					"page.playlist.settings.linkFolderFailed",
					"关联失败: {error}",
					{
						error: String(err),
					},
				),
				type: "error",
				isLoading: false,
				autoClose: 5000,
			});
		} finally {
			unlisten();
		}
	}, [param.id, t]);

	const onConfirmRemoveFolder = useCallback(async () => {
		if (!folderToRemove) return;
		try {
			await db.playlists.unlinkFolder(Number(param.id), folderToRemove);
			toast.success(
				t("page.playlist.settings.unlinkFolderSuccess", "已移除关联文件夹"),
			);
		} catch (err) {
			toast.error(
				t("page.playlist.settings.unlinkFolderFailed", "移除失败: {error}", {
					error: String(err),
				}),
			);
		} finally {
			setFolderToRemove(null);
		}
	}, [param.id, folderToRemove, t]);

	const onRefreshPlaylist = useCallback(async () => {
		const toastId = toast.loading(
			t("page.playlist.refresh.loading", "正在刷新歌单…"),
		);

		let scannedCount = 0;
		const unlisten = await listen<number>("scan-folder-progress", (event) => {
			scannedCount = event.payload;
			toast.update(toastId, {
				render: t(
					"page.playlist.refresh.scanning",
					"正在扫描… {count} 个文件",
					{ count: scannedCount },
				),
			});
		});

		try {
			const result = await db.playlists.refresh(Number(param.id));
			toast.update(toastId, {
				render: t(
					"page.playlist.refresh.success",
					"刷新完成：新增 {added}，更新 {updated}，移除 {removed}",
					{
						added: result.added,
						updated: result.updated,
						removed: result.removed,
					},
				),
				type: result.failed > 0 ? "warning" : "success",
				isLoading: false,
				autoClose: 5000,
			});
		} catch (err) {
			toast.update(toastId, {
				render: t("page.playlist.refresh.failed", "刷新失败: {error}", {
					error: String(err),
				}),
				type: "error",
				isLoading: false,
				autoClose: 5000,
			});
		} finally {
			unlisten();
		}
	}, [param.id, t]);

	const onAddLocalMusics = useCallback(async () => {
		let filters = [
			{
				name: t("page.playlist.addLocalMusic.filterName", "音频文件"),
				extensions: ["mp3", "flac", "wav", "m4a", "aac", "ogg"],
			},
			{
				name: t("page.playlist.addLocalMusic.allFiles", "所有文件"),
				extensions: ["*"],
			},
		];
		if (platform() === "android") {
			filters = [
				{
					name: t("page.playlist.addLocalMusic.filterName", "音频文件"),
					extensions: ["audio/*"],
				},
				{
					name: t("page.playlist.addLocalMusic.allFiles", "所有文件"),
					extensions: ["*/*"],
				},
			];
		}
		if (platform() === "ios") {
			filters.length = 0;
		}
		const results = await open({
			multiple: true,
			title: "选择本地音乐",
			filters,
		});
		if (!results) return;
		console.log(results);
		const id = toast.loading(
			t(
				"page.playlist.addLocalMusic.toast.parsingMusicMetadata",
				"正在解析音乐元数据以添加歌曲 ({current, plural, other {#}} / {total, plural, other {#}})",
				{
					current: 0,
					total: results.length,
				},
			),
		);
		let current = 0;
		let success = 0;
		const currentFailedList: { path: string; error: string }[] = [];
		const transformed = (
			await Promise.all(
				results.map(async (v) => {
					let normalized = v;
					console.log(v);
					if (platform() === "android" || platform() === "ios") {
						normalized = await resolveContentUri(v);
					} else {
						normalized = (await path.normalize(v)).replace(/\\/gi, "/");
					}
					try {
						const pathMd5 = md5(normalized);
						const musicInfo = await readLocalMusicMetadata(normalized);

						success += 1;
						return {
							id: pathMd5,
							filePath: normalized,
							songName: musicInfo.name,
							songArtists: musicInfo.artist,
							songAlbum: musicInfo.album,
							lyricFormat: musicInfo.lyricFormat || "none",
							lyric: musicInfo.lyric,
							duration: musicInfo.duration,
							coverPath: musicInfo.coverPath || null,
						} satisfies Song;
					} catch (err) {
						console.warn("解析歌曲元数据以添加歌曲失败", normalized, err);
						currentFailedList.push({
							path: normalized,
							error: err instanceof Error ? err.message : String(err),
						});
						return null;
					} finally {
						current += 1;
						toast.update(id, {
							render: t(
								"page.playlist.addLocalMusic.toast.parsingMusicMetadata",
								"正在解析音乐元数据以添加歌曲 ({current, plural, other {#}} / {total, plural, other {#}})",
								{
									current,
									total: results.length,
								},
							),
							progress: current / results.length,
						});
					}
				}),
			)
		).filter((v) => !!v);
		await db.songs.upsert(transformed);
		const shouldAddIds = transformed
			.map((v) => v.id)
			.filter((v) => !playlist?.songIds.includes(v));
		await db.playlists.addSongs(Number(param.id), shouldAddIds);

		if (shouldAddIds.length > 0 && queueManager) {
			const queuePlaylistId = store.get(queuePlaylistIdAtom);
			if (queuePlaylistId === Number(param.id)) {
				const newSongs = transformed.filter((v) => shouldAddIds.includes(v.id));
				for (const song of newSongs) {
					queueManager.addToQueue(song);
				}
			}
		}
		toast.done(id);
		if (currentFailedList.length > 0) {
			setFailedImports(currentFailedList);

			if (success > 0) {
				toast.warn(
					t(
						"page.playlist.addLocalMusic.toast.partiallyFailed",
						"已添加 {succeed, plural, other {#}} 首歌曲，其中 {errored, plural, other {#}} 首歌曲添加失败",
						{
							succeed: success,
							errored: currentFailedList.length,
						},
					),
				);
			} else {
				toast.error(
					t(
						"page.playlist.addLocalMusic.toast.allFailed",
						"{errored, plural, other {#}} 首歌曲添加失败",
						{
							errored: currentFailedList.length,
						},
					),
				);
			}
		} else if (success > 0) {
			toast.success(
				t(
					"page.playlist.addLocalMusic.toast.success",
					"已全部添加 {count, plural, other {#}} 首歌曲",
					{
						count: success,
					},
				),
			);
		}
	}, [playlist, param.id, t, queueManager]);

	const onPlayList = useCallback(
		async (songIndex = 0, shuffle = false) => {
			if (playlist === undefined || !queueManager) return;
			const collected = await db.playlists.getSongs(Number(param.id));
			if (shuffle) {
				queueManager.toggleShuffleOn();
			} else {
				queueManager.toggleShuffleOff();
			}
			queueManager.setQueue(collected, Number(param.id));

			if (songIndex > 0 && songIndex < collected.length) {
				queueManager.playAt(songIndex);
			}
		},
		[playlist, param.id, queueManager],
	);

	const onDeleteSong = useCallback(
		async (songId: string) => {
			if (playlist === undefined) return;
			await db.playlists.removeSong(Number(param.id), songId);

			if (queueManager?.getPlaylistId() === Number(param.id)) {
				queueManager.removeSong(songId);
			}
		},
		[playlist, param.id, queueManager],
	);

	const onPlaylistDefault = useCallback(onPlayList.bind(null, 0), [onPlayList]);
	const onPlaylistShuffle = useMemo(
		() => onPlayList.bind(null, 0, true),
		[onPlayList],
	);

	return (
		<PageContainer>
			<Flex direction="column" height="100%">
				<Flex gap="4" direction="column" flexGrow="0" pb="4" mt="5">
					<Flex align="end" pt="4">
						<Button variant="soft" onClick={() => history.back()}>
							<ArrowLeftIcon />
							<Trans i18nKey="common.page.back">返回</Trans>
						</Button>
					</Flex>
					<Flex align="end" gap="3">
						<motion.div
							style={{
								width: playlistCoverSize,
							}}
						>
							<ContextMenu.Root>
								<ContextMenu.Trigger>
									<PlaylistCover
										playlistId={Number(param.id)}
										style={{
											width: "100%",
										}}
									/>
								</ContextMenu.Trigger>
								<ContextMenu.Content>
									<ContextMenu.Item
										onClick={async () => {
											await db.playlists.clearCover(Number(param.id));
										}}
									>
										<Trans i18nKey="page.playlist.cover.changeCoverToAuto">
											更换成自动封面
										</Trans>
									</ContextMenu.Item>
									<ContextMenu.Item
										onClick={async () => {
											const selected = await open({
												multiple: false,
												filters: [
													{
														name: t(
															"page.playlist.cover.mediaFiles",
															"媒体文件",
														),
														extensions: [
															"jpg",
															"jpeg",
															"png",
															"gif",
															"webp",
															"mp4",
														],
													},
												],
											});
											if (selected) {
												await db.playlists.saveCover(
													Number(param.id),
													selected,
												);
											}
										}}
									>
										<Trans i18nKey="page.playlist.cover.uploadCoverImage">
											上传封面图片
										</Trans>
									</ContextMenu.Item>
								</ContextMenu.Content>
							</ContextMenu.Root>
						</motion.div>
						<Flex
							direction="column"
							flexGrow="1"
							display={{
								initial: "none",
								sm: "flex",
							}}
							gap={playlistInfoGapSize.get()}
							asChild
						>
							<motion.div
								style={{
									gap: playlistInfoGapSize,
								}}
							>
								<EditablePlaylistName
									playlistName={playlist?.name || ""}
									onPlaylistNameChange={(newName) =>
										db.playlists.update(Number(param.id), { name: newName })
									}
								/>
								<Text>
									{t(
										"page.playlist.totalMusicLabel",
										"{count, plural, other {#}} 首歌曲",
										{
											count: playlist?.songIds?.length || 0,
										},
									)}
								</Text>
								<Flex gap="2" align="center" justify="between" width="100%">
									<Flex gap="2">
										<Button onClick={() => onPlaylistDefault()}>
											<PlayIcon />
											<Trans i18nKey="page.playlist.playAll">播放全部</Trans>
										</Button>
										<Button variant="soft" onClick={onPlaylistShuffle}>
											<Trans i18nKey="page.playlist.shufflePlayAll">
												随机播放
											</Trans>
										</Button>
										<Button variant="soft" onClick={onAddLocalMusics}>
											<PlusIcon />
											<Trans i18nKey="page.playlist.addLocalMusic.label">
												添加本地歌曲
											</Trans>
										</Button>{" "}
										{isFolderPlaylist && (
											<Button variant="soft" onClick={onRefreshPlaylist}>
												<ReloadIcon />
												{t("page.playlist.refresh.label", "刷新")}
											</Button>
										)}
									</Flex>
									<Tooltip content={t("page.playlist.settings.label", "设置")}>
										<IconButton
											variant="soft"
											mr="5"
											onClick={() => setPlaylistSettingsOpen(true)}
											aria-label={t("page.playlist.settings.label", "设置")}
										>
											<GearIcon />
										</IconButton>
									</Tooltip>
								</Flex>
							</motion.div>
						</Flex>
						<Flex
							direction="column"
							flexGrow="1"
							display={{
								xs: "flex",
								sm: "none",
							}}
							asChild
						>
							<motion.div
								style={{
									gap: playlistInfoGapSize,
								}}
							>
								<EditablePlaylistName
									playlistName={playlist?.name || ""}
									onPlaylistNameChange={(newName) =>
										db.playlists.update(Number(param.id), { name: newName })
									}
								/>
								<Text>
									{t(
										"page.playlist.totalMusicLabel",
										"{count, plural, other {#}} 首歌曲",
										{
											count: playlist?.songIds?.length || 0,
										},
									)}
								</Text>
								<Flex gap="2" align="center" justify="between" width="100%">
									<Flex gap="2">
										<IconButton onClick={() => onPlaylistDefault()}>
											<PlayIcon />
										</IconButton>
										<IconButton variant="soft" onClick={onAddLocalMusics}>
											<PlusIcon />
										</IconButton>{" "}
										{isFolderPlaylist && (
											<IconButton variant="soft" onClick={onRefreshPlaylist}>
												<ReloadIcon />
											</IconButton>
										)}
									</Flex>
									<Tooltip content={t("page.playlist.settings.label", "设置")}>
										<IconButton
											variant="soft"
											mr="5"
											onClick={() => setPlaylistSettingsOpen(true)}
											aria-label={t("page.playlist.settings.label", "设置")}
										>
											<GearIcon />
										</IconButton>
									</Tooltip>
								</Flex>
							</motion.div>
						</Flex>
					</Flex>
				</Flex>
				<Box
					flexGrow="1"
					overflowY="auto"
					minHeight="0"
					pb="4"
					ref={playlistViewRef}
				>
					{playlist?.songIds && (
						<ViewportList
							items={playlist.songIds}
							viewportRef={playlistViewRef}
						>
							{(songId, index) => (
								<PlaylistSongCard
									key={`playlist-song-card-${songId}`}
									songId={songId}
									songIndex={index}
									onPlayList={onPlayList}
									onDeleteSong={onDeleteSong}
								/>
							)}
						</ViewportList>
					)}
				</Box>
			</Flex>

			<Dialog.Root
				open={failedImports.length > 0}
				onOpenChange={(open) => {
					if (!open) setFailedImports([]);
				}}
			>
				<Dialog.Content style={{ maxWidth: 600 }}>
					<Dialog.Title>
						{t(
							"page.playlist.addLocalMusic.dialog.failedTitle",
							"部分歌曲导入失败",
						)}
					</Dialog.Title>
					<Dialog.Description size="2" mb="4" color="gray">
						{t(
							"page.playlist.addLocalMusic.dialog.failedDescription",
							"以下 {count, plural, other {#}} 首歌曲添加失败：",
							{
								count: failedImports.length,
							},
						)}
					</Dialog.Description>

					<ScrollArea
						type="always"
						scrollbars="vertical"
						style={{ maxHeight: 300 }}
					>
						<Flex direction="column" gap="3" pr="3">
							{failedImports.map((item, index) => (
								<Box
									key={index}
									p="3"
									style={{
										backgroundColor: "var(--gray-a2)",
										borderRadius: "var(--radius-3)",
									}}
								>
									<Text
										as="div"
										size="2"
										weight="bold"
										style={{ wordBreak: "break-all" }}
									>
										{item.path}
									</Text>
									<Text
										as="div"
										size="1"
										color="red"
										mt="1"
										style={{ wordBreak: "break-all" }}
									>
										{item.error}
									</Text>
								</Box>
							))}
						</Flex>
					</ScrollArea>

					<Flex gap="3" mt="4" justify="end">
						<Dialog.Close>
							<Button variant="soft" color="gray">
								<Trans i18nKey="common.dialog.close">关闭</Trans>
							</Button>
						</Dialog.Close>
					</Flex>
				</Dialog.Content>
			</Dialog.Root>

			<Dialog.Root
				open={playlistSettingsOpen}
				onOpenChange={setPlaylistSettingsOpen}
			>
				<Dialog.Content style={{ maxWidth: 560 }}>
					<Dialog.Title>
						{t("page.playlist.settings.title", "歌单设置")}
					</Dialog.Title>

					<Flex direction="column" gap="4">
						<Flex direction="column" gap="2">
							<Text weight="bold">
								{t("page.playlist.settings.name", "歌单名称")}
							</Text>
							<TextField.Root
								value={settingsPlaylistName}
								onChange={(e) => setSettingsPlaylistName(e.currentTarget.value)}
								onBlur={saveSettingsPlaylistName}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.currentTarget.blur();
									}
								}}
							/>
						</Flex>

						<Separator size="4" />

						<Flex direction="column" gap="3">
							<Text weight="bold">
								{t("page.playlist.settings.cover", "歌单封面")}
							</Text>
							<Flex gap="3" align="center" wrap="wrap">
								<PlaylistCover
									playlistId={Number(param.id)}
									style={{ width: "5.5em" }}
								/>
								<Flex gap="2" wrap="wrap">
									<Button variant="soft" onClick={onUploadPlaylistCover}>
										{t("page.playlist.cover.uploadCoverImage", "上传封面图片")}
									</Button>
									<Button
										variant="soft"
										color="gray"
										onClick={onClearPlaylistCover}
									>
										{t(
											"page.playlist.cover.changeCoverToAuto",
											"更换成自动封面",
										)}
									</Button>
								</Flex>
							</Flex>
						</Flex>

						<Separator size="4" />

						<Flex direction="column" gap="3">
							<Text weight="bold">
								{t("page.playlist.settings.linkedFolders", "关联文件夹")}
							</Text>
							{folders && folders.length > 0 ? (
								<Flex direction="column" gap="2">
									{folders.map((folder) => (
										<Flex
											key={folder}
											align="center"
											justify="between"
											gap="3"
											p="3"
											style={{
												backgroundColor: "var(--gray-a2)",
												borderRadius: "var(--radius-3)",
											}}
										>
											<Box minWidth="0" flexGrow="1">
												<Text as="div" weight="medium">
													{getFolderName(folder)}
												</Text>
												<Text
													as="div"
													size="1"
													color="gray"
													style={{ wordBreak: "break-all" }}
												>
													{folder}
												</Text>
											</Box>
											<Flex gap="1">
												<IconButton
													size="1"
													variant="ghost"
													onClick={() => onOpenFolder(folder)}
													aria-label={t(
														"page.playlist.settings.openFolder",
														"打开",
													)}
												>
													<OpenInNewWindowIcon />
												</IconButton>
												<IconButton
													size="1"
													variant="ghost"
													color="red"
													onClick={() => setFolderToRemove(folder)}
													aria-label={t(
														"page.playlist.settings.removeFolder",
														"移除",
													)}
												>
													<TrashIcon />
												</IconButton>
											</Flex>
										</Flex>
									))}
								</Flex>
							) : (
								<Text color="gray" size="2">
									{t(
										"page.playlist.settings.noLinkedFolders",
										"此歌单未关联文件夹",
									)}
								</Text>
							)}
							<Button variant="soft" onClick={onAddFolder}>
								<PlusIcon />
								{t("page.playlist.settings.addFolder", "添加关联文件夹")}
							</Button>
						</Flex>

						<Separator size="4" />

						<Flex direction="column" gap="3">
							<Text weight="bold">
								{t("page.playlist.settings.playlistInfo", "歌单信息")}
							</Text>
							<Grid columns="2" gap="2">
								<Text color="gray" size="2">
									{t("page.playlist.settings.songCount", "歌曲数量")}
								</Text>
								<Text size="2">{playlist?.songIds.length || 0}</Text>
								<Text color="gray" size="2">
									{t("page.playlist.settings.createdAt", "创建时间")}
								</Text>
								<Text size="2">{formatDateTime(playlist?.createTime)}</Text>
								<Text color="gray" size="2">
									{t("page.playlist.settings.updatedAt", "更新时间")}
								</Text>
								<Text size="2">{formatDateTime(playlist?.updateTime)}</Text>
							</Grid>
						</Flex>
					</Flex>

					<Flex gap="3" mt="4" justify="end">
						<Dialog.Close>
							<Button variant="soft" color="gray">
								<Trans i18nKey="common.dialog.close">关闭</Trans>
							</Button>
						</Dialog.Close>
					</Flex>
				</Dialog.Content>
			</Dialog.Root>

			<Dialog.Root
				open={folderToRemove !== null}
				onOpenChange={(open) => {
					if (!open) setFolderToRemove(null);
				}}
			>
				<Dialog.Content style={{ maxWidth: 420 }}>
					<Dialog.Title>
						{t(
							"page.playlist.settings.confirmRemoveFolderTitle",
							"移除关联文件夹",
						)}
					</Dialog.Title>
					<Dialog.Description size="2" mb="4">
						{t(
							"page.playlist.settings.confirmRemoveFolderDescription",
							"确定要移除此文件夹吗？该文件夹扫描添加的歌曲将从歌单中移除。手动添加的歌曲不受影响。",
						)}
					</Dialog.Description>
					<Flex gap="3" justify="end">
						<Dialog.Close>
							<Button variant="soft" color="gray">
								<Trans i18nKey="common.dialog.cancel">取消</Trans>
							</Button>
						</Dialog.Close>
						<Button color="red" onClick={onConfirmRemoveFolder}>
							<Trans i18nKey="common.dialog.confirm">确认</Trans>
						</Button>
					</Flex>
				</Dialog.Content>
			</Dialog.Root>
		</PageContainer>
	);
};

Component.displayName = "PlaylistPage";

export default Component;
