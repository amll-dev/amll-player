export interface VideoSegment {
	inPointMs: number;
	outPointMs: number;
	loopEnabled: boolean;
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function positiveModulo(value: number, divisor: number): number {
	if (!Number.isFinite(value) || !Number.isFinite(divisor) || divisor <= 0) {
		return 0;
	}
	return ((value % divisor) + divisor) % divisor;
}

export function normalizeVideoSegment(
	segment: VideoSegment,
	durationMs: number,
): VideoSegment | null {
	if (
		!Number.isFinite(durationMs) ||
		durationMs <= 0 ||
		!Number.isFinite(segment.inPointMs) ||
		!Number.isFinite(segment.outPointMs)
	) {
		return null;
	}
	const inPointMs = clamp(Math.round(segment.inPointMs), 0, durationMs);
	const outPointMs = clamp(Math.round(segment.outPointMs), 0, durationMs);
	if (outPointMs - inPointMs < 100) return null;
	return { ...segment, inPointMs, outPointMs };
}

export function resolveVideoTimeMs(
	rawVideoTimeMs: number,
	segment: VideoSegment,
): number {
	const lengthMs = segment.outPointMs - segment.inPointMs;
	if (lengthMs <= 0) return segment.inPointMs;
	if (segment.loopEnabled) {
		return (
			segment.inPointMs +
			positiveModulo(rawVideoTimeMs - segment.inPointMs, lengthMs)
		);
	}
	return clamp(rawVideoTimeMs, segment.inPointMs, segment.outPointMs - 16);
}

export function isVideoTimeInSegment(
	videoTimeMs: number,
	segment: VideoSegment,
): boolean {
	return (
		Number.isFinite(videoTimeMs) &&
		videoTimeMs >= segment.inPointMs &&
		videoTimeMs < segment.outPointMs
	);
}

export function circularVideoDriftMs(
	actualMs: number,
	targetMs: number,
	segment: VideoSegment,
): number {
	if (!segment.loopEnabled) return targetMs - actualMs;
	const lengthMs = segment.outPointMs - segment.inPointMs;
	if (lengthMs <= 0) return 0;
	let delta = positiveModulo(targetMs - actualMs, lengthMs);
	if (delta > lengthMs / 2) delta -= lengthMs;
	return delta;
}
