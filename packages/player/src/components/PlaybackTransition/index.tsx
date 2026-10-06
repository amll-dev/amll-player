import {
	isLyricPageOpenedAtom,
	musicCoverAtom,
	musicCoverIsVideoAtom,
} from "@applemusic-like-lyrics/react-full";
import { cubicBezier } from "framer-motion";
import { useAtomValue } from "jotai";
import {
	createContext,
	type PropsWithChildren,
	type RefObject,
	useContext,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import styles from "./index.module.css";
import { type Animate, createInfoMotion, type InfoPose } from "./info-motion";

type Rect = Pick<DOMRect, "left" | "top" | "width" | "height">;
type Presentation = {
	opened: boolean;
	appRef: RefObject<HTMLDivElement | null>;
	barRef: RefObject<HTMLDivElement | null>;
	compactCoverRef: RefObject<HTMLDivElement | null>;
	compactVideoRef: RefObject<HTMLVideoElement | null>;
	compactInfoRef: RefObject<HTMLDivElement | null>;
	compactInfoSlotRef: RefObject<HTMLDivElement | null>;
	fullInfoRef: (node: HTMLDivElement | null) => void;
	videoRef: RefObject<HTMLVideoElement | null>;
	openButtonRef: RefObject<HTMLButtonElement | null>;
	pageRef: (node: HTMLDivElement | null) => void;
	coverRef: (node: HTMLDivElement | null) => void;
	coverFrameRef: (node: HTMLDivElement | null) => void;
	collapseButtonRef: (node: HTMLButtonElement | null) => void;
};

const PresentationContext = createContext<Presentation | null>(null);

export function usePlaybackPresentation() {
	const value = useContext(PresentationContext);
	if (!value) throw new Error("PlaybackTransition is missing");
	return value;
}

const mix = (from: number, to: number, progress: number) =>
	from + (to - from) * progress;
const sheetEase = cubicBezier(0.32, 0.72, 0.35, 1);
const sheetEasing = "cubic-bezier(.32,.72,.35,1)";
const near = (a: Rect, b: Rect) =>
	Math.max(
		...(["left", "top", "width", "height"] as const).map((key) =>
			Math.abs(a[key] - b[key]),
		),
	) < 1;

/** 底栏与全屏播放页共用的过渡时间轴，目标状态仍只由 `isLyricPageOpenedAtom` 决定 */
export function PlaybackTransition({ children }: PropsWithChildren) {
	const opened = useAtomValue(isLyricPageOpenedAtom);
	const coverUrl = useAtomValue(musicCoverAtom);
	const coverIsVideo = useAtomValue(musicCoverIsVideoAtom);
	const appRef = useRef<HTMLDivElement>(null);
	const barRef = useRef<HTMLDivElement>(null);
	const compactCoverRef = useRef<HTMLDivElement>(null);
	const compactVideoRef = useRef<HTMLVideoElement>(null);
	const compactInfoRef = useRef<HTMLDivElement>(null);
	const compactInfoSlotRef = useRef<HTMLDivElement>(null);
	const [fullInfo, setFullInfo] = useState<HTMLDivElement | null>(null);
	const videoRef = useRef<HTMLVideoElement>(null);
	const openButtonRef = useRef<HTMLButtonElement>(null);
	const [page, setPage] = useState<HTMLDivElement | null>(null);
	const [cover, setCover] = useState<HTMLDivElement | null>(null);
	const [coverFrame, setCoverFrame] = useState<HTMLDivElement | null>(null);
	const [collapseButton, setCollapseButton] =
		useState<HTMLButtonElement | null>(null);
	const [reducedMotion, setReducedMotion] = useState(
		() => matchMedia("(prefers-reduced-motion: reduce)").matches,
	);
	const progress = useRef(opened ? 1 : 0);
	const displayedCover = useRef<Rect | null>(null);
	const displayedInfo = useRef<InfoPose | null>(null);
	const displayedFilter = useRef<string | null>(null);
	const previousFocus = useRef<HTMLElement | null>(null);
	const wasOpened = useRef(false);

	const presentation = useMemo<Presentation>(
		() => ({
			opened,
			appRef,
			barRef,
			compactCoverRef,
			compactVideoRef,
			compactInfoRef,
			compactInfoSlotRef,
			fullInfoRef: setFullInfo,
			videoRef,
			openButtonRef,
			pageRef: setPage,
			coverRef: setCover,
			coverFrameRef: setCoverFrame,
			collapseButtonRef: setCollapseButton,
		}),
		[opened],
	);

	useLayoutEffect(() => {
		const media = matchMedia("(prefers-reduced-motion: reduce)");
		const update = () => setReducedMotion(media.matches);
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);

	useLayoutEffect(() => {
		if (!page) return;
		let focusFrame = 0;
		if (opened) {
			if (!wasOpened.current) {
				previousFocus.current =
					document.activeElement instanceof HTMLElement
						? document.activeElement
						: null;
			}
			page.dataset.phase = progress.current === 1 ? "open" : "moving";
			// 响应式布局切换时，可能替换掉已获得焦点的收起按钮
			if (
				!wasOpened.current ||
				document.activeElement === document.body ||
				document.activeElement === page
			) {
				page.focus({ preventScroll: true });
				// Motion 测量布局时会暂时隐藏该布局，因此等到下一帧再聚焦
				focusFrame = requestAnimationFrame(() => {
					if (document.activeElement === page)
						collapseButton?.focus({ preventScroll: true });
				});
			}
		} else if (wasOpened.current) {
			const target = previousFocus.current;
			if (target?.isConnected && !target.closest("[inert]"))
				target.focus({ preventScroll: true });
			else openButtonRef.current?.focus({ preventScroll: true });
		}
		wasOpened.current = opened;
		return () => cancelAnimationFrame(focusFrame);
	}, [opened, page, collapseButton]);

	useLayoutEffect(() => {
		const app = appRef.current;
		const bar = barRef.current;
		const compact = compactCoverRef.current;
		const compactButton = openButtonRef.current;
		const sheet = app?.querySelector<HTMLElement>("#amll-player-sheet");
		const background = app?.querySelector<HTMLElement>(
			"[data-player-background]",
		);
		const dimmer = app?.querySelector<HTMLElement>("[data-player-dimmer]");
		const thumb = page?.querySelector<HTMLElement>(
			"#amll-player-control-thumb",
		);
		const layout = page?.querySelector<HTMLElement>("#amll-lyric-player");
		if (!app || !page || !bar || !compact || !sheet || !layout) return;

		const target = opened ? 1 : 0;
		let disposed = false;
		let promoted = false;
		let moving = false;
		let refreshFrame = 0;
		let generation = 0;
		let startProgress = progress.current;
		let master: Animation | undefined;
		let waitingPose: Animation | undefined;
		let animations: Animation[] = [];
		let infoMotion: ReturnType<typeof createInfoMotion>;
		let cancelVideoHandoff: (() => void) | undefined;

		const measurePage = () => {
			const compactHeight = bar.getBoundingClientRect().height + 1;
			app.style.setProperty("--player-compact-height", `${compactHeight}px`);
			const barTop = window.innerHeight - compactHeight;
			page.style.setProperty("--player-sheet-top", `${barTop}px`);
			return barTop;
		};
		const capture = () => {
			if (!moving || !master) return;
			const eased = master.effect?.getComputedTiming().progress ?? 0;
			progress.current = mix(startProgress, target, eased);
			if (promoted && cover) {
				displayedCover.current = cover.getBoundingClientRect();
				displayedFilter.current = getComputedStyle(cover).filter;
			}
			if (infoMotion) displayedInfo.current = infoMotion.capture();
		};
		const restoreCover = () => {
			if (!cover || !promoted) return;
			cover.style.transition = "none";
			if (cover.matches(":popover-open")) cover.hidePopover();
			waitingPose?.cancel();
			waitingPose = undefined;
			for (const animation of animations)
				if ((animation.effect as KeyframeEffect | null)?.target === cover)
					animation.cancel();
			cover.removeAttribute("popover");
			for (const key of [
				"left",
				"top",
				"width",
				"height",
				"mask-image",
				"mask-composite",
				"transform",
				"border-radius",
				"overflow",
			])
				cover.style.removeProperty(key);
			// 交接完成后，暂停时封面自带的变换重新交由歌词库控制
			cover.getBoundingClientRect();
			cover.style.removeProperty("transition");
			compactButton?.style.removeProperty("opacity");
			promoted = false;
		};
		const stop = () => {
			cancelVideoHandoff?.();
			cancelVideoHandoff = undefined;
			infoMotion?.restore();
			infoMotion = undefined;
			restoreCover();
			for (const animation of animations) animation.cancel();
			animations = [];
			master = undefined;
		};
		const finish = () => {
			moving = false;
			progress.current = target;
			displayedCover.current =
				promoted && cover ? cover.getBoundingClientRect() : null;
			page.dataset.phase = opened ? "open" : "closed";
			infoMotion?.restore();
			infoMotion = undefined;
			displayedInfo.current = null;
			displayedFilter.current = null;
			// 只有封面可能需要等待视频就绪。页面的变换现在就释放，
			// 使落定后的布局能够响应视口尺寸变化
			for (const animation of animations)
				if ((animation.effect as KeyframeEffect | null)?.target !== cover)
					animation.cancel();
			master = undefined;
			if (opened && document.activeElement === page)
				collapseButton?.focus({ preventScroll: true });
			const release = () => {
				cancelVideoHandoff?.();
				cancelVideoHandoff = undefined;
				restoreCover();
				for (const animation of animations) animation.cancel();
				animations = [];
				master = undefined;
				displayedCover.current = null;
			};
			const video = videoRef.current;
			const thumbnail = compactVideoRef.current;
			if (target === 0) video?.pause();
			// 无动画的直接切换同样要同步已就绪的视频帧，
			// 但没有可见的浮层需要在等待媒体事件期间保留
			if (
				target === 0 &&
				!promoted &&
				video &&
				thumbnail &&
				video.readyState >= 2 &&
				thumbnail.readyState >= 1 &&
				!thumbnail.error
			)
				thumbnail.currentTime = video.currentTime;
			if (
				promoted &&
				target === 0 &&
				video &&
				thumbnail &&
				video.readyState >= 2 &&
				!thumbnail.error
			) {
				const seek = () => {
					if (Math.abs(thumbnail.currentTime - video.currentTime) >= 0.001)
						thumbnail.currentTime = video.currentTime;
					if (
						!promoted ||
						(Math.abs(thumbnail.currentTime - video.currentTime) < 0.001 &&
							!thumbnail.seeking &&
							thumbnail.readyState >= 2)
					)
						release();
				};
				cancelVideoHandoff = () => {
					thumbnail.removeEventListener("loadedmetadata", seek);
					thumbnail.removeEventListener("loadeddata", seek);
					thumbnail.removeEventListener("seeked", seek);
					thumbnail.removeEventListener("error", release);
					thumbnail.removeEventListener("emptied", release);
				};
				thumbnail.addEventListener("loadedmetadata", seek);
				thumbnail.addEventListener("loadeddata", seek);
				thumbnail.addEventListener("seeked", seek);
				thumbnail.addEventListener("error", release, { once: true });
				thumbnail.addEventListener("emptied", release, { once: true });
				if (thumbnail.readyState >= 1) seek();
			} else release();
		};

		const run = (duration = 500, corrections = 0) => {
			if (disposed) return;
			capture();
			stop();
			const runId = ++generation;
			startProgress = progress.current;
			const barTop = measurePage();
			if (!cover || !coverFrame) return;
			if (
				reducedMotion ||
				(corrections === 0 && startProgress === target) ||
				typeof cover.showPopover !== "function"
			) {
				finish();
				return;
			}

			cover.style.transition = "none";
			const nativeStyle = getComputedStyle(cover);
			const nativeTransform = new DOMMatrixReadOnly(nativeStyle.transform);
			const nativeFilter = nativeStyle.filter;
			const coverRect = cover.getBoundingClientRect();
			const nativeRect = {
				left: coverRect.left,
				top: coverRect.top - page.getBoundingClientRect().top,
				width: coverRect.width,
				height: coverRect.height,
			};
			const frame = coverFrame.getBoundingClientRect();
			const mask = getComputedStyle(coverFrame).maskImage;
			const readTarget = (): Rect => {
				if (!opened) return compact.getBoundingClientRect();
				const anchor = coverFrame.getBoundingClientRect();
				return {
					left: anchor.left + (anchor.width * (1 - nativeTransform.a)) / 2,
					top:
						anchor.top -
						page.getBoundingClientRect().top +
						(anchor.height * (1 - nativeTransform.d)) / 2,
					width: anchor.width * nativeTransform.a,
					height: anchor.height * nativeTransform.d,
				};
			};
			const start =
				displayedCover.current ??
				(opened ? compact.getBoundingClientRect() : nativeRect);
			const end = readTarget();
			const baseWidth = Math.max(1, frame.width);
			const baseHeight = Math.max(1, frame.height);
			const transform = (rect: Rect) =>
				`translate(${rect.left}px, ${rect.top}px) scale(${rect.width / baseWidth}, ${rect.height / baseHeight})`;
			const timelineStart = performance.now();
			const animate: Animate = (node, frames, options = {}) => {
				const animation = node.animate(frames, {
					duration,
					easing: sheetEasing,
					fill: "both",
					...options,
				});
				animation.startTime = timelineStart;
				animations.push(animation);
				return animation;
			};

			if (!opened) videoRef.current?.pause();
			cover.setAttribute("popover", "manual");
			cover.showPopover();
			promoted = true;
			if (compactButton) compactButton.style.opacity = "0";
			Object.assign(cover.style, {
				left: "0px",
				top: "0px",
				width: `${baseWidth}px`,
				height: `${baseHeight}px`,
				overflow: "hidden",
			});
			animate(cover, [
				{
					transform: transform(start),
					filter: displayedFilter.current ?? (opened ? "none" : nativeFilter),
					borderRadius: `${((6 * baseWidth) / Math.max(1, start.width)) * (1 - startProgress)}px`,
				},
				{
					transform: transform(end),
					filter: opened ? nativeFilter : "none",
					borderRadius: `${opened ? 0 : (6 * baseWidth) / Math.max(1, end.width)}px`,
				},
			]);
			animate(
				cover,
				[{ opacity: 1 - startProgress }, { opacity: 1 - target }],
				{ pseudoElement: "::before" },
			);
			if (mask !== "none") {
				cover.style.maskComposite = "add";
				animate(
					cover,
					Array.from({ length: 61 }, (_, i) => {
						const alpha = 1 - mix(startProgress, target, sheetEase(i / 60));
						return {
							offset: i / 60,
							maskImage: `${mask}, linear-gradient(rgb(0 0 0 / ${alpha}), rgb(0 0 0 / ${alpha}))`,
						};
					}),
					{ easing: "linear" },
				);
			}

			const source = compactInfoRef.current;
			const slot = compactInfoSlotRef.current;
			if (source && slot && fullInfo) {
				infoMotion = createInfoMotion(
					source,
					slot,
					fullInfo,
					page,
					opened,
					displayedInfo.current,
				);
				const layoutRect = layout.getBoundingClientRect();
				infoMotion?.play(
					animate,
					sheetEase,
					layoutRect.width < layoutRect.height,
				);
			}
			const positions = [startProgress, target];
			master = animate(
				sheet,
				positions.map((p) => ({
					transform: `translateY(${barTop * (1 - p)}px)`,
				})),
			);
			animate(
				bar,
				positions.map((p) => ({
					transform: `translateY(${-barTop * (1 - p)}px)`,
				})),
			);
			if (background)
				animate(
					background,
					positions.map((p) => ({ transform: `scale(${1 - p * 0.035})` })),
				);
			if (dimmer)
				animate(
					dimmer,
					positions.map((p) => ({ opacity: p * 0.35 })),
				);
			if (thumb)
				animate(
					thumb,
					positions.map((p) => ({
						transform: `translateY(${(20 - barTop) * (1 - p)}px)`,
					})),
				);
			moving = true;
			page.dataset.phase = "moving";
			master.onfinish = () => {
				if (disposed || generation !== runId) return;
				// 歌词库的布局弹簧动画可能晚于本时间轴结束。只在交接时重新测量，
				// 并以次数有限的短时修正代替逐帧轮询
				if (
					corrections < 4 &&
					(!near(cover.getBoundingClientRect(), readTarget()) ||
						(infoMotion &&
							!near(infoMotion.capture(), infoMotion.readTarget())))
				) {
					run(120, corrections + 1);
					return;
				}
				finish();
			};
		};
		const resize = () => {
			if (refreshFrame) return;
			refreshFrame = requestAnimationFrame(() => {
				refreshFrame = 0;
				if (moving) run();
				else {
					measurePage();
					if (promoted && cover && !opened) {
						const rect = compact.getBoundingClientRect();
						displayedCover.current = rect;
						const width = Number.parseFloat(cover.style.width);
						const height = Number.parseFloat(cover.style.height);
						waitingPose?.cancel();
						waitingPose = cover.animate(
							[
								{
									transform: `translate(${rect.left}px, ${rect.top}px) scale(${rect.width / width}, ${rect.height / height})`,
								},
							],
							{ duration: 0, fill: "both" },
						);
					}
				}
			});
		};
		const appearanceObserver = new MutationObserver(resize);
		if (cover)
			appearanceObserver.observe(cover, {
				attributes: true,
				attributeFilter: ["class"],
			});
		run();
		window.addEventListener("resize", resize);
		window.visualViewport?.addEventListener("resize", resize);
		return () => {
			capture();
			disposed = true;
			cancelAnimationFrame(refreshFrame);
			appearanceObserver.disconnect();
			window.removeEventListener("resize", resize);
			window.visualViewport?.removeEventListener("resize", resize);
			stop();
		};
	}, [
		opened,
		reducedMotion,
		page,
		cover,
		coverFrame,
		coverUrl,
		coverIsVideo,
		collapseButton,
		fullInfo,
	]);

	return (
		<PresentationContext.Provider value={presentation}>
			{children}
		</PresentationContext.Provider>
	);
}

export const sharedCoverClassName = styles.sharedCover;
