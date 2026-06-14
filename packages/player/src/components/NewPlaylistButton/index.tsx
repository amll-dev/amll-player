import { PlusIcon } from "@radix-ui/react-icons";
import {
	Button,
	Dialog,
	Flex,
	Select,
	Text,
	TextField,
} from "@radix-ui/themes";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { type FC, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import { db } from "../../utils/db-client.ts";

type CreateMode = "empty" | "folder";

export const NewPlaylistButton: FC = () => {
	const [name, setName] = useState("");
	const [mode, setMode] = useState<CreateMode>("empty");
	const { t } = useTranslation();

	const cannotCreate = useMemo(() => name.trim().length === 0, [name]);

	const onAddPlaylist = async () => {
		if (cannotCreate) return;
		await db.playlists.create(name);
		setName("");
	};

	const onScanFolder = async () => {
		const folder = await open({
			directory: true,
			multiple: false,
			title: t("newPlaylist.dialog.selectFolder", "选择要扫描的文件夹"),
		});
		if (!folder) return;

		const playlistName = name.trim() || undefined;
		let scannedCount = 0;
		const toastId = toast.loading(
			t("newPlaylist.dialog.scanning", "正在扫描… 已找到 0 首歌曲"),
		);

		const unlisten = await listen<number>("scan-folder-progress", (event) => {
			scannedCount = event.payload;
			toast.update(toastId, {
				render: t(
					"newPlaylist.dialog.scanningProgress",
					"正在扫描… 已找到 {count} 首歌曲",
					{ count: scannedCount },
				),
			});
		});

		try {
			const result = await db.playlists.scanFolder(folder, playlistName);
			toast.update(toastId, {
				render: t(
					"newPlaylist.dialog.scanSuccess",
					"已导入 {imported} 首歌曲，失败 {failed} 首",
					{ imported: result.imported, failed: result.failed },
				),
				type: result.failed > 0 ? "warning" : "success",
				isLoading: false,
				autoClose: 5000,
			});
			setName("");
		} catch (err) {
			toast.update(toastId, {
				render: t("newPlaylist.dialog.scanFailed", "扫描失败: {error}", {
					error: String(err),
				}),
				type: "error",
				isLoading: false,
				autoClose: 5000,
			});
		} finally {
			unlisten();
		}
	};

	return (
		<Dialog.Root>
			<Dialog.Trigger>
				<Button variant="soft">
					<PlusIcon />
					<Trans i18nKey="newPlaylist.buttonLabel">新建播放列表</Trans>
				</Button>
			</Dialog.Trigger>
			<Dialog.Content maxWidth="450px">
				<Dialog.Title>
					<Trans i18nKey="newPlaylist.dialog.title">新建歌单</Trans>
				</Dialog.Title>
				<Flex gap="3" direction="column">
					<Text>
						<Trans i18nKey="newPlaylist.dialog.name">歌单名称</Trans>
					</Text>
					<TextField.Root
						placeholder={t("newPlaylist.dialog.namePlaceholder", "歌单名称")}
						value={name}
						onChange={(e) => setName(e.currentTarget.value)}
						autoFocus
					/>
					<Select.Root
						value={mode}
						onValueChange={(v) => setMode(v as CreateMode)}
					>
						<Select.Trigger />
						<Select.Content>
							<Select.Item value="empty">
								{t("newPlaylist.mode.empty", "空歌单")}
							</Select.Item>
							<Select.Item value="folder">
								{t("newPlaylist.mode.folder", "从文件夹添加")}
							</Select.Item>
						</Select.Content>
					</Select.Root>
				</Flex>
				<Flex gap="3" mt="4" justify="end">
					<Dialog.Close>
						<Button type="button" variant="soft" color="gray">
							<Trans i18nKey="common.dialog.cancel">取消</Trans>
						</Button>
					</Dialog.Close>
					{mode === "empty" ? (
						<Dialog.Close disabled={cannotCreate}>
							<Button
								type="submit"
								disabled={cannotCreate}
								onClick={onAddPlaylist}
							>
								<Trans i18nKey="common.dialog.confirm">确认</Trans>
							</Button>
						</Dialog.Close>
					) : (
						<Dialog.Close>
							<Button type="button" onClick={onScanFolder}>
								<Trans i18nKey="common.dialog.confirm">确认</Trans>
							</Button>
						</Dialog.Close>
					)}
				</Flex>
			</Dialog.Content>
		</Dialog.Root>
	);
};
