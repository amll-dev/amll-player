export interface RhythmAnalysisRequestIdentity {
	musicId: string;
	generation: number;
}

export interface RhythmAnalysisRetryScheduler {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export type RhythmAnalysisRetryKind = "transient" | "regular";

export interface RhythmAnalysisRetrySchedule {
	kind: RhythmAnalysisRetryKind;
	retryNumber: number;
	delayMs: number;
}

const TRANSIENT_RETRY_DELAYS_MS = [200, 500, 1_000, 2_000, 4_000] as const;
const REGULAR_RETRY_DELAYS_MS = [750, 2_000] as const;

const browserScheduler: RhythmAnalysisRetryScheduler = {
	setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
	clearTimeout: (handle) =>
		globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function identitiesMatch(
	left: RhythmAnalysisRequestIdentity | null,
	right: RhythmAnalysisRequestIdentity,
): boolean {
	return (
		left?.musicId === right.musicId && left.generation === right.generation
	);
}

export function classifyRhythmAnalysisRetry(
	error: unknown,
): RhythmAnalysisRetryKind {
	const message = String(error).toUpperCase();
	return message.includes("DECODER_BUSY") || message.includes("SUPERSEDED")
		? "transient"
		: "regular";
}

/**
 * Keeps retry state separate from React rendering. A generation identifies one
 * playback of one song, so timers left by rapid skips can be cancelled without
 * allowing their callbacks to write into the next track.
 */
export class RhythmAnalysisRetryController {
	private activeIdentity: RhythmAnalysisRequestIdentity | null = null;
	private timerHandle: unknown | null = null;
	private totalRetryCount = 0;
	private regularRetryCount = 0;
	private readonly scheduler: RhythmAnalysisRetryScheduler;

	constructor(scheduler: RhythmAnalysisRetryScheduler = browserScheduler) {
		this.scheduler = scheduler;
	}

	begin(identity: RhythmAnalysisRequestIdentity | null): void {
		this.clearTimer();
		this.activeIdentity = identity;
		this.totalRetryCount = 0;
		this.regularRetryCount = 0;
	}

	isCurrent(identity: RhythmAnalysisRequestIdentity): boolean {
		return identitiesMatch(this.activeIdentity, identity);
	}

	succeed(identity: RhythmAnalysisRequestIdentity): void {
		if (!this.isCurrent(identity)) return;
		this.clearTimer();
		this.totalRetryCount = 0;
		this.regularRetryCount = 0;
	}

	scheduleFailure(
		identity: RhythmAnalysisRequestIdentity,
		error: unknown,
		retry: (identity: RhythmAnalysisRequestIdentity) => void,
	): RhythmAnalysisRetrySchedule | null {
		if (!this.isCurrent(identity) || this.timerHandle !== null) return null;

		const kind = classifyRhythmAnalysisRetry(error);
		if (this.totalRetryCount >= TRANSIENT_RETRY_DELAYS_MS.length) {
			return null;
		}

		const delayMs =
			kind === "transient"
				? TRANSIENT_RETRY_DELAYS_MS[this.totalRetryCount]
				: REGULAR_RETRY_DELAYS_MS[this.regularRetryCount];
		if (delayMs === undefined) return null;

		this.totalRetryCount += 1;
		if (kind === "regular") this.regularRetryCount += 1;
		const retryNumber = this.totalRetryCount;
		const scheduledIdentity = { ...identity };

		this.timerHandle = this.scheduler.setTimeout(() => {
			this.timerHandle = null;
			if (!this.isCurrent(scheduledIdentity)) return;
			retry(scheduledIdentity);
		}, delayMs);

		return { kind, retryNumber, delayMs };
	}

	cancel(): void {
		this.clearTimer();
		this.activeIdentity = null;
		this.totalRetryCount = 0;
		this.regularRetryCount = 0;
	}

	private clearTimer(): void {
		if (this.timerHandle === null) return;
		this.scheduler.clearTimeout(this.timerHandle);
		this.timerHandle = null;
	}
}
