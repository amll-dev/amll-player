import type { LyricLine } from "@applemusic-like-lyrics/core";
import { MediaButton } from "@applemusic-like-lyrics/react-full";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { AnimatePresence, motion } from "framer-motion";
import type React from "react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from "react";
import IconForward from "../../assets/icon_forward.svg?react";
import IconRewind from "../../assets/icon_rewind.svg?react";
import { AnimatedPlayPauseIcon } from "../../components/AnimatedPlayPauseIcon/index.tsx";
import {
	ALIGN_EVENT,
	CMD_GET_SYSTEM_THEME,
	CMD_REFRESH_TASKBAR_LAYOUT,
	CMD_SET_CLICK_INTERCEPTION,
	CMD_TASKBAR_LYRIC_PAGE_READY,
	CTRL_NEXT_EVENT,
	CTRL_PLAY_OR_RESUME_EVENT,
	CTRL_PREV_EVENT,
	FADE_IN_EVENT,
	FADE_OUT_EVENT,
	METADATA_EVENT,
	MODE_EVENT,
	PLAY_STATUS_EVENT,
	POSITION_EVENT,
	REQUEST_UPDATE_EVENT,
	SYSTEM_THEME_CHANGED_EVENT,
	type SystemThemeChangedPayload,
	TASKBAR_LAYOUT_EXTRA_EVENT,
	type TaskbarLayoutExtraPayload,
	type TaskbarLyricAlignmentPayload,
	type TaskbarLyricMetadataPayload,
	type TaskbarLyricModePayload,
	type TaskbarLyricPlayStatusPayload,
	type TaskbarLyricPositionPayload,
	type TaskbarLyricThemePayload,
	type TaskbarLyricWordProgressPayload,
	THEME_EVENT,
	WORD_PROGRESS_EVENT,
} from "../../components/TaskbarLyricBridge/types.ts";
import styles from "./index.module.css";
import "@applemusic-like-lyrics/react-full/style.css";
import {
	CMD_SHOW_MAIN_WINDOW_FROM_BACKGROUND,
	isTaskbarRestoreClick,
	type RestorePointerPosition,
} from "../../utils/window-lifecycle.ts";
import {
	hasPointerMoved,
	isPointerOutsideRect,
	type PointerPosition,
	shouldReactivateHover,
} from "./hover-state.ts";
import { LyricScroll } from "./LyricScroll.tsx";
import {
	formatEm,
	getCenteredLineStackOffsetEm,
	TASKBAR_LINE_HEIGHT_EM,
} from "./line-layout.ts";
import {
	findDisplayedLyricIndex,
	findMetadataLyricIndex,
	reconcileMetadataTimeline,
	taskbarContentGroupKey,
} from "./lyric-timeline.ts";
import { normalizeTaskbarWordFadeWidth } from "./word-progress.ts";

const HOVER_LAYOUT_TRANSITION = {
	type: "tween" as const,
	duration: 0.24,
	ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
};
const LYRIC_EXIT_EXTENT_HOLD_MS = 360;
const METADATA_LINE_STACK_OFFSET_EM = getCenteredLineStackOffsetEm([1, 0.85]);
const LYRIC_LINE_STACK_OFFSET_EM = getCenteredLineStackOffsetEm([1, 0.8]);
const SINGLE_LINE_DOUBLE_MODE_OFFSET_EM = getCenteredLineStackOffsetEm([1]);

type LayoutExtents = {
	orientation: "horizontal" | "vertical";
	collapsed: number;
	expanded: number;
	controls: number;
};

type PlaybackControlsProps = {
	isPlaying: boolean;
	enabled?: boolean;
	panelRef?: React.Ref<HTMLDivElement>;
	onPrev?: (event: React.MouseEvent) => void;
	onTogglePlay?: (event: React.MouseEvent) => void;
	onNext?: (event: React.MouseEvent) => void;
};

const PlaybackControls = ({
	isPlaying,
	enabled = true,
	panelRef,
	onPrev,
	onTogglePlay,
	onNext,
}: PlaybackControlsProps) => {
	const isInteractive = Boolean(enabled && onPrev && onTogglePlay && onNext);
	return (
		<div
			ref={panelRef}
			className={styles.controlsPanel}
			data-taskbar-lyric-control=""
		>
			<MediaButton
				className={styles.controlBtn}
				disabled={!isInteractive}
				onClick={onPrev}
				tabIndex={isInteractive ? undefined : -1}
			>
				<IconRewind className={styles.controlBtnIcon} />
			</MediaButton>
			<MediaButton
				className={`${styles.controlBtn} ${styles.controlBtnPlay}`}
				disabled={!isInteractive}
				onClick={onTogglePlay}
				tabIndex={isInteractive ? undefined : -1}
			>
				<AnimatedPlayPauseIcon
					playing={isPlaying}
					className={styles.controlBtnIconPlay}
				/>
			</MediaButton>
			<MediaButton
				className={styles.controlBtn}
				disabled={!isInteractive}
				onClick={onNext}
				tabIndex={isInteractive ? undefined : -1}
			>
				<IconForward className={styles.controlBtnIcon} />
			</MediaButton>
		</div>
	);
};

function getLyricText(line: LyricLine): string {
	return line.words.map((w) => w.word).join("");
}

type LyricItem = {
	key: string;
	text: string;
	words?: LyricLine["words"];
	status: "primary" | "secondary";
	startTime?: number;
	endTime?: number;
	nextStartTime?: number;
	isActive: boolean;
};

interface AppState {
	musicId: string;
	musicName: string;
	musicArtists: string;
	musicCover: string;
	musicCoverIsVideo: boolean;
	musicPlaying: boolean;
	lyricLines: LyricLine[];
	currentLyricIndex: number;
	jumpState: { lastIndex: number; jumpId: number };
	systemTheme: "dark" | "light";
	themeSetting: "dark" | "light" | "auto";
	systemAlign: "left" | "right";
	alignSetting: "left" | "right" | "auto";
	systemMode: "single" | "double";
	modeSetting: "auto" | "single" | "double";
	wordProgressEnabled: boolean;
	wordFadeWidth: number;
}

type Action =
	| {
			type: "SYNC_METADATA";
			payload: TaskbarLyricMetadataPayload;
			currentLyricIndex: number;
			trackChanged: boolean;
	  }
	| { type: "UPDATE_INDEX"; payload: number }
	| { type: "UPDATE_PLAY_STATUS"; payload: boolean }
	| { type: "UPDATE_SYSTEM_THEME"; payload: "dark" | "light" }
	| { type: "UPDATE_THEME_SETTING"; payload: "dark" | "light" | "auto" }
	| { type: "UPDATE_SYSTEM_ALIGN"; payload: "left" | "right" }
	| { type: "UPDATE_ALIGN_SETTING"; payload: "left" | "right" | "auto" }
	| { type: "UPDATE_SYSTEM_MODE"; payload: "single" | "double" }
	| { type: "UPDATE_MODE_SETTING"; payload: "auto" | "single" | "double" }
	| {
			type: "UPDATE_WORD_PROGRESS";
			payload: TaskbarLyricWordProgressPayload;
	  };

function reducer(state: AppState, action: Action): AppState {
	switch (action.type) {
		case "SYNC_METADATA": {
			const data = action.payload;
			const timeline = reconcileMetadataTimeline(
				state.currentLyricIndex,
				state.jumpState,
				action.currentLyricIndex,
				action.trackChanged,
				data.lyricLines.length,
			);
			return {
				...state,
				musicId: data.musicId,
				musicName: data.musicName,
				musicArtists: data.musicArtists.map((a) => a.name).join(" / "),
				musicCover: data.musicCover,
				musicCoverIsVideo: data.musicCoverIsVideo,
				lyricLines: data.lyricLines,
				currentLyricIndex: timeline.currentLyricIndex,
				jumpState: timeline.jumpState,
			};
		}

		case "UPDATE_INDEX": {
			const nextIndex = action.payload;
			if (nextIndex === state.currentLyricIndex) return state;

			const prevLastIndex = state.jumpState.lastIndex;
			const isJump = prevLastIndex !== -1 && nextIndex !== prevLastIndex + 1;

			return {
				...state,
				currentLyricIndex: nextIndex,
				jumpState: {
					lastIndex: nextIndex,
					jumpId: isJump ? state.jumpState.jumpId + 1 : state.jumpState.jumpId,
				},
			};
		}

		case "UPDATE_PLAY_STATUS": {
			return { ...state, musicPlaying: action.payload };
		}

		case "UPDATE_SYSTEM_THEME":
			return { ...state, systemTheme: action.payload };
		case "UPDATE_THEME_SETTING":
			return { ...state, themeSetting: action.payload };
		case "UPDATE_SYSTEM_ALIGN":
			return { ...state, systemAlign: action.payload };
		case "UPDATE_ALIGN_SETTING":
			return { ...state, alignSetting: action.payload };
		case "UPDATE_SYSTEM_MODE":
			return { ...state, systemMode: action.payload };
		case "UPDATE_MODE_SETTING":
			return { ...state, modeSetting: action.payload };
		case "UPDATE_WORD_PROGRESS":
			return {
				...state,
				wordProgressEnabled: action.payload.enabled,
				wordFadeWidth: normalizeTaskbarWordFadeWidth(action.payload.fadeWidth),
			};
		default:
			return state;
	}
}

const initialState: AppState = {
	musicId: "",
	musicName: "未知歌曲",
	musicArtists: "",
	musicCover: "",
	musicCoverIsVideo: false,
	musicPlaying: false,
	lyricLines: [],
	currentLyricIndex: -1,
	jumpState: { lastIndex: -1, jumpId: 0 },
	systemTheme: "light",
	themeSetting: "auto",
	systemAlign: "left",
	alignSetting: "auto",
	systemMode: "double",
	modeSetting: "auto",
	wordProgressEnabled: false,
	wordFadeWidth: 0.5,
};

export const TaskbarLyricApp = () => {
	const [state, dispatch] = useReducer(reducer, initialState);
	const [isVisible, setIsVisible] = useState(true);
	const [listenersReady, setListenersReady] = useState(false);
	const [initialLayoutReceived, setInitialLayoutReceived] = useState(false);
	const [initialAlignmentReceived, setInitialAlignmentReceived] =
		useState(false);
	const startupReady =
		listenersReady && initialLayoutReceived && initialAlignmentReceived;
	const startupReadyRef = useRef(false);
	useLayoutEffect(() => {
		startupReadyRef.current = startupReady;
	}, [startupReady]);
	const [orientation, setOrientation] = useState<"horizontal" | "vertical">(
		"horizontal",
	);
	const [contentOffset, setContentOffset] = useState({ x: 0, y: 0 });
	const [isHovered, setIsHovered] = useState(false);
	const [hoverGuardExtent, setHoverGuardExtent] = useState<{
		orientation: "horizontal" | "vertical";
		value: number;
	} | null>(null);
	const isHoveredRef = useRef(false);
	const hoverArmedRef = useRef(true);
	const hoverExitPointerRef = useRef<PointerPosition | null>(null);
	const latestPointerRef = useRef<PointerPosition | null>(null);
	const clickInterceptionRef = useRef<boolean | null>(null);
	const hoverUnlockTimerRef = useRef<number | null>(null);
	const hoverSurfaceRef = useRef<HTMLDivElement>(null);
	const layoutProbeLayerRef = useRef<HTMLDivElement>(null);
	const collapsedProbeRef = useRef<HTMLDivElement>(null);
	const expandedProbeRef = useRef<HTMLDivElement>(null);
	const controlsProbeRef = useRef<HTMLDivElement>(null);
	const restorePointerRef = useRef<RestorePointerPosition | null>(null);
	const [layoutExtents, setLayoutExtents] = useState<LayoutExtents | null>(
		null,
	);
	const [collapsedRenderExtent, setCollapsedRenderExtent] = useState<
		number | null
	>(null);
	const collapsedRenderExtentRef = useRef<number | null>(null);
	const collapsedShrinkTimerRef = useRef<number | null>(null);
	const hoverTransitionRef = useRef(false);
	const isHoverEvent = hoverTransitionRef.current;
	const positionRef = useRef(0);
	const anchorRef = useRef({ position: 0, time: performance.now() });

	const progressSubscribersRef = useRef<Set<(progress: number) => void>>(
		new Set(),
	);
	const publishProgress = useCallback((progress: number) => {
		progressSubscribersRef.current.forEach((cb) => {
			cb(progress);
		});
	}, []);
	const subscribeProgress = useCallback((cb: (progress: number) => void) => {
		progressSubscribersRef.current.add(cb);
		return () => {
			progressSubscribersRef.current.delete(cb);
		};
	}, []);
	const positionSubscribersRef = useRef<Set<(position: number) => void>>(
		new Set(),
	);
	const publishPosition = useCallback((position: number) => {
		positionSubscribersRef.current.forEach((callback) => {
			callback(position);
		});
	}, []);
	const subscribePosition = useCallback(
		(callback: (position: number) => void) => {
			positionSubscribersRef.current.add(callback);
			return () => {
				positionSubscribersRef.current.delete(callback);
			};
		},
		[],
	);

	const lyricLinesRef = useRef<LyricLine[]>([]);
	const musicIdRef = useRef<string | null>(null);
	useEffect(() => {
		lyricLinesRef.current = state.lyricLines;
	}, [state.lyricLines]);

	const updateAnchor = useCallback(
		(pos: number) => {
			anchorRef.current = { position: pos, time: performance.now() };
			positionRef.current = pos;
			publishPosition(pos);

			const nextIndex = findDisplayedLyricIndex(lyricLinesRef.current, pos);
			dispatch({ type: "UPDATE_INDEX", payload: nextIndex });
		},
		[publishPosition],
	);

	const fetchSystemTheme = async (): Promise<"light" | "dark"> => {
		try {
			const payload =
				await invoke<SystemThemeChangedPayload>(CMD_GET_SYSTEM_THEME);
			return payload.isLightTheme ? "light" : "dark";
		} catch (err) {
			console.error("获取系统初始主题失败", err);
			return "light";
		}
	};

	const setClickInterception = useCallback((intercept: boolean) => {
		if (clickInterceptionRef.current === intercept) return;
		clickInterceptionRef.current = intercept;
		invoke(CMD_SET_CLICK_INTERCEPTION, {
			intercept,
		}).catch((err) => {
			if (clickInterceptionRef.current === intercept) {
				clickInterceptionRef.current = null;
			}
			console.error(`设置鼠标拦截状态 ${intercept} 失败:`, err);
		});
	}, []);

	useEffect(() => {
		const handleResize = () => {
			const isVert = window.innerHeight > window.innerWidth;
			setOrientation(isVert ? "vertical" : "horizontal");

			const thickness = isVert ? window.innerWidth : window.innerHeight;
			dispatch({
				type: "UPDATE_SYSTEM_MODE",
				payload: thickness < 45 ? "single" : "double",
			});
		};
		handleResize();

		window.addEventListener("resize", handleResize);
		return () => {
			window.removeEventListener("resize", handleResize);
		};
	}, []);

	useEffect(() => {
		fetchSystemTheme().then((theme) => {
			dispatch({ type: "UPDATE_SYSTEM_THEME", payload: theme });
		});
	}, []);

	useEffect(() => {
		const unlistenMetadata = listen<TaskbarLyricMetadataPayload>(
			METADATA_EVENT,
			(evt) => {
				const previousMusicId = musicIdRef.current;
				const trackChanged = previousMusicId !== evt.payload.musicId;
				musicIdRef.current = evt.payload.musicId;
				lyricLinesRef.current = evt.payload.lyricLines;
				dispatch({
					type: "SYNC_METADATA",
					payload: evt.payload,
					currentLyricIndex: findMetadataLyricIndex(
						previousMusicId,
						evt.payload.musicId,
						evt.payload.lyricLines,
						positionRef.current,
					),
					trackChanged,
				});
			},
		);

		const unlistenPlayStatus = listen<TaskbarLyricPlayStatusPayload>(
			PLAY_STATUS_EVENT,
			(evt) => {
				const playing = evt.payload.musicPlaying;
				anchorRef.current = {
					position: anchorRef.current.position,
					time: performance.now(),
				};

				dispatch({ type: "UPDATE_PLAY_STATUS", payload: playing });
			},
		);

		const unlistenPosition = listen<TaskbarLyricPositionPayload>(
			POSITION_EVENT,
			(evt) => {
				updateAnchor(evt.payload.position);
			},
		);

		const unlistenTheme = listen<TaskbarLyricThemePayload>(
			THEME_EVENT,
			(evt) => {
				dispatch({ type: "UPDATE_THEME_SETTING", payload: evt.payload.theme });
			},
		);

		const unlistenAlign = listen<TaskbarLyricAlignmentPayload>(
			ALIGN_EVENT,
			(evt) => {
				dispatch({ type: "UPDATE_ALIGN_SETTING", payload: evt.payload.align });
				setInitialAlignmentReceived(true);
			},
		);

		const unlistenLayoutExtra = listen<TaskbarLayoutExtraPayload>(
			TASKBAR_LAYOUT_EXTRA_EVENT,
			(evt) => {
				dispatch({
					type: "UPDATE_SYSTEM_ALIGN",
					payload: evt.payload.isCentered ? "left" : "right",
				});
				setContentOffset({
					x: evt.payload.contentOffsetX,
					y: evt.payload.contentOffsetY,
				});
				setInitialLayoutReceived(true);
			},
		);

		const unlistenSystemTheme = listen<SystemThemeChangedPayload>(
			SYSTEM_THEME_CHANGED_EVENT,
			(evt) => {
				dispatch({
					type: "UPDATE_SYSTEM_THEME",
					payload: evt.payload.isLightTheme ? "light" : "dark",
				});
			},
		);

		const unlistenMode = listen<TaskbarLyricModePayload>(MODE_EVENT, (evt) =>
			dispatch({ type: "UPDATE_MODE_SETTING", payload: evt.payload.mode }),
		);
		const unlistenWordProgress = listen<TaskbarLyricWordProgressPayload>(
			WORD_PROGRESS_EVENT,
			(evt) =>
				dispatch({
					type: "UPDATE_WORD_PROGRESS",
					payload: evt.payload,
				}),
		);

		const unlistenFadeOut = listen(FADE_OUT_EVENT, () => {
			setIsVisible(false);
		});

		const unlistenFadeIn = listen(FADE_IN_EVENT, () => {
			setIsVisible(true);
		});
		const listeners = [
			unlistenMetadata,
			unlistenPlayStatus,
			unlistenPosition,
			unlistenTheme,
			unlistenAlign,
			unlistenLayoutExtra,
			unlistenSystemTheme,
			unlistenMode,
			unlistenWordProgress,
			unlistenFadeOut,
			unlistenFadeIn,
		];
		let cancelled = false;
		let startupRetryTimer = 0;
		const requestStartupState = () => {
			if (cancelled || startupReadyRef.current) return;
			emit(REQUEST_UPDATE_EVENT).catch((err) => {
				console.error("请求任务栏歌词数据更新失败:", err);
			});
			invoke(CMD_REFRESH_TASKBAR_LAYOUT).catch((err) => {
				console.error("刷新任务栏歌词布局失败:", err);
			});
			startupRetryTimer = window.setTimeout(requestStartupState, 250);
		};

		Promise.all(listeners)
			.then(() => {
				if (cancelled) return;
				setListenersReady(true);
				requestStartupState();
			})
			.catch((err) => {
				console.error("注册任务栏歌词事件监听失败:", err);
			});

		return () => {
			cancelled = true;
			window.clearTimeout(startupRetryTimer);
			listeners.forEach((listener) => {
				listener.then((fn) => fn());
			});
		};
	}, [updateAnchor]);

	useEffect(() => {
		// The native window must only show a frame whose final alignment and
		// taskbar offsets have already been committed to the DOM.
		if (!startupReady) return;
		let cancelled = false;
		let pageReadyFrame = 0;
		let pageReadyTimer = 0;
		let pageReadyRetryTimer = 0;
		let pageReadyAttempt = 0;
		let pageReadyInFlight = false;
		let pageReadyNotified = false;
		const generationParam = new URLSearchParams(window.location.search).get(
			"generation",
		);
		const pageGeneration = Number(generationParam);
		const hasValidPageGeneration =
			Number.isSafeInteger(pageGeneration) && pageGeneration > 0;
		const notifyPageReady = () => {
			if (cancelled || pageReadyNotified || pageReadyInFlight) return;
			if (!hasValidPageGeneration) {
				console.error("任务栏歌词页面缺少有效的窗口代际");
				return;
			}
			pageReadyInFlight = true;
			pageReadyAttempt += 1;
			invoke<void>(CMD_TASKBAR_LYRIC_PAGE_READY, {
				generation: pageGeneration,
			})
				.then(() => {
					pageReadyNotified = true;
				})
				.catch((err) => {
					if (cancelled) return;
					if (pageReadyAttempt >= 4) {
						console.error("通知任务栏歌词页面已准备失败:", err);
						return;
					}
					console.warn("通知任务栏歌词页面已准备失败，稍后重试:", err);
					pageReadyRetryTimer = window.setTimeout(
						notifyPageReady,
						100 * pageReadyAttempt,
					);
				})
				.finally(() => {
					pageReadyInFlight = false;
				});
		};

		pageReadyFrame = window.requestAnimationFrame(notifyPageReady);
		pageReadyTimer = window.setTimeout(notifyPageReady, 250);

		return () => {
			cancelled = true;
			window.cancelAnimationFrame(pageReadyFrame);
			window.clearTimeout(pageReadyTimer);
			window.clearTimeout(pageReadyRetryTimer);
		};
	}, [startupReady]);

	useEffect(() => {
		if (!state.musicPlaying) return;

		let rafId: number;
		const onFrame = () => {
			const elapsed = performance.now() - anchorRef.current.time;
			const currentPos = anchorRef.current.position + elapsed;
			positionRef.current = currentPos;
			publishPosition(currentPos);

			// Use silent gaps to prepare the next line, keeping word highlighting
			// on the unchanged playback clock published above.
			const nextIndex = findDisplayedLyricIndex(
				lyricLinesRef.current,
				currentPos,
			);

			dispatch({ type: "UPDATE_INDEX", payload: nextIndex });

			rafId = requestAnimationFrame(onFrame);
		};

		rafId = requestAnimationFrame(onFrame);

		return () => cancelAnimationFrame(rafId);
	}, [publishPosition, state.musicPlaying]);

	const {
		musicId,
		musicName,
		musicArtists,
		musicCover,
		musicCoverIsVideo,
		lyricLines,
		currentLyricIndex,
		jumpState,
		systemTheme,
		themeSetting,
		systemAlign,
		alignSetting,
		systemMode,
		modeSetting,
		wordProgressEnabled,
		wordFadeWidth,
	} = state;

	const theme = themeSetting === "auto" ? systemTheme : themeSetting;
	const align = alignSetting === "auto" ? systemAlign : alignSetting;

	const hasLyrics = lyricLines.length > 0;
	const currentLine =
		currentLyricIndex >= 0 ? lyricLines[currentLyricIndex] : null;
	const isMetadataMode = currentLyricIndex < 0 || !hasLyrics || !currentLine;
	const displayAsMetadata = isMetadataMode || isHovered;
	const isSingleLineMode =
		modeSetting === "auto" ? systemMode === "single" : modeSetting === "single";
	const isVert = orientation === "vertical";
	const measuredControlsExtent =
		layoutExtents?.orientation === orientation ? layoutExtents.controls : 0;
	const controlsEnterAnimation = {
		...(isVert
			? { height: measuredControlsExtent, marginTop: 0 }
			: { width: measuredControlsExtent, marginLeft: 0 }),
		opacity: 1,
		transition: HOVER_LAYOUT_TRANSITION,
	};
	const controlsExitAnimation = {
		...(isVert ? { height: 0, marginTop: -12 } : { width: 0, marginLeft: -12 }),
		opacity: 0,
		transition: HOVER_LAYOUT_TRANSITION,
	};
	const subLyricText = currentLine
		? currentLine.translatedLyric || currentLine.romanLyric || ""
		: "";
	const hasSubLyric = Boolean(subLyricText);

	const groupKey = taskbarContentGroupKey(
		musicId,
		displayAsMetadata,
		jumpState.jumpId,
	);

	const lyricItems: LyricItem[] = useMemo(() => {
		const items: LyricItem[] = [];
		if (currentLyricIndex >= 0 && currentLine) {
			const nextLine =
				currentLyricIndex + 1 < lyricLines.length
					? lyricLines[currentLyricIndex + 1]
					: undefined;

			items.push({
				key: `lyric-${currentLyricIndex}`,
				text: getLyricText(currentLine),
				words: currentLine.words,
				status: "primary",
				startTime: currentLine.startTime,
				endTime: currentLine.endTime,
				nextStartTime: nextLine?.startTime,
				isActive: true,
			});

			if (!isSingleLineMode) {
				if (hasSubLyric) {
					items.push({
						key: `lyric-${currentLyricIndex}-sub`,
						text: subLyricText,
						status: "secondary",
						startTime: currentLine.startTime,
						endTime: currentLine.endTime,
						nextStartTime: nextLine?.startTime,
						isActive: true,
					});
				} else if (nextLine) {
					const nextNextLine =
						currentLyricIndex + 2 < lyricLines.length
							? lyricLines[currentLyricIndex + 2]
							: undefined;

					items.push({
						key: `lyric-${currentLyricIndex + 1}`,
						text: getLyricText(nextLine),
						status: "secondary",
						startTime: nextLine.startTime,
						endTime: nextLine.endTime,
						nextStartTime: nextNextLine?.startTime,
						isActive: false,
					});
				}
			}
		}
		return items;
	}, [
		currentLyricIndex,
		lyricLines,
		currentLine,
		hasSubLyric,
		isSingleLineMode,
		subLyricText,
	]);

	useLayoutEffect(() => {
		const probeLayer = layoutProbeLayerRef.current;
		const collapsedProbe = collapsedProbeRef.current;
		const expandedProbe = expandedProbeRef.current;
		const controlsProbe = controlsProbeRef.current;
		if (!probeLayer || !collapsedProbe || !expandedProbe || !controlsProbe) {
			return;
		}

		let cancelled = false;
		const measure = () => {
			if (cancelled) return;

			const availableRect = probeLayer.getBoundingClientRect();
			const collapsedRect = collapsedProbe.getBoundingClientRect();
			const expandedRect = expandedProbe.getBoundingClientRect();
			const controlsRect = controlsProbe.getBoundingClientRect();
			const availableExtent = isVert
				? availableRect.height
				: availableRect.width;
			const next: LayoutExtents = {
				orientation,
				collapsed: Math.min(
					isVert ? collapsedRect.height : collapsedRect.width,
					availableExtent,
				),
				expanded: Math.min(
					isVert ? expandedRect.height : expandedRect.width,
					availableExtent,
				),
				controls: isVert ? controlsRect.height : controlsRect.width,
			};
			if (
				![next.collapsed, next.expanded, next.controls].every(
					(value) => Number.isFinite(value) && value > 0,
				)
			) {
				return;
			}

			setLayoutExtents((previous) => {
				if (
					previous?.orientation === next.orientation &&
					Math.abs(previous.collapsed - next.collapsed) < 0.25 &&
					Math.abs(previous.expanded - next.expanded) < 0.25 &&
					Math.abs(previous.controls - next.controls) < 0.25
				) {
					return previous;
				}
				return next;
			});
		};

		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(probeLayer);
		observer.observe(collapsedProbe);
		observer.observe(expandedProbe);
		observer.observe(controlsProbe);
		void document.fonts.ready.then(measure);

		return () => {
			cancelled = true;
			observer.disconnect();
		};
	}, [
		orientation,
		isVert,
		isMetadataMode,
		isSingleLineMode,
		musicName,
		musicArtists,
		lyricItems,
	]);

	useEffect(() => {
		if (collapsedShrinkTimerRef.current !== null) {
			window.clearTimeout(collapsedShrinkTimerRef.current);
			collapsedShrinkTimerRef.current = null;
		}

		const measured =
			layoutExtents?.orientation === orientation
				? layoutExtents.collapsed
				: null;
		const current = collapsedRenderExtentRef.current;
		const publish = (extent: number | null) => {
			collapsedRenderExtentRef.current = extent;
			setCollapsedRenderExtent(extent);
		};

		if (measured === null || current === null || measured >= current) {
			publish(measured);
			return;
		}
		if (isHovered) return;

		collapsedShrinkTimerRef.current = window.setTimeout(() => {
			collapsedShrinkTimerRef.current = null;
			publish(measured);
		}, LYRIC_EXIT_EXTENT_HOLD_MS);

		return () => {
			if (collapsedShrinkTimerRef.current !== null) {
				window.clearTimeout(collapsedShrinkTimerRef.current);
				collapsedShrinkTimerRef.current = null;
			}
		};
	}, [isHovered, layoutExtents, musicId, orientation]);

	const clearHoverUnlockTimer = useCallback(() => {
		if (hoverUnlockTimerRef.current === null) return;
		window.clearTimeout(hoverUnlockTimerRef.current);
		hoverUnlockTimerRef.current = null;
	}, []);

	const activateHover = useCallback(
		(pointer: PointerPosition) => {
			latestPointerRef.current = pointer;
			hoverArmedRef.current = true;
			isHoveredRef.current = true;
			hoverTransitionRef.current = true;
			hoverExitPointerRef.current = null;
			clearHoverUnlockTimer();

			const surfaceRect = hoverSurfaceRef.current?.getBoundingClientRect();
			if (surfaceRect) {
				if (!isPointerOutsideRect(pointer, surfaceRect, 0)) {
					setClickInterception(true);
				}
				const surfaceExtent = isVert ? surfaceRect.height : surfaceRect.width;
				const measuredLayout =
					layoutExtents?.orientation === orientation ? layoutExtents : null;
				setHoverGuardExtent({
					orientation,
					value: measuredLayout
						? Math.max(
								surfaceExtent,
								measuredLayout.collapsed,
								measuredLayout.expanded,
							)
						: surfaceExtent,
				});
			}

			setIsHovered(true);
		},
		[
			clearHoverUnlockTimer,
			isVert,
			layoutExtents,
			orientation,
			setClickInterception,
		],
	);

	const handleMouseEnter = (event: React.MouseEvent<HTMLDivElement>) => {
		const pointer = { x: event.clientX, y: event.clientY };
		latestPointerRef.current = pointer;
		if (!hoverArmedRef.current) {
			const hoverSurface = hoverSurfaceRef.current;
			if (
				!hoverSurface ||
				!shouldReactivateHover(
					pointer,
					hoverExitPointerRef.current,
					hoverSurface.getBoundingClientRect(),
				)
			) {
				return;
			}
		}

		activateHover(pointer);
	};

	const handleMouseLeave = (event: React.MouseEvent<HTMLDivElement>) => {
		const pointer = { x: event.clientX, y: event.clientY };
		latestPointerRef.current = pointer;

		if (!isHoveredRef.current) {
			const hoverSurface = hoverSurfaceRef.current;
			if (
				!hoverArmedRef.current &&
				(!hoverSurface ||
					isPointerOutsideRect(pointer, hoverSurface.getBoundingClientRect()))
			) {
				hoverArmedRef.current = true;
				hoverExitPointerRef.current = null;
			}
			setClickInterception(false);
			return;
		}

		isHoveredRef.current = false;
		hoverTransitionRef.current = true;
		hoverArmedRef.current = false;
		hoverExitPointerRef.current = pointer;
		setIsHovered(false);
		setClickInterception(false);

		clearHoverUnlockTimer();
		hoverUnlockTimerRef.current = window.setTimeout(() => {
			hoverUnlockTimerRef.current = null;
			if (!isHoveredRef.current) {
				setHoverGuardExtent(null);
			}
		}, 1500);
	};

	const handleControlsExitComplete = () => {
		if (isHoveredRef.current) return;
		clearHoverUnlockTimer();
		setHoverGuardExtent(null);

		window.requestAnimationFrame(() => {
			if (isHoveredRef.current || hoverArmedRef.current) return;

			const pointer = latestPointerRef.current;
			const hoverSurface = hoverSurfaceRef.current;
			if (
				pointer &&
				hoverSurface &&
				isPointerOutsideRect(pointer, hoverSurface.getBoundingClientRect())
			) {
				hoverArmedRef.current = true;
				hoverExitPointerRef.current = null;
			}
		});
	};

	useEffect(() => {
		setClickInterception(false);
	}, [setClickInterception]);

	useLayoutEffect(() => {
		const hoverSurface = hoverSurfaceRef.current;
		if (!hoverSurface) return;

		const releaseInterceptionOutsideSurface = () => {
			const pointer = latestPointerRef.current;
			if (
				pointer &&
				isPointerOutsideRect(pointer, hoverSurface.getBoundingClientRect(), 0)
			) {
				setClickInterception(false);
			}
		};

		const observer = new ResizeObserver(releaseInterceptionOutsideSurface);
		observer.observe(hoverSurface);
		return () => observer.disconnect();
	}, [setClickInterception]);

	useEffect(() => {
		const handlePointerMove = (event: MouseEvent) => {
			const pointer = { x: event.clientX, y: event.clientY };
			const previousPointer = latestPointerRef.current;
			latestPointerRef.current = pointer;

			if (!startupReadyRef.current || !isVisible || isHoveredRef.current)
				return;

			const exitPointer = hoverExitPointerRef.current;
			if (
				!hoverArmedRef.current &&
				exitPointer &&
				!hasPointerMoved(pointer, exitPointer)
			)
				return;

			const hoverSurface = hoverSurfaceRef.current;
			if (!hoverSurface) {
				hoverArmedRef.current = true;
				hoverExitPointerRef.current = null;
				return;
			}

			const surfaceRect = hoverSurface.getBoundingClientRect();
			if (isPointerOutsideRect(pointer, surfaceRect, 0)) {
				hoverArmedRef.current = true;
				hoverExitPointerRef.current = null;
				return;
			}

			if (
				// Re-entering through the retained guard does not cross the wrapper
				// boundary again. A move inside the surface must also handle armed
				// hover, including after native mouse forwarding recovers.
				shouldReactivateHover(
					pointer,
					exitPointer,
					surfaceRect,
					hoverArmedRef.current,
					previousPointer,
				)
			) {
				activateHover(pointer);
			}
		};

		const handleWindowMouseOut = (event: MouseEvent) => {
			if (event.relatedTarget !== null) return;

			const pointer = { x: event.clientX, y: event.clientY };
			latestPointerRef.current = pointer;
			const isAtViewportEdge =
				pointer.x <= 0 ||
				pointer.x >= window.innerWidth - 1 ||
				pointer.y <= 0 ||
				pointer.y >= window.innerHeight - 1;
			if (!isAtViewportEdge) return;

			hoverArmedRef.current = true;
			hoverExitPointerRef.current = null;
		};

		window.addEventListener("mousemove", handlePointerMove, { passive: true });
		window.addEventListener("mouseout", handleWindowMouseOut);
		return () => {
			window.removeEventListener("mousemove", handlePointerMove);
			window.removeEventListener("mouseout", handleWindowMouseOut);
		};
	}, [activateHover, isVisible]);

	useEffect(
		() => () => {
			clearHoverUnlockTimer();
		},
		[clearHoverUnlockTimer],
	);

	const handlePrev = (e: React.MouseEvent) => {
		e.stopPropagation();
		emit(CTRL_PREV_EVENT).catch(console.error);
	};

	const handleTogglePlay = (e: React.MouseEvent) => {
		e.stopPropagation();
		emit(CTRL_PLAY_OR_RESUME_EVENT).catch(console.error);
	};

	const handleNext = (e: React.MouseEvent) => {
		e.stopPropagation();
		emit(CTRL_NEXT_EVENT).catch(console.error);
	};

	const handleRestorePointerDown = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			restorePointerRef.current = null;
			if (event.button !== 0) return;
			const target = event.target;
			if (
				target instanceof Element &&
				target.closest("[data-taskbar-lyric-control]")
			) {
				return;
			}
			restorePointerRef.current = {
				pointerId: event.pointerId,
				x: event.clientX,
				y: event.clientY,
			};
		},
		[],
	);

	const handleRestorePointerUp = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			const start = restorePointerRef.current;
			restorePointerRef.current = null;
			const target = event.target;
			const blocked =
				event.button !== 0 ||
				(target instanceof Element &&
					Boolean(target.closest("[data-taskbar-lyric-control]")));
			if (
				!isTaskbarRestoreClick(
					start,
					{
						pointerId: event.pointerId,
						x: event.clientX,
						y: event.clientY,
					},
					blocked,
				)
			) {
				return;
			}
			void invoke(CMD_SHOW_MAIN_WINDOW_FROM_BACKGROUND).catch((error) => {
				console.error("显示播放器窗口失败", error);
			});
		},
		[],
	);

	useEffect(() => {
		const disableContextMenu = (e: MouseEvent) => {
			e.preventDefault();
		};

		document.addEventListener("contextmenu", disableContextMenu);

		return () => {
			document.removeEventListener("contextmenu", disableContextMenu);
		};
	}, []);

	const isOnlyOneItem = lyricItems.length === 1;
	const metadataPrimaryY = isSingleLineMode
		? "0em"
		: formatEm(METADATA_LINE_STACK_OFFSET_EM);
	const metadataSecondaryY = formatEm(
		TASKBAR_LINE_HEIGHT_EM + METADATA_LINE_STACK_OFFSET_EM,
	);
	const lyricPrimaryY = isSingleLineMode
		? 0
		: formatEm(
				isOnlyOneItem
					? SINGLE_LINE_DOUBLE_MODE_OFFSET_EM
					: LYRIC_LINE_STACK_OFFSET_EM,
			);
	const lyricSecondaryY = formatEm(
		TASKBAR_LINE_HEIGHT_EM + LYRIC_LINE_STACK_OFFSET_EM,
	);
	const lockedHoverGuardStyle: React.CSSProperties | undefined =
		hoverGuardExtent?.orientation === orientation
			? isVert
				? { minHeight: hoverGuardExtent.value }
				: { minWidth: hoverGuardExtent.value }
			: undefined;
	const measuredLayout =
		layoutExtents?.orientation === orientation ? layoutExtents : null;
	const targetContainerExtent = measuredLayout
		? isHovered
			? measuredLayout.expanded
			: (collapsedRenderExtent ?? measuredLayout.collapsed)
		: null;
	const containerSizeAnimation = isVert
		? {
				width: "100%",
				...(targetContainerExtent === null
					? {}
					: { height: targetContainerExtent }),
			}
		: {
				height: "100%",
				...(targetContainerExtent === null
					? {}
					: { width: targetContainerExtent }),
			};
	const renderGhostLines = (metadata: boolean) =>
		metadata ? (
			<>
				<div className={styles.ghostLine} data-status="primary">
					<span>{musicName}</span>
				</div>
				{!isSingleLineMode && (
					<div className={styles.ghostLine} data-status="secondary">
						<span>{musicArtists}</span>
					</div>
				)}
			</>
		) : (
			lyricItems.map((item) => (
				<div key={item.key} className={styles.ghostLine}>
					{item.text}
				</div>
			))
		);
	const renderLayoutProbe = (
		expanded: boolean,
		probeRef: React.Ref<HTMLDivElement>,
	) => {
		const metadata = expanded || isMetadataMode;
		return (
			<div
				ref={probeRef}
				className={`${styles.container} ${styles.layoutProbe}`}
				data-theme={theme}
				data-align={align}
				data-orientation={orientation}
				data-single-line={isSingleLineMode}
			>
				<div className={styles.coverWrapper} />
				{expanded && (
					<div className={styles.controlsWrapper}>
						<PlaybackControls
							isPlaying={state.musicPlaying}
							panelRef={controlsProbeRef}
						/>
					</div>
				)}
				<div
					className={styles.textPanel}
					data-content={metadata ? "metadata" : "lyrics"}
				>
					<div
						className={styles.groupContainer}
						data-group-content={metadata ? "metadata" : "lyrics"}
					>
						<div className={styles.ghostPanel}>
							{renderGhostLines(metadata)}
						</div>
					</div>
				</div>
			</div>
		);
	};

	return (
		<div
			className={styles.wrapper}
			data-ready={startupReady}
			inert={startupReady ? undefined : true}
			data-align={align}
			data-hovered={isHovered}
			data-orientation={orientation}
			data-visible={isVisible}
			style={{
				transform: `translate(${contentOffset.x}px, ${contentOffset.y}px)`,
			}}
			onMouseEnter={handleMouseEnter}
			onMouseLeave={handleMouseLeave}
		>
			<div
				className={styles.hoverGuard}
				data-align={align}
				data-orientation={orientation}
				style={lockedHoverGuardStyle}
				aria-hidden="true"
			/>
			<motion.div
				ref={hoverSurfaceRef}
				className={styles.container}
				data-theme={theme}
				data-align={align}
				data-orientation={orientation}
				data-single-line={isSingleLineMode}
				initial={false}
				animate={containerSizeAnimation}
				transition={HOVER_LAYOUT_TRANSITION}
				onPointerDown={handleRestorePointerDown}
				onPointerUp={handleRestorePointerUp}
				onPointerCancel={() => {
					restorePointerRef.current = null;
				}}
				onPointerLeave={() => {
					restorePointerRef.current = null;
				}}
				onMouseEnter={() => {
					if (!hoverArmedRef.current && !isHoveredRef.current) return;
					setClickInterception(true);
				}}
				onMouseLeave={() => setClickInterception(false)}
			>
				<div className={styles.coverWrapper}>
					<AnimatePresence initial={false}>
						{musicCover ? (
							musicCoverIsVideo ? (
								<motion.video
									key={musicCover}
									className={styles.cover}
									src={musicCover}
									autoPlay
									loop
									muted
									playsInline
									initial={{ opacity: 0 }}
									animate={{ opacity: 1 }}
									exit={{ opacity: 0 }}
									transition={{ duration: 0.3, ease: "easeInOut" }}
								/>
							) : (
								<motion.img
									key={musicCover}
									className={styles.cover}
									src={musicCover}
									alt="Cover"
									initial={{ opacity: 0 }}
									animate={{ opacity: 1 }}
									exit={{ opacity: 0 }}
									transition={{ duration: 0.3, ease: "easeInOut" }}
								/>
							)
						) : (
							<motion.div
								key="placeholder"
								className={styles.coverPlaceholder}
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{ duration: 0.3, ease: "easeInOut" }}
							/>
						)}
					</AnimatePresence>
				</div>

				<motion.div
					key={orientation}
					className={styles.controlsWrapper}
					data-visible={isHovered}
					aria-hidden={!isHovered}
					inert={isHovered ? undefined : true}
					initial={false}
					animate={isHovered ? controlsEnterAnimation : controlsExitAnimation}
					onAnimationComplete={() => {
						hoverTransitionRef.current = false;
						if (!isHoveredRef.current) handleControlsExitComplete();
					}}
				>
					<PlaybackControls
						isPlaying={state.musicPlaying}
						enabled={isHovered}
						onPrev={handlePrev}
						onTogglePlay={handleTogglePlay}
						onNext={handleNext}
					/>
				</motion.div>

				<div
					className={styles.textPanel}
					data-content={displayAsMetadata ? "metadata" : "lyrics"}
				>
					<AnimatePresence custom={isHoverEvent}>
						<motion.div
							key={groupKey}
							className={styles.groupContainer}
							data-group-content={displayAsMetadata ? "metadata" : "lyrics"}
							custom={isHoverEvent}
							variants={{
								initial: (isHoverFade: boolean) => ({
									x: isHoverFade ? 0 : isVert ? -35 : 0,
									y: isHoverFade ? 0 : isVert ? 0 : 35,
									opacity: 0,
									filter: isHoverFade ? "blur(0px)" : "blur(4px)",
								}),
								animate: (isHoverFade: boolean) => ({
									x: 0,
									y: 0,
									opacity: 1,
									filter: "blur(0px)",
									transition: isHoverFade
										? { duration: 0.2, ease: "easeOut" }
										: { type: "spring", stiffness: 250, damping: 30 },
								}),
								exit: (isHoverFade: boolean) => ({
									x: isHoverFade ? 0 : isVert ? 15 : 0,
									y: isHoverFade ? 0 : isVert ? 0 : -15,
									opacity: 0,
									filter: isHoverFade ? "blur(0px)" : "blur(4px)",
									transition: isHoverFade
										? { duration: 0.15, ease: "easeIn" }
										: { type: "spring", stiffness: 250, damping: 30 },
								}),
							}}
							initial="initial"
							animate="animate"
							exit="exit"
						>
							<div className={styles.ghostPanel} aria-hidden="true">
								{renderGhostLines(displayAsMetadata)}
							</div>

							{displayAsMetadata ? (
								<>
									<div
										className={styles.animatedLine}
										data-status="primary"
										style={{
											transform: isVert
												? "translateX(-0.2em) scale(1)"
												: `translateY(${metadataPrimaryY}) scale(1)`,
											opacity: 1,
										}}
									>
										{musicName}
									</div>
									{!isSingleLineMode && (
										<div
											className={styles.animatedLine}
											data-status="secondary"
											style={{
												transform: isVert
													? "translateX(-1.8em) scale(0.85)"
													: `translateY(${metadataSecondaryY}) scale(0.85)`,
												opacity: 1,
											}}
										>
											{musicArtists}
										</div>
									)}
								</>
							) : (
								<div className={styles.lyricViewport}>
									<div className={styles.lyricStack}>
										<AnimatePresence initial={false}>
											{lyricItems.map((item) => (
												<motion.div
													key={item.key}
													className={styles.animatedLine}
													data-status={item.status}
													initial={{
														x: isVert
															? isSingleLineMode
																? "-1.5em"
																: "-2.5em"
															: 0,
														y: isVert
															? 0
															: isSingleLineMode
																? "1.5em"
																: "2.5em",
														opacity: 0,
														scale: isSingleLineMode ? 1 : 0.8,
														filter: "blur(0px)",
													}}
													animate={
														item.status === "primary"
															? {
																	x: isVert ? "-0.2em" : 0,
																	y: isVert ? 0 : lyricPrimaryY,
																	opacity: 1,
																	scale: 1,
																	filter: "blur(0px)",
																}
															: {
																	x: isVert ? "-1.8em" : 0,
																	y: isVert ? 0 : lyricSecondaryY,
																	opacity: 1,
																	scale: 0.8,
																	filter: "blur(0px)",
																}
													}
													exit={{
														x: isVert
															? isSingleLineMode
																? "1.5em"
																: "0.8em"
															: 0,
														y: isVert
															? 0
															: isSingleLineMode
																? "-1.5em"
																: "-0.8em",
														opacity: 0,
														scale: 1,
														filter: "blur(4px)",
													}}
													transition={{
														type: "spring",
														stiffness: 250,
														damping: 30,
														mass: 0.8,
													}}
												>
													<LyricScroll
														text={item.text}
														status={item.status}
														orientation={orientation}
														align={align}
														startTime={item.startTime}
														endTime={item.endTime}
														nextStartTime={item.nextStartTime}
														isActive={item.isActive}
														isPlaying={state.musicPlaying}
														getCurrentPosition={() => positionRef.current}
														words={item.words}
														wordProgressEnabled={wordProgressEnabled}
														wordFadeWidth={wordFadeWidth}
														subscribePosition={
															item.status === "primary"
																? subscribePosition
																: undefined
														}
														onProgress={
															item.status === "primary"
																? publishProgress
																: undefined
														}
														subscribeProgress={
															item.status === "secondary"
																? subscribeProgress
																: undefined
														}
													/>
												</motion.div>
											))}
										</AnimatePresence>
									</div>
								</div>
							)}
						</motion.div>
					</AnimatePresence>
				</div>
			</motion.div>

			<div
				ref={layoutProbeLayerRef}
				className={styles.layoutProbeLayer}
				aria-hidden="true"
			>
				{renderLayoutProbe(false, collapsedProbeRef)}
				{renderLayoutProbe(true, expandedProbeRef)}
			</div>
		</div>
	);
};
