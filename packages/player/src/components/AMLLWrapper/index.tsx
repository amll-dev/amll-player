import {
	isLyricPageOpenedAtom,
	onPlayOrResumeAtom,
	PrebuiltLyricPlayer,
} from "@applemusic-like-lyrics/react-full";
import { ContextMenu } from "@radix-ui/themes";
import { platform } from "@tauri-apps/plugin-os";
import classnames from "classnames";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
	type ComponentProps,
	type FC,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";
import { useTranslation } from "react-i18next";
import {
	enableExperimentalFeaturesAtom,
	playlistCardOpenedAtom,
	recordPanelOpenedAtom,
} from "../../states/appAtoms.ts";
import { mainWindowActiveAtom } from "../../states/windowAtoms.ts";
import { useCursorAutoHide } from "../../utils/useCursorAutoHide.ts";
import { useRetainedVisuals } from "../../utils/useRetainedVisuals.ts";
import { useTitlebarAutoHide } from "../../utils/useTitlebarAutoHide.ts";
import { AMLLContextMenuContent } from "../AMLLContextMenu/index.tsx";
import { AudioQualityDialog } from "../AudioQualityDialog/index.tsx";
import { BottomLyricInfo } from "../BottomLyricInfo";
import { NowPlaylistCard } from "../NowPlaylistCard/index.tsx";
import {
	PlaylistSnapshotBackdrop,
	usePlaylistBackdropSnapshot,
} from "../PlaylistSnapshotBackdrop/index.tsx";
import { PlaylistLiveBackdrop } from "../PlaylistSnapshotBackdrop/live.tsx";
import { RecordPanel } from "../RecordPanel/index.tsx";
import { SongVideoBackground } from "../SongVideoBackground/index.tsx";
import { shouldPreservePointerFocusMode } from "./focus-modality.ts";
import { getFullscreenControlMotion } from "./fullscreen-control-motion.ts";
import { calculateFullscreenPlaylistPlacement } from "./fullscreen-playlist-position.ts";
import styles from "./index.module.css";
import "@applemusic-like-lyrics/core/style.css";
import "@applemusic-like-lyrics/react-full/style.css";

const FULLSCREEN_PLAYLIST_TOGGLE_SELECTOR =
	'button[data-amll-toggle-type="playlist"]';
const FULLSCREEN_ANIMATED_CONTROL_SELECTOR =
	'button[data-amll-media-action="shuffle"], button[data-amll-media-action="repeat"], button[data-amll-toggle-type="lyrics"], button[data-amll-toggle-type="playlist"]';

type PrebuiltLyricPlayerWithBackgroundProps = ComponentProps<
	typeof PrebuiltLyricPlayer
> & {
	backgroundSlot?: ReactNode;
};

const PrebuiltLyricPlayerWithBackground =
	PrebuiltLyricPlayer as FC<PrebuiltLyricPlayerWithBackgroundProps>;

interface FullscreenControlAnimationState {
	animation: Animation | null;
	animationFrame: number;
}

const fullscreenControlAnimations = new WeakMap<
	HTMLButtonElement,
	FullscreenControlAnimationState
>();

const animateFullscreenControl = (button: HTMLButtonElement) => {
	const previous = fullscreenControlAnimations.get(button);
	if (previous?.animationFrame) {
		cancelAnimationFrame(previous.animationFrame);
	}

	const state: FullscreenControlAnimationState = {
		animation: previous?.animation ?? null,
		animationFrame: 0,
	};
	fullscreenControlAnimations.set(button, state);
	state.animationFrame = requestAnimationFrame(() => {
		state.animationFrame = 0;
		if (!button.isConnected) {
			state.animation?.cancel();
			fullscreenControlAnimations.delete(button);
			return;
		}

		const motion = getFullscreenControlMotion(
			button.dataset.amllMediaAction,
			button.dataset.amllToggleType,
		);
		if (
			!motion ||
			window.matchMedia("(prefers-reduced-motion: reduce)").matches
		) {
			state.animation?.cancel();
			fullscreenControlAnimations.delete(button);
			return;
		}

		const currentTransform = getComputedStyle(button).transform;
		state.animation?.cancel();
		const keyframes = motion.keyframes.map((keyframe, index) =>
			index === 0 && currentTransform !== "none"
				? { ...keyframe, transform: currentTransform }
				: keyframe,
		);
		const animation = button.animate(keyframes, {
			duration: motion.duration,
			easing: motion.easing,
		});
		state.animation = animation;
		const clearAnimation = () => {
			if (fullscreenControlAnimations.get(button) === state) {
				fullscreenControlAnimations.delete(button);
			}
		};
		animation.addEventListener("finish", clearAnimation, { once: true });
		animation.addEventListener("cancel", clearAnimation, { once: true });
	});
};

export const AMLLWrapper: FC = () => {
	const { t } = useTranslation();
	const enableExperimentalFeatures = useAtomValue(
		enableExperimentalFeaturesAtom,
	);
	const isLyricPageOpened = useAtomValue(isLyricPageOpenedAtom);
	const mainWindowActive = useAtomValue(mainWindowActiveAtom);
	const recordPanelOpened = useAtomValue(recordPanelOpenedAtom);
	const retainLyricVisuals = useRetainedVisuals(
		mainWindowActive || (isLyricPageOpened && recordPanelOpened),
	);
	const onPlayOrResume = useAtomValue(onPlayOrResumeAtom).onEmit;
	const [playlistOpened, setPlaylistOpened] = useAtom(playlistCardOpenedAtom);
	const setLyricPageOpened = useSetAtom(isLyricPageOpenedAtom);
	const lyricPageRef = useRef<HTMLDivElement>(null);
	const fullscreenPlaylistPanelRef = useRef<HTMLDivElement>(null);
	const fullscreenPlaylistToggleRef = useRef<HTMLButtonElement>(null);
	const previousLyricPageOpenedRef = useRef(isLyricPageOpened);
	const fullscreenPlaylistActive =
		mainWindowActive && isLyricPageOpened && playlistOpened;
	const fullscreenPlaylistSnapshotSupported = platform() === "windows";
	const fullscreenPlaylistBackdrop = usePlaylistBackdropSnapshot(
		fullscreenPlaylistActive && fullscreenPlaylistSnapshotSupported,
		enableExperimentalFeatures,
	);
	const fullscreenPlaylistSurfaceReady =
		fullscreenPlaylistActive &&
		(!fullscreenPlaylistSnapshotSupported ||
			fullscreenPlaylistBackdrop.isReady);
	const useCapturedFullscreenPlaylistSurface =
		fullscreenPlaylistBackdrop.source !== null;

	const findVisibleFullscreenPlaylistToggle = () => {
		const remembered = fullscreenPlaylistToggleRef.current;
		if (remembered?.isConnected && remembered.getClientRects().length > 0) {
			return remembered;
		}
		const buttons = lyricPageRef.current?.querySelectorAll<HTMLButtonElement>(
			FULLSCREEN_PLAYLIST_TOGGLE_SELECTOR,
		);
		return Array.from(buttons ?? []).find((button) => {
			if (button.getClientRects().length === 0) return false;
			const style = getComputedStyle(button);
			return style.display !== "none" && style.visibility !== "hidden";
		});
	};

	const focusFullscreenPlaylistToggle = () => {
		requestAnimationFrame(() => {
			findVisibleFullscreenPlaylistToggle()?.focus();
		});
	};

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

	useLayoutEffect(() => {
		if (!isLyricPageOpened || !lyricPageRef.current) return;

		const label = playlistOpened
			? t("playbar.playlist.close", "关闭当前播放列表")
			: t("playbar.playlist.open", "打开当前播放列表");
		const buttons = lyricPageRef.current.querySelectorAll<HTMLButtonElement>(
			FULLSCREEN_PLAYLIST_TOGGLE_SELECTOR,
		);
		for (const button of buttons) {
			button.dataset.amllPlaylistOpened = playlistOpened ? "true" : "false";
			button.setAttribute("aria-label", label);
			button.setAttribute("aria-expanded", String(playlistOpened));
			button.setAttribute("aria-controls", "fullscreen-now-playlist-card");
			button.setAttribute("aria-haspopup", "dialog");
		}

		return () => {
			for (const button of buttons) {
				delete button.dataset.amllPlaylistOpened;
				button.removeAttribute("aria-expanded");
				button.removeAttribute("aria-controls");
				button.removeAttribute("aria-haspopup");
			}
		};
	}, [isLyricPageOpened, playlistOpened, retainLyricVisuals, t]);

	useLayoutEffect(() => {
		if (!isLyricPageOpened || !playlistOpened) return;
		const lyricPage = lyricPageRef.current;
		const panel = fullscreenPlaylistPanelRef.current;
		if (!lyricPage || !panel) return;

		let animationFrame = 0;
		const updatePlacement = () => {
			animationFrame = 0;
			const trigger = findVisibleFullscreenPlaylistToggle();
			if (!trigger) return;
			fullscreenPlaylistToggleRef.current = trigger;

			const containerRect = lyricPage.getBoundingClientRect();
			const triggerRect = trigger.getBoundingClientRect();
			const panelRect = panel.getBoundingClientRect();
			const computedStyle = getComputedStyle(lyricPage);
			const gap =
				Number.parseFloat(computedStyle.getPropertyValue("--space-3")) || 12;
			const titlebarHeight =
				Number.parseFloat(
					computedStyle.getPropertyValue("--system-titlebar-height"),
				) || 0;
			const placement = calculateFullscreenPlaylistPlacement(
				containerRect,
				triggerRect,
				panelRect.width,
				gap,
				titlebarHeight + gap,
			);
			panel.style.setProperty(
				"--amll-fullscreen-playlist-left",
				`${placement.left}px`,
			);
			panel.style.setProperty(
				"--amll-fullscreen-playlist-bottom",
				`${placement.bottom}px`,
			);
			panel.style.setProperty(
				"--amll-fullscreen-playlist-max-height",
				`${placement.maxHeight}px`,
			);
		};
		const schedulePlacement = () => {
			if (animationFrame) cancelAnimationFrame(animationFrame);
			animationFrame = requestAnimationFrame(updatePlacement);
		};
		const observer = new ResizeObserver(schedulePlacement);
		observer.observe(lyricPage);
		observer.observe(panel);
		for (const button of lyricPage.querySelectorAll<HTMLButtonElement>(
			FULLSCREEN_PLAYLIST_TOGGLE_SELECTOR,
		)) {
			observer.observe(button);
		}
		window.addEventListener("resize", schedulePlacement);
		schedulePlacement();

		return () => {
			if (animationFrame) cancelAnimationFrame(animationFrame);
			observer.disconnect();
			window.removeEventListener("resize", schedulePlacement);
		};
	}, [
		fullscreenPlaylistBackdrop.isReady,
		isLyricPageOpened,
		playlistOpened,
		retainLyricVisuals,
	]);

	useLayoutEffect(() => {
		if (previousLyricPageOpenedRef.current && !isLyricPageOpened) {
			setPlaylistOpened(false);
		}
		previousLyricPageOpenedRef.current = isLyricPageOpened;
	}, [isLyricPageOpened, setPlaylistOpened]);

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
				if (playlistOpened) {
					e.preventDefault();
					e.stopPropagation();
					setPlaylistOpened(false);
					focusFullscreenPlaylistToggle();
				} else {
					setLyricPageOpened(false);
				}
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, [
		isLyricPageOpened,
		onPlayOrResume,
		playlistOpened,
		setLyricPageOpened,
		setPlaylistOpened,
	]);

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
						inert={isLyricPageOpened ? undefined : true}
						onPointerDownCapture={(event) => {
							if (event.pointerType === "mouse") {
								event.currentTarget.dataset.pointerInput = "";
							}
						}}
						onClick={(event) => {
							const target = event.target;
							const controlButton =
								target instanceof Element
									? target.closest<HTMLButtonElement>(
											FULLSCREEN_ANIMATED_CONTROL_SELECTOR,
										)
									: null;
							if (
								!controlButton ||
								!event.currentTarget.contains(controlButton)
							) {
								return;
							}
							animateFullscreenControl(controlButton);
							if (controlButton.dataset.amllToggleType === "playlist") {
								fullscreenPlaylistToggleRef.current = controlButton;
								setPlaylistOpened((opened) => !opened);
							}
						}}
					>
						<div
							className={styles.lyricContent}
							data-amll-fullscreen-content=""
						>
							{retainLyricVisuals && (
								<PrebuiltLyricPlayerWithBackground
									id="amll-lyric-player"
									style={{ width: "100%", height: "100%" }}
									bottomLineSlot={<BottomLyricInfo />}
									backgroundSlot={<SongVideoBackground />}
								/>
							)}
						</div>
						{fullscreenPlaylistSurfaceReady && (
							<>
								<button
									className={styles.fullscreenPlaylistDismissLayer}
									data-amll-playlist-dismiss-layer=""
									type="button"
									tabIndex={-1}
									aria-label={t("playbar.playlist.close", "关闭当前播放列表")}
									onClick={() => {
										setPlaylistOpened(false);
										focusFullscreenPlaylistToggle();
									}}
								/>
								<div
									ref={fullscreenPlaylistPanelRef}
									className={classnames(
										styles.fullscreenPlaylistPanel,
										useCapturedFullscreenPlaylistSurface
											? styles.fullscreenPlaylistPanelSnapshot
											: styles.fullscreenPlaylistPanelLive,
									)}
									data-amll-playlist-panel=""
									onPointerDown={(event) => event.stopPropagation()}
								>
									{useCapturedFullscreenPlaylistSurface &&
										fullscreenPlaylistBackdrop.source && (
											<PlaylistSnapshotBackdrop
												source={fullscreenPlaylistBackdrop.source}
												variant="fullscreen"
											/>
										)}
									<PlaylistLiveBackdrop sourceContainerRef={lyricPageRef} />
									<NowPlaylistCard
										id="fullscreen-now-playlist-card"
										className={styles.fullscreenPlaylistCard}
										onRequestClose={() => {
											setPlaylistOpened(false);
											focusFullscreenPlaylistToggle();
										}}
									/>
								</div>
							</>
						)}
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
