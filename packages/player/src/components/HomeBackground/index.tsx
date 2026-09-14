import { isLyricPageOpenedAtom } from "@applemusic-like-lyrics/react-full";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useAtomValue, useStore } from "jotai";
import { type FC, useEffect, useMemo, useRef, useState } from "react";
import {
	effectiveHomeBackgroundConfigAtom,
	homeBackgroundConfigAtom,
	homeBackgroundLoadedAtom,
} from "../../states/homeBackgroundAtoms.ts";
import { mainWindowActiveAtom } from "../../states/windowAtoms.ts";
import { getHomeBackgroundConfig } from "../../utils/home-background-client.ts";
import { useRetainedVisuals } from "../../utils/useRetainedVisuals.ts";
import styles from "./index.module.css";

function resolveFileSource(filePath: string | null): string | null {
	if (!filePath) return null;
	try {
		return convertFileSrc(filePath);
	} catch {
		return null;
	}
}

function usePageVisible(): boolean {
	const [visible, setVisible] = useState(
		() =>
			typeof document === "undefined" || document.visibilityState !== "hidden",
	);
	useEffect(() => {
		if (typeof document === "undefined") return;
		const onVisibilityChange = () =>
			setVisible(document.visibilityState !== "hidden");
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () =>
			document.removeEventListener("visibilitychange", onVisibilityChange);
	}, []);
	return visible;
}

function usePrefersReducedMotion(): boolean {
	const [prefersReducedMotion, setPrefersReducedMotion] = useState(
		() =>
			typeof window !== "undefined" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches,
	);

	useEffect(() => {
		if (typeof window === "undefined") return;
		const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
		const onChange = (event: MediaQueryListEvent) =>
			setPrefersReducedMotion(event.matches);
		setPrefersReducedMotion(mediaQuery.matches);
		mediaQuery.addEventListener("change", onChange);
		return () => mediaQuery.removeEventListener("change", onChange);
	}, []);

	return prefersReducedMotion;
}

export const HomeBackground: FC = () => {
	const config = useAtomValue(effectiveHomeBackgroundConfigAtom);
	const store = useStore();
	const lyricPageOpened = useAtomValue(isLyricPageOpenedAtom);
	const mainWindowActive = useAtomValue(mainWindowActiveAtom);
	const retainMedia = useRetainedVisuals(mainWindowActive);
	const pageVisible = usePageVisible();
	const prefersReducedMotion = usePrefersReducedMotion();
	const videoRef = useRef<HTMLVideoElement>(null);
	const [failedSource, setFailedSource] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		getHomeBackgroundConfig()
			.then((loadedConfig) => {
				if (!cancelled && !store.get(homeBackgroundLoadedAtom)) {
					store.set(homeBackgroundConfigAtom, loadedConfig);
				}
			})
			.catch((error) => {
				console.error(
					"Failed to load the home background configuration",
					error,
				);
			})
			.finally(() => {
				if (!cancelled) store.set(homeBackgroundLoadedAtom, true);
			});
		return () => {
			cancelled = true;
		};
	}, [store]);

	const source = useMemo(
		() => resolveFileSource(retainMedia ? config.filePath : null),
		[config.filePath, retainMedia],
	);

	useEffect(() => {
		setFailedSource(null);
	}, [config.mode, config.updatedAt, source]);

	useEffect(() => {
		const video = videoRef.current;
		if (!video || config.mode !== "video") return;
		if (
			!mainWindowActive ||
			!pageVisible ||
			lyricPageOpened ||
			prefersReducedMotion
		) {
			video.pause();
			return;
		}
		void video.play().catch((error) => {
			if (error instanceof DOMException && error.name === "NotAllowedError") {
				return;
			}
			console.warn("Failed to play the custom home background", error);
		});
	}, [
		config.mode,
		config.updatedAt,
		lyricPageOpened,
		mainWindowActive,
		pageVisible,
		prefersReducedMotion,
		source,
	]);

	useEffect(() => {
		const video = videoRef.current;
		return () => {
			if (!video) return;
			video.pause();
			video.removeAttribute("src");
			video.load();
		};
	}, [config.mode, config.updatedAt, failedSource, source]);

	if (config.mode === "default") return null;
	const animatedImageSuppressed =
		prefersReducedMotion &&
		config.mode === "image" &&
		config.mimeType === "image/gif";
	const mediaAvailable =
		source !== null && failedSource !== source && !animatedImageSuppressed;

	return (
		<div
			className={styles.background}
			style={{ backgroundColor: config.color }}
			aria-hidden="true"
		>
			{config.mode === "color" && (
				<div
					className={styles.color}
					style={{ backgroundColor: config.color }}
				/>
			)}
			{config.mode === "image" && mediaAvailable && (
				<img
					className={styles.media}
					src={source}
					alt=""
					draggable={false}
					decoding="async"
					onError={() => setFailedSource(source)}
				/>
			)}
			{config.mode === "video" && mediaAvailable && (
				<video
					key={`${config.assetId ?? source}:${config.updatedAt}`}
					ref={videoRef}
					className={styles.media}
					src={source}
					muted
					autoPlay={!prefersReducedMotion}
					loop
					playsInline
					preload="auto"
					disablePictureInPicture
					aria-hidden="true"
					tabIndex={-1}
					onError={() => setFailedSource(source)}
				/>
			)}
		</div>
	);
};
