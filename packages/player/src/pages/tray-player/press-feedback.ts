export const TRAY_CONTROL_MIN_PRESS_MS = 150;

export function getTrayControlPressReleaseDelay(
	pressedAt: number,
	now: number,
): number {
	if (!Number.isFinite(pressedAt) || !Number.isFinite(now)) {
		return TRAY_CONTROL_MIN_PRESS_MS;
	}

	const elapsed = Math.max(0, now - pressedAt);
	return Math.max(0, TRAY_CONTROL_MIN_PRESS_MS - elapsed);
}
