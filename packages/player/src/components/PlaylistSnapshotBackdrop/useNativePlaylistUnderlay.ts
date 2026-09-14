import { type RefObject, useLayoutEffect } from "react";
import { getPlaylistUnderlayClip } from "./underlay-clip.ts";

const CLIP_PROPERTY = "--amll-playlist-underlay-clip";

/**
 * Keep DWM visible through the transparent, blurred WebView snapshot without
 * also showing the original sharp page. The portal itself is outside this clip.
 */
export function useNativePlaylistUnderlay(
	active: boolean,
	panelRef: RefObject<HTMLElement | null>,
	overlayRoot: HTMLElement | null,
) {
	useLayoutEffect(() => {
		if (!active) return;
		const panel = panelRef.current;
		const underlay = overlayRoot?.querySelector<HTMLElement>(
			"[data-amll-player-main]",
		);
		if (!panel || !underlay || underlay.contains(panel)) return;

		const previousClip = underlay.style.getPropertyValue(CLIP_PROPERTY);
		const restore = () => {
			if (previousClip) underlay.style.setProperty(CLIP_PROPERTY, previousClip);
			else underlay.style.removeProperty(CLIP_PROPERTY);
			delete panel.dataset.amllPlaylistNativeSurface;
		};
		const update = () => {
			const clip = getPlaylistUnderlayClip(
				underlay.getBoundingClientRect(),
				panel.getBoundingClientRect(),
				Number.parseFloat(getComputedStyle(panel).borderTopLeftRadius),
			);
			if (!clip || !CSS.supports("clip-path", clip)) {
				restore();
				return;
			}
			underlay.style.setProperty(CLIP_PROPERTY, clip);
			// Enable transparency only once the matching hole actually exists.
			panel.dataset.amllPlaylistNativeSurface = "";
		};

		const resizeObserver = new ResizeObserver(update);
		resizeObserver.observe(underlay);
		resizeObserver.observe(panel);
		const placementObserver = new MutationObserver(update);
		placementObserver.observe(panel, {
			attributes: true,
			attributeFilter: ["class", "style"],
		});
		placementObserver.observe(document.body, {
			attributes: true,
			attributeFilter: ["style"],
		});
		window.addEventListener("resize", update);
		window.visualViewport?.addEventListener("resize", update);
		update();

		return () => {
			resizeObserver.disconnect();
			placementObserver.disconnect();
			window.removeEventListener("resize", update);
			window.visualViewport?.removeEventListener("resize", update);
			restore();
		};
	}, [active, overlayRoot, panelRef]);
}
