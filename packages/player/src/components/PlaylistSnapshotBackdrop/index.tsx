import { invoke } from "@tauri-apps/api/core";
import { type FC, useCallback, useLayoutEffect, useRef, useState } from "react";
import styles from "./index.module.css";

type SnapshotStatus = "idle" | "capturing" | "ready" | "failed";
const SNAPSHOT_CAPTURE_TIMEOUT_MS = 3_000;
const TRANSIENT_MOTION_TIMEOUT_MS = 800;

interface SnapshotState {
	status: SnapshotStatus;
	source: string | null;
}

const EMPTY_SNAPSHOT: SnapshotState = {
	status: "idle",
	source: null,
};

let activeCaptureGuards = 0;

const beginCaptureGuard = () => {
	activeCaptureGuards += 1;
	document.documentElement.dataset.amllPlaylistCapturing = "";
	let released = false;
	return () => {
		if (released) return;
		released = true;
		activeCaptureGuards = Math.max(0, activeCaptureGuards - 1);
		if (activeCaptureGuards === 0) {
			delete document.documentElement.dataset.amllPlaylistCapturing;
		}
	};
};

const waitForUnobscuredFrame = () =>
	withTimeout(
		new Promise<void>((resolve) => {
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		}),
		TRANSIENT_MOTION_TIMEOUT_MS,
	);

const decodeSnapshot = async (source: string) => {
	const image = new Image();
	image.decoding = "async";
	image.src = source;
	await image.decode();
};

const withTimeout = <T,>(promise: Promise<T>, timeoutMs: number) =>
	new Promise<T>((resolve, reject) => {
		const timeout = window.setTimeout(() => {
			reject(
				new Error(`Playlist backdrop capture timed out after ${timeoutMs}ms`),
			);
		}, timeoutMs);
		promise.then(
			(value) => {
				window.clearTimeout(timeout);
				resolve(value);
			},
			(error) => {
				window.clearTimeout(timeout);
				reject(error);
			},
		);
	});

const waitForTransientPlayerMotion = async () => {
	const animations = document.getAnimations().filter((animation) => {
		const effect = animation.effect;
		const target = effect instanceof KeyframeEffect ? effect.target : null;
		return (
			target instanceof Element &&
			(target.matches("[data-amll-fullscreen-content]") ||
				target.matches("[data-amll-playbar-boundary]") ||
				target.matches("[data-amll-cover-transition-cover]"))
		);
	});
	if (animations.length === 0) return;

	await withTimeout(
		Promise.all(
			animations.map((animation) => animation.finished.catch(() => undefined)),
		).then(() => undefined),
		TRANSIENT_MOTION_TIMEOUT_MS,
	).catch(() => undefined);
};

/**
 * Captures the unobscured player before the playlist panel is mounted. WebView2
 * does not reliably sample backdrop-filter through the transparent Tauri
 * window, so the panel filters this stable image instead.
 */
export const usePlaylistBackdropSnapshot = (
	active: boolean,
	refreshKey: unknown = null,
) => {
	const [snapshot, setSnapshot] = useState<SnapshotState>(EMPTY_SNAPSHOT);
	const generationRef = useRef(0);

	useLayoutEffect(() => {
		const generation = ++generationRef.current;
		let cancelled = false;

		if (!active) {
			setSnapshot(EMPTY_SNAPSHOT);
			return;
		}

		setSnapshot({ status: "capturing", source: null });
		const releaseCaptureGuard = beginCaptureGuard();
		const capture = async () => {
			try {
				// A previous opening may still have been present in the commit that
				// activated this effect. Wait until React has removed it before CDP
				// captures the WebView.
				await waitForTransientPlayerMotion();
				await waitForUnobscuredFrame();
				if (cancelled || generationRef.current !== generation) return;

				const data = await withTimeout(
					invoke<string>("take_screenshot", {
						resizeWindow: false,
						targetWidth: 0,
						targetHeight: 0,
						recoverSize: false,
					}),
					SNAPSHOT_CAPTURE_TIMEOUT_MS,
				);
				if (!data) throw new Error("Screenshot command returned no image data");

				const source = `data:image/png;base64,${data}`;
				await withTimeout(decodeSnapshot(source), SNAPSHOT_CAPTURE_TIMEOUT_MS);
				if (cancelled || generationRef.current !== generation) return;
				releaseCaptureGuard();
				setSnapshot({ status: "ready", source });
			} catch (error) {
				if (cancelled || generationRef.current !== generation) return;
				console.warn("Unable to capture playlist backdrop", error);
				releaseCaptureGuard();
				setSnapshot({ status: "failed", source: null });
			}
		};

		void capture();
		return () => {
			cancelled = true;
			releaseCaptureGuard();
		};
	}, [active, refreshKey]);

	return {
		isReady:
			active && (snapshot.status === "ready" || snapshot.status === "failed"),
		source: snapshot.source,
	};
};

interface PlaylistSnapshotBackdropProps {
	source: string;
	variant: "compact" | "fullscreen";
}

export const PlaylistSnapshotBackdrop: FC<PlaylistSnapshotBackdropProps> = ({
	source,
	variant,
}) => {
	const rootRef = useRef<HTMLDivElement>(null);
	const firstFrameRef = useRef(0);
	const secondFrameRef = useRef(0);

	const updateGeometry = useCallback(() => {
		const root = rootRef.current;
		if (!root) return;
		const rect = root.getBoundingClientRect();
		root.style.setProperty("--playlist-snapshot-left", `${-rect.left}px`);
		root.style.setProperty("--playlist-snapshot-top", `${-rect.top}px`);
		root.style.setProperty(
			"--playlist-snapshot-width",
			`${window.innerWidth}px`,
		);
		root.style.setProperty(
			"--playlist-snapshot-height",
			`${window.innerHeight}px`,
		);
		root.style.setProperty(
			"--playlist-snapshot-origin-x",
			`${rect.left + rect.width / 2}px`,
		);
		root.style.setProperty(
			"--playlist-snapshot-origin-y",
			`${rect.top + rect.height / 2}px`,
		);
	}, []);

	useLayoutEffect(() => {
		const root = rootRef.current;
		if (!root) return;

		const scheduleGeometry = () => {
			cancelAnimationFrame(firstFrameRef.current);
			cancelAnimationFrame(secondFrameRef.current);
			firstFrameRef.current = requestAnimationFrame(() => {
				firstFrameRef.current = 0;
				updateGeometry();
				secondFrameRef.current = requestAnimationFrame(() => {
					secondFrameRef.current = 0;
					updateGeometry();
				});
			});
		};

		const resizeObserver = new ResizeObserver(scheduleGeometry);
		resizeObserver.observe(root);
		if (root.parentElement) resizeObserver.observe(root.parentElement);
		const placementObserver = new MutationObserver(scheduleGeometry);
		if (root.parentElement) {
			placementObserver.observe(root.parentElement, {
				attributes: true,
				attributeFilter: ["class", "style"],
			});
		}
		placementObserver.observe(document.body, {
			attributes: true,
			attributeFilter: ["style"],
		});
		window.addEventListener("resize", scheduleGeometry);
		window.visualViewport?.addEventListener("resize", scheduleGeometry);
		updateGeometry();
		scheduleGeometry();

		return () => {
			cancelAnimationFrame(firstFrameRef.current);
			cancelAnimationFrame(secondFrameRef.current);
			resizeObserver.disconnect();
			placementObserver.disconnect();
			window.removeEventListener("resize", scheduleGeometry);
			window.visualViewport?.removeEventListener("resize", scheduleGeometry);
		};
	}, [updateGeometry]);

	return (
		<div
			ref={rootRef}
			className={styles.root}
			data-variant={variant}
			aria-hidden="true"
		>
			<img className={styles.snapshot} src={source} alt="" draggable={false} />
			<div className={styles.tint} />
		</div>
	);
};
