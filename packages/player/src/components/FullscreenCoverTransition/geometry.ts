export interface CoverRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface CoverTransform {
	translateX: number;
	translateY: number;
	scaleX: number;
	scaleY: number;
}

export const isUsableCoverRect = (rect: CoverRect) =>
	Number.isFinite(rect.left) &&
	Number.isFinite(rect.top) &&
	Number.isFinite(rect.width) &&
	Number.isFinite(rect.height) &&
	rect.width > 1 &&
	rect.height > 1;

export const toCoverRect = (rect: DOMRect | CoverRect): CoverRect => ({
	left: rect.left,
	top: rect.top,
	width: rect.width,
	height: rect.height,
});

export const offsetCoverRect = (
	rect: CoverRect,
	offsetX: number,
	offsetY: number,
): CoverRect => ({
	left: rect.left - offsetX,
	top: rect.top - offsetY,
	width: rect.width,
	height: rect.height,
});

export const getCoverTransform = (
	base: CoverRect,
	displayed: CoverRect,
): CoverTransform => ({
	translateX: displayed.left - base.left,
	translateY: displayed.top - base.top,
	scaleX: displayed.width / base.width,
	scaleY: displayed.height / base.height,
});

export const toCoverTransformCss = (transform: CoverTransform) =>
	`translate(${transform.translateX}px, ${transform.translateY}px) scale(${transform.scaleX}, ${transform.scaleY})`;

export const getUnscaledCornerRadius = (
	displayedRadius: number,
	transform: CoverTransform,
) =>
	displayedRadius /
	Math.max(Math.abs(transform.scaleX), Math.abs(transform.scaleY), 0.001);
