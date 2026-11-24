import { toDuration } from "@applemusic-like-lyrics/react-full";
import { CopyIcon } from "@radix-ui/react-icons";
import { Button, Code, DataList, Flex, IconButton } from "@radix-ui/themes";
import { open } from "@tauri-apps/plugin-dialog";
import { platform } from "@tauri-apps/plugin-os";
import {
	type FC,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import { db } from "../../utils/db-client.ts";
import { resolveContentUri } from "../../utils/player.ts";
import { SongContext } from "./song-ctx.ts";

export const BasicTabContent: FC = () => {
	const song = useContext(SongContext);
	const { t } = useTranslation();
	const [fileMissing, setFileMissing] = useState(false);
	const [relinking, setRelinking] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setFileMissing(false);
		if (!song?.filePath) return;

		db.songs
			.fileExists(song.filePath)
			.then((exists) => {
				if (!cancelled) setFileMissing(!exists);
			})
			.catch((err) => {
				console.error("Failed to check song file existence:", err);
			});

		return () => {
			cancelled = true;
		};
	}, [song?.filePath]);

	const selectFile = useCallback(async () => {
		if (!song) return;

		const currentPlatform = platform();
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
		if (currentPlatform === "android") {
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
		if (currentPlatform === "ios") {
			filters.length = 0;
		}

		const selected = await open({
			multiple: false,
			directory: false,
			title: t("page.song.basic.selectFileTitle", "选择音乐文件"),
			filters,
		});
		if (!selected || Array.isArray(selected)) return;

		setRelinking(true);
		try {
			const newPath =
				currentPlatform === "android" || currentPlatform === "ios"
					? await resolveContentUri(selected)
					: selected;
			await db.songs.relinkFile(song.id, newPath);
			setFileMissing(false);
			toast.success(
				t("page.song.basic.relinkFileSuccess", "音乐文件路径已更新"),
			);
		} catch (err) {
			toast.error(
				t("page.song.basic.relinkFileFailed", "更新音乐文件路径失败: {error}", {
					error: err instanceof Error ? err.message : String(err),
				}),
			);
		} finally {
			setRelinking(false);
		}
	}, [song, t]);

	return (
		<DataList.Root>
			<DataList.Item>
				<DataList.Label>
					<Trans i18nKey="page.song.basic.musicId">音乐 ID</Trans>
				</DataList.Label>
				<DataList.Value>{song?.id || "未知"}</DataList.Value>
			</DataList.Item>
			<DataList.Item>
				<DataList.Label>
					<Trans i18nKey="page.song.basic.musicFilePath">音乐文件路径</Trans>
				</DataList.Label>
				<DataList.Value>
					<Flex align="center" gap="2">
						<Code variant="ghost">{song?.filePath}</Code>
						<IconButton
							size="1"
							aria-label="Copy value"
							color="gray"
							variant="ghost"
							onClick={() => {
								navigator.clipboard.writeText(song?.filePath || "");
							}}
						>
							<CopyIcon />
						</IconButton>
						{fileMissing && (
							<Button
								size="1"
								variant="soft"
								loading={relinking}
								onClick={selectFile}
							>
								<Trans i18nKey="page.song.basic.selectFile">选择</Trans>
							</Button>
						)}
					</Flex>
				</DataList.Value>
			</DataList.Item>
			<DataList.Item>
				<DataList.Label>
					<Trans i18nKey="page.song.basic.musicDuration">音乐时长</Trans>
				</DataList.Label>
				<DataList.Value>{toDuration(song?.duration || 0)}</DataList.Value>
			</DataList.Item>
		</DataList.Root>
	);
};
