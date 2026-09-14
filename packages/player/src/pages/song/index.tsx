import { ArrowLeftIcon } from "@radix-ui/react-icons";
import {
	Avatar,
	Box,
	Button,
	Container,
	Flex,
	Tabs,
	Text,
} from "@radix-ui/themes";
import { useAtomValue } from "jotai";
import { type FC, useContext, useEffect, useState } from "react";
import { Trans } from "react-i18next";
import { useParams } from "react-router-dom";
import { ExtensionInjectPoint } from "../../components/ExtensionInjectPoint/index.tsx";
import { enableExperimentalFeaturesAtom } from "../../states/appAtoms.ts";
import { db } from "../../utils/db-client.ts";
import { useDbQuery } from "../../utils/use-db-query.ts";
import { useSongCover } from "../../utils/use-song-cover.ts";
import { BasicTabContent } from "./basic.tsx";
import { LyricTabContent } from "./lyric.tsx";
import { MetadataTabContent } from "./metadata.tsx";
import { SongContext } from "./song-ctx.ts";
import { SongVideoBackgroundEditor } from "./video-background.tsx";

const SongPageHeader: FC = () => {
	const song = useContext(SongContext);
	const songImgUrl = useSongCover(song);

	return (
		<>
			<Flex align="end" mt="7" gap="4">
				<Button variant="soft" onClick={() => history.back()}>
					<ArrowLeftIcon />
					<Trans i18nKey="common.page.back">返回</Trans>
				</Button>
			</Flex>
			<Flex align="center" my="4" gap="4">
				<Avatar size="9" fallback={<div />} src={songImgUrl} />
				<Flex direction="column">
					<Text weight="bold" size="6">
						{song?.songName}
					</Text>
					<Text color="gray" size="5">
						{song?.songArtists}
					</Text>
				</Flex>
			</Flex>
		</>
	);
};

export const Component: FC = () => {
	const enableExperimentalFeatures = useAtomValue(
		enableExperimentalFeaturesAtom,
	);
	const [activeTab, setActiveTab] = useState("basic");
	const visibleTab =
		!enableExperimentalFeatures && activeTab === "background"
			? "basic"
			: activeTab;
	useEffect(() => {
		if (!enableExperimentalFeatures) {
			setActiveTab((tab) => (tab === "background" ? "basic" : tab));
		}
	}, [enableExperimentalFeatures]);
	const { id: musicId } = useParams<{ id: string }>();
	const { data: song } = useDbQuery(
		() => db.songs.get(musicId || ""),
		[musicId],
		undefined,
		["songs"],
	);

	return (
		<Container
			mx={{
				initial: "4",
				sm: "9",
			}}
			mb="150px"
		>
			<SongContext.Provider value={song}>
				<SongPageHeader />
				<Tabs.Root value={visibleTab} onValueChange={setActiveTab}>
					<Tabs.List>
						<ExtensionInjectPoint injectPointName="page.song.tab.list.before" />
						<Tabs.Trigger value="basic">
							<Trans i18nKey="page.song.basic.tabs.basic">基本</Trans>
						</Tabs.Trigger>
						<Tabs.Trigger value="metadata">
							<Trans i18nKey="page.song.basic.tabs.metadata">元数据</Trans>
						</Tabs.Trigger>
						<Tabs.Trigger value="lyric">
							<Trans i18nKey="page.song.basic.tabs.lyric">歌词</Trans>
						</Tabs.Trigger>
						{enableExperimentalFeatures && (
							<Tabs.Trigger value="background">
								<Trans i18nKey="page.song.basic.tabs.background">背景</Trans>
							</Tabs.Trigger>
						)}
						<ExtensionInjectPoint injectPointName="page.song.tab.list.after" />
					</Tabs.List>
					<Box pt="3">
						<ExtensionInjectPoint injectPointName="page.song.tab.content.before" />
						<Tabs.Content value="basic">
							<BasicTabContent />
						</Tabs.Content>
						<Tabs.Content value="metadata">
							<MetadataTabContent />
						</Tabs.Content>
						<Tabs.Content value="lyric">
							<LyricTabContent />
						</Tabs.Content>
						{enableExperimentalFeatures && (
							<Tabs.Content value="background">
								<SongVideoBackgroundEditor key={song?.id ?? "missing-song"} />
							</Tabs.Content>
						)}
						<ExtensionInjectPoint injectPointName="page.song.tab.content.after" />
					</Box>
				</Tabs.Root>
			</SongContext.Provider>
		</Container>
	);
};

Component.displayName = "SongPage";

export default Component;
