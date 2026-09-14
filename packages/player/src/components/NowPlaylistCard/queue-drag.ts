export const QUEUE_DRAG_THRESHOLD_PX = 6;
export const QUEUE_DRAG_EDGE_PX = 48;
export const QUEUE_DRAG_MAX_SCROLL_PX = 16;

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

export function getQueueDropIndex(
	scrollTop: number,
	pointerClientY: number,
	viewportTop: number,
	grabOffset: number,
	rowHeight: number,
	itemCount: number,
): number {
	if (itemCount <= 0 || rowHeight <= 0) return -1;
	const draggedTop = scrollTop + pointerClientY - viewportTop - grabOffset;
	return clamp(Math.round(draggedTop / rowHeight), 0, itemCount - 1);
}

export function getQueueDragShift(
	index: number,
	originIndex: number,
	targetIndex: number,
	rowHeight: number,
): number {
	if (
		originIndex < targetIndex &&
		index > originIndex &&
		index <= targetIndex
	) {
		return -rowHeight;
	}
	if (
		targetIndex < originIndex &&
		index >= targetIndex &&
		index < originIndex
	) {
		return rowHeight;
	}
	return 0;
}

export function getQueueAutoScrollSpeed(
	pointerClientY: number,
	viewportTop: number,
	viewportBottom: number,
	edgeSize = QUEUE_DRAG_EDGE_PX,
	maximumSpeed = QUEUE_DRAG_MAX_SCROLL_PX,
): number {
	if (edgeSize <= 0 || maximumSpeed <= 0 || viewportBottom <= viewportTop) {
		return 0;
	}
	if (pointerClientY < viewportTop + edgeSize) {
		const pressure = clamp(
			(viewportTop + edgeSize - pointerClientY) / edgeSize,
			0,
			1,
		);
		return -maximumSpeed * pressure;
	}
	if (pointerClientY > viewportBottom - edgeSize) {
		const pressure = clamp(
			(pointerClientY - (viewportBottom - edgeSize)) / edgeSize,
			0,
			1,
		);
		return maximumSpeed * pressure;
	}
	return 0;
}
