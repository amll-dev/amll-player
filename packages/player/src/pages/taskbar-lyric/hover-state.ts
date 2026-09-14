export const HOVER_REARM_MARGIN = 2;

export type PointerPosition = {
	x: number;
	y: number;
};

export type RectBounds = {
	left: number;
	right: number;
	top: number;
	bottom: number;
};

export function isPointerOutsideRect(
	pointer: PointerPosition,
	rect: RectBounds,
	margin = HOVER_REARM_MARGIN,
): boolean {
	return (
		pointer.x < rect.left - margin ||
		pointer.x > rect.right + margin ||
		pointer.y < rect.top - margin ||
		pointer.y > rect.bottom + margin
	);
}

export function hasPointerMoved(
	pointer: PointerPosition,
	origin: PointerPosition,
	distance = 0,
): boolean {
	return (
		Math.abs(pointer.x - origin.x) > distance ||
		Math.abs(pointer.y - origin.y) > distance
	);
}

export function shouldReactivateHover(
	pointer: PointerPosition,
	exitPointer: PointerPosition | null,
	surfaceRect: RectBounds,
	armed = false,
	previousPointer: PointerPosition | null = null,
): boolean {
	return Boolean(
		(armed
			? !previousPointer || hasPointerMoved(pointer, previousPointer)
			: exitPointer && hasPointerMoved(pointer, exitPointer)) &&
			!isPointerOutsideRect(pointer, surfaceRect, 0),
	);
}
