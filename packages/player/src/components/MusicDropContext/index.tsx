import type { PhysicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAtomValue } from "jotai";
import { type FC, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import { queueManagerAtom } from "../../states/appAtoms.ts";
import { db, type ImportMusicResult } from "../../utils/db-client.ts";
import styles from "./index.module.css";

const PLAYLIST_DROP_ATTRIBUTE = "data-music-drop-playlist-id";
const CREATE_PLAYLIST_DROP_ATTRIBUTE = "data-music-drop-create-playlist";

interface PlaylistDropTarget {
	element: HTMLElement;
	kind: "playlist";
	playlistId: number;
}

interface CreatePlaylistDropTarget {
	element: HTMLElement;
	kind: "create-playlist";
}

type MusicDropTarget = PlaylistDropTarget | CreatePlaylistDropTarget;

function resolveDropTarget(
	position: PhysicalPosition,
	scaleFactor: number,
): MusicDropTarget | null {
	const safeScaleFactor =
		Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
	const element = document.elementFromPoint(
		position.x / safeScaleFactor,
		position.y / safeScaleFactor,
	);
	const target = element?.closest<HTMLElement>(
		`[${PLAYLIST_DROP_ATTRIBUTE}], [${CREATE_PLAYLIST_DROP_ATTRIBUTE}]`,
	);
	if (!target) return null;

	const playlistIdText = target.getAttribute(PLAYLIST_DROP_ATTRIBUTE);
	if (playlistIdText !== null) {
		const playlistId = Number(playlistIdText);
		if (Number.isSafeInteger(playlistId) && playlistId > 0) {
			return { element: target, kind: "playlist", playlistId };
		}
		return null;
	}
	return { element: target, kind: "create-playlist" };
}

function describeImportResult(result: ImportMusicResult): string {
	const details = [`新增 ${result.added} 首`];
	if (result.alreadyPresent > 0) {
		details.push(`已有 ${result.alreadyPresent} 首`);
	}
	const issueCount =
		result.failed.length + result.skipped.length + result.warnings.length;
	if (issueCount > 0) {
		details.push(`${issueCount} 项未导入或需注意`);
	}
	return details.join("，");
}

export const MusicDropContext: FC = () => {
	const { t } = useTranslation();
	const queueManager = useAtomValue(queueManagerAtom);
	const queueManagerRef = useRef(queueManager);

	useEffect(() => {
		queueManagerRef.current = queueManager;
	}, [queueManager]);

	useEffect(() => {
		const webview = getCurrentWebview();
		const appWindow = getCurrentWindow();
		let cancelled = false;
		let unlistenDragDrop: (() => void) | undefined;
		let unlistenScaleChanged: (() => void) | undefined;
		let activeElement: HTMLElement | null = null;
		let scaleFactor = window.devicePixelRatio || 1;
		let pendingPosition: PhysicalPosition | null = null;
		let hoverFrame = 0;

		const setActiveElement = (nextElement: HTMLElement | null) => {
			if (activeElement === nextElement) return;
			activeElement?.classList.remove(styles.activeDropTarget);
			activeElement = nextElement;
			activeElement?.classList.add(styles.activeDropTarget);
		};

		const updateHoverTarget = (position: PhysicalPosition) => {
			setActiveElement(
				resolveDropTarget(position, scaleFactor)?.element ?? null,
			);
		};

		const scheduleHoverTarget = (position: PhysicalPosition) => {
			pendingPosition = position;
			if (hoverFrame !== 0) return;
			hoverFrame = window.requestAnimationFrame(() => {
				hoverFrame = 0;
				const currentPosition = pendingPosition;
				pendingPosition = null;
				if (currentPosition) updateHoverTarget(currentPosition);
			});
		};

		const cancelPendingHover = () => {
			pendingPosition = null;
			if (hoverFrame === 0) return;
			window.cancelAnimationFrame(hoverFrame);
			hoverFrame = 0;
		};

		const syncImportedSongsToActiveQueue = async (
			playlistId: number,
			result: ImportMusicResult,
		) => {
			const manager = queueManagerRef.current;
			if (
				!manager ||
				manager.getPlaylistId() !== playlistId ||
				result.addedSongIds.length === 0
			) {
				return;
			}
			const songs = await db.songs.getByIds(result.addedSongIds);
			if (
				queueManagerRef.current !== manager ||
				manager.getPlaylistId() !== playlistId
			) {
				return;
			}
			const songsById = new Map(songs.map((song) => [song.id, song]));
			for (const songId of result.addedSongIds) {
				const song = songsById.get(songId);
				if (song) manager.addToQueue(song);
			}
		};

		const importIntoPlaylist = async (playlistId: number, paths: string[]) => {
			const toastId = toast.loading(
				t("musicDrop.importing", "正在导入拖放的音乐…"),
			);
			try {
				const result = await db.playlists.importPaths(playlistId, paths);
				try {
					await syncImportedSongsToActiveQueue(playlistId, result);
				} catch (error) {
					console.warn(
						"[MusicDrop] Imported songs but failed to update the active queue",
						error,
					);
				}
				if (result.added > 0) {
					toast.update(toastId, {
						render: t("musicDrop.imported", "已导入：{summary}", {
							summary: describeImportResult(result),
						}),
						type:
							result.failed.length + result.warnings.length > 0
								? "warning"
								: "success",
						isLoading: false,
						autoClose: 5000,
					});
				} else {
					toast.update(toastId, {
						render: t("musicDrop.noNewSongs", "没有新增歌曲：{summary}", {
							summary: describeImportResult(result),
						}),
						type: result.failed.length > 0 ? "error" : "info",
						isLoading: false,
						autoClose: 5000,
					});
				}
			} catch (error) {
				toast.update(toastId, {
					render: t("musicDrop.importFailed", "拖放导入失败：{error}", {
						error: String(error),
					}),
					type: "error",
					isLoading: false,
					autoClose: 5000,
				});
			}
		};

		const createPlaylistFromFolder = async (paths: string[]) => {
			if (paths.length !== 1) {
				toast.info(
					t(
						"musicDrop.homeFolderOnly",
						"首页空白处一次只接受一个音乐文件夹；音乐文件请拖到具体歌单上。",
					),
				);
				return;
			}

			const toastId = toast.loading(
				t("musicDrop.creatingPlaylist", "正在从文件夹创建歌单…"),
			);
			try {
				const result = await db.playlists.createFromFolder(paths[0]);
				if (result.playlistId === null) {
					const folderRejected = [...result.failed, ...result.skipped].some(
						(issue) =>
							issue.stage === "classify" &&
							(issue.message.includes("必须拖入一个文件夹") ||
								issue.message.includes("符号链接") ||
								issue.message.includes("目录联接")),
					);
					toast.update(toastId, {
						render: folderRejected
							? t(
									"musicDrop.homeFolderOnly",
									"首页空白处一次只接受一个音乐文件夹；音乐文件请拖到具体歌单上。",
								)
							: result.failed[0]?.message
								? t("musicDrop.createRejected", "未创建歌单：{error}", {
										error: result.failed[0].message,
									})
								: t(
										"musicDrop.folderHasNoMusic",
										"文件夹内没有可导入的音乐，未创建歌单。",
									),
						type: folderRejected
							? "info"
							: result.failed.length > 0
								? "error"
								: "info",
						isLoading: false,
						autoClose: 5000,
					});
					return;
				}
				toast.update(toastId, {
					render: t(
						"musicDrop.playlistCreated",
						"已创建歌单“{name}”：{summary}",
						{
							name: result.playlistName ?? "",
							summary: describeImportResult(result),
						},
					),
					type:
						result.failed.length + result.warnings.length > 0
							? "warning"
							: "success",
					isLoading: false,
					autoClose: 5000,
				});
			} catch (error) {
				toast.update(toastId, {
					render: t("musicDrop.createFailed", "创建歌单失败：{error}", {
						error: String(error),
					}),
					type: "error",
					isLoading: false,
					autoClose: 5000,
				});
			}
		};

		void appWindow
			.scaleFactor()
			.then((value) => {
				if (!cancelled) scaleFactor = value;
			})
			.catch((error) => {
				console.warn(
					"[MusicDrop] Failed to read the window scale factor",
					error,
				);
			});
		void appWindow
			.onScaleChanged(({ payload }) => {
				scaleFactor = payload.scaleFactor;
			})
			.then((unlisten) => {
				if (cancelled) {
					unlisten();
				} else {
					unlistenScaleChanged = unlisten;
				}
			})
			.catch((error) => {
				console.warn(
					"[MusicDrop] Failed to listen for scale factor changes",
					error,
				);
			});
		void webview
			.onDragDropEvent(({ payload }) => {
				if (cancelled) return;
				if (payload.type === "leave") {
					cancelPendingHover();
					setActiveElement(null);
					return;
				}
				if (payload.type === "over") {
					scheduleHoverTarget(payload.position);
					return;
				}

				const target = resolveDropTarget(payload.position, scaleFactor);
				if (payload.type === "enter") {
					cancelPendingHover();
					setActiveElement(target?.element ?? null);
					return;
				}

				cancelPendingHover();
				setActiveElement(null);
				if (!target || payload.paths.length === 0) return;
				if (target.kind === "playlist") {
					void importIntoPlaylist(target.playlistId, payload.paths);
				} else {
					void createPlaylistFromFolder(payload.paths);
				}
			})
			.then((unlisten) => {
				if (cancelled) {
					unlisten();
				} else {
					unlistenDragDrop = unlisten;
				}
			})
			.catch((error) => {
				console.warn("[MusicDrop] Failed to listen for native drops", error);
			});

		return () => {
			cancelled = true;
			cancelPendingHover();
			setActiveElement(null);
			unlistenDragDrop?.();
			unlistenScaleChanged?.();
		};
	}, [t]);

	return null;
};
