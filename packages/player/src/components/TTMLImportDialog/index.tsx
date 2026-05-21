import {
	Button,
	Callout,
	Card,
	Dialog,
	Flex,
	Text,
	TextField,
} from "@radix-ui/themes";
import { open } from "@tauri-apps/plugin-shell";
import {
	type FC,
	useCallback,
	useEffect,
	useLayoutEffect,
	useState,
} from "react";
import { Trans, useTranslation } from "react-i18next";
import {
	getLyricDetail,
	type LyricSearchResult,
	type SearchFilter,
	SyncStatus,
	searchLyrics,
	syncLyrics,
} from "../../utils/lyric-db-api.ts";
import styles from "./index.module.css";

export const TTMLImportDialog: FC<{
	defaultValue?: string;
	onSelectedLyric?: (ttmlContent: string) => void;
}> = ({ onSelectedLyric, defaultValue }) => {
	const { t } = useTranslation();

	const [searchWord, setSearchWord] = useState("");
	const [opened, setOpened] = useState(false);
	const [results, setResults] = useState<LyricSearchResult[]>([]);
	const [_isSearching, setIsSearching] = useState(false);
	const [_isSyncing, setIsSyncing] = useState(false);
	const [syncStatus, setSyncStatus] = useState<string | null>(null);

	const performSearch = useCallback(async (keyword: string) => {
		if (keyword.trim().length === 0) {
			setResults([]);
			return;
		}

		setIsSearching(true);
		try {
			const filters: SearchFilter[] = [];

			filters.push(
				{ field: "title", keyword },
				{ field: "artist", keyword },
				{ field: "album", keyword },
				{ field: "lyric_text", keyword },
				{ field: "bg_vocal_text", keyword },
			);

			const searchResults = await searchLyrics(filters);
			setResults(searchResults.slice(0, 10));
		} catch (error) {
			console.error("Search failed:", error);
			setResults([]);
		} finally {
			setIsSearching(false);
		}
	}, []);

	useEffect(() => {
		const timer = setTimeout(() => {
			performSearch(searchWord);
		}, 50);

		return () => clearTimeout(timer);
	}, [searchWord, performSearch]);

	useLayoutEffect(() => {
		setSearchWord(defaultValue ?? "");
	}, [defaultValue]);

	const handleSync = useCallback(async () => {
		setIsSyncing(true);
		setSyncStatus(null);

		try {
			const result = await syncLyrics();

			switch (result.status) {
				case SyncStatus.Skipped:
					setSyncStatus(
						t("amll.ttmlImportDialog.sync.skipped", "歌词库已是最新"),
					);
					break;
				case SyncStatus.Updated:
					setSyncStatus(
						t("amll.ttmlImportDialog.sync.updated", "已更新 {count} 首歌词", {
							count: result.count ?? 0,
						}),
					);
					break;
				case SyncStatus.Empty:
					setSyncStatus(t("amll.ttmlImportDialog.sync.empty", "歌词库为空"));
					break;
				case SyncStatus.Failed:
					setSyncStatus(
						t("amll.ttmlImportDialog.sync.failed", "同步失败: {error}", {
							error: result.error ?? "Unknown error",
						}),
					);
					break;
				default:
					setSyncStatus(null);
			}

			if (
				result.status === SyncStatus.Updated &&
				searchWord.trim().length > 0
			) {
				performSearch(searchWord);
			}
		} catch (error) {
			setSyncStatus(
				t("amll.ttmlImportDialog.sync.error", "同步出错: {error}", {
					error: String(error),
				}),
			);
		} finally {
			setIsSyncing(false);
		}
	}, [searchWord, performSearch, t]);

	useEffect(() => {
		if (opened) {
			handleSync();
		}
	}, [opened, handleSync]);

	const handleSelectLyric = useCallback(
		async (result: LyricSearchResult) => {
			try {
				const detail = await getLyricDetail(result.file_path);
				if (detail) {
					onSelectedLyric?.(detail);
					setOpened(false);
				}
			} catch (error) {
				console.error("Failed to get lyric detail:", error);
			}
		},
		[onSelectedLyric],
	);

	return (
		<Dialog.Root open={opened} onOpenChange={setOpened}>
			<Dialog.Trigger>
				<Button>
					<Trans i18nKey="amll.ttmlImportDialog.openButtonLabel">
						从 AMLL TTML DB 搜索 / 导入歌词
					</Trans>
				</Button>
			</Dialog.Trigger>
			<Dialog.Content>
				<Dialog.Title>
					<Trans i18nKey="amll.ttmlImportDialog.title">
						从 AMLL TTML DB 搜索 / 导入歌词
					</Trans>
				</Dialog.Title>
				<TextField.Root
					placeholder={t(
						"amll.ttmlImportDialog.searchInput.placeholder",
						"搜索歌曲、歌词内容、歌手等……",
					)}
					type="text"
					onChange={(v) => setSearchWord(v.target.value)}
					value={searchWord}
				/>
				{syncStatus && (
					<Callout.Root mt="2" color="gray">
						<Text size="1">{syncStatus}</Text>
					</Callout.Root>
				)}
				<Callout.Root mt="4">
					<Trans i18nKey="amll.ttmlImportDialog.tip">
						在上方输入搜索关键词，点击候选项即可将歌词内容直接导入到歌词数据中。
					</Trans>
				</Callout.Root>
				<Callout.Root mt="4" color="grass">
					<Text>
						<Trans i18nKey="amll.ttmlImportDialog.supportText">
							AMLL TTML DB 是由 AMLL
							社区爱好者们一同建设的开源无版权歌词数据库，想为 AMLL TTML DB
							贡献歌词吗？前往
							<Button
								variant="outline"
								onClick={() => open("https://github.com/amll-dev/amll-ttml-db")}
								style={{
									verticalAlign: "baseline",
									margin: "0 0.5em",
									fontWeight: "bold",
								}}
							>
								GitHub 仓库
							</Button>
							即可知晓提交歌词流程！
						</Trans>
					</Text>
				</Callout.Root>
				{results.length > 0 ? (
					results.map((v) => (
						<Card key={v.file_path} asChild>
							<button
								className={styles.resultCard}
								type="button"
								onClick={() => handleSelectLyric(v)}
							>
								<div className={styles.name}>{v.file_path}</div>
								<div>
									{v.artist} - {v.title}
								</div>
								{v.matched_line_preview.length > 0 && (
									<ul>
										{v.matched_line_preview.map((l, i) => (
											<li key={`${l}-${i}`}>{l}</li>
										))}
									</ul>
								)}
							</button>
						</Card>
					))
				) : searchWord.trim().length > 0 ? (
					<div style={{ margin: "1em", textAlign: "center", opacity: "0.5" }}>
						<Trans i18nKey="amll.ttmlImportDialog.noResults">无结果</Trans>
					</div>
				) : null}
				<Flex gap="3" mt="4" justify="end">
					<Dialog.Close>
						<Button variant="soft">
							<Trans i18nKey="common.dialog.close">关闭</Trans>
						</Button>
					</Dialog.Close>
				</Flex>
			</Dialog.Content>
		</Dialog.Root>
	);
};
