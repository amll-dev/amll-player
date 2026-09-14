interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** The page stays visible everywhere except the rounded playlist footprint. */
export function getPlaylistUnderlayClip(
	underlay: Rect,
	panel: Rect,
	borderRadius: number,
): string | null {
	if (
		![
			underlay.left,
			underlay.top,
			underlay.width,
			underlay.height,
			panel.left,
			panel.top,
			panel.width,
			panel.height,
			borderRadius,
		].every(Number.isFinite) ||
		underlay.width <= 0 ||
		underlay.height <= 0 ||
		panel.width <= 0 ||
		panel.height <= 0
	) {
		return null;
	}
	const left = panel.left - underlay.left;
	const top = panel.top - underlay.top;
	const right = left + panel.width;
	const bottom = top + panel.height;
	// If placement ever moves beyond the page, retain the opaque fallback.
	if (
		left < 0 ||
		top < 0 ||
		right > underlay.width ||
		bottom > underlay.height
	) {
		return null;
	}
	const radius = Math.max(
		0,
		Math.min(borderRadius, panel.width / 2, panel.height / 2),
	);
	const path = [
		`M 0 0 H ${underlay.width} V ${underlay.height} H 0 Z`,
		`M ${left + radius} ${top} H ${right - radius}`,
		`A ${radius} ${radius} 0 0 1 ${right} ${top + radius}`,
		`V ${bottom - radius} A ${radius} ${radius} 0 0 1 ${right - radius} ${bottom}`,
		`H ${left + radius} A ${radius} ${radius} 0 0 1 ${left} ${bottom - radius}`,
		`V ${top + radius} A ${radius} ${radius} 0 0 1 ${left + radius} ${top} Z`,
	].join(" ");
	return `path(evenodd, "${path}")`;
}
