import {
	isLyricPageOpenedAtom,
	MediaButton,
	musicArtistsAtom,
	musicCoverAtom,
	musicCoverIsVideoAtom,
	musicIdAtom,
	musicNameAtom,
	musicPlayingAtom,
	onPlayOrResumeAtom,
	onRequestNextSongAtom,
	onRequestPrevSongAtom,
	TextMarquee,
} from "@applemusic-like-lyrics/react-full";
import lyricIcon from "@iconify/icons-ic/round-lyrics";
import { Icon } from "@iconify/react";
import {
	ListBulletIcon,
	TrackNextIcon,
	TrackPreviousIcon,
} from "@radix-ui/react-icons";
import { Flex, IconButton } from "@radix-ui/themes";
import { platform } from "@tauri-apps/plugin-os";
import classNames from "classnames";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
	type FC,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import IconForward from "../../assets/icon_forward.svg?react";
import IconRewind from "../../assets/icon_rewind.svg?react";
import {
	hasBackgroundAtom,
	hideNowPlayingBarAtom,
	isDarkThemeAtom,
	playlistCardOpenedAtom,
} from "../../states/appAtoms.ts";
import {
	effectiveHomeBackgroundConfigAtom,
	homeBackgroundLoadedAtom,
} from "../../states/homeBackgroundAtoms.ts";
import { mainWindowActiveAtom } from "../../states/windowAtoms.ts";
import { isCustomHomeBackground } from "../../utils/home-background-state.ts";
import { AnimatedPlayPauseIcon } from "../AnimatedPlayPauseIcon/index.tsx";
import {
	captureFullscreenCoverTransition,
	FullscreenCoverTransition,
	type FullscreenCoverTransitionSnapshot,
} from "../FullscreenCoverTransition/index.tsx";
import { NowPlaylistCard } from "../NowPlaylistCard/index.tsx";
import {
	PlaylistSnapshotBackdrop,
	usePlaylistBackdropSnapshot,
} from "../PlaylistSnapshotBackdrop/index.tsx";
import { useNativePlaylistUnderlay } from "../PlaylistSnapshotBackdrop/useNativePlaylistUnderlay.ts";
import styles from "./index.module.css";

const VIEWPORT_RESIZE_SETTLE_DELAY = 120;

export const NowPlayingBar: FC = () => {
	const { t } = useTranslation();
	const hideNowPlayingBar = useAtomValue(hideNowPlayingBarAtom);
	const isLyricPageOpened = useAtomValue(isLyricPageOpenedAtom);
	const mainWindowActive = useAtomValue(mainWindowActiveAtom);
	const musicName = useAtomValue(musicNameAtom);
	const musicArtists = useAtomValue(musicArtistsAtom);
	const musicPlaying = useAtomValue(musicPlayingAtom);
	const musicCover = useAtomValue(musicCoverAtom);
	const musicCoverIsVideo = useAtomValue(musicCoverIsVideoAtom);
	const musicId = useAtomValue(musicIdAtom);
	const hasBackground = useAtomValue(hasBackgroundAtom);
	const homeBackgroundConfig = useAtomValue(effectiveHomeBackgroundConfigAtom);
	const homeBackgroundLoaded = useAtomValue(homeBackgroundLoadedAtom);
	const isDarkTheme = useAtomValue(isDarkThemeAtom);
	const [playlistOpened, setPlaylistOpened] = useAtom(playlistCardOpenedAtom);
	const setLyricPageOpened = useSetAtom(isLyricPageOpenedAtom);
	const [coverTransition, setCoverTransition] =
		useState<FullscreenCoverTransitionSnapshot | null>(null);
	const [playlistPortalTarget, setPlaylistPortalTarget] =
		useState<HTMLElement | null>(null);
	const previousLyricPageOpenedRef = useRef(isLyricPageOpened);
	const coverTransitionBusyRef = useRef(false);

	const onPlayOrResume = useAtomValue(onPlayOrResumeAtom).onEmit;
	const onRequestPrevSong = useAtomValue(onRequestPrevSongAtom).onEmit;
	const onRequestNextSong = useAtomValue(onRequestNextSongAtom).onEmit;

	const playbarRef = useRef<HTMLDivElement>(null);
	const coverButtonRef = useRef<HTMLButtonElement>(null);
	const playlistPanelRef = useRef<HTMLDivElement>(null);
	const playlistDismissLayerRef = useRef<HTMLButtonElement>(null);
	const playlistToggleButtonRef = useRef<HTMLButtonElement>(null);
	const normalPlaylistActive =
		mainWindowActive &&
		playlistOpened &&
		!isLyricPageOpened &&
		playlistPortalTarget !== null;
	const playlistSnapshotSupported = platform() === "windows";
	// Transparent WebView2 windows cannot reliably blur page content behind
	// this panel, even when DWM supplies the default window material.
	const usePlaylistSnapshot =
		normalPlaylistActive && homeBackgroundLoaded && playlistSnapshotSupported;
	const playlistBackdrop = usePlaylistBackdropSnapshot(
		usePlaylistSnapshot,
		`${homeBackgroundConfig.mode}:${homeBackgroundConfig.assetId ?? ""}:${homeBackgroundConfig.updatedAt}:${isDarkTheme}`,
	);
	const playlistSurfaceReady =
		normalPlaylistActive &&
		homeBackgroundLoaded &&
		(!playlistSnapshotSupported || playlistBackdrop.isReady);
	const useNativeHomeMaterial =
		playlistSnapshotSupported &&
		!hasBackground &&
		!isCustomHomeBackground(homeBackgroundConfig);
	useNativePlaylistUnderlay(
		playlistSurfaceReady &&
			useNativeHomeMaterial &&
			playlistBackdrop.source !== null,
		playlistPanelRef,
		playlistPortalTarget,
	);
	const finishCoverTransition = useCallback(() => {
		coverTransitionBusyRef.current = false;
		setCoverTransition(null);
	}, []);
	const openLyricPage = () => {
		if (isLyricPageOpened || coverTransitionBusyRef.current) return;
		const source = coverButtonRef.current;
		const reduceMotion = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches;
		const snapshot =
			source && musicCover && !musicCoverIsVideo && !reduceMotion
				? captureFullscreenCoverTransition(source, musicCover, musicId, "enter")
				: null;
		coverTransitionBusyRef.current = snapshot !== null;
		setCoverTransition(snapshot);
		setLyricPageOpened(true);
	};

	useLayoutEffect(() => {
		const wasOpened = previousLyricPageOpenedRef.current;
		previousLyricPageOpenedRef.current = isLyricPageOpened;
		if (!wasOpened || isLyricPageOpened) return;

		const source = coverButtonRef.current;
		const reduceMotion = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches;
		const snapshot =
			source && musicCover && !musicCoverIsVideo && !reduceMotion
				? captureFullscreenCoverTransition(source, musicCover, musicId, "exit")
				: null;
		coverTransitionBusyRef.current = snapshot !== null;
		setCoverTransition(snapshot);
	}, [isLyricPageOpened, musicCover, musicCoverIsVideo, musicId]);

	useLayoutEffect(() => {
		if (
			coverTransition &&
			(coverTransition.coverUrl !== musicCover ||
				coverTransition.musicId !== musicId ||
				musicCoverIsVideo)
		) {
			coverTransitionBusyRef.current = false;
			setCoverTransition(null);
		}
	}, [coverTransition, musicCover, musicCoverIsVideo, musicId]);

	useLayoutEffect(() => {
		const playbarEl = playbarRef.current;
		if (!playbarEl) return;
		setPlaylistPortalTarget(
			playbarEl.closest<HTMLElement>("[data-amll-player-overlay-root]"),
		);
		const playbarBoundary = playbarEl.closest<HTMLElement>(
			"[data-amll-playbar-boundary]",
		);
		let viewportResizeFrame = 0;
		let secondViewportResizeFrame = 0;
		let viewportResizeTimeout = 0;
		const updateSafeBound = () => {
			const { height, top } = playbarEl.getBoundingClientRect();
			const parsedSeparatorHeight = playbarBoundary
				? Number.parseFloat(
						getComputedStyle(playbarBoundary).getPropertyValue(
							"--amll-player-separator-height",
						),
					)
				: 0;
			const separatorHeight = Number.isFinite(parsedSeparatorHeight)
				? parsedSeparatorHeight
				: 0;
			const compactHeight = Math.max(1, height + separatorHeight);
			const sheetTop = Math.min(
				window.innerHeight,
				Math.max(0, top - separatorHeight),
			);
			document.body.style.setProperty(
				"--amll-player-playbar-bottom",
				`${compactHeight}px`,
			);
			document.body.style.setProperty(
				"--amll-player-playbar-top",
				`${sheetTop}px`,
			);
			document.body.style.setProperty(
				"--amll-player-playbar-height",
				`${compactHeight}px`,
			);
		};
		const handleViewportResize = () => {
			if (playbarBoundary?.hasAttribute("data-amll-playbar-expanded")) {
				playbarBoundary.dataset.amllViewportResizing = "";
				window.clearTimeout(viewportResizeTimeout);
				cancelAnimationFrame(viewportResizeFrame);
				cancelAnimationFrame(secondViewportResizeFrame);
				viewportResizeTimeout = window.setTimeout(() => {
					viewportResizeTimeout = 0;
					viewportResizeFrame = requestAnimationFrame(() => {
						viewportResizeFrame = 0;
						secondViewportResizeFrame = requestAnimationFrame(() => {
							secondViewportResizeFrame = 0;
							delete playbarBoundary.dataset.amllViewportResizing;
						});
					});
				}, VIEWPORT_RESIZE_SETTLE_DELAY);
			}
			updateSafeBound();
		};
		const observer = new ResizeObserver(updateSafeBound);
		window.addEventListener("resize", handleViewportResize);
		window.visualViewport?.addEventListener("resize", handleViewportResize);
		observer.observe(playbarEl);
		updateSafeBound();
		return () => {
			window.removeEventListener("resize", handleViewportResize);
			window.visualViewport?.removeEventListener(
				"resize",
				handleViewportResize,
			);
			window.clearTimeout(viewportResizeTimeout);
			cancelAnimationFrame(viewportResizeFrame);
			cancelAnimationFrame(secondViewportResizeFrame);
			if (playbarBoundary) {
				delete playbarBoundary.dataset.amllViewportResizing;
			}
			observer.disconnect();
			document.body.style.removeProperty("--amll-player-playbar-bottom");
			document.body.style.removeProperty("--amll-player-playbar-top");
			document.body.style.removeProperty("--amll-player-playbar-height");
		};
	}, []);

	useLayoutEffect(() => {
		if (isLyricPageOpened) return;
		const playbarBoundary = playbarRef.current?.closest<HTMLElement>(
			"[data-amll-playbar-boundary]",
		);
		if (playbarBoundary) {
			delete playbarBoundary.dataset.amllViewportResizing;
		}
	}, [isLyricPageOpened]);

	useEffect(() => {
		if (!playlistOpened || isLyricPageOpened) return;

		const handlePointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			const targetElement = target instanceof Element ? target : null;
			if (
				playlistPanelRef.current?.contains(target) ||
				playlistDismissLayerRef.current?.contains(target) ||
				playlistToggleButtonRef.current?.contains(target) ||
				targetElement?.closest(
					'[data-amll-playlist-panel], [data-amll-toggle-type="playlist"]',
				)
			) {
				return;
			}
			setPlaylistOpened(false);
		};
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			setPlaylistOpened(false);
			playlistToggleButtonRef.current?.focus();
		};

		document.addEventListener("pointerdown", handlePointerDown, true);
		document.addEventListener("keydown", handleKeyDown, true);
		return () => {
			document.removeEventListener("pointerdown", handlePointerDown, true);
			document.removeEventListener("keydown", handleKeyDown, true);
		};
	}, [isLyricPageOpened, playlistOpened, setPlaylistOpened]);

	return (
		<>
			{coverTransition && (
				<FullscreenCoverTransition
					key={`${coverTransition.direction}:${coverTransition.musicId}:${coverTransition.coverUrl}`}
					snapshot={coverTransition}
					onFinish={finishCoverTransition}
				/>
			)}
			{/* <Container
		 	className={classNames(
		 		styles.nowPlayingBar,
		 		hideNowPlayingBar && styles.hide,
		 	)}
		 	position="fixed"
		 	bottom="0"
		 	left="0"
		 	right="0"
			> */}
			{playlistSurfaceReady &&
				playlistPortalTarget &&
				createPortal(
					<>
						<button
							ref={playlistDismissLayerRef}
							className={styles.playlistDismissLayer}
							data-amll-playlist-dismiss-layer=""
							type="button"
							tabIndex={-1}
							aria-label={t("playbar.playlist.close", "关闭当前播放列表")}
							onPointerDown={(event) => event.preventDefault()}
							onClick={(event) => {
								event.preventDefault();
								event.stopPropagation();
								setPlaylistOpened(false);
								playlistToggleButtonRef.current?.focus();
							}}
						/>
						<Flex
							className={classNames(
								styles.playlistPanel,
								playlistSnapshotSupported
									? styles.playlistPanelSnapshot
									: styles.playlistPanelLive,
							)}
							direction="row-reverse"
							mx="3"
							position="fixed"
							right="0"
							bottom="calc(var(--amll-player-playbar-bottom) + var(--space-3))"
							ref={playlistPanelRef}
							data-amll-playlist-panel=""
						>
							{playlistBackdrop.source && (
								<PlaylistSnapshotBackdrop
									source={playlistBackdrop.source}
									variant="compact"
								/>
							)}
							<NowPlaylistCard
								id="now-playlist-card"
								className={classNames(styles.playlistCard)}
								onRequestClose={() => {
									setPlaylistOpened(false);
									playlistToggleButtonRef.current?.focus();
								}}
							/>
						</Flex>
					</>,
					playlistPortalTarget,
				)}
			<Flex
				className={classNames(
					styles.playBar,
					hideNowPlayingBar && styles.hide,
					isLyricPageOpened && styles.lyricPageOpened,
				)}
				data-amll-playbar-content=""
				overflow="hidden"
				ref={playbarRef}
				inert={isLyricPageOpened ? true : undefined}
			>
				<Flex
					direction="row"
					justify="center"
					align="center"
					flexGrow="1"
					flexBasis="33.3%"
				>
					<button
						ref={coverButtonRef}
						data-amll-cover-transition-source=""
						className={classNames(
							styles.coverButton,
							coverTransition && styles.coverTransitionSourceHidden,
						)}
						type="button"
						disabled={isLyricPageOpened || coverTransition !== null}
						aria-label={t("playbar.openLyricPage", "打开全屏歌词")}
						style={{
							backgroundImage: `url(${musicCover})`,
						}}
						onClick={openLyricPage}
					>
						<div className={styles.lyricIconButton}>
							<Icon width={34} icon={lyricIcon} className="icon" />
						</div>
					</button>
					<Flex
						direction="column"
						justify="center"
						ml="4"
						flexGrow="1"
						minWidth="0"
						overflow="hidden"
						data-amll-playbar-reveal=""
						style={{
							textWrap: "nowrap",
						}}
					>
						<TextMarquee>{musicName}</TextMarquee>
						<TextMarquee>
							{musicArtists.map((v) => v.name).join(", ")}
						</TextMarquee>
					</Flex>
				</Flex>
				<Flex
					direction="row"
					justify="center"
					align="center"
					flexGrow="1"
					flexBasis="33.3%"
					gap="5"
					data-amll-playbar-reveal=""
					display={{
						initial: "none",
						sm: "flex",
					}}
				>
					<MediaButton
						style={{
							scale: "1.5",
						}}
						onClick={onRequestPrevSong}
					>
						<IconRewind
							style={{
								scale: "1.25",
							}}
						/>
					</MediaButton>
					<MediaButton
						style={{
							scale: "1.5",
						}}
						onClick={onPlayOrResume}
					>
						<AnimatedPlayPauseIcon
							playing={musicPlaying}
							style={{
								scale: "0.75",
							}}
						/>
					</MediaButton>
					<MediaButton
						style={{
							scale: "1.5",
						}}
						onClick={onRequestNextSong}
					>
						<IconForward
							style={{
								scale: "1.25",
							}}
						/>
					</MediaButton>
				</Flex>
				<Flex
					direction="row"
					justify="end"
					align="center"
					flexGrow={{
						initial: "0",
						sm: "1",
					}}
					flexBasis={{
						initial: "",
						sm: "33.3%",
					}}
					gap="1"
					data-amll-playbar-reveal=""
				>
					<Flex
						direction="row"
						justify="end"
						align="center"
						gap="1"
						display={{
							initial: "flex",
							sm: "none",
						}}
					>
						<IconButton onClick={onRequestPrevSong} variant="soft">
							<TrackPreviousIcon />
						</IconButton>
						<IconButton onClick={onPlayOrResume} variant="soft">
							<AnimatedPlayPauseIcon playing={musicPlaying} />
						</IconButton>
						<IconButton onClick={onRequestNextSong} variant="soft">
							<TrackNextIcon />
						</IconButton>
					</Flex>
					<IconButton
						ref={playlistToggleButtonRef}
						variant="soft"
						onClick={() => setPlaylistOpened((v) => !v)}
						aria-label={
							playlistOpened
								? t("playbar.playlist.close", "关闭当前播放列表")
								: t("playbar.playlist.open", "打开当前播放列表")
						}
						aria-expanded={playlistOpened}
						aria-controls="now-playlist-card"
						aria-haspopup="dialog"
					>
						<ListBulletIcon />
					</IconButton>
				</Flex>
			</Flex>
			{/* </Container> */}
		</>
	);
};
