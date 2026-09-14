import type {
	RhythmAnalysis,
	RhythmOnsetPoint,
} from "../../utils/db-client.ts";

export interface RhythmImpactEvent {
	timeMs: number;
	/** Acoustic confidence before absolute level and motion-density scaling. */
	confidence: number;
	strength: number;
	peakEnergy: number;
	/** Actual neighbouring impacts, independent of half/double-time beat grids. */
	periodMs: number;
}

interface ImpactCandidate extends RhythmImpactEvent {
	lowLevel: number;
	levelGate: number;
	peakTimeMs: number;
}

const impactProfiles = new WeakMap<
	RhythmAnalysis,
	readonly RhythmImpactEvent[] | null
>();

function unit(value: number): number {
	return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function smooth(value: number): number {
	const x = unit(value);
	return x * x * x * (x * (x * 6 - 15) + 10);
}

function lowerBound<T extends { timeMs: number }>(
	points: readonly T[],
	timeMs: number,
): number {
	let left = 0;
	let right = points.length;
	while (left < right) {
		const middle = (left + right) >>> 1;
		if (points[middle].timeMs < timeMs) left = middle + 1;
		else right = middle;
	}
	return left;
}

function hasValidBandLevels(onset: RhythmOnsetPoint): boolean {
	return (
		onset.bandLevels?.length === 5 &&
		onset.bandLevels.every((value) => Number.isFinite(value) && value >= 0)
	);
}

function lowBandEvidence(onset: RhythmOnsetPoint): {
	level: number;
	presence: number;
	dominance: number;
} | null {
	const levels = onset.bandLevels;
	if (!levels || !hasValidBandLevels(onset)) {
		return null;
	}
	const totalPower = levels.reduce((sum, value) => sum + value * value, 0);
	if (totalPower <= Number.EPSILON) return null;
	// 30–150 Hz carries the bass body. 150–400 Hz contributes, but must not
	// turn every vocal/piano attack into a full-strength low-frequency impact.
	const lowPower = levels[0] ** 2 + levels[1] ** 2 * 0.35;
	return {
		level: Math.sqrt(lowPower),
		presence: smooth((lowPower / totalPower - 0.18) / 0.5),
		dominance: smooth((lowPower / totalPower - 0.5) / 0.25),
	};
}

/**
 * Build once in audio time, never in render time. A rising RMS lobe identifies
 * one attack; an onset supplies its time and measured low-frequency identity.
 * BPM is deliberately not an admission rule: a half-time grid, syncopation or
 * an absent grid cannot remove a real impact. Conversely, a grid alone cannot
 * manufacture bass when the spectral evidence is missing.
 *
 * null denotes a legacy analysis without absolute band levels. An empty list
 * denotes a current analysis with no supported impacts (e.g. a sustained pad).
 */
export function getRhythmImpactEvents(
	analysis: RhythmAnalysis,
): readonly RhythmImpactEvent[] | null {
	const cached = impactProfiles.get(analysis);
	if (cached !== undefined) return cached;
	const scale = analysis.energyScale;
	const bands = analysis.onsets.map(lowBandEvidence);
	if (
		!Number.isFinite(scale) ||
		scale <= Number.EPSILON ||
		analysis.onsets.some((onset) => !hasValidBandLevels(onset)) ||
		(!bands.some((band) => band !== null) && analysis.analyzerVersion < 3)
	) {
		impactProfiles.set(analysis, null);
		return null;
	}

	const energy = analysis.energyEnvelope;
	const onsetEnergyPeaks = analysis.onsets.map((onset) => {
		let peak = 0;
		for (
			let index = lowerBound(energy, onset.timeMs - 35);
			index < energy.length && energy[index].timeMs <= onset.timeMs + 65;
			index++
		) {
			peak = Math.max(peak, unit(energy[index].value));
		}
		return peak;
	});
	const candidatesByOnset = new Map<number, ImpactCandidate>();
	for (let index = 1; index < energy.length; index++) {
		const peak = energy[index];
		const height = unit(peak.value);
		if (
			!Number.isFinite(peak.timeMs) ||
			height <= unit(energy[index - 1].value)
		) {
			continue;
		}
		// A clipped/flat top is a single lobe. Keep its first maximum, so a long
		// bass sustain does not delay the event to the end of the plateau.
		let plateauEnd = index;
		while (
			plateauEnd + 1 < energy.length &&
			unit(energy[plateauEnd + 1].value) === height
		) {
			plateauEnd++;
		}
		if (
			plateauEnd + 1 < energy.length &&
			unit(energy[plateauEnd + 1].value) > height
		) {
			index = plateauEnd;
			continue;
		}
		let valleyIndex = index - 1;
		while (
			valleyIndex > 0 &&
			peak.timeMs - energy[valleyIndex - 1].timeMs <= 320 &&
			unit(energy[valleyIndex - 1].value) <= unit(energy[valleyIndex].value)
		) {
			valleyIndex--;
		}
		const valley = energy[valleyIndex];
		const rise = unit((height - unit(valley.value)) / Math.max(height, 0.001));
		const energyAttack = smooth((rise - 0.06) / 0.5);
		index = plateauEnd;
		if (energyAttack <= 0) continue;

		// RMS is block-averaged (~46 ms), so its maximum usually follows the
		// spectral attack. Search the rising lobe rather than around a raw beat.
		const fromMs = Math.max(peak.timeMs - 160, valley.timeMs - 46);
		let onsetIndex = lowerBound(analysis.onsets, fromMs);
		let selectedIndex = -1;
		let selectedScore = 0;
		while (onsetIndex < analysis.onsets.length) {
			const onset = analysis.onsets[onsetIndex];
			if (onset.timeMs > peak.timeMs + 35) break;
			const band = bands[onsetIndex];
			if (band && Number.isFinite(onset.timeMs)) {
				const distance = (onset.timeMs - (peak.timeMs - 23)) / 55;
				const score =
					unit(onset.strength) * Math.exp(-0.5 * distance * distance);
				if (score > selectedScore) {
					selectedScore = score;
					selectedIndex = onsetIndex;
				}
			}
			onsetIndex++;
		}
		if (selectedIndex < 0) continue;
		const onset = analysis.onsets[selectedIndex];
		const band = bands[selectedIndex];
		if (!band) continue;

		// A snare/hat over an unchanged bass sustain has total-RMS novelty but
		// no low-band attack. When nearby band observations exist, require that
		// the bass itself rises too. Sparse attacks retain the RMS evidence.
		let lowBaseline = band.level;
		let observations = 0;
		for (
			let prior = lowerBound(analysis.onsets, onset.timeMs - 350);
			prior < selectedIndex;
			prior++
		) {
			if (analysis.onsets[prior].timeMs > onset.timeMs - 90) break;
			const previousBand = bands[prior];
			if (!previousBand) continue;
			// Measurements at other attack peaks are not observations of the
			// baseline: equal kicks in a fast pattern also have equal band levels.
			if (onsetEnergyPeaks[prior] >= height * 0.85) continue;
			lowBaseline = Math.min(lowBaseline, previousBand.level);
			observations++;
		}
		const lowRise = (band.level - lowBaseline) / Math.max(band.level, 0.001);
		const lowAttack = smooth((lowRise - 0.03) / 0.45);
		const observationWeight = smooth(observations / 3);
		// Repeated bass attacks can have zero normalized spectral novelty. A
		// bass-dominated RMS lobe still supports them; a hat-dominated lobe over
		// steady bass needs actual low-band novelty or a measured low-band rise.
		const lowNovelty = smooth(
			(Math.max(unit(onset.bands[0]), unit(onset.bands[1])) - 0.05) / 0.5,
		);
		const lowSupport = Math.max(lowNovelty, lowAttack, band.dominance);
		const confidence =
			energyAttack *
			smooth((height - 0.25) / 0.65) *
			smooth(unit(onset.strength) / 0.25) *
			band.presence *
			lowSupport *
			(1 - observationWeight * (1 - lowAttack));
		const levelGate = smooth(
			(Math.min(height * scale, band.level) - 0.06) / 0.24,
		);
		if (confidence <= 0.001) continue;
		const candidate: ImpactCandidate = {
			timeMs: onset.timeMs,
			confidence,
			strength: confidence * levelGate,
			peakEnergy: height,
			periodMs: 500,
			lowLevel: band.level,
			levelGate,
			peakTimeMs: peak.timeMs,
		};
		const previous = candidatesByOnset.get(selectedIndex);
		if (!previous || candidate.strength > previous.strength) {
			candidatesByOnset.set(selectedIndex, candidate);
		}
	}
	// Adjacent maxima on one broad ridge are one physical impact. A genuine
	// intervening energy valley keeps fast kicks distinct, without a cooldown.
	const ridges: ImpactCandidate[] = [];
	for (const candidate of [...candidatesByOnset.values()].sort(
		(left, right) => left.peakTimeMs - right.peakTimeMs,
	)) {
		const previous = ridges.at(-1);
		let valley = 0;
		if (previous && candidate.peakTimeMs - previous.peakTimeMs <= 320) {
			valley = 1;
			for (
				let index = lowerBound(energy, previous.peakTimeMs);
				index < energy.length && energy[index].timeMs <= candidate.peakTimeMs;
				index++
			) {
				valley = Math.min(valley, unit(energy[index].value));
			}
		}
		if (
			previous &&
			valley >= Math.min(previous.peakEnergy, candidate.peakEnergy) * 0.8
		) {
			if (candidate.strength > previous.strength)
				ridges[ridges.length - 1] = candidate;
		} else ridges.push(candidate);
	}
	const candidates = ridges.sort((left, right) => left.timeMs - right.timeMs);

	// Stabilize repeated, acoustically similar attacks, not whole time spans.
	// A real level drop immediately loses its absolute gain; silence cannot
	// inherit a prior kick. All history is evaluated once in chronological order.
	const stabilized = candidates.map((point, index) => {
		let total = point.confidence;
		let weight = 1;
		for (let prior = index - 1; prior >= Math.max(0, index - 4); prior--) {
			const previous = candidates[prior];
			const gap = point.timeMs - previous.timeMs;
			if (gap > 2_000) break;
			const levelDistance = Math.log(point.lowLevel / previous.lowLevel) / 0.3;
			const peakDistance =
				Math.log(point.peakEnergy / previous.peakEnergy) / 0.25;
			const similarity = Math.exp(
				-0.5 * (levelDistance ** 2 + peakDistance ** 2) - gap / 1_000,
			);
			total += previous.confidence * similarity;
			weight += similarity;
		}
		const confidence =
			point.confidence +
			(total / weight - point.confidence) *
				0.3 *
				smooth(point.confidence / 0.2);
		return { ...point, confidence, strength: confidence * point.levelGate };
	});
	const events = stabilized.map((point, index): RhythmImpactEvent => {
		// Limit accumulated motion continuously. Dense drum fills receive smaller
		// impulses, rather than dropping every other hit via a fixed cooldown/BPM.
		let load = point.strength;
		let periodMs = 1_000;
		for (
			let neighbour = lowerBound(stabilized, point.timeMs - 900);
			neighbour < stabilized.length;
			neighbour++
		) {
			const other = stabilized[neighbour];
			const distance = Math.abs(other.timeMs - point.timeMs);
			if (other.timeMs > point.timeMs + 900) break;
			if (neighbour !== index) {
				load += other.strength * Math.exp(-distance / 180);
				const relativeConfidence = Math.min(
					1,
					other.confidence / Math.max(0.1, point.confidence),
				);
				periodMs = Math.min(
					periodMs,
					distance / Math.max(0.001, relativeConfidence),
				);
			}
		}
		return {
			timeMs: point.timeMs,
			confidence: point.confidence,
			strength: point.strength / Math.max(1, load),
			peakEnergy: point.peakEnergy,
			periodMs: Math.max(180, periodMs),
		};
	});
	impactProfiles.set(analysis, events);
	return events;
}
