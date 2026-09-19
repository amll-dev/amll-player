import {
	isLyricPageOpenedAtom,
	onPlayOrResumeAtom,
	PrebuiltLyricPlayer,
} from "@applemusic-like-lyrics/react-full";
import { ContextMenu } from "@radix-ui/themes";
import classnames from "classnames";
import { useAtomValue, useSetAtom } from "jotai";
import { type FC, useEffect, useLayoutEffect, useRef } from "react";
import { useCursorAutoHide } from "../../utils/useCursorAutoHide.ts";
import { useTitlebarAutoHide } from "../../utils/useTitlebarAutoHide.ts";
import { AMLLContextMenuContent } from "../AMLLContextMenu/index.tsx";
import { AudioQualityDialog } from "../AudioQualityDialog/index.tsx";
import { BottomLyricInfo } from "../BottomLyricInfo";
import { RecordPanel } from "../RecordPanel/index.tsx";
import { shouldPreservePointerFocusMode } from "./focus-modality.ts";
import styles from "./index.module.css";
import "@applemusic-like-lyrics/core/style.css";
import "@applemusic-like-lyrics/react-full/style.css";

export const AMLLWrapper: FC = () => {
	const isLyricPageOpened = useAtomValue(isLyricPageOpenedAtom);
	const onPlayOrResume = useAtomValue(onPlayOrResumeAtom).onEmit;
	const setLyricPageOpened = useSetAtom(isLyricPageOpenedAtom);
	const lyricPageRef = useRef<HTMLDivElement>(null);

	useTitlebarAutoHide(isLyricPageOpened);
	const cursorHidden = useCursorAutoHide(isLyricPageOpened);

	useLayoutEffect(() => {
		if (isLyricPageOpened) {
			document.body.dataset.amllLyricsOpen = "";
		} else {
			delete document.body.dataset.amllLyricsOpen;
			if (lyricPageRef.current) {
				delete lyricPageRef.current.dataset.pointerInput;
			}
		}
	}, [isLyricPageOpened]);

	useEffect(() => {
		if (!isLyricPageOpened) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (!shouldPreservePointerFocusMode(e) && lyricPageRef.current) {
				delete lyricPageRef.current.dataset.pointerInput;
			}
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
						ref={lyricPageRef}
						className={classnames(
							styles.lyricPage,
							isLyricPageOpened && styles.opened,
						)}
						id="amll-lyric-player-wrapper"
						onPointerDownCapture={(event) => {
							if (event.pointerType === "mouse") {
								event.currentTarget.dataset.pointerInput = "";
							}
						}}
					>
						<PrebuiltLyricPlayer
							id="amll-lyric-player"
							style={{ width: "100%", height: "100%" }}
							bottomLineSlot={<BottomLyricInfo />}
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
