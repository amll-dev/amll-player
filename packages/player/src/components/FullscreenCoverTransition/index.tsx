import { type CSSProperties, type FC, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
	type CoverRect,
	getCoverTransform,
	getUnscaledCornerRadius,
	isUsableCoverRect,
	offsetCoverRect,
	toCoverRect,
	toCoverTransformCss,
} from "./geometry.ts";
import styles from "./index.module.css";

export type FullscreenCoverTransitionDirection = "enter" | "exit";

export interface FullscreenCoverTransitionSnapshot {
	direction: FullscreenCoverTransitionDirection;
	musicId: string;
	coverUrl: string;
	base: CoverRect;
	start: CoverRect;
	end: CoverRect;
	startCornerRadius: number;
	endCornerRadius: number;
	startFilter: string;
	endFilter: string;
	sourceMaterialFrom: number;
	sourceMaterialTo: number;
	sourceMaterialBackgroundColor: string;
	sourceMaterialBoxShadow: string;
	sourceMaterialBackdropFilter: string;
}

const TRANSITION_DURATION = 500;
const RESIZE_CORRECTION_DURATION = 220;
const ENDPOINT_CORRECTION_DURATION = 120;
const MAX_ENDPOINT_CORRECTIONS = 2;
const ENDPOINT_RECT_TOLERANCE = 0.75;
const ENDPOINT_RETRY_LIMIT = 8;
const HANDOFF_RETRY_LIMIT = 8;
const HANDOFF_FADE_DURATION = 120;
const TRANSPARENT_DROP_SHADOW = "drop-shadow(rgba(0, 0, 0, 0) 0px 0px 0px)";
const SOURCE_SELECTOR = "[data-amll-cover-transition-source]";
const TARGET_SELECTOR = "[data-amll-cover]";
const TRANSITION_COVER_SELECTOR = "[data-amll-cover-transition-cover]";
const FULLSCREEN_CONTENT_SELECTOR = "[data-amll-fullscreen-content]";
const PANEL_SELECTOR = "#amll-lyric-player-wrapper";
const PLAYBAR_CONTENT_SELECTOR = "[data-amll-playbar-content]";
const SOURCE_SURFACE_WAIT_LIMIT = 400;

const getFullscreenContentTranslation = (element: HTMLElement) => {
	const content = element.closest<HTMLElement>(FULLSCREEN_CONTENT_SELECTOR);
	const transform = content ? getComputedStyle(content).transform : "none";
	if (transform === "none") return { x: 0, y: 0 };
	try {
		const matrix = new DOMMatrixReadOnly(transform);
		return { x: matrix.m41, y: matrix.m42 };
	} catch {
		return { x: 0, y: 0 };
	}
};

const getFinalFullscreenCoverRect = (element: HTMLElement) => {
	const rect = toCoverRect(element.getBoundingClientRect());
	const offset = getFullscreenContentTranslation(element);
	return offsetCoverRect(rect, offset.x, offset.y);
};

const isSourceSurfaceReady = (element: HTMLElement) => {
	const surface = element.closest<HTMLElement>(PLAYBAR_CONTENT_SELECTOR);
	if (!surface) return true;
	const opacity = Number.parseFloat(getComputedStyle(surface).opacity);
	return !Number.isFinite(opacity) || opacity >= 0.995;
};

const getLargestFullscreenCover = () => {
	const wrapper = document.getElementById("amll-lyric-player-wrapper");
	if (!wrapper) return null;
	const result = Array.from(
		wrapper.querySelectorAll<HTMLElement>(TARGET_SELECTOR),
	)
		.map((element) => ({
			element,
			rect: getFinalFullscreenCoverRect(element),
		}))
		.filter(({ rect }) => isUsableCoverRect(rect))
		.sort(
			(left, right) =>
				right.rect.width * right.rect.height -
				left.rect.width * left.rect.height,
		)[0];
	return result ?? null;
};

const getCornerRadius = (element: HTMLElement, fallback: number) => {
	const radius = Number.parseFloat(
		getComputedStyle(element).borderTopLeftRadius,
	);
	return Number.isFinite(radius) && radius > 0 ? radius : fallback;
};

const getVisualFilter = (element: HTMLElement) => {
	const filter = getComputedStyle(element).filter;
	return filter === "none" ? TRANSPARENT_DROP_SHADOW : filter;
};

const hasIntrinsicCoverClip = (element: HTMLElement) =>
	[element, ...element.querySelectorAll<HTMLElement>("*")].some((candidate) => {
		const clipPath = getComputedStyle(candidate).clipPath;
		return clipPath !== "none" && clipPath !== "";
	});

const getCoverRectDelta = (left: CoverRect, right: CoverRect) =>
	Math.max(
		Math.abs(left.left - right.left),
		Math.abs(left.top - right.top),
		Math.abs(left.width - right.width),
		Math.abs(left.height - right.height),
	);

const getSourceMaterialStyle = (
	element: HTMLElement,
	pseudoElement?: string,
) => {
	const style = getComputedStyle(element, pseudoElement);
	return {
		backgroundColor: style.backgroundColor || "rgb(100 100 100 / 0.1)",
		boxShadow:
			style.boxShadow === "none"
				? "inset 0 0 0 1px #504e4e25"
				: style.boxShadow,
		backdropFilter: style.backdropFilter || "none",
	};
};

const measureFullscreenTarget = () => {
	const target = getLargestFullscreenCover();
	if (!target) return null;
	const fallbackCornerRadius = Math.max(
		Math.min(target.rect.width, target.rect.height) * 0.02,
		window.innerHeight * 0.007,
	);
	return {
		element: target.element,
		rect: target.rect,
		filter: getVisualFilter(target.element),
		cornerRadius: getCornerRadius(
			target.element,
			hasIntrinsicCoverClip(target.element) ? 0 : fallbackCornerRadius,
		),
	};
};

export const captureFullscreenCoverTransition = (
	sourceElement: HTMLElement,
	coverUrl: string,
	musicId: string,
	direction: FullscreenCoverTransitionDirection = "enter",
): FullscreenCoverTransitionSnapshot | null => {
	const source = toCoverRect(sourceElement.getBoundingClientRect());
	const target = measureFullscreenTarget();
	if (!target || !isUsableCoverRect(source)) return null;

	const activeCover = document.querySelector<HTMLElement>(
		TRANSITION_COVER_SELECTOR,
	);
	const activeRect = activeCover
		? toCoverRect(activeCover.getBoundingClientRect())
		: null;
	const activeSourceMaterial = activeCover?.querySelector<HTMLElement>(
		"[data-amll-cover-source-material]",
	);
	const sourceCornerRadius = getCornerRadius(sourceElement, 6);
	const start =
		direction === "exit" && activeRect && isUsableCoverRect(activeRect)
			? activeRect
			: direction === "enter"
				? source
				: target.rect;
	const startCornerRadius =
		direction === "exit" && activeCover
			? getCornerRadius(activeCover, target.cornerRadius)
			: direction === "enter"
				? sourceCornerRadius
				: target.cornerRadius;
	const startFilter =
		direction === "exit" && activeCover
			? getVisualFilter(activeCover)
			: direction === "enter"
				? getVisualFilter(sourceElement)
				: target.filter;
	const activeSourceMaterialOpacity = activeSourceMaterial
		? Number.parseFloat(getComputedStyle(activeSourceMaterial).opacity)
		: 0;
	const sourceMaterialStyle = activeSourceMaterial
		? getSourceMaterialStyle(activeSourceMaterial)
		: getSourceMaterialStyle(sourceElement, "::before");

	return {
		direction,
		musicId,
		coverUrl,
		base: target.rect,
		start,
		end: direction === "enter" ? target.rect : source,
		startCornerRadius,
		endCornerRadius:
			direction === "enter" ? target.cornerRadius : sourceCornerRadius,
		startFilter,
		endFilter:
			direction === "enter" ? target.filter : getVisualFilter(sourceElement),
		sourceMaterialFrom:
			direction === "enter"
				? 1
				: Number.isFinite(activeSourceMaterialOpacity)
					? activeSourceMaterialOpacity
					: 0,
		sourceMaterialTo: direction === "enter" ? 0 : 1,
		sourceMaterialBackgroundColor: sourceMaterialStyle.backgroundColor,
		sourceMaterialBoxShadow: sourceMaterialStyle.boxShadow,
		sourceMaterialBackdropFilter: sourceMaterialStyle.backdropFilter,
	};
};

const setBaseRect = (element: HTMLElement, rect: CoverRect) => {
	element.style.left = `${rect.left}px`;
	element.style.top = `${rect.top}px`;
	element.style.width = `${rect.width}px`;
	element.style.height = `${rect.height}px`;
};

export const FullscreenCoverTransition: FC<{
	snapshot: FullscreenCoverTransitionSnapshot;
	onFinish: () => void;
}> = ({ snapshot, onFinish }) => {
	const viewportRef = useRef<HTMLDivElement>(null);
	const coverRef = useRef<HTMLDivElement>(null);
	const targetMaterialRef = useRef<HTMLDivElement>(null);
	const sourceMaterialRef = useRef<HTMLDivElement>(null);
	const startTransform = getCoverTransform(snapshot.base, snapshot.start);
	const style: CSSProperties = {
		left: snapshot.base.left,
		top: snapshot.base.top,
		width: snapshot.base.width,
		height: snapshot.base.height,
		backgroundImage: `url(${snapshot.coverUrl})`,
		borderRadius: getUnscaledCornerRadius(
			snapshot.startCornerRadius,
			startTransform,
		),
		filter: snapshot.startFilter,
		transform: toCoverTransformCss(startTransform),
	};

	useLayoutEffect(() => {
		const viewport = viewportRef.current;
		const cover = coverRef.current;
		const targetMaterial = targetMaterialRef.current;
		const sourceMaterial = sourceMaterialRef.current;
		if (!viewport || !cover || !targetMaterial || !sourceMaterial) return;

		const syncTargetMaterial = () => {
			const nativeTarget = getLargestFullscreenCover()?.element;
			if (!nativeTarget) {
				targetMaterial.replaceChildren();
				cover.style.backgroundImage = `url(${snapshot.coverUrl})`;
				cover.style.backgroundColor = "#111";
				return false;
			}
			const nativeRect = nativeTarget.getBoundingClientRect();
			const nativeLayoutWidth = Math.max(
				nativeTarget.offsetWidth,
				nativeRect.width,
				1,
			);
			const nativeLayoutHeight = Math.max(
				nativeTarget.offsetHeight,
				nativeRect.height,
				1,
			);
			const materialScaleX = nativeRect.width / nativeLayoutWidth;
			const materialScaleY = nativeRect.height / nativeLayoutHeight;
			const clone = nativeTarget.cloneNode(true) as HTMLElement;
			clone.removeAttribute("data-amll-cover");
			clone.removeAttribute("id");
			for (const element of clone.querySelectorAll<HTMLElement>(
				"[data-amll-cover], [id]",
			)) {
				element.removeAttribute("data-amll-cover");
				element.removeAttribute("id");
			}
			Object.assign(clone.style, {
				position: "absolute",
				inset: "auto",
				left: "0",
				top: "0",
				width: `${nativeLayoutWidth}px`,
				height: `${nativeLayoutHeight}px`,
				filter: "none",
				transform: `scale(${materialScaleX}, ${materialScaleY})`,
				transformOrigin: "top left",
				transition: "none",
				pointerEvents: "none",
			});
			for (const element of clone.querySelectorAll<HTMLElement>("*")) {
				element.style.transition = "none";
			}
			targetMaterial.replaceChildren(clone);
			cover.style.backgroundImage = "none";
			cover.style.backgroundColor = "transparent";
			return true;
		};
		const syncSourceMaterial = () => {
			const nativeSource = document.querySelector<HTMLElement>(SOURCE_SELECTOR);
			if (!nativeSource) return;
			const sourceStyle = getSourceMaterialStyle(nativeSource, "::before");
			Object.assign(sourceMaterial.style, {
				backgroundColor: sourceStyle.backgroundColor,
				boxShadow: sourceStyle.boxShadow,
				backdropFilter: sourceStyle.backdropFilter,
			});
		};

		syncTargetMaterial();

		document.body.dataset.amllCoverTransition = snapshot.direction;
		let settled = false;
		let geometryAnimation: Animation | null = null;
		let materialAnimation: Animation | null = null;
		let nativeHandoffAnimation: Animation | null = null;
		let coverHandoffAnimation: Animation | null = null;
		let handoffFrame = 0;
		let secondHandoffFrame = 0;
		let endpointFrame = 0;
		let clipFrame = 0;
		let resizeFrame = 0;
		let handoffStarted = false;
		let endpointAttempts = 0;
		let endpointCorrectionCount = 0;
		let handoffRetries = 0;
		let sourceSurfaceDeadline = 0;

		const syncPanelClip = () => {
			if (settled) return;
			const panel = document.querySelector<HTMLElement>(PANEL_SELECTOR);
			const panelTop = panel
				? Math.max(
						0,
						Math.min(window.innerHeight, panel.getBoundingClientRect().top),
					)
				: 0;
			viewport.style.clipPath = `inset(${panelTop}px 0px 0px 0px)`;
			clipFrame = requestAnimationFrame(syncPanelClip);
		};
		syncPanelClip();

		const finish = () => {
			if (settled) return;
			settled = true;
			delete document.body.dataset.amllCoverTransition;
			onFinish();
		};

		const getCurrentCoverState = () => {
			const rect = toCoverRect(cover.getBoundingClientRect());
			const computedStyle = getComputedStyle(cover);
			const parsedCssRadius = Number.parseFloat(
				computedStyle.borderTopLeftRadius,
			);
			const cssRadius = Number.isFinite(parsedCssRadius)
				? parsedCssRadius
				: snapshot.startCornerRadius;
			return {
				rect,
				cornerRadius:
					cssRadius *
					Math.max(
						rect.width / Math.max(cover.offsetWidth, 1),
						rect.height / Math.max(cover.offsetHeight, 1),
					),
				filter: getVisualFilter(cover),
				materialOpacity: Number.parseFloat(
					getComputedStyle(sourceMaterial).opacity,
				),
			};
		};

		const prepareOverlayForHandoff = () => {
			if (snapshot.direction === "exit") syncSourceMaterial();
			const computedStyle = getComputedStyle(cover);
			const materialStyle = getComputedStyle(sourceMaterial);
			cover.style.transform = computedStyle.transform;
			cover.style.borderRadius = computedStyle.borderTopLeftRadius;
			cover.style.filter = computedStyle.filter;
			sourceMaterial.style.opacity = materialStyle.opacity;
			geometryAnimation?.cancel();
			materialAnimation?.cancel();
			geometryAnimation = null;
			materialAnimation = null;
		};

		const fadeOverlayAndFinish = () => {
			handoffStarted = true;
			document.body.dataset.amllCoverTransition = `${snapshot.direction}-handoff`;
			coverHandoffAnimation = cover.animate([{ opacity: 1 }, { opacity: 0 }], {
				duration: HANDOFF_FADE_DURATION,
				easing: "ease-out",
				fill: "both",
			});
			coverHandoffAnimation.addEventListener("finish", finish, {
				once: true,
			});
		};

		const resetHandoff = () => {
			if (endpointFrame) {
				cancelAnimationFrame(endpointFrame);
				endpointFrame = 0;
			}
			nativeHandoffAnimation?.cancel();
			coverHandoffAnimation?.cancel();
			nativeHandoffAnimation = null;
			coverHandoffAnimation = null;
			cover.style.opacity = "1";
			handoffStarted = false;
			endpointAttempts = 0;
			sourceSurfaceDeadline = 0;
			document.body.dataset.amllCoverTransition = snapshot.direction;
		};

		const retryHandoff = () => {
			if (settled) return;
			resetHandoff();
			handoffRetries += 1;
			if (handoffRetries >= HANDOFF_RETRY_LIMIT) {
				fadeOverlayAndFinish();
				return;
			}
			if (snapshot.direction === "enter") syncTargetMaterial();
			endpointFrame = requestAnimationFrame(beginHandoff);
		};

		const beginHandoff = () => {
			if (settled || handoffStarted) return;
			const nativeEndpoint =
				snapshot.direction === "enter"
					? getLargestFullscreenCover()?.element
					: document.querySelector<HTMLElement>(SOURCE_SELECTOR);
			if (!nativeEndpoint) {
				endpointAttempts += 1;
				if (endpointAttempts < ENDPOINT_RETRY_LIMIT) {
					endpointFrame = requestAnimationFrame(beginHandoff);
					return;
				}
				fadeOverlayAndFinish();
				return;
			}
			if (
				snapshot.direction === "exit" &&
				!isSourceSurfaceReady(nativeEndpoint)
			) {
				if (sourceSurfaceDeadline === 0) {
					sourceSurfaceDeadline = performance.now() + SOURCE_SURFACE_WAIT_LIMIT;
				}
				if (performance.now() < sourceSurfaceDeadline) {
					endpointFrame = requestAnimationFrame(beginHandoff);
					return;
				}
			}
			const endpointRect =
				snapshot.direction === "enter"
					? getFinalFullscreenCoverRect(nativeEndpoint)
					: toCoverRect(nativeEndpoint.getBoundingClientRect());
			const current = getCurrentCoverState();
			if (
				endpointCorrectionCount < MAX_ENDPOINT_CORRECTIONS &&
				getCoverRectDelta(current.rect, endpointRect) > ENDPOINT_RECT_TOLERANCE
			) {
				endpointCorrectionCount += 1;
				animateGeometry(
					current.rect,
					current.cornerRadius,
					current.filter,
					Number.isFinite(current.materialOpacity)
						? current.materialOpacity
						: snapshot.sourceMaterialFrom,
					ENDPOINT_CORRECTION_DURATION,
				);
				return;
			}
			handoffStarted = true;
			document.body.dataset.amllCoverTransition = `${snapshot.direction}-handoff`;
			endpointFrame = requestAnimationFrame(() => {
				endpointFrame = 0;
				if (!nativeEndpoint.isConnected) {
					retryHandoff();
					return;
				}
				const paintedEndpointRect =
					snapshot.direction === "enter"
						? getFinalFullscreenCoverRect(nativeEndpoint)
						: toCoverRect(nativeEndpoint.getBoundingClientRect());
				const paintedCurrent = getCurrentCoverState();
				const paintedDelta = getCoverRectDelta(
					paintedCurrent.rect,
					paintedEndpointRect,
				);
				if (
					paintedDelta > ENDPOINT_RECT_TOLERANCE &&
					endpointCorrectionCount < MAX_ENDPOINT_CORRECTIONS
				) {
					handoffStarted = false;
					document.body.dataset.amllCoverTransition = snapshot.direction;
					endpointCorrectionCount += 1;
					animateGeometry(
						paintedCurrent.rect,
						paintedCurrent.cornerRadius,
						paintedCurrent.filter,
						Number.isFinite(paintedCurrent.materialOpacity)
							? paintedCurrent.materialOpacity
							: snapshot.sourceMaterialFrom,
						ENDPOINT_CORRECTION_DURATION,
					);
					return;
				}
				prepareOverlayForHandoff();
				const endpointCornerRadius = getCornerRadius(
					nativeEndpoint,
					snapshot.endCornerRadius,
				);
				if (paintedDelta > ENDPOINT_RECT_TOLERANCE) {
					setBaseRect(cover, paintedEndpointRect);
					cover.style.transform = toCoverTransformCss(
						getCoverTransform(paintedEndpointRect, paintedEndpointRect),
					);
				}
				cover.style.borderRadius = `${endpointCornerRadius}px`;
				cover.style.filter = getVisualFilter(nativeEndpoint);
				const nativeAnimation = nativeEndpoint.animate(
					[{ opacity: 1 }, { opacity: 1 }],
					{
						duration: HANDOFF_FADE_DURATION,
						easing: "ease-out",
						fill: "both",
					},
				);
				nativeHandoffAnimation = nativeAnimation;
				cover.style.opacity = "0";
				endpointFrame = requestAnimationFrame(() => {
					endpointFrame = 0;
					if (!nativeEndpoint.isConnected) {
						retryHandoff();
						return;
					}
					endpointFrame = requestAnimationFrame(() => {
						endpointFrame = 0;
						if (
							!nativeEndpoint.isConnected ||
							nativeHandoffAnimation !== nativeAnimation
						) {
							retryHandoff();
							return;
						}
						finish();
					});
				});
			});
		};

		const scheduleHandoff = () => {
			handoffFrame = requestAnimationFrame(() => {
				handoffFrame = 0;
				if (snapshot.direction === "enter") syncTargetMaterial();
				else syncSourceMaterial();
				secondHandoffFrame = requestAnimationFrame(() => {
					secondHandoffFrame = 0;
					beginHandoff();
				});
			});
		};

		const animateGeometry = (
			start: CoverRect,
			startCornerRadius: number,
			startFilter: string,
			materialFrom: number,
			duration: number,
		) => {
			const liveTarget = measureFullscreenTarget();
			const liveSource = document.querySelector<HTMLElement>(SOURCE_SELECTOR);
			const base = liveTarget?.rect ?? snapshot.base;
			const end =
				snapshot.direction === "enter"
					? base
					: liveSource
						? toCoverRect(liveSource.getBoundingClientRect())
						: snapshot.end;
			const endCornerRadius =
				snapshot.direction === "enter"
					? (liveTarget?.cornerRadius ?? snapshot.endCornerRadius)
					: liveSource
						? getCornerRadius(liveSource, snapshot.endCornerRadius)
						: snapshot.endCornerRadius;
			const endFilter =
				snapshot.direction === "enter"
					? (liveTarget?.filter ?? snapshot.endFilter)
					: liveSource
						? getVisualFilter(liveSource)
						: snapshot.endFilter;
			const fromTransform = getCoverTransform(base, start);
			const toTransform = getCoverTransform(base, end);
			setBaseRect(cover, base);
			geometryAnimation?.cancel();
			materialAnimation?.cancel();
			geometryAnimation = cover.animate(
				[
					{
						transform: toCoverTransformCss(fromTransform),
						borderRadius: `${getUnscaledCornerRadius(startCornerRadius, fromTransform)}px`,
						filter: startFilter,
					},
					{
						transform: toCoverTransformCss(toTransform),
						borderRadius: `${getUnscaledCornerRadius(endCornerRadius, toTransform)}px`,
						filter: endFilter,
					},
				],
				{
					duration,
					easing: "cubic-bezier(0.25, 1, 0.5, 1)",
					fill: "both",
				},
			);
			materialAnimation = sourceMaterial.animate(
				[{ opacity: materialFrom }, { opacity: snapshot.sourceMaterialTo }],
				{
					duration,
					easing: "cubic-bezier(0.25, 1, 0.5, 1)",
					fill: "both",
				},
			);
			const activeGeometryAnimation = geometryAnimation;
			const activeMaterialAnimation = materialAnimation;
			void Promise.allSettled([
				activeGeometryAnimation.finished,
				activeMaterialAnimation.finished,
			]).then(() => {
				if (
					settled ||
					geometryAnimation !== activeGeometryAnimation ||
					materialAnimation !== activeMaterialAnimation
				) {
					return;
				}
				scheduleHandoff();
			});
		};

		animateGeometry(
			snapshot.start,
			snapshot.startCornerRadius,
			snapshot.startFilter,
			snapshot.sourceMaterialFrom,
			TRANSITION_DURATION,
		);

		const handleResize = () => {
			if (settled) return;
			if (handoffStarted) {
				const current = getCurrentCoverState();
				resetHandoff();
				endpointCorrectionCount = 0;
				handoffRetries = 0;
				if (resizeFrame) cancelAnimationFrame(resizeFrame);
				resizeFrame = requestAnimationFrame(() => {
					resizeFrame = 0;
					if (settled || handoffStarted) return;
					syncTargetMaterial();
					animateGeometry(
						current.rect,
						current.cornerRadius,
						current.filter,
						Number.isFinite(current.materialOpacity)
							? current.materialOpacity
							: snapshot.sourceMaterialFrom,
						RESIZE_CORRECTION_DURATION,
					);
				});
				return;
			}
			if (handoffFrame) {
				cancelAnimationFrame(handoffFrame);
				handoffFrame = 0;
			}
			if (secondHandoffFrame) {
				cancelAnimationFrame(secondHandoffFrame);
				secondHandoffFrame = 0;
			}
			if (endpointFrame) {
				cancelAnimationFrame(endpointFrame);
				endpointFrame = 0;
			}
			endpointAttempts = 0;
			endpointCorrectionCount = 0;
			handoffRetries = 0;
			sourceSurfaceDeadline = 0;
			const current = getCurrentCoverState();
			prepareOverlayForHandoff();
			if (resizeFrame) cancelAnimationFrame(resizeFrame);
			resizeFrame = requestAnimationFrame(() => {
				resizeFrame = 0;
				if (settled) return;
				if (handoffStarted) return;
				syncTargetMaterial();
				animateGeometry(
					current.rect,
					current.cornerRadius,
					current.filter,
					Number.isFinite(current.materialOpacity)
						? current.materialOpacity
						: snapshot.sourceMaterialFrom,
					RESIZE_CORRECTION_DURATION,
				);
			});
		};
		window.addEventListener("resize", handleResize);
		window.visualViewport?.addEventListener("resize", handleResize);

		return () => {
			settled = true;
			if (handoffFrame) cancelAnimationFrame(handoffFrame);
			if (secondHandoffFrame) cancelAnimationFrame(secondHandoffFrame);
			if (endpointFrame) cancelAnimationFrame(endpointFrame);
			if (clipFrame) cancelAnimationFrame(clipFrame);
			if (resizeFrame) cancelAnimationFrame(resizeFrame);
			geometryAnimation?.cancel();
			materialAnimation?.cancel();
			nativeHandoffAnimation?.cancel();
			coverHandoffAnimation?.cancel();
			window.removeEventListener("resize", handleResize);
			window.visualViewport?.removeEventListener("resize", handleResize);
			delete document.body.dataset.amllCoverTransition;
		};
	}, [onFinish, snapshot]);

	return createPortal(
		<div
			ref={viewportRef}
			className={styles.transitionViewport}
			aria-hidden="true"
		>
			<div
				ref={coverRef}
				className={styles.transitionCover}
				style={style}
				data-amll-cover-transition-cover=""
			>
				<div
					ref={targetMaterialRef}
					className={styles.targetMaterial}
					data-amll-cover-target-material=""
				/>
				<div
					ref={sourceMaterialRef}
					className={styles.sourceMaterial}
					style={{
						opacity: snapshot.sourceMaterialFrom,
						backgroundColor: snapshot.sourceMaterialBackgroundColor,
						boxShadow: snapshot.sourceMaterialBoxShadow,
						backdropFilter: snapshot.sourceMaterialBackdropFilter,
					}}
					data-amll-cover-source-material=""
				/>
			</div>
		</div>,
		document.body,
	);
};
