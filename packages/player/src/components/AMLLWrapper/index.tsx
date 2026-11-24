import {
	isLyricPageOpenedAtom,
	onPlayOrResumeAtom,
	PrebuiltLyricPlayer,
} from "@applemusic-like-lyrics/react-full";
import { ContextMenu } from "@radix-ui/themes";
import classnames from "classnames";
import { useAtomValue, useSetAtom } from "jotai";
import { type FC, useEffect, useLayoutEffect } from "react";
import { optimizeLyricOptionsAtom } from "../../states/appAtoms.ts";
import { useCursorAutoHide } from "../../utils/useCursorAutoHide.ts";
import { useTitlebarAutoHide } from "../../utils/useTitlebarAutoHide.ts";
import { AMLLContextMenuContent } from "../AMLLContextMenu/index.tsx";
import { AudioQualityDialog } from "../AudioQualityDialog/index.tsx";
import { BottomLyricInfo } from "../BottomLyricInfo";
import { RecordPanel } from "../RecordPanel/index.tsx";
import styles from "./index.module.css";
import "@applemusic-like-lyrics/core/style.css";
import "@applemusic-like-lyrics/react-full/style.css";

export const AMLLWrapper: FC = () => {
	const isLyricPageOpened = useAtomValue(isLyricPageOpenedAtom);
	const onPlayOrResume = useAtomValue(onPlayOrResumeAtom).onEmit;
	const setLyricPageOpened = useSetAtom(isLyricPageOpenedAtom);
	const optimizeOptions = useAtomValue(optimizeLyricOptionsAtom);

	useTitlebarAutoHide(isLyricPageOpened);
	const cursorHidden = useCursorAutoHide(isLyricPageOpened);

	useLayoutEffect(() => {
		if (isLyricPageOpened) {
			document.body.dataset.amllLyricsOpen = "";
		} else {
			delete document.body.dataset.amllLyricsOpen;
		}
	}, [isLyricPageOpened]);

	useEffect(() => {
		if (!isLyricPageOpened) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === " ") {
				e.preventDefault();
				onPlayOrResume?.();
			} else if (e.key === "Escape") {
				setLyricPageOpened(false);
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, [isLyricPageOpened, onPlayOrResume, setLyricPageOpened]);

	return (
		<>
			<ContextMenu.Root>
				<ContextMenu.Trigger>
					<div
						className={classnames(
							styles.lyricPage,
							isLyricPageOpened && styles.opened,
						)}
						id="amll-lyric-player-wrapper"
					>
						<PrebuiltLyricPlayer
							id="amll-lyric-player"
							style={{ width: "100%", height: "100%" }}
							bottomLineSlot={<BottomLyricInfo />}
							optimizeOptions={optimizeOptions}
						/>
						{cursorHidden && (
							<div className={styles.cursorHiddenOverlay} />
						)}
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
