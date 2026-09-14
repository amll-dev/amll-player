import type {
	RhythmAnalysis,
	RhythmBeatPoint,
	RhythmOnsetPoint,
	RhythmTimedValue,
} from "../../utils/db-client.ts";
import {
	getRhythmImpactEvents,
	type RhythmImpactEvent,
} from "./rhythm-impact-events.ts";

const MIN_BEAT_PRE_ROLL_MS = 80;
const MAX_BEAT_PRE_ROLL_MS = 140;
const BEAT_PRE_ROLL_PERIOD_RATIO = 0.32;
const ONSET_PRE_ROLL_MS = 55;
const ONSET_RELEASE_MS = 240;
const ONSET_BEAT_MERGE_MS = 180;
const MIN_BEAT_RELEASE_MS = 185;
const MAX_BEAT_RELEASE_MS = 520;
const BEAT_RELEASE_PERIOD_RATIO = 0.35;
const STRONG_BEAT_PRE_ROLL_MS = 65;
const STRONG_BEAT_RELEASE_MS = 130;
const STRONG_BEAT_IMPACT_START = 0.96;
const STRONG_BEAT_IMPACT_FULL = 0.995;
const STRONG_BEAT_ABSOLUTE_RMS_FLOOR = 0.06;
const STRONG_BEAT_ABSOLUTE_RMS_FULL = 0.3;
const STRONG_BEAT_WEAK_EXTRA_PRE_ROLL_MS = 85;
const MAX_STRONG_BEAT_PRE_ROLL_MS =
	STRONG_BEAT_PRE_ROLL_MS + STRONG_BEAT_WEAK_EXTRA_PRE_ROLL_MS;
const STRONG_BEAT_FULL_ATTACK_STRENGTH = 0.5;
const PERCUSSIVE_ACCENT_PRE_ROLL_MS = 55;
const PERCUSSIVE_ACCENT_RELEASE_MS = 170;
const PERCUSSIVE_ACCENT_GRID_TOLERANCE_RATIO = 0.32;
const PERCUSSIVE_ACCENT_GRID_TOLERANCE_MIN_MS = 90;
const PERCUSSIVE_ACCENT_GRID_TOLERANCE_MAX_MS = 180;
const PERCUSSIVE_ACCENT_GRID_COVERAGE_FULL = 0.4;
const PERCUSSIVE_ACCENT_GRID_COVERAGE_LIMIT = 0.5;
const PERCUSSIVE_ACCENT_MIN_SALIENT_ONSETS = 6;
const PERCUSSIVE_ACCENT_LOCAL_RADIUS_MS = 4_000;
const PERCUSSIVE_ACCENT_LOCAL_MIN_SALIENT_ONSETS = 8;
const PERCUSSIVE_ACCENT_NMS_MS = 125;
const PERCUSSIVE_ACCENT_RAW_FLOOR = 0.18;
const PERCUSSIVE_ACCENT_STANDALONE_FLOOR = 0.64;
const PERCUSSIVE_ACCENT_QUANTILE_BIN_COUNT = 1024;
const PERCUSSIVE_ACCENT_RETIME_MIN_OFFSET_MS = 50;
const PERCUSSIVE_ACCENT_FAST_GRID_MIN_BPM = 150;
const PERCUSSIVE_ACCENT_STRONG_MIN_GAP_MS = 420;
const PERCUSSIVE_ACCENT_STRONG_RECOVERY_MAX_GAP_PERIODS = 6.25;
const PERCUSSIVE_ACCENT_STRONG_RELEASE_COVERAGE_START = 0.85;
const PERCUSSIVE_ACCENT_STRONG_RELEASE_COVERAGE_END = 1;
const PERCUSSIVE_ACCENT_STRONG_RAW_FLOOR = 0.88;
const PERCUSSIVE_ACCENT_STRONG_BREADTH_FLOOR = 0.85;
const PERCUSSIVE_ACCENT_STRONG_ENERGY_FLOOR = 0.75;
const PERCUSSIVE_ACCENT_STRONG_MAX = 0.65;

const VISUAL_ATTACK_MS = 70;
const VISUAL_RELEASE_MS = 180;
const BEAT_DYNAMIC_RANGE_SCALE = 0.2;
export const MAX_RHYTHM_VISUAL_STEP_MS = 50;

const ENERGY_SMOOTH_PAST_RADIUS_MS = 720;
const ENERGY_SMOOTH_FUTURE_RADIUS_MS = 160;
const ENERGY_SMOOTH_PAST_SIGMA_MS = 240;
const ENERGY_SMOOTH_FUTURE_SIGMA_MS = 90;
const ENERGY_SMOOTH_PAST_EDGE_MS = 240;
const ENERGY_SMOOTH_FUTURE_EDGE_MS = 80;
const BEAT_ENERGY_PEAK_RADIUS_MS = 90;
const BEAT_ENERGY_BASELINE_INNER_MS = 120;
const BEAT_ENERGY_BASELINE_RADIUS_MS = 320;
const ABSOLUTE_RMS_SILENCE_FLOOR = 0.015;
const ABSOLUTE_RMS_FULL_DRIVE = 0.55;
const ABSOLUTE_ACCENT_GAIN_FLOOR = 0.18;
const ABSOLUTE_BREATH_RELATIVE_FLOOR = 0.2;
const EVENT_AUDIBILITY_FULL_RMS = 0.08;
const MIN_PERCEPTIBLE_ACCENT = 0.32;
const UNDERSAMPLED_TEMPO_MIN_CONFIDENCE = 0.45;
const UNDERSAMPLED_TEMPO_MIN_DURATION_MS = 8_000;
const UNDERSAMPLED_TEMPO_MIN_BEAT_GAPS = 6;
const UNDERSAMPLED_TEMPO_MIN_PERIOD_RATIO = 1.6;
const ONSET_LEVEL_GAIN_FLOOR = 0.25;
const ONSET_LEVEL_FULL_HIT_RATIO = 0.45;

interface BeatStrengthProfile {
	lower: number;
	upper: number;
}

interface PercussiveAccentPoint {
	timeMs: number;
	strength: number;
	structured: boolean;
	peakEnergy: number;
	onsetIndex: number;
	coverageCorrection: number;
	localCorrection: number;
	levelGain: number;
}

interface PercussiveAccentCandidate extends PercussiveAccentPoint {
	coveredByGrid: boolean;
	bandBreadth: number;
	localCoverage: number;
	localSalientOnsetCount: number;
	undersampledTempo: boolean;
}

interface TempoGridProfile {
	startMs: number;
	endMs: number;
	periodMs: number;
	undersampled: boolean;
}

interface LocalGridCoverageProfile {
	corrections: Float64Array;
	coverages: Float64Array;
	counts: Uint32Array;
}

interface VisualBeatPoint {
	timeMs: number;
	value: number;
	periodMs?: number;
}

interface StrongAccentPoint {
	timeMs: number;
	strength: number;
}

interface PercussiveAccentProfile {
	gridCoverage: number;
	visualBeats: VisualBeatPoint[];
	points: PercussiveAccentPoint[];
	strongPoints: StrongAccentPoint[];
}

interface BeatEnergyEvidence {
	impact: number;
	peak: number;
}

const beatStrengthProfiles = new WeakMap<RhythmAnalysis, BeatStrengthProfile>();
const beatEnergyEvidences = new WeakMap<
	RhythmAnalysis,
	Map<RhythmBeatPoint, BeatEnergyEvidence>
>();
const usableBeatGridCache = new WeakMap<RhythmAnalysis, boolean>();
const percussiveAccentProfiles = new WeakMap<
	RhythmAnalysis,
	PercussiveAccentProfile
>();
const tempoGridProfiles = new WeakMap<RhythmAnalysis, TempoGridProfile[]>();
const visualEventProfiles = new WeakMap<
	RhythmAnalysis,
	PercussiveAccentProfile
>();

/**
 * 保持现有 0..0.4 接口范围；Mesh 内部会在拆分慢呼吸与重拍相位前将其
 * 重新归一化到 0..1，避免放大其他背景实现的输入。
 */
export const MAX_RHYTHM_VISUAL_VOLUME = 0.4;

export function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, value));
}

/** 两端一阶、二阶导数均为零，适合直接驱动视觉相位。 */
export function smootherStep01(value: number): number {
	const x = clamp01(value);
	return x * x * x * (x * (x * 6 - 15) + 10);
}

function lowerBound<T extends { timeMs: number }>(
	values: readonly T[],
	timeMs: number,
): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if ((values[middle]?.timeMs ?? Number.POSITIVE_INFINITY) < timeMs) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	return low;
}

function sampleEnergy(
	values: readonly RhythmTimedValue[],
	timeMs: number,
): number {
	if (values.length === 0) return 0;
	const nextIndex = lowerBound(values, timeMs);
	if (nextIndex === 0) return clamp01(values[0]?.value ?? 0);
	if (nextIndex >= values.length) {
		return clamp01(values[values.length - 1]?.value ?? 0);
	}

	const previous = values[nextIndex - 1];
	const next = values[nextIndex];
	if (!(previous && next)) return 0;
	const span = next.timeMs - previous.timeMs;
	if (span <= 0) return clamp01(next.value);
	const amount = clamp01((timeMs - previous.timeMs) / span);
	return clamp01(previous.value + (next.value - previous.value) * amount);
}

/**
 * energyEnvelope 约每 46ms 产生一个折点。非对称高斯平滑保留少量前视以
 * 平顺起势，但主要向过去取样，避免在响度变化前数百毫秒出现呼吸 pre-echo。
 * 窗口边缘平滑归零，采样点进出窗口时也不会突跳。
 */
function sampleSmoothedEnergy(
	values: readonly RhythmTimedValue[],
	timeMs: number,
): number {
	if (values.length === 0 || !Number.isFinite(timeMs)) return 0;
	let weightedValue = 0;
	let totalWeight = 0;
	let index = lowerBound(values, timeMs - ENERGY_SMOOTH_PAST_RADIUS_MS);
	while (index < values.length) {
		const point = values[index];
		if (!point || point.timeMs > timeMs + ENERGY_SMOOTH_FUTURE_RADIUS_MS) break;
		const offsetMs = point.timeMs - timeMs;
		const isFuture = offsetMs >= 0;
		const radiusMs = isFuture
			? ENERGY_SMOOTH_FUTURE_RADIUS_MS
			: ENERGY_SMOOTH_PAST_RADIUS_MS;
		const sigmaMs = isFuture
			? ENERGY_SMOOTH_FUTURE_SIGMA_MS
			: ENERGY_SMOOTH_PAST_SIGMA_MS;
		const edgeMs = isFuture
			? ENERGY_SMOOTH_FUTURE_EDGE_MS
			: ENERGY_SMOOTH_PAST_EDGE_MS;
		const edgeWeight = smootherStep01((radiusMs - Math.abs(offsetMs)) / edgeMs);
		const weight =
			edgeWeight * Math.exp(-(offsetMs * offsetMs) / (2 * sigmaMs * sigmaMs));
		weightedValue += clamp01(point.value) * weight;
		totalWeight += weight;
		index++;
	}
	return totalWeight > Number.EPSILON
		? clamp01(weightedValue / totalWeight)
		: sampleEnergy(values, timeMs);
}

/**
 * 后端 envelope 仍描述曲内相对起伏；energyScale 把它还原为近似绝对
 * RMS。视觉使用平滑的物理能量门控，避免轻缓歌曲中“相对最强”的拍点
 * 抢到与高响度电音相同的振幅。
 *
 * 返回 null 表示旧缓存或测试夹具没有绝对标尺，此时沿用旧映射，保证
 * JSON 向后兼容；v2 缓存会始终携带有效标尺（静音除外）。
 */
function approximateAbsoluteRms(
	analysis: RhythmAnalysis,
	relativeEnergy: number,
): number | null {
	const scale = analysis.energyScale;
	if (!Number.isFinite(scale) || scale <= Number.EPSILON) return null;
	return clamp01(relativeEnergy) * scale;
}

function absoluteEnergyDrive(
	analysis: RhythmAnalysis,
	relativeEnergy: number,
): number | null {
	const absoluteRms = approximateAbsoluteRms(analysis, relativeEnergy);
	if (absoluteRms === null) return null;
	return smootherStep01(
		(absoluteRms - ABSOLUTE_RMS_SILENCE_FLOOR) /
			(ABSOLUTE_RMS_FULL_DRIVE - ABSOLUTE_RMS_SILENCE_FLOOR),
	);
}

function visualEnergyDrive(
	analysis: RhythmAnalysis,
	relativeEnergy: number,
): number {
	const relativeDrive = Math.sqrt(clamp01(relativeEnergy));
	const absoluteDrive = absoluteEnergyDrive(analysis, relativeEnergy);
	return absoluteDrive === null
		? relativeDrive
		: relativeDrive *
				(ABSOLUTE_BREATH_RELATIVE_FLOOR +
					(1 - ABSOLUTE_BREATH_RELATIVE_FLOOR) * absoluteDrive);
}

function absoluteAccentGain(
	analysis: RhythmAnalysis,
	relativeEnergy: number,
): number {
	const absoluteDrive = absoluteEnergyDrive(analysis, relativeEnergy);
	return absoluteDrive === null
		? 1
		: ABSOLUTE_ACCENT_GAIN_FLOOR +
				(1 - ABSOLUTE_ACCENT_GAIN_FLOOR) * absoluteDrive;
}

/**
 * 绝对能量继续决定普通拍的主要幅度；另一条更低的可听性曲线只保证
 * 已经通过 beat/onset 声学验证的事件不被多级平滑压成肉眼不可见。
 * 下限封顶而不按比例抬高整段呼吸，因此轻缓段仍明显弱于高能量段。
 */
function perceptibleAccent(
	analysis: RhythmAnalysis,
	rawAccent: number,
	relativeEnergy: number,
): number {
	const accent = clamp01(rawAccent);
	const energyScaled = accent * absoluteAccentGain(analysis, relativeEnergy);
	const absoluteRms = approximateAbsoluteRms(analysis, relativeEnergy);
	if (absoluteRms === null) return accent;
	const audibility = smootherStep01(
		(absoluteRms - ABSOLUTE_RMS_SILENCE_FLOOR) /
			(EVENT_AUDIBILITY_FULL_RMS - ABSOLUTE_RMS_SILENCE_FLOOR),
	);
	return Math.max(
		energyScaled,
		Math.min(accent, MIN_PERCEPTIBLE_ACCENT) * audibility,
	);
}

/**
 * bands 只回答“哪个频带发生了变化”，不回答“它响不响”。v3 分析为每个
 * onset 附带各频带的绝对线性电平；把命中频带的电平除以全曲能量标尺，
 * 得到这次敲击在全曲响度语境下的真实占比，作为幅度增益。这样持续响亮
 * 却被自适应基线压低的鼓点不再输给“相对自身很新颖”的轻声部。旧缓存
 * (无 bandLevels)保持原幅度。
 */
function onsetLevelGain(
	analysis: RhythmAnalysis,
	onset: RhythmOnsetPoint,
): number {
	const levels = onset.bandLevels;
	const scale = analysis.energyScale;
	if (!levels || !Number.isFinite(scale) || scale <= Number.EPSILON) return 1;
	let hit = 0;
	for (let band = 0; band < levels.length; band++) {
		const level = levels[band] ?? 0;
		if (!Number.isFinite(level) || level <= 0) continue;
		const novelty = clamp01(onset.bands?.[band] ?? 0);
		hit = Math.max(hit, novelty * (level / scale));
	}
	return (
		ONSET_LEVEL_GAIN_FLOOR +
		(1 - ONSET_LEVEL_GAIN_FLOOR) *
			smootherStep01(hit / ONSET_LEVEL_FULL_HIT_RATIO)
	);
}

function quantile(sortedValues: readonly number[], amount: number): number {
	if (sortedValues.length === 0) return 0;
	const position = clamp01(amount) * (sortedValues.length - 1);
	const lowerIndex = Math.floor(position);
	const upperIndex = Math.ceil(position);
	const lower = sortedValues[lowerIndex] ?? 0;
	const upper = sortedValues[upperIndex] ?? lower;
	return lower + (upper - lower) * (position - lowerIndex);
}

/**
 * tempoSegments 是局部估计。若缓存中一个
 * 足够长且可信的快速分段，其局部周期明显短于该段实际拍点间距，就说明
 * 拍格被欠采样了。记录实际网格周期，既避免把稀疏拍的包络错误缩短，
 * 也给严格 onset 补普通视觉脉冲提供纯声学判据。
 */
function buildTempoGridProfiles(analysis: RhythmAnalysis): TempoGridProfile[] {
	const cached = tempoGridProfiles.get(analysis);
	if (cached) return cached;
	const profiles = analysis.tempoSegments.map((segment) => {
		const gaps: number[] = [];
		let beatIndex = Math.max(1, lowerBound(analysis.beats, segment.startMs));
		while (beatIndex < analysis.beats.length) {
			const previous = analysis.beats[beatIndex - 1];
			const current = analysis.beats[beatIndex];
			if (!(previous && current)) break;
			const midpoint = (previous.timeMs + current.timeMs) * 0.5;
			if (midpoint >= segment.endMs) break;
			if (midpoint >= segment.startMs) {
				const gap = current.timeMs - previous.timeMs;
				if (gap > 0) gaps.push(gap);
			}
			beatIndex++;
		}
		gaps.sort((left, right) => left - right);
		const observedPeriodMs = quantile(gaps, 0.5);
		const localPeriodMs =
			Number.isFinite(segment.bpm) && segment.bpm > 0
				? 60_000 / segment.bpm
				: 0;
		const undersampled =
			segment.bpm >= PERCUSSIVE_ACCENT_FAST_GRID_MIN_BPM &&
			segment.confidence >= UNDERSAMPLED_TEMPO_MIN_CONFIDENCE &&
			segment.endMs - segment.startMs >= UNDERSAMPLED_TEMPO_MIN_DURATION_MS &&
			gaps.length >= UNDERSAMPLED_TEMPO_MIN_BEAT_GAPS &&
			localPeriodMs > 0 &&
			observedPeriodMs / localPeriodMs >= UNDERSAMPLED_TEMPO_MIN_PERIOD_RATIO;
		return {
			startMs: segment.startMs,
			endMs: segment.endMs,
			periodMs: undersampled ? observedPeriodMs : localPeriodMs,
			undersampled,
		};
	});
	tempoGridProfiles.set(analysis, profiles);
	return profiles;
}

function tempoGridProfileAt(
	analysis: RhythmAnalysis,
	timeMs: number,
): TempoGridProfile | undefined {
	const profiles = buildTempoGridProfiles(analysis);
	let low = 0;
	let high = profiles.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if ((profiles[middle]?.startMs ?? Infinity) <= timeMs) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	const profile = profiles[low - 1];
	return profile && timeMs >= profile.startMs && timeMs < profile.endMs
		? profile
		: undefined;
}

function beatStrengthProfile(analysis: RhythmAnalysis): BeatStrengthProfile {
	const cached = beatStrengthProfiles.get(analysis);
	if (cached) return cached;

	const strengths = analysis.beats
		.map((point) => clamp01(point.strength))
		.filter((strength) => strength > 0)
		.sort((left, right) => left - right);
	const lower = quantile(strengths, 0.25);
	const profile = { lower, upper: quantile(strengths, 0.9) };
	beatStrengthProfiles.set(analysis, profile);
	return profile;
}

/**
 * novelty 衡量的是频谱变化，不等同于听感冲击；持续且等强的重低音可能
 * 因频谱形态相似而得到忽高忽低的 strength。用拍点附近 RMS 峰值相对
 * 局部底噪的抬升作为正交证据，持续响亮的铺底不会把每一拍都推成重拍。
 */
function beatEnergyEvidence(
	analysis: RhythmAnalysis,
	beat: RhythmBeatPoint,
): BeatEnergyEvidence {
	let cached = beatEnergyEvidences.get(analysis);
	if (!cached) {
		cached = new Map<RhythmBeatPoint, BeatEnergyEvidence>();
		const energy = analysis.energyEnvelope;
		for (const point of analysis.beats) {
			let energyIndex = lowerBound(
				energy,
				point.timeMs - BEAT_ENERGY_BASELINE_RADIUS_MS,
			);
			let peak = 0;
			const localBaselineValues: number[] = [];
			while (energyIndex < energy.length) {
				const energyPoint = energy[energyIndex];
				if (
					!energyPoint ||
					energyPoint.timeMs > point.timeMs + BEAT_ENERGY_BASELINE_RADIUS_MS
				) {
					break;
				}
				const offsetMs = Math.abs(energyPoint.timeMs - point.timeMs);
				const value = clamp01(energyPoint.value);
				if (offsetMs <= BEAT_ENERGY_PEAK_RADIUS_MS) {
					peak = Math.max(peak, value);
				} else if (offsetMs >= BEAT_ENERGY_BASELINE_INNER_MS) {
					localBaselineValues.push(value);
				}
				energyIndex++;
			}
			localBaselineValues.sort((left, right) => left - right);
			const baseline = quantile(localBaselineValues, 0.2);
			const absoluteImpact = smootherStep01((peak - 0.35) / 0.55);
			const transientImpact = smootherStep01((peak - baseline - 0.1) / 0.45);
			cached.set(point, {
				impact: absoluteImpact * (0.2 + transientImpact * 0.8),
				peak,
			});
		}
		beatEnergyEvidences.set(analysis, cached);
	}
	return cached.get(beat) ?? { impact: 0, peak: 0 };
}

function beatEnergyImpact(
	analysis: RhythmAnalysis,
	beat: RhythmBeatPoint,
): number {
	return beatEnergyEvidence(analysis, beat).impact;
}

/**
 * 包络里的 peak 只是曲内相对高度；安静曲目自己最响的一拍同样能到 1。
 * 强旋转必须由真实声压支撑，因此再乘一条绝对 RMS 门控，避免轻音乐的
 * “相对满格”拍点获得与高响度电音相同的旋转力度。旧缓存没有绝对标尺
 * 时保持原行为。
 */
function strongBeatAbsoluteGate(
	analysis: RhythmAnalysis,
	relativeEnergy: number,
): number {
	const absoluteRms = approximateAbsoluteRms(analysis, relativeEnergy);
	if (absoluteRms === null) return 1;
	return smootherStep01(
		(absoluteRms - STRONG_BEAT_ABSOLUTE_RMS_FLOOR) /
			(STRONG_BEAT_ABSOLUTE_RMS_FULL - STRONG_BEAT_ABSOLUTE_RMS_FLOOR),
	);
}

function approximatePercussiveSalientThreshold(
	onsets: readonly RhythmOnsetPoint[],
): number {
	const bins = new Uint32Array(PERCUSSIVE_ACCENT_QUANTILE_BIN_COUNT);
	for (const onset of onsets) {
		const bin = Math.min(
			PERCUSSIVE_ACCENT_QUANTILE_BIN_COUNT - 1,
			Math.floor(
				clamp01(onset.strength) * PERCUSSIVE_ACCENT_QUANTILE_BIN_COUNT,
			),
		);
		bins[bin]++;
	}
	const position = 0.8 * (onsets.length - 1);
	const lowerRank = Math.floor(position);
	const upperRank = Math.ceil(position);
	let lowerValue: number | undefined;
	let upperValue = 0;
	let seen = 0;
	for (let bin = 0; bin < bins.length; bin++) {
		seen += bins[bin] ?? 0;
		const value = bin / PERCUSSIVE_ACCENT_QUANTILE_BIN_COUNT;
		if (seen > lowerRank && lowerValue === undefined) lowerValue = value;
		if (seen <= upperRank) continue;
		upperValue = value;
		break;
	}
	const amount = position - lowerRank;
	const lower = lowerValue ?? upperValue;
	return Math.max(0.65, lower + (upperValue - lower) * amount);
}

function onsetGridCoverageFlags(
	onsets: readonly RhythmOnsetPoint[],
	beats: readonly RhythmBeatPoint[],
	toleranceMs: number,
): Uint8Array {
	const covered = new Uint8Array(onsets.length);
	if (beats.length === 0) return covered;

	let beatIndex = 0;
	for (let onsetIndex = 0; onsetIndex < onsets.length; onsetIndex++) {
		const onset = onsets[onsetIndex];
		if (!onset) continue;
		while (beatIndex + 1 < beats.length) {
			const current = beats[beatIndex];
			const next = beats[beatIndex + 1];
			if (!(current && next)) break;
			const currentDistance = Math.abs(current.timeMs - onset.timeMs);
			const nextDistance = Math.abs(next.timeMs - onset.timeMs);
			if (nextDistance < currentDistance || next.timeMs === current.timeMs) {
				beatIndex++;
			} else {
				break;
			}
		}
		const nearest = beats[beatIndex];
		if (nearest && Math.abs(nearest.timeMs - onset.timeMs) <= toleranceMs) {
			covered[onsetIndex] = 1;
		}
	}
	return covered;
}

function peakEnergyAroundPoints(
	points: readonly { timeMs: number }[],
	energy: readonly RhythmTimedValue[],
	radiusMs: number,
): Float64Array {
	const peaks = new Float64Array(points.length);
	const deque = new Int32Array(energy.length);
	let head = 0;
	let tail = 0;
	let nextEnergy = 0;

	for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
		const point = points[pointIndex];
		if (!point) continue;
		const upper = point.timeMs + radiusMs;
		const lower = point.timeMs - radiusMs;
		while (
			nextEnergy < energy.length &&
			(energy[nextEnergy]?.timeMs ?? Number.POSITIVE_INFINITY) <= upper
		) {
			const value = clamp01(energy[nextEnergy]?.value ?? 0);
			while (
				tail > head &&
				clamp01(energy[deque[tail - 1] ?? 0]?.value ?? 0) <= value
			) {
				tail--;
			}
			deque[tail++] = nextEnergy++;
		}
		while (
			head < tail &&
			(energy[deque[head] ?? 0]?.timeMs ?? Number.NEGATIVE_INFINITY) < lower
		) {
			head++;
		}
		peaks[pointIndex] =
			head < tail ? clamp01(energy[deque[head] ?? 0]?.value ?? 0) : 0;
	}
	return peaks;
}

function percussiveGridToleranceMs(analysis: RhythmAnalysis): number {
	const periodMs = analysis.globalBpm
		? 60_000 / Math.max(1, analysis.globalBpm)
		: PERCUSSIVE_ACCENT_GRID_TOLERANCE_MAX_MS /
			PERCUSSIVE_ACCENT_GRID_TOLERANCE_RATIO;
	return clamp(
		periodMs * PERCUSSIVE_ACCENT_GRID_TOLERANCE_RATIO,
		PERCUSSIVE_ACCENT_GRID_TOLERANCE_MIN_MS,
		PERCUSSIVE_ACCENT_GRID_TOLERANCE_MAX_MS,
	);
}

/**
 * 有些歌曲能建立全曲拍点网格，但局部敲击采用切分、三连击或完全不同的
 * 拍速。全曲 P80 覆盖率保留原有稀疏敲击补偿；另用 ±4 秒滑窗识别局部
 * 双速占位网格，只在快速网格确实失准时把脉冲搬回真实 onset。
 *
 * 声学门控同时要求频谱变化、至少三个频带的展开以及局部可听能量。
 * “三声—停—三声”结构允许较弱的第二、第三声被同组强声补足，但结构
 * 本身不能让没有声学冲击的普通密集 onset 变成重拍。
 */
function gridCoverageCorrection(gridCoverage: number): number {
	return (
		1 -
		smootherStep01(
			(gridCoverage - PERCUSSIVE_ACCENT_GRID_COVERAGE_FULL) /
				(PERCUSSIVE_ACCENT_GRID_COVERAGE_LIMIT -
					PERCUSSIVE_ACCENT_GRID_COVERAGE_FULL),
		)
	);
}

function localGridCoverageProfile<T extends { timeMs: number }>(
	queries: readonly T[],
	salientOnsets: readonly { timeMs: number; covered: boolean }[],
): LocalGridCoverageProfile {
	const corrections = new Float64Array(queries.length);
	const coverages = new Float64Array(queries.length);
	const counts = new Uint32Array(queries.length);
	let left = 0;
	let right = 0;
	let covered = 0;
	for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
		const timeMs = queries[queryIndex]?.timeMs ?? 0;
		while (
			right < salientOnsets.length &&
			(salientOnsets[right]?.timeMs ?? Number.POSITIVE_INFINITY) <=
				timeMs + PERCUSSIVE_ACCENT_LOCAL_RADIUS_MS
		) {
			covered += salientOnsets[right]?.covered ? 1 : 0;
			right++;
		}
		while (
			left < right &&
			(salientOnsets[left]?.timeMs ?? Number.NEGATIVE_INFINITY) <
				timeMs - PERCUSSIVE_ACCENT_LOCAL_RADIUS_MS
		) {
			covered -= salientOnsets[left]?.covered ? 1 : 0;
			left++;
		}
		const count = right - left;
		const coverage = count > 0 ? covered / count : 1;
		coverages[queryIndex] = coverage;
		counts[queryIndex] = count;
		const localCorrection =
			count >= PERCUSSIVE_ACCENT_LOCAL_MIN_SALIENT_ONSETS
				? gridCoverageCorrection(coverage)
				: 0;
		corrections[queryIndex] = localCorrection;
	}
	return { corrections, coverages, counts };
}

function percussiveAccentProfile(
	analysis: RhythmAnalysis,
): PercussiveAccentProfile {
	const cached = percussiveAccentProfiles.get(analysis);
	if (cached) return cached;

	const emptyProfile = {
		gridCoverage: 1,
		visualBeats: [],
		points: [],
		strongPoints: [],
	};
	if (!hasUsableBeatGrid(analysis)) {
		percussiveAccentProfiles.set(analysis, emptyProfile);
		return emptyProfile;
	}

	const salientThreshold = approximatePercussiveSalientThreshold(
		analysis.onsets,
	);
	// 后端会在网格中保留 strength=0 的占位点；它们不能证明附近的
	// onset 已被正确解释，否则快歌或错相位网格会天然得到虚假的高覆盖率。
	const usableBeats = analysis.beats.filter(
		(point) => clamp01(point.strength) >= 0.06,
	);
	const gridToleranceMs = percussiveGridToleranceMs(analysis);
	const coveredByGrid = onsetGridCoverageFlags(
		analysis.onsets,
		usableBeats,
		gridToleranceMs,
	);
	const salientOnsets: { timeMs: number; covered: boolean }[] = [];
	let coveredSalientOnsetCount = 0;
	for (let onsetIndex = 0; onsetIndex < analysis.onsets.length; onsetIndex++) {
		const onset = analysis.onsets[onsetIndex];
		if (!onset || clamp01(onset.strength) < salientThreshold) continue;
		const covered = coveredByGrid[onsetIndex] === 1;
		salientOnsets.push({ timeMs: onset.timeMs, covered });
		coveredSalientOnsetCount += covered ? 1 : 0;
	}
	const salientOnsetCount = salientOnsets.length;
	const gridCoverage =
		salientOnsetCount > 0 ? coveredSalientOnsetCount / salientOnsetCount : 1;
	const globalCorrection =
		salientOnsetCount >= PERCUSSIVE_ACCENT_MIN_SALIENT_ONSETS
			? gridCoverageCorrection(gridCoverage)
			: 0;
	const onsetLocalProfile = localGridCoverageProfile(
		analysis.onsets,
		salientOnsets,
	);
	const beatLocalProfile = localGridCoverageProfile(
		analysis.beats,
		salientOnsets,
	);
	const onsetLocalCorrections = onsetLocalProfile.corrections;
	const beatLocalCorrections = beatLocalProfile.corrections;
	const usesFastLocalRecovery =
		(analysis.globalBpm ?? 0) >= PERCUSSIVE_ACCENT_FAST_GRID_MIN_BPM;

	const peakEnergies = peakEnergyAroundPoints(
		analysis.onsets,
		analysis.energyEnvelope,
		90,
	);
	const candidates: PercussiveAccentCandidate[] = [];
	for (let onsetIndex = 0; onsetIndex < analysis.onsets.length; onsetIndex++) {
		const onset = analysis.onsets[onsetIndex];
		if (!onset) continue;
		const sortedBands = [...(onset.bands ?? [])].sort(
			(left, right) => right - left,
		);
		const bandBreadth =
			((sortedBands[0] ?? 0) + (sortedBands[1] ?? 0) + (sortedBands[2] ?? 0)) /
			3;
		const spectralStrength = smootherStep01(
			(clamp01(onset.strength) - 0.68) / 0.22,
		);
		const breadthStrength = smootherStep01((bandBreadth - 0.62) / 0.25);
		const peakEnergy = peakEnergies[onsetIndex] ?? 0;
		const audibleStrength = smootherStep01((peakEnergy - 0.42) / 0.43);
		const strength = Math.cbrt(
			spectralStrength * breadthStrength * audibleStrength,
		);
		if (strength < PERCUSSIVE_ACCENT_RAW_FLOOR) continue;
		const undersampledTempo =
			tempoGridProfileAt(analysis, onset.timeMs)?.undersampled ?? false;
		const localCorrection = onsetLocalCorrections[onsetIndex] ?? 0;

		const candidate = {
			timeMs: onset.timeMs,
			strength,
			structured: false,
			onsetIndex,
			coverageCorrection: Math.max(
				globalCorrection,
				usesFastLocalRecovery || undersampledTempo ? localCorrection : 0,
			),
			localCorrection,
			levelGain: onsetLevelGain(analysis, onset),
			coveredByGrid: coveredByGrid[onsetIndex] === 1,
			bandBreadth,
			peakEnergy,
			localCoverage: onsetLocalProfile.coverages[onsetIndex] ?? 1,
			localSalientOnsetCount: onsetLocalProfile.counts[onsetIndex] ?? 0,
			undersampledTempo,
		};
		const previous = candidates[candidates.length - 1];
		if (
			previous &&
			candidate.timeMs - previous.timeMs < PERCUSSIVE_ACCENT_NMS_MS
		) {
			if (candidate.strength > previous.strength) {
				candidates[candidates.length - 1] = candidate;
			}
			continue;
		}
		candidates.push(candidate);
	}

	const structuredTimes = new Set<number>();
	for (let index = 0; index + 5 < candidates.length; index++) {
		const window = candidates.slice(index, index + 6);
		const [first, second, third, fourth, fifth, sixth] = window;
		if (!(first && second && third && fourth && fifth && sixth)) continue;
		const shortGaps = [
			second.timeMs - first.timeMs,
			third.timeMs - second.timeMs,
			fifth.timeMs - fourth.timeMs,
			sixth.timeMs - fifth.timeMs,
		].sort((left, right) => left - right);
		const referenceGap = quantile(shortGaps, 0.5);
		const pauseGap = fourth.timeMs - third.timeMs;
		const regularTriplets =
			referenceGap >= 150 &&
			referenceGap <= 360 &&
			shortGaps.every(
				(gap) => Math.abs(gap - referenceGap) <= referenceGap * 0.22,
			);
		const separatedGroups =
			pauseGap >= referenceGap * 1.55 && pauseGap <= referenceGap * 3.2;
		if (regularTriplets && separatedGroups) {
			for (const point of window) structuredTimes.add(point.timeMs);
		}
	}

	const points: PercussiveAccentPoint[] = [];
	const candidateByOnsetIndex = new Map<number, PercussiveAccentCandidate>();
	for (const candidate of candidates) {
		candidateByOnsetIndex.set(candidate.onsetIndex, candidate);
		// 结构化三连击只沿用已经验证过的全曲低覆盖门控。局部恢复出来的
		// 333ms 双速节拍即使外形相似，也必须走受限的普通重拍通道。
		const structured =
			!candidate.undersampledTempo &&
			structuredTimes.has(candidate.timeMs) &&
			globalCorrection > 0 &&
			(!usesFastLocalRecovery ||
				globalCorrection >= candidate.localCorrection - 1e-6);
		const correction = structured
			? globalCorrection
			: candidate.coverageCorrection;
		const rawStrength = structured
			? Math.max(candidate.strength, 0.52 + candidate.strength * 0.18)
			: candidate.strength;
		const strength = rawStrength * correction;
		const fastLocalRecovery =
			usesFastLocalRecovery &&
			candidate.localCorrection > globalCorrection + 1e-6;
		if (
			(structured ||
				candidate.undersampledTempo ||
				((!candidate.coveredByGrid || fastLocalRecovery) &&
					rawStrength >= PERCUSSIVE_ACCENT_STANDALONE_FLOOR)) &&
			strength >= PERCUSSIVE_ACCENT_RAW_FLOOR
		) {
			points.push({
				timeMs: candidate.timeMs,
				strength,
				structured,
				peakEnergy: candidate.peakEnergy,
				onsetIndex: candidate.onsetIndex,
				coverageCorrection: correction,
				localCorrection: candidate.localCorrection,
				levelGain: candidate.levelGain,
			});
		}
	}

	// 一次线性归并记录 onset 原先会被哪个拍点吸收；随后把局部失准的
	// 脉冲搬到真实 onset 时间，而不是在旧拍点旁再叠一个短 residual。
	const assignedOnsetStrengths = new Float64Array(analysis.beats.length);
	const assignedOnsetLevelGains = new Float64Array(analysis.beats.length).fill(
		1,
	);
	const assignedBeatByOnset = new Int32Array(analysis.onsets.length);
	assignedBeatByOnset.fill(-1);
	let nearestBeatIndex = 0;
	for (let onsetIndex = 0; onsetIndex < analysis.onsets.length; onsetIndex++) {
		const onset = analysis.onsets[onsetIndex];
		if (!onset || analysis.beats.length === 0) continue;
		while (nearestBeatIndex + 1 < analysis.beats.length) {
			const current = analysis.beats[nearestBeatIndex];
			const next = analysis.beats[nearestBeatIndex + 1];
			if (!(current && next)) break;
			if (
				Math.abs(next.timeMs - onset.timeMs) <
				Math.abs(current.timeMs - onset.timeMs)
			) {
				nearestBeatIndex++;
			} else {
				break;
			}
		}
		const beat = analysis.beats[nearestBeatIndex];
		if (!beat || Math.abs(beat.timeMs - onset.timeMs) > ONSET_BEAT_MERGE_MS) {
			continue;
		}
		assignedBeatByOnset[onsetIndex] = nearestBeatIndex;
		const onsetStrength = clamp01(onset.strength);
		if (onsetStrength > (assignedOnsetStrengths[nearestBeatIndex] ?? 0)) {
			assignedOnsetStrengths[nearestBeatIndex] = onsetStrength;
			assignedOnsetLevelGains[nearestBeatIndex] = onsetLevelGain(
				analysis,
				onset,
			);
		}
	}

	const reroutePointByBeat = new Int32Array(analysis.beats.length);
	reroutePointByBeat.fill(-1);
	for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
		const point = points[pointIndex];
		const candidate = point
			? candidateByOnsetIndex.get(point.onsetIndex)
			: undefined;
		if (
			!point ||
			(!usesFastLocalRecovery && !candidate?.undersampledTempo) ||
			point.localCorrection <= globalCorrection + 1e-6
		) {
			continue;
		}
		const beatIndex = assignedBeatByOnset[point.onsetIndex] ?? -1;
		if (beatIndex < 0) continue;
		const currentPoint = points[reroutePointByBeat[beatIndex] ?? -1];
		if (!currentPoint || point.strength > currentPoint.strength) {
			reroutePointByBeat[beatIndex] = pointIndex;
		}
	}

	const consumedOnsets = new Set<number>();
	const beatPeakEnergies = peakEnergyAroundPoints(
		analysis.beats,
		analysis.energyEnvelope,
		BEAT_ENERGY_PEAK_RADIUS_MS,
	);
	const visualBeats = analysis.beats
		.flatMap((beat, beatIndex) => {
			const undersampledTempo =
				tempoGridProfileAt(analysis, beat.timeMs)?.undersampled ?? false;
			const normalizedStrength = normalizeBeatStrength(analysis, beat.strength);
			const impact = Math.max(
				normalizedStrength,
				beatEnergyImpact(analysis, beat),
			);
			const beatValue = impact * (0.82 + clamp01(beat.confidence) * 0.18);
			const placeholderBlend =
				1 - smootherStep01(clamp01(beat.strength) / 0.06);
			const onsetValue =
				Math.sqrt(assignedOnsetStrengths[beatIndex] ?? 0) *
				(assignedOnsetLevelGains[beatIndex] ?? 1) *
				(0.76 + placeholderBlend * 0.12);
			let value = Math.max(beatValue, onsetValue);
			let peakEnergy = beatPeakEnergies[beatIndex] ?? 0;
			let timeMs = beat.timeMs;
			const point = points[reroutePointByBeat[beatIndex] ?? -1];
			if (
				point &&
				(clamp01(beat.strength) < 0.06 ||
					Math.abs(point.timeMs - beat.timeMs) >
						PERCUSSIVE_ACCENT_RETIME_MIN_OFFSET_MS)
			) {
				timeMs += (point.timeMs - beat.timeMs) * point.coverageCorrection;
				value = Math.max(value, point.strength * 0.88 * point.levelGain);
				peakEnergy = Math.max(peakEnergy, point.peakEnergy);
				consumedOnsets.add(point.onsetIndex);
			} else if (
				(usesFastLocalRecovery || undersampledTempo) &&
				!point &&
				(assignedOnsetStrengths[beatIndex] ?? 0) < salientThreshold &&
				(beatLocalCorrections[beatIndex] ?? 0) > globalCorrection + 1e-6
			) {
				// 局部拍格已经被真实宽频敲击证明不可靠时，不能只移走 strength=0
				// 的占位拍。没有显著起音支撑的非零旧拍同样会在真实峰后约 200ms
				// 形成第二个肩峰；仍有显著起音的拍点则保留，避免误删真实敲击。
				value *= 1 - (beatLocalCorrections[beatIndex] ?? 0);
			}
			value = perceptibleAccent(analysis, value * 0.8, peakEnergy);
			return value > Number.EPSILON ? [{ timeMs, value }] : [];
		})
		.sort((left, right) => left.timeMs - right.timeMs);
	const residualPoints = points.filter((point) => {
		if (consumedOnsets.has(point.onsetIndex)) return false;
		const candidate = candidateByOnsetIndex.get(point.onsetIndex);
		const coveredLocalRecovery =
			(usesFastLocalRecovery || candidate?.undersampledTempo) &&
			point.localCorrection > globalCorrection + 1e-6 &&
			candidate?.coveredByGrid;
		return !coveredLocalRecovery;
	});

	const structuredStrongPoints = points.flatMap((point) =>
		point.structured
			? [
					{
						timeMs: point.timeMs,
						strength:
							Math.max(
								0.22,
								smootherStep01((point.strength - 0.45) / 0.45) * 0.35,
							) * strongBeatAbsoluteGate(analysis, point.peakEnergy),
					},
				]
			: [],
	);
	const structuredStrongTimes = new Set(
		points.filter((point) => point.structured).map((point) => point.timeMs),
	);
	const localStrongSeeds = points.flatMap((point) => {
		if (point.structured || point.localCorrection <= globalCorrection + 1e-6) {
			return [];
		}
		const candidate = candidateByOnsetIndex.get(point.onsetIndex);
		if (
			!candidate ||
			candidate.undersampledTempo ||
			candidate.strength < PERCUSSIVE_ACCENT_STRONG_RAW_FLOOR ||
			candidate.bandBreadth < PERCUSSIVE_ACCENT_STRONG_BREADTH_FLOOR ||
			candidate.peakEnergy < PERCUSSIVE_ACCENT_STRONG_ENERGY_FLOOR
		) {
			return [];
		}
		const strength =
			smootherStep01((candidate.strength - 0.82) / 0.18) *
			PERCUSSIVE_ACCENT_STRONG_MAX *
			point.coverageCorrection *
			strongBeatAbsoluteGate(analysis, point.peakEnergy);
		return strength >= 0.04
			? [
					{
						timeMs: point.timeMs,
						strength,
						coverageCorrection: point.coverageCorrection,
					},
				]
			: [];
	});
	const localStrongSeedsByTime = new Map(
		localStrongSeeds.map((point) => [point.timeMs, point]),
	);
	const ordinaryStrongCandidates: (StrongAccentPoint & { seeded: boolean })[] =
		[];
	const globalBpm = analysis.globalBpm ?? 0;
	if (globalBpm >= PERCUSSIVE_ACCENT_FAST_GRID_MIN_BPM) {
		const beatPeriodMs = 60_000 / globalBpm;
		const minGapMs = Math.max(
			PERCUSSIVE_ACCENT_STRONG_MIN_GAP_MS,
			beatPeriodMs * 1.25,
		);
		const maxRecoveryEvidenceGapMs =
			beatPeriodMs * PERCUSSIVE_ACCENT_STRONG_RECOVERY_MAX_GAP_PERIODS;
		let recoveryActive = false;
		let lastRecoveryEvidenceTimeMs = Number.NEGATIVE_INFINITY;
		let lastVisibleRecoveryTimeMs = Number.NEGATIVE_INFINITY;
		let recoveryCoverageCorrection = 0;
		let recoveryReleaseWeight = 1;
		for (const candidate of candidates) {
			if (
				candidate.undersampledTempo ||
				structuredStrongTimes.has(candidate.timeMs) ||
				candidate.strength < PERCUSSIVE_ACCENT_STRONG_RAW_FLOOR ||
				candidate.bandBreadth < PERCUSSIVE_ACCENT_STRONG_BREADTH_FLOOR ||
				candidate.peakEnergy < PERCUSSIVE_ACCENT_STRONG_ENERGY_FLOOR
			) {
				continue;
			}
			const seed = localStrongSeedsByTime.get(candidate.timeMs);
			const seeded = seed !== undefined;
			let strength = seed?.strength ?? 0;
			if (seed) {
				recoveryActive = true;
				lastRecoveryEvidenceTimeMs = candidate.timeMs;
				lastVisibleRecoveryTimeMs = candidate.timeMs;
				recoveryCoverageCorrection = seed.coverageCorrection;
				recoveryReleaseWeight = 1;
			} else {
				const evidenceExpired =
					candidate.localSalientOnsetCount <
						PERCUSSIVE_ACCENT_LOCAL_MIN_SALIENT_ONSETS ||
					candidate.timeMs - lastRecoveryEvidenceTimeMs >
						maxRecoveryEvidenceGapMs ||
					candidate.timeMs - lastVisibleRecoveryTimeMs >
						maxRecoveryEvidenceGapMs * 2;
				if (!recoveryActive || evidenceExpired) {
					recoveryActive = false;
					continue;
				}
				const localReleaseWeight =
					1 -
					smootherStep01(
						(candidate.localCoverage -
							PERCUSSIVE_ACCENT_STRONG_RELEASE_COVERAGE_START) /
							(PERCUSSIVE_ACCENT_STRONG_RELEASE_COVERAGE_END -
								PERCUSSIVE_ACCENT_STRONG_RELEASE_COVERAGE_START),
					);
				recoveryReleaseWeight = Math.min(
					recoveryReleaseWeight,
					localReleaseWeight,
				);
				const recoverableStrengthCeiling =
					PERCUSSIVE_ACCENT_STRONG_MAX *
					recoveryCoverageCorrection *
					recoveryReleaseWeight;
				if (recoverableStrengthCeiling < 0.04) {
					recoveryActive = false;
					continue;
				}
				strength =
					smootherStep01((candidate.strength - 0.82) / 0.18) *
					recoverableStrengthCeiling *
					strongBeatAbsoluteGate(analysis, candidate.peakEnergy);
				lastRecoveryEvidenceTimeMs = candidate.timeMs;
				if (strength < 0.04 || !candidate.coveredByGrid) {
					// 离网格的严格敲击只用于证明声学链路仍连续，不能直接升级为
					// 强旋转；暂时较弱的严格候选也不应关闭仍有恢复余量的链路。
					continue;
				}
				lastVisibleRecoveryTimeMs = candidate.timeMs;
				// 拍格逐渐恢复时仍由连续的严格声学证据续期，并随局部覆盖率平滑
				// 单调释放。这样不会在固定秒数处硬切，也不会在一段静默后重新增强。
			}
			if (strength < 0.04) continue;
			const previous =
				ordinaryStrongCandidates[ordinaryStrongCandidates.length - 1];
			if (previous && candidate.timeMs - previous.timeMs < minGapMs) {
				if (
					strength > previous.strength ||
					(seeded && !previous.seeded && strength >= previous.strength - 1e-6)
				) {
					ordinaryStrongCandidates[ordinaryStrongCandidates.length - 1] = {
						timeMs: candidate.timeMs,
						strength,
						seeded,
					};
				}
				continue;
			}
			ordinaryStrongCandidates.push({
				timeMs: candidate.timeMs,
				strength,
				seeded,
			});
		}
	}
	const ordinaryStrongPoints = ordinaryStrongCandidates.map(
		({ timeMs, strength }) => ({ timeMs, strength }),
	);

	const profile = {
		gridCoverage,
		visualBeats,
		points: residualPoints,
		strongPoints: [...structuredStrongPoints, ...ordinaryStrongPoints].sort(
			(left, right) => left.timeMs - right.timeMs,
		),
	};
	percussiveAccentProfiles.set(analysis, profile);
	return profile;
}

function hasUsableBeatGrid(analysis: RhythmAnalysis): boolean {
	const cached = usableBeatGridCache.get(analysis);
	if (cached !== undefined) return cached;
	const result = analysis.beats.some(
		(point) => clamp01(point.strength) >= 0.06,
	);
	usableBeatGridCache.set(analysis, result);
	return result;
}

function nearestImpact(
	events: readonly RhythmImpactEvent[],
	timeMs: number,
): RhythmImpactEvent | undefined {
	let result: RhythmImpactEvent | undefined;
	let score = 0;
	for (
		let index = lowerBound(events, timeMs - ONSET_BEAT_MERGE_MS);
		index < events.length;
		index++
	) {
		const event = events[index];
		const offset = Math.abs(event.timeMs - timeMs);
		if (event.timeMs > timeMs + ONSET_BEAT_MERGE_MS) break;
		const tolerance = Math.min(ONSET_BEAT_MERGE_MS, event.periodMs * 0.36);
		if (offset > tolerance) continue;
		const candidateScore =
			event.confidence * (1 - (offset / (tolerance + 1)) * 0.2);
		if (candidateScore > score) {
			result = event;
			score = candidateScore;
		}
	}
	return result;
}

/** Share acoustic event times with the rotation channel, including off-grid bass. */
function visualEventProfile(analysis: RhythmAnalysis): PercussiveAccentProfile {
	const cached = visualEventProfiles.get(analysis);
	if (cached) return cached;
	const base = percussiveAccentProfile(analysis);
	const events = getRhythmImpactEvents(analysis);
	if (events === null || events.length === 0) {
		visualEventProfiles.set(analysis, base);
		return base;
	}
	const consumed = new Set<RhythmImpactEvent>();
	// An acoustic event may adjust only its closest grid point. Moving
	// both neighbours part-way inward creates a false pair of close pulses.
	const owners = new Map<RhythmImpactEvent, VisualBeatPoint>();
	for (const beat of base.visualBeats) {
		const event = nearestImpact(events, beat.timeMs);
		if (!event) continue;
		const owner = owners.get(event);
		if (
			!owner ||
			Math.abs(beat.timeMs - event.timeMs) <
				Math.abs(owner.timeMs - event.timeMs)
		)
			owners.set(event, beat);
	}
	const visualBeats = base.visualBeats.map((beat) => {
		const event = nearestImpact(events, beat.timeMs);
		if (!event) return beat;
		if (owners.get(event) !== beat) return beat;
		consumed.add(event);
		const alignment = smootherStep01(event.confidence / 0.35);
		return {
			timeMs: beat.timeMs + (event.timeMs - beat.timeMs) * alignment,
			value: Math.max(
				beat.value,
				perceptibleAccent(analysis, event.strength * 0.8, event.peakEnergy),
			),
			periodMs:
				beatPeriodMs(analysis, beat.timeMs) * (1 - alignment) +
				event.periodMs * alignment,
		};
	});
	for (const event of events) {
		if (consumed.has(event)) continue;
		visualBeats.push({
			timeMs: event.timeMs,
			value: perceptibleAccent(
				analysis,
				event.strength * 0.8,
				event.peakEnergy,
			),
			periodMs: event.periodMs,
		});
	}
	visualBeats.sort((left, right) => left.timeMs - right.timeMs);
	const merged: VisualBeatPoint[] = [];
	for (const point of visualBeats) {
		const previous = merged[merged.length - 1];
		if (previous && Math.abs(previous.timeMs - point.timeMs) < 1) {
			previous.value = Math.max(previous.value, point.value);
		} else {
			merged.push({ ...point });
		}
	}
	const profile = {
		...base,
		visualBeats: merged,
		// These onsets already contributed to the shared low-frequency event.
		// Leave genuine subdivisions alone; remove duplicate displaced shoulders.
		points: base.points.map((point) => {
			const impact = nearestImpact(events, point.timeMs);
			return impact
				? {
						...point,
						strength:
							point.strength * (1 - smootherStep01(impact.confidence / 0.35)),
					}
				: point;
		}),
	};
	visualEventProfiles.set(analysis, profile);
	return profile;
}

/** 将全曲中等以下拍点映射为轻触，把 P90 重拍明确拉到满幅。 */
export function normalizeBeatStrength(
	analysis: RhythmAnalysis,
	strength: number,
): number {
	const safeStrength = clamp01(strength);
	if (safeStrength <= 0) return 0;
	const profile = beatStrengthProfile(analysis);
	const spread = Math.max(0, profile.upper - profile.lower);
	const relativeContrast = smootherStep01(
		(safeStrength - profile.lower) / Math.max(0.001, spread),
	);
	const uniformContrast = smootherStep01(
		safeStrength / Math.max(0.001, profile.upper),
	);
	// 对窄动态曲目少用分位对比，避免听感一致的重拍仅因很小的
	// novelty 差异就在 0.12 与 1.0 之间交替。动态真正足够宽时，
	// 仍保留原有的强弱分层。
	const rangeBlend = smootherStep01(spread / BEAT_DYNAMIC_RANGE_SCALE);
	const contrast =
		uniformContrast + (relativeContrast - uniformContrast) * rangeBlend;
	// 后端以 0.06 作为可定位真实拍点的门槛；在同一范围内连续淡入，
	// 避免极弱拍的一点浮点变化让视觉信号从静止直接跳到满幅。
	const visibility = smootherStep01(safeStrength / 0.06);
	return visibility * (0.12 + contrast * 0.88);
}

/**
 * 完整本地文件允许预知下一拍，因此在事件前平滑预起，在事件后平滑回落。
 * 该包络在事件点两侧都连续且导数为零，不会像指数脉冲一样突然换相位。
 */
export function sampleSmoothPulse(
	timeMs: number,
	pointTimeMs: number,
	preRollMs: number,
	releaseMs: number,
): number {
	if (!(Number.isFinite(timeMs) && Number.isFinite(pointTimeMs))) return 0;
	const offset = timeMs - pointTimeMs;
	if (offset < -preRollMs || offset > releaseMs) return 0;
	if (offset <= 0) {
		return smootherStep01(1 + offset / Math.max(1, preRollMs));
	}
	return 1 - smootherStep01(offset / Math.max(1, releaseMs));
}

function sampleTimedPulses<T extends { timeMs: number }>(
	values: readonly T[],
	timeMs: number,
	preRollMs: number,
	releaseMs: number,
	getValue: (point: T) => number,
): number {
	if (values.length === 0) return 0;
	const nextIndex = lowerBound(values, timeMs);
	let result = 0;

	const next = values[nextIndex];
	if (next && next.timeMs - timeMs <= preRollMs) {
		result = Math.max(
			result,
			clamp01(getValue(next)) *
				sampleSmoothPulse(timeMs, next.timeMs, preRollMs, releaseMs),
		);
	}

	for (let index = nextIndex - 1; index >= 0; index--) {
		const point = values[index];
		if (!point) break;
		if (timeMs - point.timeMs > releaseMs) break;
		result = Math.max(
			result,
			clamp01(getValue(point)) *
				sampleSmoothPulse(timeMs, point.timeMs, preRollMs, releaseMs),
		);
	}
	return clamp01(result);
}

function beatPeriodMs(analysis: RhythmAnalysis, timeMs: number): number {
	const localPeriodMs = tempoGridProfileAt(analysis, timeMs)?.periodMs ?? 0;
	if (Number.isFinite(localPeriodMs) && localPeriodMs > 0) {
		return localPeriodMs;
	}
	const bpm = analysis.globalBpm ?? 0;
	return bpm > 0 ? 60_000 / Math.max(1, bpm) : 500;
}

function beatPreRollMs(
	analysis: RhythmAnalysis,
	timeMs: number,
	eventPeriodMs?: number,
): number {
	const periodMs = eventPeriodMs ?? beatPeriodMs(analysis, timeMs);
	return clamp(
		periodMs * BEAT_PRE_ROLL_PERIOD_RATIO,
		MIN_BEAT_PRE_ROLL_MS,
		MAX_BEAT_PRE_ROLL_MS,
	);
}

function beatReleaseMs(
	analysis: RhythmAnalysis,
	timeMs: number,
	eventPeriodMs?: number,
): number {
	const periodMs = eventPeriodMs ?? beatPeriodMs(analysis, timeMs);
	return clamp(
		periodMs * BEAT_RELEASE_PERIOD_RATIO,
		MIN_BEAT_RELEASE_MS,
		MAX_BEAT_RELEASE_MS,
	);
}

/**
 * 每个拍点在自身时刻锁定局部 BPM。这样旧拍的释放跨过变速段边界时，
 * 不会因为当前采样时刻换段而在一帧内改用另一套包络时长。
 */
function sampleBeatPulses(
	analysis: RhythmAnalysis,
	values: readonly VisualBeatPoint[],
	timeMs: number,
): number {
	if (values.length === 0 || !Number.isFinite(timeMs)) return 0;
	const nextIndex = lowerBound(values, timeMs);
	let result = 0;

	const next = values[nextIndex];
	if (next) {
		const preRollMs = beatPreRollMs(analysis, next.timeMs, next.periodMs);
		if (next.timeMs - timeMs <= preRollMs) {
			result = Math.max(
				result,
				clamp01(next.value) *
					sampleSmoothPulse(
						timeMs,
						next.timeMs,
						preRollMs,
						beatReleaseMs(analysis, next.timeMs, next.periodMs),
					),
			);
		}
	}

	for (let index = nextIndex - 1; index >= 0; index--) {
		const point = values[index];
		if (!point) break;
		const ageMs = timeMs - point.timeMs;
		if (ageMs > MAX_BEAT_RELEASE_MS) break;
		const releaseMs = beatReleaseMs(analysis, point.timeMs, point.periodMs);
		if (ageMs > releaseMs) continue;
		result = Math.max(
			result,
			clamp01(point.value) *
				sampleSmoothPulse(
					timeMs,
					point.timeMs,
					beatPreRollMs(analysis, point.timeMs, point.periodMs),
					releaseMs,
				),
		);
	}
	return clamp01(result);
}

/**
 * 将分析结果变成连续的 0..1 视觉目标。
 *
 * 普通拍格保留轻声部的节律；有频带和能量支撑的低频事件校正拍点时间，
 * 并补足半速拍格之外的真实冲击。它与强旋转共享事件时间和邻拍间隔。
 */
export function sampleAnalysisTarget(
	analysis: RhythmAnalysis,
	timeMs: number,
): number {
	if (!Number.isFinite(timeMs)) return 0;
	const energy = sampleSmoothedEnergy(analysis.energyEnvelope, timeMs);
	const hasBeatGrid = hasUsableBeatGrid(analysis);
	const accentProfile = visualEventProfile(analysis);
	const beat = sampleBeatPulses(analysis, accentProfile.visualBeats, timeMs);
	const onset = hasBeatGrid
		? 0
		: sampleTimedPulses(
				analysis.onsets,
				timeMs,
				ONSET_PRE_ROLL_MS,
				ONSET_RELEASE_MS,
				(point) =>
					perceptibleAccent(
						analysis,
						Math.sqrt(clamp01(point.strength)) *
							0.3 *
							onsetLevelGain(analysis, point),
						sampleEnergy(analysis.energyEnvelope, point.timeMs),
					),
			);
	const ordinaryPercussiveAccent = sampleTimedPulses(
		accentProfile?.points ?? [],
		timeMs,
		PERCUSSIVE_ACCENT_PRE_ROLL_MS,
		PERCUSSIVE_ACCENT_RELEASE_MS,
		(point) =>
			point.structured
				? 0
				: perceptibleAccent(
						analysis,
						point.strength * 0.72 * point.levelGain,
						point.peakEnergy,
					),
	);
	const structuredPercussiveAccent = sampleTimedPulses(
		accentProfile?.points ?? [],
		timeMs,
		PERCUSSIVE_ACCENT_PRE_ROLL_MS,
		PERCUSSIVE_ACCENT_RELEASE_MS,
		(point) => (point.structured ? point.strength * point.levelGain : 0),
	);
	const structuredPresence = sampleTimedPulses(
		accentProfile?.points ?? [],
		timeMs,
		PERCUSSIVE_ACCENT_PRE_ROLL_MS,
		PERCUSSIVE_ACCENT_RELEASE_MS,
		(point) => (point.structured ? 1 : 0),
	);

	const energyDrive = visualEnergyDrive(analysis, energy);
	const breath = energyDrive * 0.2;
	const beatAccent = beat;
	const onsetFallback = hasBeatGrid ? 0 : onset;
	const ordinaryGridAccent = Math.max(beatAccent, onsetFallback);
	const ordinaryResidualAccent = ordinaryPercussiveAccent;
	const structuredResidualAccent = structuredPercussiveAccent * 0.72;
	const energyScaledTarget =
		breath + Math.max(ordinaryGridAccent, ordinaryResidualAccent);
	const legacyBreath = Math.sqrt(energy) * 0.2;
	const structuredBreath =
		breath + (legacyBreath - breath) * structuredPresence;
	const structuredTarget = structuredBreath + structuredResidualAccent;
	return clamp01(Math.max(energyScaledTarget, structuredTarget));
}

/**
 * 强拍脉冲的预滚随强度自适应：不足 0.5 的冲量用更长的起势时间，把
 * “不算重音却快速抽动一小段”变成缓慢的推挤；0.5 以上的极重拍保持原有
 * 65ms 的锐利前冲。只改事件前的爬坡形状，峰值时刻的数值完全不变。
 */
function strongBeatPreRollMs(strength: number): number {
	return (
		STRONG_BEAT_PRE_ROLL_MS +
		(1 - smootherStep01(strength / STRONG_BEAT_FULL_ATTACK_STRENGTH)) *
			STRONG_BEAT_WEAK_EXTRA_PRE_ROLL_MS
	);
}

function sampleStrongPulses<T extends { timeMs: number }>(
	values: readonly T[],
	timeMs: number,
	getStrength: (point: T) => number,
): number {
	if (values.length === 0) return 0;
	const nextIndex = lowerBound(values, timeMs);
	let result = 0;

	for (let index = nextIndex; index < values.length; index++) {
		const point = values[index];
		if (!point || point.timeMs - timeMs > MAX_STRONG_BEAT_PRE_ROLL_MS) break;
		const strength = clamp01(getStrength(point));
		if (strength <= 0) continue;
		result = Math.max(
			result,
			strength *
				sampleSmoothPulse(
					timeMs,
					point.timeMs,
					strongBeatPreRollMs(strength),
					STRONG_BEAT_RELEASE_MS,
				),
		);
	}

	for (let index = nextIndex - 1; index >= 0; index--) {
		const point = values[index];
		if (!point) break;
		if (timeMs - point.timeMs > STRONG_BEAT_RELEASE_MS) break;
		const strength = clamp01(getStrength(point));
		if (strength <= 0) continue;
		result = Math.max(
			result,
			strength *
				sampleSmoothPulse(
					timeMs,
					point.timeMs,
					strongBeatPreRollMs(strength),
					STRONG_BEAT_RELEASE_MS,
				),
		);
	}
	return clamp01(result);
}

/**
 * 额外旋转只响应有明确能量冲击的极强拍点。它与连续呼吸信号分离，
 * 短脉冲结束后由 Mesh 内的物理包络慢慢卸力，使下一拍能在尚未回零时
 * 再次把画面推开，而不是生成等速、对称的正反摆动。
 *
 * 两条通道都会再经过绝对 RMS 门控：相对包络只能证明“这拍在曲内最响”，
 * 不能证明它真的响。
 */
export function sampleStrongBeatTarget(
	analysis: RhythmAnalysis,
	timeMs: number,
): number {
	if (!Number.isFinite(timeMs)) return 0;
	const impacts = getRhythmImpactEvents(analysis);
	if (impacts !== null) {
		return sampleStrongPulses(impacts, timeMs, (point) => point.strength);
	}
	// Legacy payloads have no absolute band identity; retain their established
	// conservative grid-based behaviour until a current analysis is available.
	if (!hasUsableBeatGrid(analysis)) return 0;
	const lowFrequencyImpact = sampleStrongPulses(
		analysis.beats,
		timeMs,
		(point) => {
			const evidence = beatEnergyEvidence(analysis, point);
			return (
				smootherStep01(
					(evidence.impact - STRONG_BEAT_IMPACT_START) /
						(STRONG_BEAT_IMPACT_FULL - STRONG_BEAT_IMPACT_START),
				) * strongBeatAbsoluteGate(analysis, evidence.peak)
			);
		},
	);
	const percussiveImpact = sampleStrongPulses(
		percussiveAccentProfile(analysis).strongPoints,
		timeMs,
		(point) => point.strength,
	);
	return Math.max(lowFrequencyImpact, percussiveImpact);
}

export function mapRhythmTargetToVolume(target: number): number {
	return clamp01(target) * MAX_RHYTHM_VISUAL_VOLUME;
}

/**
 * 丢帧后不追赶没有真正显示过的动画。音乐时间仍按真实进度采样，只有
 * 当前可见帧的视觉状态推进量受限，避免恢复渲染时一步跳到新姿态。
 */
export function limitRhythmVisualDelta(deltaMs: number): number {
	if (!Number.isFinite(deltaMs)) return 0;
	return Math.min(MAX_RHYTHM_VISUAL_STEP_MS, Math.max(0, deltaMs));
}

/**
 * 帧率无关的一阶滤波。Mesh 已将呼吸和旋转拆开，释放阶段可以恢复明确
 * 的收缩；不再为了旧的“音量直接叠加相位”公式牺牲重拍幅度。
 */
export function advanceRhythmVisualVolume(
	current: number,
	target: number,
	deltaMs: number,
): number {
	const safeCurrent = clamp(current, 0, MAX_RHYTHM_VISUAL_VOLUME);
	const safeTarget = clamp(target, 0, MAX_RHYTHM_VISUAL_VOLUME);
	const safeDeltaMs = Number.isFinite(deltaMs) ? Math.max(0, deltaMs) : 0;
	if (safeDeltaMs === 0) return safeCurrent;

	const smoothingMs =
		safeTarget > safeCurrent ? VISUAL_ATTACK_MS : VISUAL_RELEASE_MS;
	const smoothing = 1 - Math.exp(-safeDeltaMs / smoothingMs);
	return clamp(
		safeCurrent + (safeTarget - safeCurrent) * smoothing,
		0,
		MAX_RHYTHM_VISUAL_VOLUME,
	);
}
