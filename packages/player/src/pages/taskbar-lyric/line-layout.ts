export const TASKBAR_LINE_HEIGHT_EM = 1.2;

export function getCenteredLineStackOffsetEm(
	lineScales: readonly number[],
	reservedLineCount = 2,
): number {
	const visibleLineCount = lineScales.reduce((sum, scale) => sum + scale, 0);
	return (TASKBAR_LINE_HEIGHT_EM * (reservedLineCount - visibleLineCount)) / 2;
}

export function formatEm(value: number): string {
	return `${Number(value.toFixed(4))}em`;
}
