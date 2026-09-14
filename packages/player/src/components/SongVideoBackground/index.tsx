import {
	MeshGradientRenderer,
	PixiRenderer,
} from "@applemusic-like-lyrics/core";
import { BackgroundRender } from "@applemusic-like-lyrics/react";
import {
	cssBackgroundPropertyAtom,
	isLyricPageOpenedAtom,
	lowFreqVolumeAtom,
	lyricBackgroundFPSAtom,
	lyricBackgroundRendererAtom,
	lyricBackgroundRenderScaleAtom,
	lyricBackgroundStaticModeAtom,
	musicCoverAtom,
	musicCoverIsVideoAtom,
	musicIdAtom,
	musicPlayingAtom,
	musicPlayingPositionAtom,
} from "@applemusic-like-lyrics/react-full";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useAtomValue, useStore } from "jotai";
import {
	type FC,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	enableExperimentalFeaturesAtom,
	lyricBackgroundAnimationIntensityAtom,
	musicTimelineJumpAtom,
} from "../../states/appAtoms.ts";
import { resolveBackgroundRendererOptions } from "../../utils/background-renderer-options.ts";
import {
	db,
	type SongBackgroundOverride,
	type SongVideoBackground as SongVideoBackgroundRecord,
	type SongVideoBaseRendererMode,
} from "../../utils/db-client.ts";
import { useDbQuery } from "../../utils/use-db-query.ts";
import styles from "./index.module.css";
import {
	circularVideoDriftMs,
	isVideoTimeInSegment,
	normalizeVideoSegment,
	resolveVideoTimeMs,
	type VideoSegment,
} from "./timeline.ts";

const HARD_SYNC_DRIFT_MS = 250;
const SOFT_SYNC_DRIFT_MS = 80;
const FIRST_FRAME_DRIFT_MS = 80;
const HARD_SYNC_COOLDOWN_MS = 500;
const VIDEO_END_FRAME_OFFSET_MS = 16;
const TIMELINE_JUMP_SAMPLE_GRACE_MS = 1_500;

interface MusicClockSample {
	positionMs: number;
	observedAt: number;
}

interface VideoMediaState {
	key: string | null;
	status: "loading" | "ready" | "failed";
}

interface InitialFrameTarget {
	key: string;
	timeMs: number;
}

interface PendingTimelineJump {
	positionMs: number;
	observedAt: number;
}

interface QueriedSongBackground {
	override: SongBackgroundOverride | null;
	video: SongVideoBackgroundRecord | null;
}

function usePageVisibility(): boolean {
	const [visible, setVisible] = useState(
		() =>
			typeof document === "undefined" || document.visibilityState === "visible",
	);
	useEffect(() => {
		if (typeof document === "undefined") return;
		const update = () => setVisible(document.visibilityState === "visible");
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);
	return visible;
}

function useReducedMotion(): boolean {
	const [reduced, setReduced] = useState(
		() =>
			typeof window !== "undefined" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches,
	);
	useEffect(() => {
		if (typeof window === "undefined") return;
		const query = window.matchMedia("(prefers-reduced-motion: reduce)");
		const update = () => setReduced(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);
	return reduced;
}

function clampOpacity(value: number): number {
	if (!Number.isFinite(value)) return 1;
	return Math.min(1, Math.max(0, value));
}

function resolveObjectFit(value: unknown): "cover" | "contain" | "fill" {
	return value === "contain" || value === "fill" ? value : "cover";
}

function resolveVideoBaseRendererMode(
	value: unknown,
): SongVideoBaseRendererMode {
	return value === "mesh" || value === "pixi" ? value : "css-bg";
}

function resolveVideoBaseCssBackground(value: unknown): string {
	return typeof value === "string" && value.trim() ? value : "#000000";
}

function resolveFileSource(filePath: string | null): string | null {
	if (!filePath) return null;
	try {
		return convertFileSrc(filePath);
	} catch {
		return null;
	}
}

export const SongVideoBackground: FC = () => {
	const store = useStore();
	const enableExperimentalFeatures = useAtomValue(
		enableExperimentalFeaturesAtom,
	);
	const musicId = useAtomValue(musicIdAtom);
	const musicCover = useAtomValue(musicCoverAtom);
	const musicCoverIsVideo = useAtomValue(musicCoverIsVideoAtom);
	const musicPlaying = useAtomValue(musicPlayingAtom);
	const lyricPageOpened = useAtomValue(isLyricPageOpenedAtom);
	const rendererValue = useAtomValue(lyricBackgroundRendererAtom);
	const cssBackground = useAtomValue(cssBackgroundPropertyAtom);
	const fps = useAtomValue(lyricBackgroundFPSAtom);
	const renderScale = useAtomValue(lyricBackgroundRenderScaleAtom);
	const staticMode = useAtomValue(lyricBackgroundStaticModeAtom);
	const lowFreqVolume = useAtomValue(lowFreqVolumeAtom);
	const backgroundAnimationIntensity = useAtomValue(
		lyricBackgroundAnimationIntensityAtom,
	);
	const pageVisible = usePageVisibility();
	const reducedMotion = useReducedMotion();

	const videoRef = useRef<HTMLVideoElement>(null);
	const activeMediaKeyRef = useRef<string | null>(null);
	const mediaStateRef = useRef<VideoMediaState>({
		key: null,
		status: "loading",
	});
	const initialFrameTargetRef = useRef<InitialFrameTarget | null>(null);
	const cancelFirstFrameRef = useRef<(() => void) | null>(null);
	const stallFallbackRef = useRef<number | null>(null);
	const anchorRef = useRef({ musicMs: 0, videoMs: 0 });
	const lastHardSyncRef = useRef(0);
	const musicPlayingRef = useRef(musicPlaying);
	const presentationAllowedRef = useRef(lyricPageOpened && pageVisible);
	const dynamicPlaybackAllowedRef = useRef(false);
	const musicClockRef = useRef<MusicClockSample>({
		positionMs: store.get(musicPlayingPositionAtom),
		observedAt: performance.now(),
	});
	const pendingTimelineJumpRef = useRef<PendingTimelineJump | null>(null);
	const lastTimelineJumpSequenceRef = useRef(
		store.get(musicTimelineJumpAtom).sequence,
	);
	const [mediaState, setMediaState] = useState<VideoMediaState>({
		key: null,
		status: "loading",
	});

	mediaStateRef.current = mediaState;
	presentationAllowedRef.current = lyricPageOpened && pageVisible;
	const { data: queriedBackground } = useDbQuery<QueriedSongBackground>(
		async () => {
			if (!enableExperimentalFeatures || !musicId) {
				return { override: null, video: null };
			}
			const [backgroundOverride, video] = await Promise.all([
				db.songBackgroundOverrides.get(musicId),
				db.videoBackgrounds.get(musicId),
			]);
			return { override: backgroundOverride, video };
		},
		[enableExperimentalFeatures, musicId],
		{ override: null, video: null },
		["song_background_overrides", "song_video_backgrounds"],
	);
	const backgroundOverride =
		enableExperimentalFeatures && queriedBackground.override?.songId === musicId
			? queriedBackground.override
			: null;
	const background =
		enableExperimentalFeatures && queriedBackground.video?.songId === musicId
			? queriedBackground.video
			: null;
	const rendererOptions = resolveBackgroundRendererOptions(
		{
			fps,
			animationIntensity: backgroundAnimationIntensity,
			renderScale,
			staticMode,
			cssBackground,
		},
		backgroundOverride,
		musicId,
		enableExperimentalFeatures,
	);
	const effectiveStaticMode = rendererOptions.staticMode;
	dynamicPlaybackAllowedRef.current =
		musicPlaying &&
		lyricPageOpened &&
		pageVisible &&
		!reducedMotion &&
		!effectiveStaticMode;
	useEffect(() => {
		MeshGradientRenderer.setRhythmVisualIntensity(
			rendererOptions.animationIntensity,
		);
	}, [rendererOptions.animationIntensity]);
	const videoEnabled =
		backgroundOverride?.overrideEnabled === true &&
		backgroundOverride.rendererMode === "video" &&
		background !== null;
	const source = useMemo(
		() =>
			resolveFileSource(videoEnabled ? (background?.filePath ?? null) : null),
		[background?.filePath, videoEnabled],
	);
	const segment = useMemo<VideoSegment | null>(
		() =>
			background
				? normalizeVideoSegment(
						{
							inPointMs: background.inPointMs,
							outPointMs: background.outPointMs,
							loopEnabled: background.loopEnabled,
						},
						background.durationMs,
					)
				: null,
		[
			background?.durationMs,
			background?.inPointMs,
			background?.loopEnabled,
			background?.outPointMs,
		],
	);
	const mediaKey = useMemo(
		() =>
			source && segment && background
				? JSON.stringify([
						background.songId,
						background.assetId,
						background.filePath,
						background.durationMs,
						segment.inPointMs,
						segment.outPointMs,
						segment.loopEnabled,
						background.updatedAt,
					])
				: null,
		[
			background?.assetId,
			background?.durationMs,
			background?.filePath,
			background?.songId,
			background?.updatedAt,
			segment?.inPointMs,
			segment?.loopEnabled,
			segment?.outPointMs,
			source,
		],
	);
	const setVideoElement = useCallback(
		(video: HTMLVideoElement | null) => {
			videoRef.current = video;
			if (video) {
				activeMediaKeyRef.current = mediaKey;
			} else if (activeMediaKeyRef.current === mediaKey) {
				activeMediaKeyRef.current = null;
			}
		},
		[mediaKey],
	);

	const videoReady =
		mediaKey !== null &&
		mediaState.key === mediaKey &&
		mediaState.status === "ready";
	const videoFailed =
		mediaKey !== null &&
		mediaState.key === mediaKey &&
		mediaState.status === "failed";
	const dualLayer = videoEnabled && backgroundOverride?.dualLayer === true;
	const configuredVideoOpacity = backgroundOverride?.videoOpacity ?? 0.4;
	const videoOpacity =
		videoReady && !videoFailed
			? dualLayer
				? clampOpacity(configuredVideoOpacity)
				: 1
			: 0;
	const baseOpacity = videoOpacity > 0 && !dualLayer ? 0 : 1;
	const videoCoversBase = videoOpacity === 1;
	const runnable =
		videoOpacity > 0.001 &&
		musicPlaying &&
		lyricPageOpened &&
		pageVisible &&
		!reducedMotion &&
		!effectiveStaticMode;
	const syncOnSeek = background?.syncOnSeek ?? true;

	const readMusicTimeMs = useCallback(() => {
		const sample = musicClockRef.current;
		if (!musicPlayingRef.current) return Math.max(0, sample.positionMs);
		return Math.max(
			0,
			sample.positionMs + (performance.now() - sample.observedAt),
		);
	}, []);

	const cancelFirstFrame = useCallback(() => {
		cancelFirstFrameRef.current?.();
		cancelFirstFrameRef.current = null;
	}, []);
	const cancelStallFallback = useCallback(() => {
		if (stallFallbackRef.current !== null) {
			window.clearTimeout(stallFallbackRef.current);
			stallFallbackRef.current = null;
		}
	}, []);

	const updateMediaState = useCallback((nextState: VideoMediaState) => {
		mediaStateRef.current = nextState;
		setMediaState(nextState);
	}, []);

	const markVideoFailed = useCallback(
		(expectedKey: string, video: HTMLVideoElement, error?: unknown) => {
			if (
				activeMediaKeyRef.current !== expectedKey ||
				videoRef.current !== video
			) {
				return;
			}
			if (
				typeof error === "object" &&
				error !== null &&
				"name" in error &&
				error.name === "AbortError"
			) {
				return;
			}
			cancelStallFallback();
			cancelFirstFrame();
			video.pause();
			video.playbackRate = 1;
			updateMediaState({ key: expectedKey, status: "failed" });
		},
		[cancelFirstFrame, cancelStallFallback, updateMediaState],
	);

	const scheduleStallFallback = useCallback(
		(expectedKey: string, video: HTMLVideoElement) => {
			if (
				activeMediaKeyRef.current !== expectedKey ||
				videoRef.current !== video
			) {
				return;
			}
			cancelStallFallback();
			stallFallbackRef.current = window.setTimeout(() => {
				stallFallbackRef.current = null;
				if (
					!dynamicPlaybackAllowedRef.current ||
					activeMediaKeyRef.current !== expectedKey ||
					videoRef.current !== video ||
					video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
				) {
					return;
				}
				markVideoFailed(expectedKey, video);
			}, 2_000);
		},
		[cancelStallFallback, markVideoFailed],
	);

	const queuePresentedFrame = useCallback(
		(video: HTMLVideoElement, expectedKey: string) => {
			const currentState = mediaStateRef.current;
			if (
				!presentationAllowedRef.current ||
				activeMediaKeyRef.current !== expectedKey ||
				videoRef.current !== video ||
				video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
				(currentState.key === expectedKey && currentState.status !== "loading")
			) {
				return;
			}
			cancelStallFallback();
			const initialTarget = initialFrameTargetRef.current;
			if (
				initialTarget?.key === expectedKey &&
				Math.abs(video.currentTime * 1_000 - initialTarget.timeMs) >
					FIRST_FRAME_DRIFT_MS
			) {
				return;
			}

			cancelFirstFrame();
			let settled = false;
			let videoFrameCallbackId: number | null = null;
			let firstFrame = 0;
			let secondFrame = 0;
			const cancelScheduledFrames = () => {
				if (videoFrameCallbackId !== null) {
					video.cancelVideoFrameCallback(videoFrameCallbackId);
					videoFrameCallbackId = null;
				}
				if (firstFrame) {
					cancelAnimationFrame(firstFrame);
					firstFrame = 0;
				}
				if (secondFrame) {
					cancelAnimationFrame(secondFrame);
					secondFrame = 0;
				}
			};
			const finishAttempt = () => {
				if (settled) return false;
				settled = true;
				cancelScheduledFrames();
				cancelFirstFrameRef.current = null;
				return true;
			};
			const confirmPresentedFrame = () => {
				if (settled) return;
				if (
					!presentationAllowedRef.current ||
					activeMediaKeyRef.current !== expectedKey ||
					videoRef.current !== video ||
					(mediaStateRef.current.key === expectedKey &&
						mediaStateRef.current.status === "failed")
				) {
					finishAttempt();
					return;
				}

				const actualMs = video.currentTime * 1_000;
				const frozenTarget = initialFrameTargetRef.current;
				if (
					frozenTarget?.key === expectedKey &&
					Math.abs(actualMs - frozenTarget.timeMs) > FIRST_FRAME_DRIFT_MS
				) {
					finishAttempt();
					video.currentTime = frozenTarget.timeMs / 1_000;
					return;
				}

				if (!finishAttempt()) return;
				const musicMs = readMusicTimeMs();
				anchorRef.current = { musicMs, videoMs: actualMs };
				initialFrameTargetRef.current = null;
				updateMediaState({ key: expectedKey, status: "ready" });
			};

			if (typeof video.requestVideoFrameCallback === "function") {
				videoFrameCallbackId = video.requestVideoFrameCallback(
					confirmPresentedFrame,
				);
			}

			// requestVideoFrameCallback only observes the *next* presented frame.
			// A hidden, paused video may already have presented its decoded seek
			// target before fullscreen opens, so no later frame arrives. Always race
			// it with a two-RAF fallback once HAVE_CURRENT_DATA is available.
			firstFrame = requestAnimationFrame(() => {
				secondFrame = requestAnimationFrame(confirmPresentedFrame);
			});
			cancelFirstFrameRef.current = () => {
				if (settled) return;
				settled = true;
				cancelScheduledFrames();
			};
		},
		[cancelFirstFrame, cancelStallFallback, readMusicTimeMs, updateMediaState],
	);

	const recoverPresentableVideo = useCallback(
		(
			video: HTMLVideoElement,
			expectedKey: string,
			expectedSegment: VideoSegment,
			expectedSyncOnSeek: boolean,
		) => {
			if (
				activeMediaKeyRef.current !== expectedKey ||
				videoRef.current !== video
			) {
				return;
			}
			cancelStallFallback();
			const recoveringFromFailure =
				mediaStateRef.current.key === expectedKey &&
				mediaStateRef.current.status === "failed";
			if (recoveringFromFailure) {
				updateMediaState({ key: expectedKey, status: "loading" });
			} else {
				queuePresentedFrame(video, expectedKey);
				return;
			}
			const targetMs = expectedSyncOnSeek
				? resolveVideoTimeMs(
						expectedSegment.inPointMs + readMusicTimeMs(),
						expectedSegment,
					)
				: resolveVideoTimeMs(video.currentTime * 1_000, expectedSegment);
			initialFrameTargetRef.current = { key: expectedKey, timeMs: targetMs };
			if (Math.abs(video.currentTime * 1_000 - targetMs) > 1) {
				video.currentTime = targetMs / 1_000;
				return;
			}
			queuePresentedFrame(video, expectedKey);
		},
		[
			cancelStallFallback,
			queuePresentedFrame,
			readMusicTimeMs,
			updateMediaState,
		],
	);

	useEffect(() => {
		const observePosition = () => {
			const now = performance.now();
			const positionMs = store.get(musicPlayingPositionAtom);
			const pendingJump = pendingTimelineJumpRef.current;
			if (pendingJump) {
				const elapsedMs = now - pendingJump.observedAt;
				const expectedPositionMs =
					pendingJump.positionMs +
					(musicPlayingRef.current ? Math.max(0, elapsedMs) : 0);
				if (
					elapsedMs < TIMELINE_JUMP_SAMPLE_GRACE_MS &&
					Math.abs(positionMs - expectedPositionMs) >= HARD_SYNC_DRIFT_MS
				) {
					return;
				}
				pendingTimelineJumpRef.current = null;
			}
			musicClockRef.current = {
				positionMs,
				observedAt: now,
			};
		};
		const observePlaying = () => {
			const now = performance.now();
			const previousSample = musicClockRef.current;
			const positionMs = musicPlayingRef.current
				? previousSample.positionMs + (now - previousSample.observedAt)
				: previousSample.positionMs;
			musicPlayingRef.current = store.get(musicPlayingAtom);
			musicClockRef.current = { positionMs, observedAt: now };
		};
		observePosition();
		musicPlayingRef.current = store.get(musicPlayingAtom);
		const unsubscribePosition = store.sub(
			musicPlayingPositionAtom,
			observePosition,
		);
		const unsubscribePlaying = store.sub(musicPlayingAtom, observePlaying);
		return () => {
			unsubscribePosition();
			unsubscribePlaying();
		};
	}, [store]);

	useEffect(() => {
		const handleTimelineJump = () => {
			const timelineJump = store.get(musicTimelineJumpAtom);
			if (lastTimelineJumpSequenceRef.current === timelineJump.sequence) return;
			lastTimelineJumpSequenceRef.current = timelineJump.sequence;
			const jumpObservedAt = performance.now();
			pendingTimelineJumpRef.current = {
				positionMs: timelineJump.positionMs,
				observedAt: jumpObservedAt,
			};
			musicClockRef.current = {
				positionMs: timelineJump.positionMs,
				observedAt: jumpObservedAt,
			};

			const video = videoRef.current;
			if (!video || !segment || !mediaKey || !videoReady) return;
			if (syncOnSeek) {
				const targetMs = resolveVideoTimeMs(
					segment.inPointMs + timelineJump.positionMs,
					segment,
				);
				video.currentTime = targetMs / 1_000;
				video.playbackRate = 1;
				lastHardSyncRef.current = performance.now();
			} else {
				anchorRef.current = {
					musicMs: timelineJump.positionMs,
					videoMs: video.currentTime * 1_000,
				};
			}
		};
		const unsubscribe = store.sub(musicTimelineJumpAtom, handleTimelineJump);
		return unsubscribe;
	}, [mediaKey, segment, store, syncOnSeek, videoReady]);

	useEffect(() => {
		cancelFirstFrame();
		cancelStallFallback();
		initialFrameTargetRef.current = null;
		lastHardSyncRef.current = 0;
		updateMediaState({ key: mediaKey, status: "loading" });
		const musicMs = readMusicTimeMs();
		anchorRef.current = {
			musicMs,
			videoMs: segment?.inPointMs ?? 0,
		};
	}, [
		cancelFirstFrame,
		cancelStallFallback,
		mediaKey,
		readMusicTimeMs,
		segment?.inPointMs,
		updateMediaState,
	]);

	useEffect(() => {
		if (!mediaKey) return;
		const video = videoRef.current;
		return () => {
			cancelFirstFrame();
			cancelStallFallback();
			if (!video) return;
			video.pause();
			video.playbackRate = 1;
			video.removeAttribute("src");
			video.load();
		};
	}, [cancelFirstFrame, cancelStallFallback, mediaKey]);

	useEffect(() => {
		if (!presentationAllowedRef.current) {
			cancelFirstFrame();
		}
		if (!dynamicPlaybackAllowedRef.current) {
			cancelStallFallback();
		}
	}, [
		cancelFirstFrame,
		cancelStallFallback,
		lyricPageOpened,
		musicPlaying,
		pageVisible,
		reducedMotion,
		effectiveStaticMode,
	]);

	useEffect(() => {
		if (!lyricPageOpened || !pageVisible || !mediaKey || !segment || videoReady)
			return;
		const video = videoRef.current;
		if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
		recoverPresentableVideo(video, mediaKey, segment, syncOnSeek);
	}, [
		lyricPageOpened,
		mediaKey,
		pageVisible,
		recoverPresentableVideo,
		segment,
		syncOnSeek,
		videoFailed,
		videoReady,
	]);

	useEffect(() => {
		if (
			!mediaKey ||
			videoReady ||
			videoFailed ||
			!lyricPageOpened ||
			!pageVisible
		)
			return;
		const timeout = window.setTimeout(() => {
			const video = videoRef.current;
			if (video) markVideoFailed(mediaKey, video);
		}, 12_000);
		return () => window.clearTimeout(timeout);
	}, [
		lyricPageOpened,
		markVideoFailed,
		mediaKey,
		pageVisible,
		videoFailed,
		videoReady,
	]);

	useEffect(() => {
		const video = videoRef.current;
		if (!video || !segment || !mediaKey || !videoReady || !runnable) return;
		const musicMs = readMusicTimeMs();
		if (syncOnSeek) {
			const targetMs = resolveVideoTimeMs(segment.inPointMs + musicMs, segment);
			const actualMs = video.currentTime * 1_000;
			if (
				!isVideoTimeInSegment(actualMs, segment) ||
				Math.abs(circularVideoDriftMs(actualMs, targetMs, segment)) >=
					HARD_SYNC_DRIFT_MS
			) {
				video.currentTime = targetMs / 1_000;
			}
		} else {
			anchorRef.current = { musicMs, videoMs: video.currentTime * 1_000 };
		}
	}, [mediaKey, readMusicTimeMs, runnable, segment, syncOnSeek, videoReady]);

	useEffect(() => {
		const video = videoRef.current;
		if (!video || !segment || !mediaKey || !videoReady || !runnable) {
			video?.pause();
			if (video) video.playbackRate = 1;
			return;
		}

		let disposed = false;
		let animationFrame = 0;
		let playPending = false;
		let playbackBlocked = false;
		const ensurePlaying = () => {
			if (video.seeking || !video.paused || playPending || playbackBlocked)
				return;
			playPending = true;
			void video.play().then(
				() => {
					playPending = false;
				},
				(error: unknown) => {
					playPending = false;
					if (disposed) return;
					if (
						typeof error === "object" &&
						error !== null &&
						"name" in error &&
						error.name === "NotAllowedError"
					) {
						// Keep the decoded frame visible instead of treating an autoplay
						// policy rejection as a corrupt or unsupported video.
						playbackBlocked = true;
						video.playbackRate = 1;
						return;
					}
					markVideoFailed(mediaKey, video, error);
				},
			);
		};

		const syncFrame = () => {
			if (disposed) return;
			const musicMs = readMusicTimeMs();
			const rawTargetMs = syncOnSeek
				? segment.inPointMs + musicMs
				: anchorRef.current.videoMs + (musicMs - anchorRef.current.musicMs);
			const targetMs = resolveVideoTimeMs(rawTargetMs, segment);
			const actualMs = video.currentTime * 1_000;
			const actualInSegment = isVideoTimeInSegment(actualMs, segment);
			const driftMs = circularVideoDriftMs(actualMs, targetMs, segment);
			const now = performance.now();
			const reachedOutPoint =
				!segment.loopEnabled && rawTargetMs >= segment.outPointMs;
			if (reachedOutPoint) {
				const endFrameMs = Math.max(
					segment.inPointMs,
					segment.outPointMs - VIDEO_END_FRAME_OFFSET_MS,
				);
				if (Math.abs(video.currentTime * 1_000 - endFrameMs) > 1) {
					video.currentTime = endFrameMs / 1_000;
				}
				video.pause();
				video.playbackRate = 1;
				return;
			}

			if (!actualInSegment) {
				video.currentTime = targetMs / 1_000;
				video.playbackRate = 1;
				lastHardSyncRef.current = now;
			} else if (
				Math.abs(driftMs) >= HARD_SYNC_DRIFT_MS &&
				now - lastHardSyncRef.current >= HARD_SYNC_COOLDOWN_MS
			) {
				video.currentTime = targetMs / 1_000;
				video.playbackRate = 1;
				lastHardSyncRef.current = now;
			} else if (Math.abs(driftMs) >= SOFT_SYNC_DRIFT_MS) {
				video.playbackRate = Math.min(
					1.02,
					Math.max(0.98, 1 + driftMs / 10_000),
				);
			} else {
				video.playbackRate = 1;
			}

			ensurePlaying();
			animationFrame = requestAnimationFrame(syncFrame);
		};

		syncFrame();
		return () => {
			disposed = true;
			if (animationFrame) cancelAnimationFrame(animationFrame);
			video.pause();
			video.playbackRate = 1;
		};
	}, [
		markVideoFailed,
		mediaKey,
		readMusicTimeMs,
		runnable,
		segment,
		syncOnSeek,
		videoReady,
	]);

	const videoBaseRendererMode = resolveVideoBaseRendererMode(
		backgroundOverride?.videoBaseRendererMode,
	);
	const overrideBaseRendererMode =
		backgroundOverride?.overrideEnabled !== true
			? null
			: backgroundOverride.rendererMode === "video"
				? videoBaseRendererMode
				: backgroundOverride.rendererMode;
	const overrideBaseRenderer =
		overrideBaseRendererMode === "mesh"
			? MeshGradientRenderer
			: overrideBaseRendererMode === "pixi"
				? PixiRenderer
				: overrideBaseRendererMode === "css-bg"
					? "css-bg"
					: null;
	const baseRendererValue = overrideBaseRenderer ?? rendererValue.renderer;
	const renderer =
		typeof baseRendererValue !== "string"
			? baseRendererValue
			: baseRendererValue === "pixi"
				? PixiRenderer
				: MeshGradientRenderer;
	const basePlaying =
		!videoCoversBase && lyricPageOpened && pageVisible && !reducedMotion;
	const baseStatic =
		effectiveStaticMode || !lyricPageOpened || !pageVisible || reducedMotion;
	const fitMode = resolveObjectFit(background?.fitMode);
	const effectiveCssBackground =
		backgroundOverride?.overrideEnabled === true &&
		backgroundOverride.rendererMode === "video"
			? resolveVideoBaseCssBackground(backgroundOverride.videoBaseCssBackground)
			: rendererOptions.cssBackground;

	return (
		<div className={styles.layers} data-amll-song-video-background="">
			<div
				className={styles.baseLayer}
				style={{ opacity: baseOpacity }}
				data-amll-song-background-base=""
			>
				{baseRendererValue === "css-bg" ? (
					<div
						className={styles.cssBackground}
						data-amll-css-background=""
						style={{ background: effectiveCssBackground }}
					/>
				) : (
					<BackgroundRender
						album={musicCover}
						albumIsVideo={musicCoverIsVideo}
						fps={rendererOptions.fps}
						lowFreqVolume={lowFreqVolume}
						renderScale={rendererOptions.renderScale}
						renderer={renderer}
						playing={basePlaying}
						staticMode={baseStatic}
					/>
				)}
			</div>
			{source && segment && mediaKey && background && (
				<video
					key={mediaKey}
					ref={setVideoElement}
					className={styles.videoLayer}
					data-amll-video-background=""
					src={source}
					muted
					playsInline
					disablePictureInPicture
					preload="auto"
					aria-hidden="true"
					tabIndex={-1}
					style={{
						objectFit: fitMode,
						objectPosition: "center center",
						opacity: videoOpacity,
					}}
					onLoadedMetadata={(event) => {
						const video = event.currentTarget;
						if (
							activeMediaKeyRef.current !== mediaKey ||
							videoRef.current !== video
						) {
							return;
						}
						const musicMs = readMusicTimeMs();
						const targetMs = syncOnSeek
							? resolveVideoTimeMs(segment.inPointMs + musicMs, segment)
							: segment.inPointMs;
						anchorRef.current = {
							musicMs,
							videoMs: segment.inPointMs,
						};
						initialFrameTargetRef.current = { key: mediaKey, timeMs: targetMs };
						if (Math.abs(video.currentTime * 1_000 - targetMs) > 1) {
							video.currentTime = targetMs / 1_000;
						} else if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
							queuePresentedFrame(video, mediaKey);
						}
					}}
					onLoadedData={(event) =>
						recoverPresentableVideo(
							event.currentTarget,
							mediaKey,
							segment,
							syncOnSeek,
						)
					}
					onSeeked={(event) =>
						queuePresentedFrame(event.currentTarget, mediaKey)
					}
					onEnded={(event) => {
						const video = event.currentTarget;
						if (
							activeMediaKeyRef.current !== mediaKey ||
							videoRef.current !== video
						) {
							return;
						}
						if (!segment.loopEnabled) {
							video.currentTime =
								Math.max(
									segment.inPointMs,
									segment.outPointMs - VIDEO_END_FRAME_OFFSET_MS,
								) / 1_000;
							video.pause();
							return;
						}
						const musicMs = readMusicTimeMs();
						const rawTargetMs = syncOnSeek
							? segment.inPointMs + musicMs
							: anchorRef.current.videoMs +
								(musicMs - anchorRef.current.musicMs);
						video.currentTime =
							resolveVideoTimeMs(rawTargetMs, segment) / 1_000;
						video.playbackRate = 1;
					}}
					onError={(event) => markVideoFailed(mediaKey, event.currentTarget)}
					onAbort={(event) => markVideoFailed(mediaKey, event.currentTarget)}
					onStalled={(event) =>
						scheduleStallFallback(mediaKey, event.currentTarget)
					}
					onWaiting={(event) =>
						scheduleStallFallback(mediaKey, event.currentTarget)
					}
					onCanPlay={(event) =>
						recoverPresentableVideo(
							event.currentTarget,
							mediaKey,
							segment,
							syncOnSeek,
						)
					}
					onPlaying={() => cancelStallFallback()}
				/>
			)}
		</div>
	);
};
