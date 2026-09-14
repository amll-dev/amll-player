import { type FC, type RefObject, useLayoutEffect, useRef } from "react";
import styles from "./index.module.css";
import {
	type CanvasFrameSource,
	createCanvasFrameSource,
	getVideoDrawRect,
} from "./live-frame.ts";

const BACKDROP_FPS = 15;
const MAX_BACKDROP_WIDTH = 1_280;

interface PlaylistLiveBackdropProps {
	sourceContainerRef: RefObject<HTMLElement | null>;
}

/** Mirror only the song background, so queue rows can never enter its capture. */
export const PlaylistLiveBackdrop: FC<PlaylistLiveBackdropProps> = ({
	sourceContainerRef,
}) => {
	const rootRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const cssRef = useRef<HTMLDivElement>(null);
	const shadeRef = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		const root = rootRef.current;
		const target = canvasRef.current;
		const css = cssRef.current;
		const shade = shadeRef.current;
		const container = sourceContainerRef.current;
		const context = target?.getContext("2d");
		if (!root || !target || !css || !shade || !container || !context) return;

		let sourceCanvas: HTMLCanvasElement | null = null;
		let frameSource: CanvasFrameSource | null = null;
		let frameId = 0;
		let lastFrame = -Infinity;
		const findBackground = () =>
			container.querySelector<HTMLElement>("[data-amll-song-video-background]");
		const bindCanvas = () => {
			const nextCanvas = findBackground()?.querySelector("canvas") ?? null;
			if (nextCanvas === sourceCanvas) return;
			root.dataset.liveReady = "false";
			frameSource?.dispose();
			frameSource = null;
			sourceCanvas = nextCanvas;
			if (nextCanvas) {
				try {
					frameSource = createCanvasFrameSource(nextCanvas, BACKDROP_FPS);
				} catch {
					// The opening snapshot remains available if a canvas cannot stream.
				}
			}
		};
		// Bind a replacement renderer before its first paint, including static mode.
		const observer = new MutationObserver(bindCanvas);
		observer.observe(container, { childList: true, subtree: true });
		bindCanvas();

		const draw = () => {
			const background = findBackground();
			if (!background) {
				root.dataset.liveReady = "false";
				return;
			}
			const bounds = background.getBoundingClientRect();
			const panel = root.getBoundingClientRect();
			if (bounds.width <= 0 || bounds.height <= 0) {
				root.dataset.liveReady = "false";
				return;
			}
			const width = Math.max(
				1,
				Math.round(Math.min(bounds.width, MAX_BACKDROP_WIDTH)),
			);
			const height = Math.max(
				1,
				Math.round((width * bounds.height) / bounds.width),
			);
			const base = background.querySelector<HTMLElement>(
				"[data-amll-song-background-base]",
			);
			const cssBackground = base?.querySelector<HTMLElement>(
				"[data-amll-css-background]",
			);
			const video = background.querySelector<HTMLVideoElement>(
				"[data-amll-video-background]",
			);
			const baseOpacity = base ? Number(getComputedStyle(base).opacity) : 1;
			const videoStyle = video ? getComputedStyle(video) : null;
			const videoOpacity = videoStyle ? Number(videoStyle.opacity) : 0;
			const baseFrame = frameSource?.video;
			const baseReady =
				baseOpacity > 0 &&
				!!baseFrame &&
				baseFrame.readyState >= 2 &&
				baseFrame.videoWidth > 0;
			const videoReady =
				videoOpacity > 0 &&
				!!video &&
				video.readyState >= 2 &&
				video.videoWidth > 0;
			if (!(cssBackground && baseOpacity > 0) && !baseReady && !videoReady) {
				root.dataset.liveReady = "false";
				return;
			}

			root.style.setProperty(
				"--playlist-snapshot-left",
				`${bounds.left - panel.left}px`,
			);
			root.style.setProperty(
				"--playlist-snapshot-top",
				`${bounds.top - panel.top}px`,
			);
			root.style.setProperty("--playlist-snapshot-width", `${bounds.width}px`);
			root.style.setProperty(
				"--playlist-snapshot-height",
				`${bounds.height}px`,
			);
			root.style.setProperty(
				"--playlist-snapshot-origin-x",
				`${panel.left + panel.width / 2 - bounds.left}px`,
			);
			root.style.setProperty(
				"--playlist-snapshot-origin-y",
				`${panel.top + panel.height / 2 - bounds.top}px`,
			);
			css.style.background = cssBackground
				? getComputedStyle(cssBackground).background
				: "transparent";
			css.style.opacity = `${baseOpacity}`;
			shade.style.background = background.parentElement
				? getComputedStyle(background.parentElement, "::after").background
				: "transparent";
			if (target.width !== width || target.height !== height) {
				target.width = width;
				target.height = height;
			}
			context.clearRect(0, 0, width, height);
			if (baseReady && baseFrame) {
				context.globalAlpha = baseOpacity;
				context.drawImage(baseFrame, 0, 0, width, height);
			}
			if (videoReady && video && videoStyle) {
				const rect = getVideoDrawRect(
					video.videoWidth,
					video.videoHeight,
					width,
					height,
					videoStyle.objectFit,
				);
				if (rect) {
					context.globalAlpha = videoOpacity;
					context.drawImage(video, rect.x, rect.y, rect.width, rect.height);
				}
			}
			context.globalAlpha = 1;
			root.dataset.liveReady = "true";
		};
		const tick = (time: number) => {
			frameId = requestAnimationFrame(tick);
			if (document.hidden || time - lastFrame < 1_000 / BACKDROP_FPS) return;
			lastFrame = time;
			try {
				draw();
			} catch {
				root.dataset.liveReady = "false";
			}
		};
		frameId = requestAnimationFrame(tick);
		return () => {
			cancelAnimationFrame(frameId);
			observer.disconnect();
			frameSource?.dispose();
		};
	}, [sourceContainerRef]);

	return (
		<div
			ref={rootRef}
			className={`${styles.root} ${styles.liveRoot}`}
			data-variant="fullscreen"
			aria-hidden="true"
		>
			<div className={`${styles.snapshot} ${styles.liveSurface}`}>
				<div ref={cssRef} className={styles.liveLayer} />
				<canvas ref={canvasRef} className={styles.liveLayer} />
				<div ref={shadeRef} className={styles.liveLayer} />
			</div>
			<div className={styles.tint} />
		</div>
	);
};
