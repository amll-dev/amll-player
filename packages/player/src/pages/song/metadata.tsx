import { Button, Callout, Flex, TextField } from "@radix-ui/themes";
import {
	type FC,
	useCallback,
	useContext,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Trans, useTranslation } from "react-i18next";
import { db } from "../../utils/db-client.ts";
import {
	pickAndSaveSongCover,
	readLocalMusicMetadata,
} from "../../utils/player.ts";
import { Option } from "./common.tsx";
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
	const coverPickerBusyRef = useRef(false);
	const [isPickingCover, setIsPickingCover] = useState(false);
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
		if (song === undefined || coverPickerBusyRef.current) return;
		coverPickerBusyRef.current = true;
		setIsPickingCover(true);
		try {
			const coverPath = await pickAndSaveSongCover(
				song.id,
				t("page.song.metadata.changeCoverToImageOrVideo"),
				t("page.playlist.cover.mediaFiles", "媒体文件"),
				t("page.playlist.addLocalMusic.allFiles", "所有文件"),
			);
			if (!coverPath) return;
			await db.songs.update(song.id, { coverPath });
		} catch (err) {
			console.error("Failed to save cover:", err);
		} finally {
			coverPickerBusyRef.current = false;
			setIsPickingCover(false);
		}
	}, [song, t]);

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
			<Flex mt="4" gap="2" wrap="wrap">
				<Button
					variant="soft"
					disabled={isPickingCover}
					loading={isPickingCover}
					onClick={uploadCoverAsImage}
				>
					<Trans i18nKey="page.song.metadata.changeCoverToImageOrVideo">
						更换封面图为图片 / 视频
					</Trans>
				</Button>
				<Button variant="soft" onClick={readMetadataFromFile}>
					<Trans i18nKey="page.song.metadata.reloadMetadataFromFile">
						重新从文件中读取元数据
					</Trans>
				</Button>
			</Flex>
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
