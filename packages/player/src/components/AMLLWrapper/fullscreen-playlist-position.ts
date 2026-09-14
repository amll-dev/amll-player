export interface PlaylistAnchorRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
}

export interface FullscreenPlaylistPlacement {
	left: number;
	bottom: number;
	maxHeight: number;
}

const clamp = (value: number, min: number, max: number) =>
	Math.min(Math.max(value, min), Math.max(min, max));

export const calculateFullscreenPlaylistPlacement = (
	container: PlaylistAnchorRect,
	trigger: PlaylistAnchorRect,
	panelWidth: number,
	gap: number,
	topInset: number,
): FullscreenPlaylistPlacement => {
	const horizontalInset = Math.max(0, gap);
	const usableWidth = Math.max(0, container.width - horizontalInset * 2);
	const fittedPanelWidth = Math.min(Math.max(0, panelWidth), usableWidth);
	const preferredLeft = trigger.right - container.left - fittedPanelWidth;
	const left = clamp(
		preferredLeft,
		horizontalInset,
		container.width - fittedPanelWidth - horizontalInset,
	);
	const triggerTop = clamp(trigger.top, container.top, container.bottom);

	return {
		left,
		bottom: Math.max(
			horizontalInset,
			container.bottom - triggerTop + horizontalInset,
		),
		maxHeight: Math.max(
			0,
			triggerTop - container.top - Math.max(0, topInset) - horizontalInset,
		),
	};
};
