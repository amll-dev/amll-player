import { toDuration } from "@applemusic-like-lyrics/react-full";
import { CopyIcon } from "@radix-ui/react-icons";
import {
	Callout,
	Code,
	DataList,
	Flex,
	Heading,
	IconButton,
	Text,
} from "@radix-ui/themes";
import { type FC, type ReactNode, useContext } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
	type LocalMusicFileMetadata,
	readLocalMusicFileMetadata,
} from "../../utils/player.ts";
import { useDbQuery } from "../../utils/use-db-query.ts";
import { SongContext } from "./song-ctx.ts";

const normalizeTagKey = (key: string) =>
	key
		.trim()
		.toLowerCase()
		.replace(/[\s_.:\-/]+/g, "");

const TAG_FIELDS = [
	{ key: "album", fallback: "专辑", aliases: ["album"] },
	{
		key: "albumArtist",
		fallback: "专辑艺术家",
		aliases: ["album artist", "album_artist", "albumartist"],
	},
	{ key: "genre", fallback: "流派", aliases: ["genre"] },
	{
		key: "recordingDate",
		fallback: "日期",
		aliases: ["date", "year", "recording date", "original date"],
	},
	{
		key: "trackNumber",
		fallback: "音轨号",
		aliases: ["track", "track number", "track_number", "tracknumber"],
	},
	{
		key: "discNumber",
		fallback: "碟号",
		aliases: ["disc", "disk", "disc number", "disc_number", "discnumber"],
	},
	{ key: "composer", fallback: "作曲", aliases: ["composer"] },
	{
		key: "lyricist",
		fallback: "作词",
		aliases: ["lyricist", "text author", "writer"],
	},
	{
		key: "publisher",
		fallback: "发行方",
		aliases: ["publisher", "organization", "label"],
	},
	{ key: "copyright", fallback: "版权", aliases: ["copyright"] },
	{
		key: "encoder",
		fallback: "编码器",
		aliases: ["encoder", "encoded by", "encoded_by", "encodedby"],
	},
] as const;

const HIDDEN_TAG_KEYS = new Set(
	[
		"title",
		"track title",
		"track_title",
		"tracktitle",
		"artist",
		"artists",
		"author",
		"performer",
		"lyric",
		"lyrics",
		"unsynced lyrics",
		"unsyncedlyrics",
		"synced lyrics",
		"syncedlyrics",
		"metadata block picture",
		"metadata_block_picture",
		"cover",
		"cover art",
		"coverart",
		"picture",
		"attached pic",
		"attached_pic",
	].map(normalizeTagKey),
);

const RECOGNIZED_TAG_KEYS = new Set(
	TAG_FIELDS.flatMap((field) => field.aliases.map(normalizeTagKey)),
);

interface PrimaryTagRow {
	key: string;
	labelKey: (typeof TAG_FIELDS)[number]["key"];
	fallback: string;
	value: string;
}

interface OtherTagRow {
	key: string;
	label: string;
	value: string;
}

const buildTagRows = (tags: Record<string, string>) => {
	const entries = Object.entries(tags)
		.map(([key, value]) => [key.trim(), value.trim()] as const)
		.filter(([key, value]) => key.length > 0 && value.length > 0)
		.sort(([left], [right]) => left.localeCompare(right));
	const byNormalizedKey = new Map<string, (typeof entries)[number]>();
	for (const entry of entries) {
		const normalizedKey = normalizeTagKey(entry[0]);
		if (!byNormalizedKey.has(normalizedKey)) {
			byNormalizedKey.set(normalizedKey, entry);
		}
	}

	const primaryRows: PrimaryTagRow[] = TAG_FIELDS.flatMap((field) => {
		const entry = field.aliases
			.map((alias) => byNormalizedKey.get(normalizeTagKey(alias)))
			.find((value) => value !== undefined);
		return entry
			? [
					{
						key: field.key,
						labelKey: field.key,
						fallback: field.fallback,
						value: entry[1],
					},
				]
			: [];
	});
	const otherRows: OtherTagRow[] = entries
		.filter(([key]) => {
			const normalizedKey = normalizeTagKey(key);
			return (
				!RECOGNIZED_TAG_KEYS.has(normalizedKey) &&
				!HIDDEN_TAG_KEYS.has(normalizedKey)
			);
		})
		.map(([key, value]) => ({ key: `raw-${key}`, label: key, value }));

	return { primaryRows, otherRows };
};

const formatNumber = (
	value: number,
	language: string,
	maximumFractionDigits = 1,
) => new Intl.NumberFormat(language, { maximumFractionDigits }).format(value);

const formatFileSize = (bytes: number, language: string) => {
	if (!Number.isFinite(bytes) || bytes < 0) return "-";
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let value = bytes;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	return `${formatNumber(value, language, unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
};

const formatModifiedAt = (modifiedAt: number, language: string) => {
	if (!Number.isSafeInteger(modifiedAt)) return "-";
	const date = new Date(modifiedAt);
	if (Number.isNaN(date.getTime())) return "-";
	return new Intl.DateTimeFormat(language, {
		dateStyle: "medium",
		timeStyle: "medium",
	}).format(date);
};

const MetadataValue: FC<{ children: ReactNode }> = ({ children }) => (
	<Text style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
		{children}
	</Text>
);

export const BasicTabContent: FC = () => {
	const song = useContext(SongContext);
	const { t, i18n } = useTranslation();
	const {
		data: loadedFileMetadata,
		loading,
		error,
	} = useDbQuery<
		| {
				sourcePath: string;
				metadata: LocalMusicFileMetadata;
		  }
		| undefined
	>(
		async () => {
			if (!song?.filePath) return undefined;
			const sourcePath = song.filePath;
			return {
				sourcePath,
				metadata: await readLocalMusicFileMetadata(sourcePath),
			};
		},
		[song?.filePath],
		undefined,
	);
	const fileMetadata =
		loadedFileMetadata && loadedFileMetadata.sourcePath === song?.filePath
			? loadedFileMetadata.metadata
			: undefined;
	const { primaryRows, otherRows } = buildTagRows(fileMetadata?.tags ?? {});
	const language = i18n.resolvedLanguage || i18n.language || "en-US";
	return (
		<Flex direction="column" gap="5">
			<DataList.Root>
				<DataList.Item>
					<DataList.Label>
						<Trans i18nKey="page.song.basic.musicId">音乐 ID</Trans>
					</DataList.Label>
					<DataList.Value>{song?.id || "-"}</DataList.Value>
				</DataList.Item>
				<DataList.Item>
					<DataList.Label>
						<Trans i18nKey="page.song.basic.musicFilePath">音乐文件路径</Trans>
					</DataList.Label>
					<DataList.Value>
						<Flex align="center" gap="2" minWidth="0">
							<Code
								variant="ghost"
								style={{ overflowWrap: "anywhere", minWidth: 0 }}
							>
								{song?.filePath}
							</Code>
							<IconButton
								size="1"
								aria-label={t("page.song.basic.copyFilePath", "复制文件路径")}
								color="gray"
								variant="ghost"
								onClick={() => {
									navigator.clipboard.writeText(song?.filePath || "");
								}}
							>
								<CopyIcon />
							</IconButton>
						</Flex>
					</DataList.Value>
				</DataList.Item>
				<DataList.Item>
					<DataList.Label>
						<Trans i18nKey="page.song.basic.musicDuration">音乐时长</Trans>
					</DataList.Label>
					<DataList.Value>{toDuration(song?.duration || 0)}</DataList.Value>
				</DataList.Item>
				{fileMetadata && (
					<>
						{fileMetadata.fileSize !== null && (
							<DataList.Item>
								<DataList.Label>
									<Trans i18nKey="page.song.basic.fileSize">文件大小</Trans>
								</DataList.Label>
								<DataList.Value>
									{formatFileSize(fileMetadata.fileSize, language)}
								</DataList.Value>
							</DataList.Item>
						)}
						{fileMetadata.modifiedAt !== null && (
							<DataList.Item>
								<DataList.Label>
									<Trans i18nKey="page.song.basic.fileModifiedAt">
										文件修改时间
									</Trans>
								</DataList.Label>
								<DataList.Value>
									{formatModifiedAt(fileMetadata.modifiedAt, language)}
								</DataList.Value>
							</DataList.Item>
						)}
					</>
				)}
			</DataList.Root>

			{song?.filePath && loading && (
				<Text color="gray">
					<Trans i18nKey="page.song.basic.loadingFileMetadata">
						正在读取原始音乐文件信息…
					</Trans>
				</Text>
			)}
			{song?.filePath && error && (
				<Callout.Root color="red" role="alert">
					<Callout.Text>
						{t(
							"page.song.basic.fileMetadataError",
							"无法读取原始音乐文件信息：{message}",
							{ message: error.message },
						)}
					</Callout.Text>
				</Callout.Root>
			)}

			{fileMetadata && (
				<Flex direction="column" gap="2">
					<Heading size="4">
						<Trans i18nKey="page.song.basic.originalFileMetadata">
							原始文件元数据
						</Trans>
					</Heading>
					{primaryRows.length === 0 && otherRows.length === 0 ? (
						<Text color="gray">
							<Trans i18nKey="page.song.basic.noFileMetadata">
								原始音乐文件中没有可显示的元数据标签
							</Trans>
						</Text>
					) : (
						<DataList.Root>
							{primaryRows.map((row) => (
								<DataList.Item key={row.key}>
									<DataList.Label>
										{t(`page.song.basic.${row.labelKey}`, row.fallback)}
									</DataList.Label>
									<DataList.Value>
										<MetadataValue>{row.value}</MetadataValue>
									</DataList.Value>
								</DataList.Item>
							))}
							{otherRows.map((row) => (
								<DataList.Item key={row.key}>
									<DataList.Label>
										<Code variant="ghost">{row.label}</Code>
									</DataList.Label>
									<DataList.Value>
										<MetadataValue>{row.value}</MetadataValue>
									</DataList.Value>
								</DataList.Item>
							))}
						</DataList.Root>
					)}
				</Flex>
			)}
		</Flex>
	);
};
