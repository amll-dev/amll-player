import {
	isLyricPageOpenedAtom,
	onPlayOrResumeAtom,
	PrebuiltLyricPlayer,
} from "@applemusic-like-lyrics/react-full";
import { ContextMenu } from "@radix-ui/themes";
import classnames from "classnames";
import { useAtomValue, useSetAtom } from "jotai";
import { type FC, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { useCursorAutoHide } from "../../utils/useCursorAutoHide.ts";
import { useTitlebarAutoHide } from "../../utils/useTitlebarAutoHide.ts";
import { AMLLContextMenuContent } from "../AMLLContextMenu/index.tsx";
import { AudioQualityDialog } from "../AudioQualityDialog/index.tsx";
import { BottomLyricInfo } from "../BottomLyricInfo";
import {
	sharedCoverClassName,
	usePlaybackPresentation,
} from "../PlaybackTransition/index.tsx";
import { RecordPanel } from "../RecordPanel/index.tsx";
import styles from "./index.module.css";
import "@applemusic-like-lyrics/core/style.css";
import "@applemusic-like-lyrics/react-full/style.css";

export const AMLLWrapper: FC = () => {
	const { t } = useTranslation();
	const {
		pageRef,
		coverRef,
		videoRef,
		coverFrameRef,
		fullInfoRef,
		collapseButtonRef,
		opened: isLyricPageOpened,
	} = usePlaybackPresentation();
	const onPlayOrResume = useAtomValue(onPlayOrResumeAtom).onEmit;
	const setLyricPageOpened = useSetAtom(isLyricPageOpenedAtom);

	useTitlebarAutoHide(isLyricPageOpened);
	const cursorHidden = useCursorAutoHide(isLyricPageOpened);

	useLayoutEffect(() => {
		if (isLyricPageOpened) {
			document.body.dataset.amllLyricsOpen = "";
		} else {
			delete document.body.dataset.amllLyricsOpen;
		}
		return () => {
			delete document.body.dataset.amllLyricsOpen;
		};
	}, [isLyricPageOpened]);

	return (
		<>
			<ContextMenu.Root>
				<ContextMenu.Trigger>
					<div
						ref={pageRef}
						inert={!isLyricPageOpened}
						aria-hidden={!isLyricPageOpened}
						role="region"
						aria-label={t("amll.nowPlaying", "正在播放")}
						tabIndex={-1}
						className={classnames(
							styles.lyricPage,
							isLyricPageOpened && styles.opened,
						)}
						id="amll-lyric-player-wrapper"
						onKeyDown={(e) => {
							if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey)
								return;
							if (e.key === "Escape") {
								e.preventDefault();
								setLyricPageOpened(false);
							} else if (
								e.key === " " &&
								!e.repeat &&
								e.target instanceof HTMLElement &&
								!e.target.closest(
									"button, input, textarea, select, a, [role=button], [role=slider], [contenteditable]",
								)
							) {
								e.preventDefault();
								onPlayOrResume?.();
							}
						}}
					>
						<div className={styles.lyricContent} id="amll-player-content">
							<PrebuiltLyricPlayer
								id="amll-lyric-player"
								style={{ width: "100%", height: "100%" }}
								bottomLineSlot={<BottomLyricInfo />}
								coverFrameRef={coverFrameRef}
								musicInfoProps={{ ref: fullInfoRef, id: "amll-full-info" }}
								coverProps={{
									id: "amll-player-cover",
									ref: coverRef,
									videoRef,
									coverVideoPaused: !isLyricPageOpened,
									className: sharedCoverClassName,
								}}
								controlThumbProps={{
									id: "amll-player-control-thumb",
									className: styles.controlThumb,
									buttonRef: collapseButtonRef,
									buttonLabel: t("amll.closePlayer", "收起播放页"),
									onClick: () => setLyricPageOpened(false),
								}}
							/>
						</div>
						{cursorHidden && <div className={styles.cursorHiddenOverlay} />}
					</div>
				</ContextMenu.Trigger>
				<AMLLContextMenuContent />
			</ContextMenu.Root>
			<AudioQualityDialog />
			<RecordPanel />
		</>
	);
};

export default AMLLWrapper;
