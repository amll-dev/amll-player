import { Button, Callout, Flex, TextField } from "@radix-ui/themes";
import { open } from "@tauri-apps/plugin-dialog";
import {
	type FC,
	useCallback,
	useContext,
	useLayoutEffect,
	useState,
} from "react";
import { Trans, useTranslation } from "react-i18next";
import { db } from "../../utils/db-client.ts";
import {
	readLocalMusicMetadata,
	saveCoverFromPath,
} from "../../utils/player.ts";
import { getLyricFormatFromExtension, Option } from "./common.tsx";
import { SongContext } from "./song-ctx.ts";

const MetaInput: FC<
	TextField.RootProps & {
		label: string;
	}
> = ({ label, ...props }) => (
	<Option label={label}>
		<TextField.Root {...props} />
	</Option>
);

export const MetadataTabContent: FC = () => {
	const song = useContext(SongContext);
	const [songName, setSongName] = useState("");
	const [songArtists, setSongArtists] = useState("");
	const [songAlbum, setSongAlbum] = useState("");
	const { t } = useTranslation();

	useLayoutEffect(() => {
		if (song) {
			setSongName(song.songName);
			setSongArtists(song.songArtists);
			setSongAlbum(song.songAlbum);
		} else {
			setSongName("");
			setSongArtists("");
			setSongAlbum("");
		}
	}, [song]);

	const uploadCoverAsImage = useCallback(async () => {
		if (song === undefined) return;
		const selected = await open({
			multiple: false,
			filters: [
				{
					name: t("page.playlist.cover.mediaFiles", "媒体文件"),
					extensions: ["jpg", "jpeg", "png", "gif", "mp4", "webm"],
				},
				{ name: "所有文件", extensions: ["*"] },
			],
		});
		if (!selected) return;
		try {
			const coverPath = await saveCoverFromPath(song.id, selected);
			await db.songs.update(song.id, { coverPath });
		} catch (err) {
			console.error("Failed to save cover:", err);
		}
	}, [song]);

	const readMetadataFromFile = useCallback(async () => {
		if (song === undefined) return;
		const newInfo = await readLocalMusicMetadata(song.filePath);

		await db.songs.update(song.id, {
			songName: newInfo.name,
			songAlbum: newInfo.album,
			songArtists: newInfo.artist,
			...(newInfo.lyric ? { lyricFormat: "lrc", lyric: newInfo.lyric } : {}),
			...(newInfo.coverPath ? { coverPath: newInfo.coverPath } : {}),
		});
	}, [song]);

	const importLyricFromFile = useCallback(() => {
		if (song === undefined) return;
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".lrc,.eslrc,.yrc,.qrc,.lys,.ttml";
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			const format = getLyricFormatFromExtension(file.name);
			if (!format) return;
			const content = await file.text();
			await db.songs.update(song.id, {
				lyricFormat: format,
				lyric: content,
				...(format === "ttml" ? { translatedLrc: "", romanLrc: "" } : {}),
			});
		};
		input.click();
	}, [song]);

	const saveData = useCallback(async () => {
		if (song === undefined) return;
		await db.songs.update(song.id, {
			songName,
			songArtists,
			songAlbum,
		});
	}, [song, songName, songArtists, songAlbum]);

	return (
		<>
			<Callout.Root my="2">
				<Callout.Text>
					<Trans i18nKey="page.song.metadata.overrideSafeTip">
						本页面的设置不会写入到原始音乐文件中
					</Trans>
				</Callout.Text>
			</Callout.Root>
			<Flex direction="column" gap="4">
				<MetaInput
					label={t("page.song.metadata.songName", "音乐名称")}
					value={songName}
					onChange={(v) => setSongName(v.currentTarget.value)}
				/>
				<MetaInput
					label={t("page.song.metadata.songArtists", "音乐作者")}
					value={songArtists}
					onChange={(v) => setSongArtists(v.currentTarget.value)}
				/>
				<MetaInput
					label={t("page.song.metadata.songAlbum", "音乐专辑名")}
					value={songAlbum}
					onChange={(v) => setSongAlbum(v.currentTarget.value)}
				/>
			</Flex>
			<Button
				mt="4"
				style={{
					display: "block",
				}}
				variant="soft"
				onClick={uploadCoverAsImage}
			>
				<Trans i18nKey="page.song.metadata.changeCoverToImageOrVideo">
					更换封面图为图片 / 视频
				</Trans>
			</Button>
			<Button
				mt="4"
				style={{
					display: "block",
				}}
				variant="soft"
				onClick={readMetadataFromFile}
			>
				<Trans i18nKey="page.song.metadata.reloadMetadataFromFile">
					重新从文件中读取元数据
				</Trans>
			</Button>
			<Button
				mt="4"
				style={{
					display: "block",
				}}
				variant="soft"
				onClick={importLyricFromFile}
			>
				<Trans i18nKey="page.song.metadata.importLyricFromFile">
					从本地文件导入歌词
				</Trans>
			</Button>
			<Button
				mt="4"
				style={{
					display: "block",
				}}
				onClick={saveData}
			>
				<Trans i18nKey="common.dialog.save">保存</Trans>
			</Button>
		</>
	);
};
