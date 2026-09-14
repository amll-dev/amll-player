import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	advanceRhythmVisualVolume,
	limitRhythmVisualDelta,
	mapRhythmTargetToVolume,
	normalizeBeatStrength,
	sampleAnalysisTarget,
	sampleSmoothPulse,
	sampleStrongBeatTarget,
} from "../src/components/LocalMusicContext/rhythm-visual-signal.ts";

globalThis.MouseEvent ??= class {};
const { MeshGradientRenderer } = await import(
	"../node_modules/@applemusic-like-lyrics/core/dist/amll-core.mjs"
);

function makeAnalysis({
	beatTime = 1_000,
	beatStrength = 0.9,
	onsetTime = null,
} = {}) {
	return {
		analyzerVersion: 1,
		durationMs: 4_000,
		globalBpm: 120,
		confidence: 0.65,
		beats: [
			{ timeMs: beatTime, strength: beatStrength, confidence: 0.8 },
			{ timeMs: beatTime + 500, strength: 0.8, confidence: 0.75 },
		],
		onsets:
			onsetTime === null
				? []
				: [
						{
							timeMs: onsetTime,
							strength: 1,
							bands: [0.1, 0.3, 0.7, 0.9, 1],
						},
					],
		tempoSegments: [],
		energyEnvelope: [
			{ timeMs: 0, value: 0.35 },
			{ timeMs: 4_000, value: 0.35 },
		],
	};
}

test("拍点包络在事件边界连续且峰值两侧没有突跳", () => {
	const before = sampleSmoothPulse(999.999, 1_000, 120, 340);
	const at = sampleSmoothPulse(1_000, 1_000, 120, 340);
	const after = sampleSmoothPulse(1_000.001, 1_000, 120, 340);

	assert.ok(Math.abs(at - before) < 1e-9);
	assert.ok(Math.abs(at - after) < 1e-9);
	assert.equal(at, 1);
});

test("同一拍点窗口内的 onset 与弱 beat 也只产生一个视觉峰", () => {
	for (const onsetOffsetMs of [-180, -160, -20, 20, 160, 180]) {
		const analysis = makeAnalysis({
			beatStrength: 0.3,
			onsetTime: 1_000 + onsetOffsetMs,
		});
		const samples = [];
		for (let timeMs = 650; timeMs <= 1_350; timeMs += 2) {
			samples.push(sampleAnalysisTarget(analysis, timeMs));
		}

		let localPeaks = 0;
		for (let index = 1; index < samples.length - 1; index++) {
			if (
				(samples[index] ?? 0) > (samples[index - 1] ?? 0) &&
				(samples[index] ?? 0) >= (samples[index + 1] ?? 0)
			) {
				localPeaks++;
			}
		}
		assert.equal(localPeaks, 1, `onset 偏移 ${onsetOffsetMs}ms 时出现双峰`);
	}
});

test("可靠 beat grid 会屏蔽高密度 onset 的独立碎动", () => {
	const withoutOnsets = makeAnalysis();
	const withDenseOnsets = {
		...withoutOnsets,
		onsets: Array.from({ length: 18 }, (_, index) => ({
			timeMs: 650 + index * 70,
			strength: index % 2 === 0 ? 1 : 0.45,
			bands: [0.2, 0.4, 0.7, 0.9, 1],
		})),
	};

	for (let timeMs = 650; timeMs <= 1_850; timeMs += 5) {
		assert.equal(
			sampleAnalysisTarget(withDenseOnsets, timeMs),
			sampleAnalysisTarget(withoutOnsets, timeMs),
			`高密度 onset 在 ${timeMs}ms 改变了可靠拍点轨迹`,
		);
	}
});

test("单个有效拍点可驱动视觉，纯空拍网格则回退到 onset", () => {
	const singleBeat = {
		...makeAnalysis(),
		beats: [{ timeMs: 1_000, strength: 0.8, confidence: 0.8 }],
		onsets: [],
	};
	assert.ok(sampleAnalysisTarget(singleBeat, 1_000) > 0.5);

	const emptyGrid = {
		...makeAnalysis({ onsetTime: 1_000 }),
		beats: [
			{ timeMs: 500, strength: 0, confidence: 0.1 },
			{ timeMs: 1_500, strength: 0, confidence: 0.1 },
		],
	};
	assert.ok(sampleAnalysisTarget(emptyGrid, 1_000) > 0.2);
});

test("空拍占位会吸收邻近 onset 的强度而不是把真实打击删掉", () => {
	for (const beatStrength of [0, 0.001]) {
		const withoutOnset = makeAnalysis({ beatStrength });
		const withOnset = makeAnalysis({ beatStrength, onsetTime: 1_000 });
		const baseline = sampleAnalysisTarget(withoutOnset, 1_000);
		const accented = sampleAnalysisTarget(withOnset, 1_000);
		assert.ok(
			accented > baseline + 0.15,
			`beatStrength=${beatStrength} 时邻近 onset 未并入拍点`,
		);
	}
});

test("正常 beat 也会合并同拍 onset，修正被 novelty 低估的重拍", () => {
	const withoutOnset = makeAnalysis({ beatStrength: 0.43 });
	const withOnset = makeAnalysis({ beatStrength: 0.43, onsetTime: 1_000 });
	const baseline = sampleAnalysisTarget(withoutOnset, 1_000);
	const corrected = sampleAnalysisTarget(withOnset, 1_000);

	assert.ok(corrected >= 0.65, `同拍 onset 合并后仅达到 ${corrected}`);
	assert.ok(
		corrected > baseline + 0.25,
		`正常 beat 的 onset 校正幅度不足：${baseline} -> ${corrected}`,
	);
});

test("拍点附近的高能量会补强持续重低音，而不会依赖 novelty 抖动", () => {
	const beatStrengths = [0.33, 0.44, 0.56, 0.41];
	const analysis = {
		...makeAnalysis(),
		durationMs: 3_000,
		beats: beatStrengths.map((strength, index) => ({
			timeMs: 750 + index * 500,
			strength,
			confidence: 0.45,
		})),
		onsets: [],
		energyEnvelope: beatStrengths.flatMap((_, index) => {
			const beatTime = 750 + index * 500;
			return [
				{ timeMs: beatTime - 230, value: 0.44 },
				{ timeMs: beatTime - 46, value: 0.72 },
				{ timeMs: beatTime, value: 1 },
				{ timeMs: beatTime + 46, value: 0.68 },
				{ timeMs: beatTime + 230, value: 0.45 },
			];
		}),
	};
	const targets = analysis.beats.map((beat) =>
		sampleAnalysisTarget(analysis, beat.timeMs),
	);

	assert.ok(Math.min(...targets) >= 0.82, `重低音仍出现弱拍：${targets}`);
	assert.ok(
		Math.max(...targets) - Math.min(...targets) <= 0.04,
		`等能量重低音仍随 novelty 闪烁：${targets}`,
	);
});

test("持续高能量铺底不会把缺少局部冲击的拍点误判为重拍", () => {
	const strengths = [0.1, 0.2, 0.3, 0.4, 0.5, 0.55, 0.58, 0.6, 0.61, 0.62];
	const analysis = {
		...makeAnalysis(),
		durationMs: 6_000,
		beats: strengths.map((strength, index) => ({
			timeMs: 500 + index * 500,
			strength,
			confidence: 0.8,
		})),
		onsets: [],
		energyEnvelope: Array.from({ length: 131 }, (_, index) => ({
			timeMs: index * 46,
			value: 0.9,
		})),
	};
	const weakBeatTarget = sampleAnalysisTarget(analysis, 1_000);
	assert.ok(weakBeatTarget < 0.4, `持续响亮铺底把弱拍推到 ${weakBeatTarget}`);
});

function makeAbsoluteEnergyPulseAnalysis(energyScale) {
	return {
		analyzerVersion: 2,
		durationMs: 5_000,
		globalBpm: 180,
		confidence: 0.7,
		beats: Array.from({ length: 12 }, (_, index) => ({
			timeMs: 500 + index * 333,
			strength: 0.55,
			confidence: 0.8,
		})),
		onsets: [],
		tempoSegments: [],
		energyEnvelope: Array.from({ length: 110 }, (_, index) => ({
			timeMs: index * 46,
			value: 0.82,
		})),
		energyScale,
	};
}

function summarizeAbsoluteEnergyMotion(analysis) {
	const deltaMs = 1_000 / 240;
	let volume = 0;
	let previousDifference = 0;
	let total = 0;
	let count = 0;
	let motion = 0;
	let maxStep = 0;
	let maxSecondDifference = 0;
	for (let timeMs = 0; timeMs <= 4_500; timeMs += deltaMs) {
		const next = advanceRhythmVisualVolume(
			volume,
			mapRhythmTargetToVolume(sampleAnalysisTarget(analysis, timeMs)),
			deltaMs,
		);
		const difference = next - volume;
		if (timeMs >= 500) {
			total += next;
			count++;
			motion += Math.abs(difference);
			maxStep = Math.max(maxStep, Math.abs(difference));
			maxSecondDifference = Math.max(
				maxSecondDifference,
				Math.abs(difference - previousDifference),
			);
		}
		previousDifference = difference;
		volume = next;
	}
	return {
		mean: total / count,
		motion,
		maxStep,
		maxSecondDifference,
	};
}

test("相同节律证据的动态强度会随绝对 RMS 单调增加", () => {
	const quiet = makeAbsoluteEnergyPulseAnalysis(0.12);
	const medium = makeAbsoluteEnergyPulseAnalysis(0.3);
	const loud = makeAbsoluteEnergyPulseAnalysis(0.58);
	const quietMotion = summarizeAbsoluteEnergyMotion(quiet);
	const mediumMotion = summarizeAbsoluteEnergyMotion(medium);
	const loudMotion = summarizeAbsoluteEnergyMotion(loud);

	assert.ok(
		sampleAnalysisTarget(quiet, 1_500) < sampleAnalysisTarget(medium, 1_500) &&
			sampleAnalysisTarget(medium, 1_500) < sampleAnalysisTarget(loud, 1_500),
		"绝对能量没有传递到拍点峰值",
	);
	assert.ok(
		quietMotion.mean < mediumMotion.mean && mediumMotion.mean < loudMotion.mean,
		`平均动态未随能量递增：${JSON.stringify({ quietMotion, mediumMotion, loudMotion })}`,
	);
	assert.ok(
		loudMotion.mean >= quietMotion.mean * 2.5,
		`高、低绝对能量的平均视觉差距被压平：${JSON.stringify({ quietMotion, loudMotion })}`,
	);
	assert.ok(
		loudMotion.motion >= quietMotion.motion * 2.25,
		`高能量累计运动未达到弱能量的 2.25 倍：${JSON.stringify({ quietMotion, loudMotion })}`,
	);
	assert.ok(loudMotion.maxStep < 0.012);
	assert.ok(loudMotion.maxSecondDifference < 0.0015);
});

test("缺少绝对能量标尺的旧缓存保持原视觉映射", () => {
	const legacy = makeAnalysis({ onsetTime: 1_000 });
	const expectedVisual = sampleAnalysisTarget(legacy, 1_000);
	const expectedStrong = sampleStrongBeatTarget(legacy, 1_000);
	for (const energyScale of [undefined, 0, Number.NaN]) {
		const compatible = { ...legacy, energyScale };
		assert.equal(sampleAnalysisTarget(compatible, 1_000), expectedVisual);
		assert.equal(sampleStrongBeatTarget(compatible, 1_000), expectedStrong);
	}
});

test("无结构化敲击的安静片段不会用旧相对呼吸绕过绝对能量门控", () => {
	const legacy = {
		...makeAnalysis(),
		globalBpm: null,
		beats: [],
		onsets: [],
		energyEnvelope: [
			{ timeMs: 0, value: 0.5 },
			{ timeMs: 4_000, value: 0.5 },
		],
	};
	const quiet = {
		...legacy,
		analyzerVersion: 2,
		energyScale: 0.12,
	};
	const legacyTarget = sampleAnalysisTarget(legacy, 2_000);
	const quietTarget = sampleAnalysisTarget(quiet, 2_000);
	assert.ok(quietTarget > 0, "安静歌曲的呼吸被完全清零");
	assert.ok(
		quietTarget < legacyTarget * 0.5,
		`绝对能量门控被旧呼吸下限绕过：${legacyTarget} -> ${quietTarget}`,
	);
});

// 以下两组是本机真实缓存的匿名前奏摘要：
// [beatTime, beatStrength, confidence, ±90ms RMS peak, merged onset strength]
const LOVE_PRELUDE_ROWS = [
	[1_126, 0.534339, 0.284344, 0.192783, 0.867434],
	[1_962, 0.502214, 0.275254, 0.178513, 0.815282],
	[2_798, 0.580302, 0.297349, 0.183003, 0.942049],
	[3_599, 0.49882, 0.274294, 0.181695, 0.809773],
	[4_423, 0.403407, 0.247297, 0.152946, 0.654882],
	[5_248, 0.513739, 0.278515, 0.142355, 0.833991],
	[6_049, 0.534016, 0.284253, 0.183869, 0.866908],
];

const SHOTS_PRELUDE_ROWS = [
	[801, 0.546143, 0.462952, 0.27016, 0.886596],
	[1_300, 0.546271, 0.46301, 0.278821, 0.886804],
	[1_800, 0.552883, 0.46602, 0.283731, 0.897537],
	[2_287, 0.486478, 0.435784, 0.249478, 0.789737],
	[2_798, 0.504174, 0.443842, 0.26507, 0.818464],
	[3_297, 0.491979, 0.438289, 0.261317, 0.798667],
	[3_796, 0.498327, 0.441179, 0.240177, 0.808972],
	[4_296, 0.541328, 0.460759, 0.277331, 0.878779],
	[4_795, 0.512616, 0.447686, 0.289015, 0.832169],
	[5_294, 0.50628, 0.444801, 0.28815, 0.821884],
	[5_793, 0.532006, 0.456514, 0.267049, 0.863645],
	[6_293, 0.547062, 0.46337, 0.305954, 0.888088],
];

const SHOTS_LATER_WEAK_ROWS = [
	[12_806, 0.493518, 0.43899, 0.375169, 0.801165],
	[13_328, 0.304684, 0.353007, 0.381372, 0.577053],
	[37_779, 0.490425, 0.437582, 0.363436, 0.796145],
	[38_301, 0.259099, 0.332251, 0.365461, 0.727938],
];

function makePreludeEnergyEnvelope(rows, baseline) {
	const values = new Map([
		[0, 0],
		[7_000, baseline],
	]);
	for (const [timeMs, , , peakEnergy] of rows) {
		values.set(timeMs - 220, baseline);
		values.set(timeMs, peakEnergy);
		values.set(timeMs + 220, baseline);
	}
	return [...values]
		.sort(([left], [right]) => left - right)
		.map(([timeMs, value]) => ({ timeMs, value }));
}

function makeWeakPreludeAnalysis(kind) {
	const isLove = kind === "love";
	const rows = isLove ? LOVE_PRELUDE_ROWS : SHOTS_PRELUDE_ROWS;
	const profileAnchors = isLove
		? [0.2, 0.3, 0.411315, 0.411315, 0.45, 0.5, 0.55, 0.574871, 0.574871, 0.7]
		: [0.3, 0.4, 0.437584, 0.437584, 0.48, 0.51, 0.53, 0.541507, 0.541507, 0.7];
	return {
		analyzerVersion: 2,
		durationMs: 80_000,
		globalBpm: isLove ? 72.975655 : 120.0448,
		confidence: isLove ? 0.408238 : 0.662615,
		beats: [
			...rows.map(([timeMs, strength, confidence]) => ({
				timeMs,
				strength,
				confidence,
			})),
			...profileAnchors.map((strength, index) => ({
				timeMs: 60_000 + index * 600,
				strength,
				confidence: 0.5,
			})),
		],
		onsets: rows.map(([timeMs, , , , strength]) => ({
			timeMs,
			strength,
			bands: [0.9, 0.86, 0.8, 0.65, 0.25],
		})),
		tempoSegments: [
			{
				startMs: 0,
				endMs: 80_000,
				bpm: isLove ? 144.47739 : 120.0504,
				confidence: isLove ? 0.425359 : 0.680576,
			},
		],
		energyEnvelope: makePreludeEnergyEnvelope(rows, isLove ? 0.1 : 0.17),
		energyScale: isLove ? 0.481243 : 0.76178,
	};
}

function makeExtendedShotsPreludeAnalysis() {
	const analysis = makeWeakPreludeAnalysis("shots");
	return {
		...analysis,
		beats: [
			...analysis.beats,
			...SHOTS_LATER_WEAK_ROWS.map(([timeMs, strength, confidence]) => ({
				timeMs,
				strength,
				confidence,
			})),
		].sort((left, right) => left.timeMs - right.timeMs),
		onsets: [
			...analysis.onsets,
			...SHOTS_LATER_WEAK_ROWS.map(([timeMs, , , , strength]) => ({
				timeMs,
				strength,
				bands: [0.9, 0.86, 0.8, 0.65, 0.25],
			})),
		].sort((left, right) => left.timeMs - right.timeMs),
		energyEnvelope: makePreludeEnergyEnvelope(
			[...SHOTS_PRELUDE_ROWS, ...SHOTS_LATER_WEAK_ROWS],
			0.17,
		),
	};
}

const INFERIORITY_SUPERIORITY_BEAT_ROWS = [
	[72_202, 0.484681, 0.345604],
	[73_143, 0.380015, 0.307737],
	[74_072, 0.540097, 0.365652],
	[75_024, 0.176453, 0.234091],
	[75_952, 0.498668, 0.350664],
	[76_870, 0.245963, 0.259239],
	[77_810, 0.272822, 0.268956],
	[78_762, 0.318449, 0.285463],
	[79_702, 0.335497, 0.291631],
	[80_620, 0.186169, 0.237606],
	[81_583, 0.470048, 0.34031],
	[82_512, 0.273584, 0.269232],
	[83_476, 0.373858, 0.305509],
	[84_393, 0.335613, 0.291673],
	[85_322, 0.40058, 0.315177],
	[86_262, 0.455158, 0.334922],
	[87_203, 0.46593, 0.33882],
	[88_131, 0.3977, 0.314135],
	[89_083, 0.507642, 0.353911],
];

// [onsetTime, novelty, bands, ±90ms RMS peak]
const INFERIORITY_SUPERIORITY_ONSET_ROWS = [
	[72_945, 0.824085, [0.032, 0.837, 0.967, 0.66, 0.795], 0.470889],
	[73_329, 0.868931, [0.189, 0.978, 0.928, 0.653, 0.701], 0.467816],
	[73_700, 0.871011, [0, 0.976, 0.992, 0.835, 0.356], 0.645393],
	[74_072, 0.87678, [0, 0.953, 0.854, 0.88, 0.942], 0.710859],
	[74_826, 0.914962, [0.313, 0.989, 0.943, 0.857, 0.933], 0.616511],
	[77_079, 0.954308, [0.516, 1, 0.947, 0.966, 0.978], 0.994145],
	[78_576, 0.87333, [0, 0.943, 0.975, 0.977, 0.381], 1],
	[80_074, 0.840825, [0, 0.813, 0.965, 0.988, 0], 1],
];

function makeInferioritySuperiorityAnalysis() {
	const energy = new Map([
		[0, 0.3],
		[90_000, 0.3],
	]);
	for (const [timeMs, , , peakEnergy] of INFERIORITY_SUPERIORITY_ONSET_ROWS) {
		energy.set(timeMs - 100, 0.3);
		energy.set(timeMs, peakEnergy);
		energy.set(timeMs + 100, 0.3);
	}
	return {
		analyzerVersion: 2,
		durationMs: 90_000,
		globalBpm: 63.962917,
		confidence: 0.51661,
		beats: INFERIORITY_SUPERIORITY_BEAT_ROWS.map(
			([timeMs, strength, confidence]) => ({
				timeMs,
				strength,
				confidence,
			}),
		),
		onsets: [
			...Array.from({ length: 32 }, (_, index) => ({
				timeMs: 1_000 + index * 1_500,
				strength: 0.4,
				bands: [0.2, 0.25, 0.3, 0.2, 0.15],
			})),
			...INFERIORITY_SUPERIORITY_ONSET_ROWS.map(
				([timeMs, strength, bands]) => ({ timeMs, strength, bands }),
			),
		],
		tempoSegments: [
			{ startMs: 0, endMs: 71_982, bpm: 63.961353, confidence: 0.602393 },
			{
				startMs: 71_982,
				endMs: 89_977,
				bpm: 160.30145,
				confidence: 0.500841,
			},
		],
		energyEnvelope: [...energy]
			.sort(([left], [right]) => left - right)
			.map(([timeMs, value]) => ({ timeMs, value })),
		energyScale: 0.450716,
	};
}

test("劣等上等的局部快拍欠采样会补普通脉冲而不会升级成强旋转", () => {
	const analysis = makeInferioritySuperiorityAnalysis();
	const recoveredTimes = [72_945, 73_329, 73_700, 74_826];
	const recovered = recoveredTimes.map((timeMs) =>
		sampleAnalysisTarget(analysis, timeMs),
	);
	assert.ok(
		Math.min(...recovered) >= 0.18,
		`局部 160 BPM 的可信敲击仍被 64 BPM 拍格吞掉：${recovered}`,
	);
	assert.deepEqual(
		recoveredTimes.map((timeMs) => sampleStrongBeatTarget(analysis, timeMs)),
		[0, 0, 0, 0],
		"局部补拍错误进入了强旋转通道",
	);

	const slowControl = {
		...analysis,
		tempoSegments: [
			{ startMs: 0, endMs: 90_000, bpm: 63.962917, confidence: 0.6 },
		],
	};
	const control = recoveredTimes
		.slice(0, 2)
		.map((timeMs) => sampleAnalysisTarget(slowControl, timeMs));
	assert.ok(
		control.every((value, index) => value < recovered[index] - 0.05),
		`段外同等 onset 也被当作欠采样快拍：${control} -> ${recovered}`,
	);

	const boundaryMs = 71_982;
	const before = sampleAnalysisTarget(analysis, boundaryMs - 0.01);
	const atBoundary = sampleAnalysisTarget(analysis, boundaryMs);
	const after = sampleAnalysisTarget(analysis, boundaryMs + 0.01);
	assert.ok(
		Math.abs(atBoundary - before) < 0.001 &&
			Math.abs(after - atBoundary) < 0.001,
		`局部快拍分段边界发生跳变：${before},${atBoundary},${after}`,
	);
});

test("全曲本身较快时局部欠采样补拍也不会进入强旋转", () => {
	const beats = Array.from({ length: 49 }, (_, index) => ({
		timeMs: index * 375,
		strength: 0.5,
		confidence: 0.7,
	}));
	const onsets = [];
	for (let timeMs = 0; timeMs <= 18_000; timeMs += 375) {
		if (timeMs >= 5_000 && timeMs < 13_000) continue;
		onsets.push({ timeMs, strength: 1, bands: [1, 1, 1, 1, 1] });
	}
	for (let timeMs = 5_000; timeMs < 13_000; timeMs += 125) {
		const strictAccent = (timeMs - 5_000) % 1_000 === 0;
		onsets.push({
			timeMs,
			strength: strictAccent ? 1 : 0.7,
			bands: strictAccent ? [1, 1, 1, 1, 1] : [0, 0, 0, 0, 0],
		});
	}
	onsets.sort((left, right) => left.timeMs - right.timeMs);
	const analysis = {
		analyzerVersion: 2,
		durationMs: 18_000,
		globalBpm: 160,
		confidence: 0.8,
		beats,
		onsets,
		tempoSegments: [
			{ startMs: 0, endMs: 5_000, bpm: 160, confidence: 0.8 },
			{ startMs: 5_000, endMs: 13_000, bpm: 480, confidence: 0.8 },
			{ startMs: 13_000, endMs: 18_001, bpm: 160, confidence: 0.8 },
		],
		energyEnvelope: onsets.map(({ timeMs }) => ({ timeMs, value: 1 })),
		energyScale: 1,
	};

	assert.ok(
		sampleAnalysisTarget(analysis, 9_000) >= 0.5,
		"局部欠采样的可信敲击没有进入普通视觉通道",
	);
	assert.equal(
		sampleStrongBeatTarget(analysis, 9_000),
		0,
		"局部欠采样补拍被快速全局 BPM 错误升级成强旋转",
	);
});

test("全曲覆盖率较高时局部欠采样仍会使用局部证据补普通脉冲", () => {
	const beats = Array.from({ length: 33 }, (_, index) => ({
		timeMs: index * 937.5,
		strength: 0.5,
		confidence: 0.7,
	}));
	const onsets = [
		...beats
			.filter((point) => point.timeMs < 10_000 || point.timeMs >= 20_000)
			.map((point) => ({
				timeMs: point.timeMs,
				strength: 0.7,
				bands: [0, 0, 0, 0, 0],
			})),
		...Array.from({ length: 26 }, (_, index) => {
			const timeMs = 10_312.5 + index * 375;
			const strictAccent = timeMs === 14_437.5;
			return {
				timeMs,
				strength: strictAccent ? 1 : 0.7,
				bands: strictAccent ? [1, 1, 1, 1, 1] : [0, 0, 0, 0, 0],
			};
		}),
	].sort((left, right) => left.timeMs - right.timeMs);
	const base = {
		analyzerVersion: 2,
		durationMs: 30_000,
		globalBpm: 64,
		confidence: 0.8,
		beats,
		onsets,
		energyEnvelope: onsets.map(({ timeMs }) => ({ timeMs, value: 1 })),
		energyScale: 1,
	};
	const undersampled = {
		...base,
		tempoSegments: [
			{ startMs: 0, endMs: 10_000, bpm: 64, confidence: 0.8 },
			{ startMs: 10_000, endMs: 20_000, bpm: 160, confidence: 0.8 },
			{ startMs: 20_000, endMs: 30_001, bpm: 64, confidence: 0.8 },
		],
	};
	const matchedGlobalTempo = {
		...base,
		tempoSegments: [{ startMs: 0, endMs: 30_001, bpm: 64, confidence: 0.8 }],
	};
	const targetMs = 14_437.5;
	const recovered = sampleAnalysisTarget(undersampled, targetMs);
	const control = sampleAnalysisTarget(matchedGlobalTempo, targetMs);
	assert.ok(
		recovered >= control + 0.5 && control <= 0.21,
		`全曲高覆盖率清除了局部欠采样补拍：${control} -> ${recovered}`,
	);
	const unsupportedGridTimeMs = 15_000;
	const suppressedGrid = sampleAnalysisTarget(
		undersampled,
		unsupportedGridTimeMs,
	);
	const controlGrid = sampleAnalysisTarget(
		matchedGlobalTempo,
		unsupportedGridTimeMs,
	);
	assert.ok(
		suppressedGrid <= 0.205 && suppressedGrid <= controlGrid - 0.1,
		`没有声学事件支撑的旧拍仍与补拍叠成双峰：${controlGrid} -> ${suppressedGrid}`,
	);
	assert.equal(
		sampleStrongBeatTarget(undersampled, targetMs),
		0,
		"慢速全局拍格的局部补拍错误进入了强旋转通道",
	);
});

test("变速段使用局部 BPM 收紧快节奏拍点包络", () => {
	const globalTempo = makeAnalysis();
	globalTempo.globalBpm = 60;
	const localTempo = {
		...globalTempo,
		tempoSegments: [{ startMs: 500, endMs: 2_000, bpm: 180, confidence: 0.8 }],
	};
	const globalTail = sampleAnalysisTarget(globalTempo, 1_250);
	const localTail = sampleAnalysisTarget(localTempo, 1_250);
	assert.ok(
		localTail < globalTail - 0.1,
		`局部快节奏没有缩短拍点尾部：${globalTail} -> ${localTail}`,
	);
});

test("拍点释放跨过变速段边界时保持连续", () => {
	const analysis = {
		...makeAnalysis({ beatTime: 900 }),
		globalBpm: 60,
		tempoSegments: [
			{ startMs: 0, endMs: 1_000, bpm: 60, confidence: 0.8 },
			{ startMs: 1_000, endMs: 3_000, bpm: 180, confidence: 0.8 },
		],
	};
	const before = sampleAnalysisTarget(analysis, 999.99);
	const atBoundary = sampleAnalysisTarget(analysis, 1_000);
	const after = sampleAnalysisTarget(analysis, 1_000.01);
	assert.ok(Math.abs(atBoundary - before) < 0.001);
	assert.ok(Math.abs(after - atBoundary) < 0.001);
});

test("全曲分位映射会明确拉开弱拍与重拍", () => {
	const analysis = {
		...makeAnalysis(),
		beats: [0.1, 0.2, 0.3, 0.4, 0.5, 0.55, 0.58, 0.6, 0.61, 0.62].map(
			(strength, index) => ({
				timeMs: 500 + index * 500,
				strength,
				confidence: 0.8,
			}),
		),
	};

	const weak = normalizeBeatStrength(analysis, 0.2);
	const heavy = normalizeBeatStrength(analysis, 0.61);
	assert.ok(weak > 0, "弱拍对比测试退化成除以零");
	assert.ok(weak <= 0.13, `弱拍被放大到 ${weak}`);
	assert.ok(heavy >= 0.95, `重拍只达到 ${heavy}`);
	assert.ok(heavy / weak >= 7, "重拍与弱拍的对比不足");
});

test("强度近乎一致的拍点不会全部退化成轻触", () => {
	for (const strength of [0.2, 0.9]) {
		const analysis = {
			...makeAnalysis(),
			beats: Array.from({ length: 8 }, (_, index) => ({
				timeMs: 500 + index * 400,
				strength,
				confidence: 0.8,
			})),
		};
		assert.ok(
			normalizeBeatStrength(analysis, strength) >= 0.95,
			`均匀 strength=${strength} 被错误压低`,
		);
	}
});

// 来自本机 Shots (Broiler Remix) 00:49–01:03 缓存的精简夹具：
// [beatTime, novelty, confidence, ±90ms RMS peak, local P20, onset peak]
const SHOTS_SEGMENT_ROWS = [
	[49_284, 0.561548, 0.469966, 1, 0.429668, 0.912],
	[49_784, 0.43605, 0.412823, 1, 0.421527, 0.708],
	[50_283, 0.551568, 0.465422, 1, 0.450381, 0.895],
	[50_782, 0.509389, 0.446216, 1, 0.461999, 0.827],
	[51_281, 0.534513, 0.457656, 1, 0.446995, 0.868],
	[51_780, 0.436754, 0.413143, 1, 0.444138, 0.725],
	[52_280, 0.500249, 0.442055, 1, 0.452376, 0.812],
	[52_779, 0.502283, 0.442981, 1, 0.425373, 0.815],
	[53_278, 0.508979, 0.44603, 1, 0.430158, 0.826],
	[53_789, 0.32801, 0.363628, 1, 0.460404, 0.623],
	[54_288, 0.522869, 0.452354, 1, 0.454134, 0.849],
	[54_776, 0.493918, 0.439172, 1, 0.427888, 0.802],
	[55_287, 0.528434, 0.454888, 1, 0.430728, 0.858],
	[55_774, 0.468666, 0.427674, 1, 0.466899, 0.761],
	[56_285, 0.486296, 0.435702, 1, 0.494909, 0.789],
	[56_773, 0.488216, 0.436576, 1, 0.460491, 0.793],
	[57_284, 0.565237, 0.471646, 1, 0.427071, 0.918],
	[57_794, 0.329207, 0.364173, 1, 0.437071, 0.72],
	[58_282, 0.552554, 0.465871, 1, 0.44411, 0.897],
	[58_781, 0.507527, 0.445369, 1, 0.446878, 0.824],
	[59_281, 0.528483, 0.45491, 1, 0.454853, 0.858],
	[59_780, 0.410327, 0.40111, 1, 0.45823, 0.71],
	[60_291, 0.510188, 0.44658, 1, 0.450585, 0.828],
	[60_778, 0.505621, 0.444501, 1, 0.454156, 0.821],
	[61_289, 0.522786, 0.452316, 1, 0.416029, 0.849],
	[61_788, 0.433563, 0.41169, 1, 0.430163, 0.704],
	[62_299, 0.323054, 0.361372, 0.403, 0.443471, 0.612],
	[62_775, 0.494181, 0.439291, 0.332, 0.269554, 0.802],
];

function makeShotsSegmentAnalysis() {
	return {
		analyzerVersion: 1,
		durationMs: 64_000,
		globalBpm: 120.0448,
		confidence: 0.6626,
		beats: SHOTS_SEGMENT_ROWS.map(([timeMs, strength, confidence]) => ({
			timeMs,
			strength,
			confidence,
		})),
		onsets: SHOTS_SEGMENT_ROWS.map((row) => ({
			timeMs: row[0],
			strength: row[5],
		})),
		tempoSegments: [],
		energyEnvelope: SHOTS_SEGMENT_ROWS.flatMap((row) => [
			{ timeMs: row[0] - 230, value: row[4] },
			{ timeMs: row[0], value: row[3] },
			{ timeMs: row[0] + 230, value: row[4] },
		]),
	};
}

test("Shots 真实片段的持续重低音不会随 novelty 忽强忽弱", () => {
	const analysis = makeShotsSegmentAnalysis();
	const heavyTargets = analysis.beats
		.slice(0, 26)
		.map((beat) => sampleAnalysisTarget(analysis, beat.timeMs));

	assert.ok(
		Math.min(...heavyTargets) >= 0.85,
		`持续重低音仍出现弱拍：${heavyTargets}`,
	);
	assert.ok(
		Math.max(...heavyTargets) - Math.min(...heavyTargets) <= 0.05,
		`持续重低音仍随 novelty 闪烁：${heavyTargets}`,
	);
});

test("Shots 真实片段只将前 26 个极重拍送入额外旋转通道", () => {
	const analysis = makeShotsSegmentAnalysis();
	const strongTargets = analysis.beats.map((beat) =>
		sampleStrongBeatTarget(analysis, beat.timeMs),
	);
	const heavyTargets = strongTargets.slice(0, 26);
	const endingTargets = strongTargets.slice(26);

	assert.ok(
		Math.min(...heavyTargets) >= 0.998,
		`前 26 个极重拍仍有漏判：${heavyTargets}`,
	);
	assert.deepEqual(
		endingTargets,
		[0, 0],
		`尾部普通拍被误触发：${endingTargets}`,
	);

	const absoluteAnalysis = {
		...analysis,
		analyzerVersion: 2,
		energyScale: 0.76178,
	};
	assert.deepEqual(
		absoluteAnalysis.beats.map((beat) =>
			sampleStrongBeatTarget(absoluteAnalysis, beat.timeMs),
		),
		strongTargets,
		"加入绝对能量标尺后改变了原版重低音旋转通道",
	);
});

function makeStrongKickAnalysis(energyScale) {
	const beats = [1_000, 1_500, 2_000].map((timeMs) => ({
		timeMs,
		strength: 0.9,
		confidence: 0.8,
	}));
	return {
		analyzerVersion: energyScale === undefined ? 1 : 2,
		durationMs: 4_000,
		globalBpm: 120,
		confidence: 0.7,
		beats,
		onsets: [],
		tempoSegments: [],
		energyEnvelope: [
			{ timeMs: 0, value: 0.15 },
			...beats.flatMap(({ timeMs }) => [
				{ timeMs: timeMs - 200, value: 0.15 },
				{ timeMs: timeMs - 40, value: 0.15 },
				{ timeMs, value: 1 },
				{ timeMs: timeMs + 40, value: 0.15 },
				{ timeMs: timeMs + 200, value: 0.15 },
			]),
			{ timeMs: 4_000, value: 0.15 },
		],
		...(energyScale === undefined ? {} : { energyScale }),
	};
}

test("强旋转通道尊重绝对响度：安静曲目的相对满格拍不再满力旋转", () => {
	const legacyStrong = sampleStrongBeatTarget(makeStrongKickAnalysis(), 1_000);
	const loudStrong = sampleStrongBeatTarget(
		makeStrongKickAnalysis(0.55),
		1_000,
	);
	const quietAnalysis = makeStrongKickAnalysis(0.12);
	const quietStrong = sampleStrongBeatTarget(quietAnalysis, 1_000);

	assert.ok(legacyStrong >= 0.99, `旧缓存的极重拍被误削弱：${legacyStrong}`);
	assert.ok(loudStrong >= 0.99, `响亮曲目的极重拍被误削弱：${loudStrong}`);
	assert.ok(
		quietStrong <= 0.15,
		`安静曲目的相对满格拍仍触发强旋转：${quietStrong}`,
	);

	// 呼吸与普通拍通道不受强拍门控影响，安静歌曲仍保留可见的拍点动态。
	const quietVisual = sampleAnalysisTarget(quietAnalysis, 1_000);
	assert.ok(
		quietVisual >= 0.25,
		`安静曲目的普通拍呼吸被强拍门控误伤：${quietVisual}`,
	);
});

function makeBandLevelFallbackAnalysis(withLevels) {
	return {
		analyzerVersion: withLevels ? 3 : 2,
		durationMs: 6_000,
		globalBpm: null,
		confidence: 0,
		beats: [],
		onsets: [
			{
				timeMs: 2_000,
				strength: 0.9,
				bands: [1, 0.2, 0, 0, 0],
				...(withLevels ? { bandLevels: [0.4, 0.02, 0, 0, 0] } : {}),
			},
			{
				timeMs: 4_000,
				strength: 0.9,
				bands: [0, 0, 0, 0.2, 1],
				...(withLevels ? { bandLevels: [0, 0, 0, 0.004, 0.02] } : {}),
			},
		],
		tempoSegments: [],
		energyEnvelope: [
			{ timeMs: 0, value: 0.5 },
			{ timeMs: 6_000, value: 0.5 },
		],
		energyScale: 0.5,
	};
}

test("v3 频带绝对电平决定幅度：响频段的敲击强于轻频段", () => {
	const analysis = makeBandLevelFallbackAnalysis(true);
	const breath = sampleAnalysisTarget(analysis, 3_000);
	const loudAccent = sampleAnalysisTarget(analysis, 2_000) - breath;
	const quietAccent = sampleAnalysisTarget(analysis, 4_000) - breath;
	assert.ok(
		loudAccent >= quietAccent * 3,
		`轻频段敲击仍与响频段同幅：${loudAccent} / ${quietAccent}`,
	);

	// 旧缓存(无 bandLevels)保持两者等幅的原行为。
	const legacy = makeBandLevelFallbackAnalysis(false);
	const legacyBreath = sampleAnalysisTarget(legacy, 3_000);
	const legacyLoud = sampleAnalysisTarget(legacy, 2_000) - legacyBreath;
	const legacyQuiet = sampleAnalysisTarget(legacy, 4_000) - legacyBreath;
	assert.ok(
		Math.abs(legacyLoud - legacyQuiet) < 1e-9,
		`旧缓存的幅度被频带电平改变：${legacyLoud} / ${legacyQuiet}`,
	);
});

test("v3 合并进拍点的 onset 幅度也按频带电平加权", () => {
	const makeMergedAnalysis = (bandLevels) => ({
		...makeAnalysis({ beatStrength: 0, onsetTime: 1_000 }),
		analyzerVersion: 3,
		energyScale: 0.5,
		onsets: [
			{
				timeMs: 1_000,
				strength: 1,
				bands: [0.1, 0.3, 0.7, 0.9, 1],
				...(bandLevels ? { bandLevels } : {}),
			},
		],
	});
	const loud = sampleAnalysisTarget(
		makeMergedAnalysis([0, 0, 0, 0.3, 0.45]),
		1_000,
	);
	const quiet = sampleAnalysisTarget(
		makeMergedAnalysis([0, 0, 0, 0.002, 0.01]),
		1_000,
	);
	const legacy = sampleAnalysisTarget(makeMergedAnalysis(null), 1_000);
	assert.ok(
		quiet < loud * 0.7,
		`轻频段 onset 合并后未被压低：${quiet} / ${loud}`,
	);
	assert.ok(
		Math.abs(legacy - loud) < 1e-9,
		`响频段命中或旧缓存的合并幅度被改变：${legacy} / ${loud}`,
	);
});

// 来自本机实际缓存的纯数值摘要，不包含音频、路径或歌曲元数据。
// 第一段保留 2:05 附近的“三声—停—三声”：
// [onsetTime, novelty, five bands, ±90ms RMS peak]
const PERCUSSIVE_TEST_PRE_ROLL_MS = 55;
const PERCUSSIVE_TEST_RELEASE_MS = 170;
const TRIPLET_ACCENT_ROWS = [
	[125_144, 0.842, [0.34, 0.05, 0.35, 0.98, 0.99], 0.843],
	[125_341, 0.754, [0, 0, 0.27, 0.87, 0.95], 0.781],
	[125_550, 0.785, [0, 0.75, 0.75, 0.66, 0.97], 0.689],
	[125_945, 0.836, [0, 0.64, 0.97, 0.87, 0.83], 0.648],
	[126_154, 0.758, [0, 0.88, 0.92, 0, 0.43], 0.508],
	[126_351, 0.751, [0.51, 0.82, 0.69, 0.48, 0.78], 0.571],
];

// 第二段保留 0:54 后错误慢速网格漏掉的宽频鼓点。
const DRUM_ACCENT_ROWS = [
	[54_195, 0.933, [0, 0.96, 1, 1, 1], 0.893],
	[54_602, 0.86, [0, 0.12, 0.7, 1, 1], 0.755],
	[54_822, 0.948, [1, 1, 0.94, 0.93, 0.34], 1],
	[55_031, 0.839, [0.99, 0.4, 0.59, 0.93, 0], 0.938],
	[55_438, 0.915, [1, 0.87, 0.65, 0.93, 0.6], 1],
	[55_658, 0.927, [0, 1, 0.96, 1, 0.91], 0.888],
];

function makeLowCoverageAccentAnalysis({
	rows,
	beats,
	durationMs,
	globalBpm = 60,
}) {
	const quietOnsets = Array.from({ length: 24 }, (_, index) => ({
		timeMs: 10_000 + index * 1_500,
		strength: 0.2,
		bands: [0.1, 0.1, 0.1, 0.1, 0.1],
	}));
	const onsets = [
		...quietOnsets,
		...rows.map(([timeMs, strength, bands]) => ({
			timeMs,
			strength,
			bands,
		})),
	].sort((left, right) => left.timeMs - right.timeMs);
	const energyEnvelope = [
		{ timeMs: 0, value: 0.25 },
		...rows.flatMap(([timeMs, , , peak]) => [
			{ timeMs: timeMs - 100, value: peak * 0.55 },
			{ timeMs, value: peak },
			{ timeMs: timeMs + 100, value: peak * 0.55 },
		]),
		{ timeMs: durationMs, value: 0.25 },
	].sort((left, right) => left.timeMs - right.timeMs);
	return {
		analyzerVersion: 1,
		durationMs,
		globalBpm,
		confidence: 0.5,
		beats,
		onsets,
		tempoSegments: [],
		energyEnvelope,
	};
}

test("低覆盖慢速网格会保留三声停顿三声，并只给中等偏重旋转", () => {
	const analysis = makeLowCoverageAccentAnalysis({
		rows: [
			...TRIPLET_ACCENT_ROWS,
			[125_771, 0.68, [0, 0, 0.87, 0.76, 0.29], 0.482],
		],
		beats: [
			{ timeMs: 125_341, strength: 0.465, confidence: 0.353 },
			{ timeMs: 126_154, strength: 0.467, confidence: 0.354 },
		],
		durationMs: 150_000,
	});
	const visualTargets = TRIPLET_ACCENT_ROWS.map(([timeMs]) =>
		sampleAnalysisTarget(analysis, timeMs),
	);
	const strongTargets = TRIPLET_ACCENT_ROWS.map(([timeMs]) =>
		sampleStrongBeatTarget(analysis, timeMs),
	);

	assert.ok(
		Math.min(...visualTargets) >= 0.52,
		`三连击仍被当成轻拍：${visualTargets}`,
	);
	assert.ok(
		Math.min(...strongTargets) >= 0.21,
		`三连击没有获得中等旋转：${strongTargets}`,
	);
	assert.ok(
		Math.max(...strongTargets) <= 0.36,
		`中高频三连击被误判成极重低音：${strongTargets}`,
	);
	assert.equal(
		sampleStrongBeatTarget(analysis, 125_771),
		0,
		"两组三连击之间的普通 onset 被补成重拍",
	);

	const absoluteAnalysis = {
		...analysis,
		analyzerVersion: 2,
		energyScale: 0.65945,
	};
	const absoluteVisualTargets = TRIPLET_ACCENT_ROWS.map(([timeMs]) =>
		sampleAnalysisTarget(absoluteAnalysis, timeMs),
	);
	const absoluteStrongTargets = TRIPLET_ACCENT_ROWS.map(([timeMs]) =>
		sampleStrongBeatTarget(absoluteAnalysis, timeMs),
	);
	assert.ok(
		Math.min(...absoluteVisualTargets) >= 0.52,
		`绝对能量门控压掉了结构化三连击：${absoluteVisualTargets}`,
	);
	assert.ok(
		Math.min(...absoluteStrongTargets) >= 0.21,
		`绝对能量标尺削弱了结构化三连击旋转：${absoluteStrongTargets}`,
	);
	for (const boundaryMs of [
		(TRIPLET_ACCENT_ROWS[0]?.[0] ?? 0) - PERCUSSIVE_TEST_PRE_ROLL_MS,
		(TRIPLET_ACCENT_ROWS.at(-1)?.[0] ?? 0) + PERCUSSIVE_TEST_RELEASE_MS,
	]) {
		const before = sampleAnalysisTarget(absoluteAnalysis, boundaryMs - 0.01);
		const atBoundary = sampleAnalysisTarget(absoluteAnalysis, boundaryMs);
		const after = sampleAnalysisTarget(absoluteAnalysis, boundaryMs + 0.01);
		assert.ok(
			Math.abs(atBoundary - before) < 0.001 &&
				Math.abs(after - atBoundary) < 0.001,
			`结构化敲击窗口边界发生跳变：${before},${atBoundary},${after}`,
		);
	}
});

test("慢速三连击只沿用全曲门控，不会被更低的局部覆盖取消", () => {
	const wideBands = [0.9, 0.92, 0.94, 0.91, 0.93];
	const controlRows = Array.from({ length: 14 }, (_, index) => [
		20_000 + index * 1_000,
		0.92,
		wideBands,
		0.9,
	]);
	const quietPaddingRows = Array.from({ length: 80 }, (_, index) => [
		40_000 + index * 500,
		0.2,
		[0.1, 0.1, 0.1, 0.1, 0.1],
		0.2,
	]);
	const localRows = [
		[124_500, 0.9, wideBands, 0.9],
		...TRIPLET_ACCENT_ROWS,
		[127_000, 0.9, wideBands, 0.9],
	];
	const analysis = makeLowCoverageAccentAnalysis({
		rows: [...controlRows, ...quietPaddingRows, ...localRows],
		beats: [
			...controlRows.slice(0, 8).map(([timeMs]) => ({
				timeMs,
				strength: 0.5,
				confidence: 0.5,
			})),
			{ timeMs: 125_341, strength: 0.465, confidence: 0.353 },
			{ timeMs: 126_154, strength: 0.467, confidence: 0.354 },
		],
		durationMs: 150_000,
		globalBpm: 60,
	});
	const strongTargets = TRIPLET_ACCENT_ROWS.map(([timeMs]) =>
		sampleStrongBeatTarget(analysis, timeMs),
	);
	assert.ok(
		Math.min(...strongTargets) >= 0.21,
		`部分全曲门控下的慢速三连击被局部覆盖取消：${strongTargets}`,
	);
});

test("低覆盖网格外的宽频鼓点会补足动态，但不会形成持续旋转", () => {
	const analysis = makeLowCoverageAccentAnalysis({
		rows: DRUM_ACCENT_ROWS,
		beats: [
			{ timeMs: 54_195, strength: 0.57, confidence: 0.4 },
			{ timeMs: 55_229, strength: 0.27, confidence: 0.28 },
			{ timeMs: 56_285, strength: 0.54, confidence: 0.39 },
		],
		durationMs: 93_000,
	});
	const offGridRows = DRUM_ACCENT_ROWS.slice(1);
	const visualTargets = offGridRows.map(([timeMs]) =>
		sampleAnalysisTarget(analysis, timeMs),
	);
	const strongTargets = offGridRows.map(([timeMs]) =>
		sampleStrongBeatTarget(analysis, timeMs),
	);

	assert.ok(
		Math.min(...visualTargets) >= 0.68,
		`网格外鼓点动态仍不足：${visualTargets}`,
	);
	assert.deepEqual(
		strongTargets,
		[0, 0, 0, 0, 0],
		`普通宽频鼓点形成了持续旋转：${strongTargets}`,
	);

	const absoluteAnalysis = {
		...analysis,
		analyzerVersion: 2,
		energyScale: 0.55429,
	};
	const absoluteVisualTargets = offGridRows.map(([timeMs]) =>
		sampleAnalysisTarget(absoluteAnalysis, timeMs),
	);
	assert.ok(
		Math.min(...absoluteVisualTargets) >= 0.68,
		`绝对能量门控压掉了网格外宽频鼓点：${absoluteVisualTargets}`,
	);
});

test("低覆盖但密集的宽频 onset 只补动态，不会连续推动旋转", () => {
	const denseRows = Array.from({ length: 12 }, (_, index) => [
		70_000 + index * 130,
		0.94,
		[0.91, 0.93, 0.95, 0.92, 0.9],
		0.9,
	]);
	const analysis = makeLowCoverageAccentAnalysis({
		rows: denseRows,
		beats: [{ timeMs: 60_000, strength: 0.5, confidence: 0.5 }],
		durationMs: 90_000,
	});
	const visualTargets = denseRows.map(([timeMs]) =>
		sampleAnalysisTarget(analysis, timeMs),
	);
	const strongTargets = denseRows.map(([timeMs]) =>
		sampleStrongBeatTarget(analysis, timeMs),
	);

	assert.ok(
		Math.min(...visualTargets) >= 0.6,
		`漏拍动态没有得到补偿：${visualTargets}`,
	);
	assert.deepEqual(
		strongTargets,
		Array(12).fill(0),
		`密集 standalone onset 造成连续旋转：${strongTargets}`,
	);
});

test("显著 onset 已有一半被有效拍格解释时不会启用补偿", () => {
	const rows = Array.from({ length: 6 }, (_, index) => [
		80_000 + index * 400,
		0.94,
		[0.9, 0.92, 0.94, 0.91, 0.93],
		0.9,
	]);
	const analysis = makeLowCoverageAccentAnalysis({
		rows,
		beats: [0, 2, 4].map((index) => ({
			timeMs: rows[index][0],
			strength: 0.5,
			confidence: 0.5,
		})),
		durationMs: 90_000,
	});
	const offGridRows = [rows[1], rows[3], rows[5]];
	const visualTargets = offGridRows.map(([timeMs]) =>
		sampleAnalysisTarget(analysis, timeMs),
	);
	assert.ok(
		Math.max(...visualTargets) < 0.4,
		`高覆盖拍格仍补入了离网格动态：${visualTargets}`,
	);
	assert.deepEqual(
		offGridRows.map(([timeMs]) => sampleStrongBeatTarget(analysis, timeMs)),
		[0, 0, 0],
		"高覆盖拍格仍启用了额外旋转",
	);
});

test("P80 跨越强度断层时会插值，不会用低桶稀释拍格覆盖率", () => {
	const weakOnsets = Array.from({ length: 80 }, (_, index) => ({
		timeMs: 1_000 + index * 1_000,
		strength: 0.65,
		bands: [0.9, 0.9, 0.9, 0.9, 0.9],
	}));
	const strongOnsets = Array.from({ length: 20 }, (_, index) => ({
		timeMs: 100_000 + index * 1_000,
		strength: 0.95,
		bands: [0.9, 0.9, 0.9, 0.9, 0.9],
	}));
	const onsets = [...weakOnsets, ...strongOnsets];
	const analysis = {
		analyzerVersion: 1,
		durationMs: 120_000,
		globalBpm: 60,
		confidence: 0.5,
		beats: strongOnsets.slice(0, 10).map((onset) => ({
			timeMs: onset.timeMs,
			strength: 0.5,
			confidence: 0.5,
		})),
		onsets,
		tempoSegments: [],
		energyEnvelope: [
			{ timeMs: 0, value: 0.2 },
			...onsets.map((onset) => ({ timeMs: onset.timeMs, value: 0.9 })),
			{ timeMs: 120_000, value: 0.2 },
		],
	};
	const target = sampleAnalysisTarget(analysis, 119_000);
	assert.ok(target < 0.4, `P80 低桶误开了补偿：${target}`);
});

test("快歌错开半拍的网格不会仅因固定时间容差而吞掉敲击", () => {
	const rows = Array.from({ length: 6 }, (_, index) => [
		100_000 + index * 333,
		0.94,
		[0.9, 0.92, 0.94, 0.91, 0.93],
		0.9,
	]);
	const analysis = makeLowCoverageAccentAnalysis({
		rows,
		beats: rows.map(([timeMs]) => ({
			timeMs: timeMs + 166,
			strength: 0.2,
			confidence: 0.5,
		})),
		durationMs: 110_000,
		globalBpm: 180,
	});
	const visualTargets = rows.map(([timeMs]) =>
		sampleAnalysisTarget(analysis, timeMs),
	);
	assert.ok(
		Math.min(...visualTargets) >= 0.65,
		`快歌错相位敲击仍被错误网格吞掉：${visualTargets}`,
	);
});

// 来自本机 Faded 约 0:59–1:02 缓存的匿名数值摘要。该段被误建成
// 180 BPM 网格，真实宽频敲击却稳定晚于相邻拍点约 85–94ms。
const FADED_MISPHASE_BEATS = [
	[59_024, 0, 0.219872],
	[59_358, 0, 0.219872],
	[59_699, 0.088468, 0.261207],
	[60_024, 0.150923, 0.290388],
	[60_359, 0, 0.219872],
	[60_693, 0, 0.219872],
	[61_027, 0, 0.219872],
	[61_360, 0, 0.219872],
	[61_694, 0, 0.219872],
	[62_028, 0, 0.219872],
	[62_346, 0.274632, 0.348188],
];

// [onsetTime, novelty, five bands, ±90ms RMS peak]
const FADED_MISPHASE_ONSETS = [
	[59_443, 0.93104, [0, 0.943009, 0.998267, 0.994121, 0.999415], 0.970064],
	[
		59_791,
		0.818121,
		[0.951116, 0.58185, 0.390311, 0.508459, 0.839382],
		0.867171,
	],
	[60_116, 0.837995, [0, 0.998717, 0.904863, 0.83184, 0.245476], 0.939261],
	[
		60_453,
		0.811299,
		[0.87328, 0.741186, 0.524086, 0.721847, 0.820095],
		0.813691,
	],
	[
		60_778,
		0.943585,
		[0.251136, 0.96843, 0.994679, 0.999763, 0.934033],
		0.931102,
	],
	[
		61_115,
		0.830966,
		[0.698354, 0.242242, 0.893086, 0.764439, 0.893656],
		0.87168,
	],
	[
		61_452,
		0.933188,
		[0.932679, 0.999013, 0.959511, 0.89501, 0.39019],
		0.861091,
	],
	[
		61_788,
		0.936512,
		[0.981745, 0.835754, 0.809605, 0.702862, 0.964357],
		0.982507,
	],
	[
		62_113,
		0.949961,
		[0.340269, 0.994055, 0.978485, 0.998897, 0.943874],
		0.925497,
	],
];

function makeFadedMisphaseAnalysis() {
	const coveredOnsets = Array.from({ length: 36 }, (_, index) => ({
		timeMs: 10_000 + index * 500,
		strength: 0.9,
		bands: [0.1, 0.1, 0.1, 0.1, 0.1],
	}));
	const quietOnsets = Array.from({ length: 180 }, (_, index) => ({
		timeMs: 100 + index * 200,
		strength: 0.2,
		bands: [0.1, 0.1, 0.1, 0.1, 0.1],
	}));
	const onsets = [
		...quietOnsets,
		...coveredOnsets,
		...FADED_MISPHASE_ONSETS.map(([timeMs, strength, bands]) => ({
			timeMs,
			strength,
			bands,
		})),
	].sort((left, right) => left.timeMs - right.timeMs);
	const beats = [
		...coveredOnsets.map((onset) => ({
			timeMs: onset.timeMs,
			strength: 0.4,
			confidence: 0.5,
		})),
		...FADED_MISPHASE_BEATS.map(([timeMs, strength, confidence]) => ({
			timeMs,
			strength,
			confidence,
		})),
	].sort((left, right) => left.timeMs - right.timeMs);
	const energyEnvelope = [
		{ timeMs: 0, value: 0.25 },
		...coveredOnsets.map((onset) => ({ timeMs: onset.timeMs, value: 0.35 })),
		...FADED_MISPHASE_ONSETS.flatMap(([timeMs, , , peak]) => [
			{ timeMs: timeMs - 100, value: peak * 0.55 },
			{ timeMs, value: peak },
			{ timeMs: timeMs + 100, value: peak * 0.55 },
		]),
		{ timeMs: 70_000, value: 0.25 },
	].sort((left, right) => left.timeMs - right.timeMs);
	return {
		analyzerVersion: 1,
		durationMs: 70_000,
		globalBpm: 179.811,
		confidence: 0.631,
		beats,
		onsets,
		tempoSegments: [],
		energyEnvelope,
	};
}

function strongestTargetTime(analysis, centerMs, radiusMs = 130) {
	let strongestTimeMs = centerMs - radiusMs;
	let strongest = -Infinity;
	for (
		let timeMs = centerMs - radiusMs;
		timeMs <= centerMs + radiusMs;
		timeMs++
	) {
		const target = sampleAnalysisTarget(analysis, timeMs);
		if (target > strongest) {
			strongest = target;
			strongestTimeMs = timeMs;
		}
	}
	return strongestTimeMs;
}

test("Faded 局部失准的 180 BPM 占位拍会搬到真实宽频敲击时间", () => {
	const analysis = makeFadedMisphaseAnalysis();
	const offsets = FADED_MISPHASE_ONSETS.map(
		([timeMs]) => strongestTargetTime(analysis, timeMs) - timeMs,
	);
	const absoluteOffsets = offsets
		.map((offset) => Math.abs(offset))
		.sort((left, right) => left - right);
	const medianOffset = absoluteOffsets[Math.floor(absoluteOffsets.length / 2)];
	const p90Offset =
		absoluteOffsets[Math.floor((absoluteOffsets.length - 1) * 0.9)];
	const earlyByMoreThan50Ms = offsets.filter((offset) => offset < -50).length;

	assert.ok(medianOffset <= 25, `峰值偏移中位数仍有 ${medianOffset}ms`);
	assert.ok(p90Offset <= 45, `峰值偏移 P90 仍有 ${p90Offset}ms`);
	assert.ok(
		earlyByMoreThan50Ms <= 1,
		`仍有 ${earlyByMoreThan50Ms} 个峰提前超过 50ms：${offsets}`,
	);
	for (const [timeMs] of FADED_MISPHASE_ONSETS) {
		assert.ok(
			sampleAnalysisTarget(analysis, timeMs) >= 0.68,
			`${timeMs}ms 的真实敲击仍被当成轻拍`,
		);
	}
});

test("Faded 的 240Hz 呼吸轨迹不会在真实敲击之间新增闪峰", () => {
	const analysis = makeFadedMisphaseAnalysis();
	const deltaMs = 1_000 / 240;
	let smoothedVolume = 0;
	const samples = [];
	for (let timeMs = 59_200; timeMs <= 62_600; timeMs += deltaMs) {
		const target = mapRhythmTargetToVolume(
			sampleAnalysisTarget(analysis, timeMs),
		);
		smoothedVolume = advanceRhythmVisualVolume(smoothedVolume, target, deltaMs);
		samples.push({ timeMs, value: smoothedVolume });
	}
	const peaks = samples.filter(
		(sample, index) =>
			sample.value >= 0.2 &&
			sample.value > (samples[index - 1]?.value ?? sample.value) &&
			sample.value >= (samples[index + 1]?.value ?? sample.value),
	);
	const unmatchedPeaks = peaks.filter(
		(peak) =>
			Math.min(
				...FADED_MISPHASE_ONSETS.map(([timeMs]) =>
					Math.abs(timeMs - peak.timeMs),
				),
			) > 90,
	);
	assert.ok(peaks.length >= 8, `真实敲击只形成了 ${peaks.length} 个呼吸峰`);
	assert.deepEqual(
		unmatchedPeaks,
		[],
		`真实敲击后的非零旧拍仍形成肩峰：${JSON.stringify(unmatchedPeaks)}`,
	);
});

test("Faded 搬正真实敲击后会完全移除 62.346 秒的非零旧拍", () => {
	const actual = makeFadedMisphaseAnalysis();
	const zeroStrengthControl = makeFadedMisphaseAnalysis();
	zeroStrengthControl.beats = zeroStrengthControl.beats.map((beat) =>
		beat.timeMs === 62_346 ? { ...beat, strength: 0 } : beat,
	);
	for (let timeMs = 62_180; timeMs <= 62_600; timeMs += 2) {
		assert.ok(
			Math.abs(
				sampleAnalysisTarget(actual, timeMs) -
					sampleAnalysisTarget(zeroStrengthControl, timeMs),
			) < 1e-12,
			`${timeMs}ms 仍受到已失准非零旧拍影响`,
		);
	}
});

test("全曲高覆盖的慢速拍格不会误用 Faded 的局部快速网格回退", () => {
	const fastAnalysis = makeFadedMisphaseAnalysis();
	const coveredBeats = fastAnalysis.beats.filter(
		(beat) => beat.timeMs < 30_000,
	);
	const analysis = {
		...fastAnalysis,
		globalBpm: 120,
		beats: [
			...coveredBeats,
			...FADED_MISPHASE_ONSETS.map(([timeMs]) => ({
				timeMs: timeMs - 250,
				strength: 0.2,
				confidence: 0.5,
			})),
		].sort((left, right) => left.timeMs - right.timeMs),
	};
	const acousticallyQuietControl = {
		...analysis,
		onsets: analysis.onsets.map((onset) =>
			onset.timeMs >= 59_000
				? { ...onset, bands: [0.1, 0.1, 0.1, 0.1, 0.1] }
				: onset,
		),
	};
	for (const [timeMs] of FADED_MISPHASE_ONSETS) {
		assert.ok(
			Math.abs(
				sampleAnalysisTarget(analysis, timeMs) -
					sampleAnalysisTarget(acousticallyQuietControl, timeMs),
			) < 1e-12,
			`${timeMs}ms 的慢速曲目误加了局部 residual`,
		);
		assert.equal(
			sampleStrongBeatTarget(analysis, timeMs),
			sampleStrongBeatTarget(acousticallyQuietControl, timeMs),
			`${timeMs}ms 的慢速曲目误加了局部旋转`,
		);
	}
});

test("Faded 的局部宽频重拍足够明显且受 420ms 限流", () => {
	const analysis = makeFadedMisphaseAnalysis();
	const strongPoints = FADED_MISPHASE_ONSETS.flatMap(([timeMs]) => {
		const strength = sampleStrongBeatTarget(analysis, timeMs);
		return strength >= 0.04 ? [{ timeMs, strength }] : [];
	});
	assert.deepEqual(
		strongPoints.map((point) => point.timeMs),
		[59_443, 60_116, 60_778, 61_452, 62_113],
	);
	assert.ok(
		Math.max(...strongPoints.map((point) => point.strength)) >= 0.64 &&
			Math.max(...strongPoints.map((point) => point.strength)) <= 0.651,
		`局部宽频重拍没有达到可见但受限的强度：${JSON.stringify(strongPoints)}`,
	);
	for (let index = 1; index < strongPoints.length; index++) {
		assert.ok(
			strongPoints[index].timeMs - strongPoints[index - 1].timeMs >= 420,
			`420ms 内出现重复重拍：${JSON.stringify(strongPoints)}`,
		);
	}
	const deltaMs = 1_000 / 240;
	let strongFrames = 0;
	let totalFrames = 0;
	for (let timeMs = 59_250; timeMs <= 62_300; timeMs += deltaMs) {
		strongFrames += sampleStrongBeatTarget(analysis, timeMs) >= 0.15 ? 1 : 0;
		totalFrames++;
	}
	assert.ok(
		strongFrames / totalFrames <= 0.22,
		`宽频重拍目标占空比仍有 ${strongFrames / totalFrames}`,
	);
});

function makeStrongRecoveryAnalysis({
	uncoveredSupportTimes = [56_337, 57_004, 59_672, 60_339, 61_006],
	coveredSupportTimes = [
		61_672, 62_339, 63_006, 63_673, 64_340, 65_007, 65_674,
	],
} = {}) {
	const narrowBands = [0.1, 0.1, 0.1, 0.1, 0.1];
	const wideBands = [0.92, 0.98, 1, 0.96, 0.9];
	const coveredBaseline = Array.from({ length: 20 }, (_, index) => ({
		timeMs: 10_000 + index * 500,
		strength: 0.99,
		bands: narrowBands,
	}));
	const localSeeds = Array.from({ length: 8 }, (_, index) => ({
		timeMs: 50_000 + index * 667,
		strength: 0.99,
		bands: wideBands,
	}));
	const recoveryCandidates = Array.from({ length: 20 }, (_, index) => ({
		timeMs: 55_336 + index * 667,
		strength: 0.99,
		bands: wideBands,
	}));
	const uncoveredSupport = uncoveredSupportTimes.map((timeMs) => ({
		timeMs,
		strength: 0.99,
		bands: narrowBands,
	}));
	const coveredSupport = coveredSupportTimes.map((timeMs) => ({
		timeMs,
		strength: 0.99,
		bands: narrowBands,
	}));
	const beats = [...coveredBaseline, ...recoveryCandidates, ...coveredSupport]
		.map((onset) => ({
			timeMs: onset.timeMs,
			strength: 0.2,
			confidence: 0.3,
		}))
		.sort((left, right) => left.timeMs - right.timeMs);
	const onsets = [
		...coveredBaseline,
		...localSeeds,
		...recoveryCandidates,
		...uncoveredSupport,
		...coveredSupport,
	].sort((left, right) => left.timeMs - right.timeMs);
	const energyEnvelope = [
		{ timeMs: 0, value: 0.25 },
		...Array.from({ length: 251 }, (_, index) => ({
			timeMs: 45_000 + index * 100,
			value: 0.85,
		})),
		{ timeMs: 72_000, value: 0.25 },
	];
	return {
		analysis: {
			analyzerVersion: 1,
			durationMs: 72_000,
			globalBpm: 180,
			confidence: 0.6,
			beats,
			onsets,
			tempoSegments: [],
			energyEnvelope,
		},
		recoveryCandidates,
	};
}

test("Faded 式强敲击由连续证据续期并随拍格恢复平滑释放", () => {
	const { analysis, recoveryCandidates } = makeStrongRecoveryAnalysis();
	const lastSeedTimeMs = recoveryCandidates[0]?.timeMs ?? 0;
	const beyondEightSeconds = recoveryCandidates[12]?.timeMs ?? 0;
	const middleReleaseCandidate = recoveryCandidates[13]?.timeMs ?? 0;
	const lateReleaseCandidate = recoveryCandidates[14]?.timeMs ?? 0;
	const fullyCoveredCandidate = recoveryCandidates[15]?.timeMs ?? 0;
	assert.ok(
		sampleStrongBeatTarget(analysis, lastSeedTimeMs) >= 0.15,
		"测试没有建立最后一个局部失准 seed",
	);
	assert.ok(
		beyondEightSeconds - lastSeedTimeMs > 8_000,
		"测试候选没有越过旧的固定 8 秒边界",
	);
	const continuedStrength = sampleStrongBeatTarget(
		analysis,
		beyondEightSeconds,
	);
	assert.ok(
		continuedStrength >= 0.15,
		`连续声学证据在 8 秒后仅有 ${continuedStrength}`,
	);
	const releaseStrengths = [
		continuedStrength,
		sampleStrongBeatTarget(analysis, middleReleaseCandidate),
		sampleStrongBeatTarget(analysis, lateReleaseCandidate),
	];
	assert.ok(
		releaseStrengths.every((strength) => strength > 0) &&
			(releaseStrengths[0] ?? 0) > (releaseStrengths[1] ?? 0) &&
			(releaseStrengths[1] ?? 0) > (releaseStrengths[2] ?? 0),
		`三个非 seed 候选没有随拍格覆盖率回升而连续减弱：${JSON.stringify(releaseStrengths)}`,
	);
	assert.equal(
		sampleStrongBeatTarget(analysis, fullyCoveredCandidate),
		0,
		"拍格完全恢复后仍持续升级宽频重拍",
	);

	const noSeedControl = makeStrongRecoveryAnalysis();
	noSeedControl.analysis.beats = noSeedControl.analysis.onsets.map((onset) => ({
		timeMs: onset.timeMs,
		strength: 0.2,
		confidence: 0.3,
	}));
	assert.equal(
		sampleStrongBeatTarget(noSeedControl.analysis, beyondEightSeconds),
		0,
		"没有局部失准 seed 的可靠快歌被宽频候选升级",
	);

	const brokenChainControl = makeStrongRecoveryAnalysis();
	brokenChainControl.analysis.onsets = brokenChainControl.analysis.onsets.map(
		(onset) =>
			onset.timeMs >= 59_338 && onset.timeMs < beyondEightSeconds
				? { ...onset, bands: [0.1, 0.1, 0.1, 0.1, 0.1] }
				: onset,
	);
	assert.equal(
		sampleStrongBeatTarget(brokenChainControl.analysis, beyondEightSeconds),
		0,
		"严格候选中断超过 6.25 个拍周期后仍错误续期",
	);
});

test("离网格严格敲击只续接证据，不会自身触发强旋转", () => {
	const prepareBridgeAnalysis = ({ keepBridgeWide }) => {
		const { analysis, recoveryCandidates } = makeStrongRecoveryAnalysis();
		const bridgeTimeMs = recoveryCandidates[10]?.timeMs ?? 0;
		const narrowTimes = new Set(
			[8, 9, 11, 12].map(
				(index) => recoveryCandidates[index]?.timeMs ?? Number.NaN,
			),
		);
		if (!keepBridgeWide) narrowTimes.add(bridgeTimeMs);
		analysis.onsets = analysis.onsets.map((onset) =>
			narrowTimes.has(onset.timeMs)
				? { ...onset, bands: [0.1, 0.1, 0.1, 0.1, 0.1] }
				: onset,
		);
		analysis.beats = analysis.beats.filter(
			(beat) => beat.timeMs !== bridgeTimeMs,
		);
		return {
			analysis,
			bridgeTimeMs,
			coveredTargetTimeMs: recoveryCandidates[13]?.timeMs ?? 0,
		};
	};

	const bridged = prepareBridgeAnalysis({ keepBridgeWide: true });
	assert.equal(
		sampleStrongBeatTarget(bridged.analysis, bridged.bridgeTimeMs),
		0,
		"离开拍格的续链证据被直接升级成强旋转",
	);
	assert.ok(
		sampleStrongBeatTarget(bridged.analysis, bridged.coveredTargetTimeMs) > 0.1,
		"离网格严格证据没有桥接到后续重新对齐的重拍",
	);

	const withoutBridge = prepareBridgeAnalysis({ keepBridgeWide: false });
	assert.equal(
		sampleStrongBeatTarget(
			withoutBridge.analysis,
			withoutBridge.coveredTargetTimeMs,
		),
		0,
		"缺少严格桥接证据时仍跨越 6.25 个拍周期续期",
	);
});

test("连续隐藏证据不能在长时间无可见重拍后重新激活旋转", () => {
	const prepareHiddenChain = ({ revealSecondBridge }) => {
		const { analysis, recoveryCandidates } = makeStrongRecoveryAnalysis();
		const firstBridgeTimeMs = recoveryCandidates[10]?.timeMs ?? 0;
		const secondBridgeTimeMs = recoveryCandidates[13]?.timeMs ?? 0;
		const finalCoveredTimeMs = recoveryCandidates[16]?.timeMs ?? 0;
		const retainedWideTimes = new Set([
			firstBridgeTimeMs,
			secondBridgeTimeMs,
			finalCoveredTimeMs,
		]);
		analysis.onsets = [
			...analysis.onsets.map((onset) =>
				onset.timeMs > (recoveryCandidates[7]?.timeMs ?? 0) &&
				!retainedWideTimes.has(onset.timeMs)
					? { ...onset, bands: [0.1, 0.1, 0.1, 0.1, 0.1] }
					: onset,
			),
			...[61_006, 62_340, 63_674, 65_008, 66_342, 67_676].map((timeMs) => ({
				timeMs,
				strength: 0.99,
				bands: [0.1, 0.1, 0.1, 0.1, 0.1],
			})),
		].sort((left, right) => left.timeMs - right.timeMs);
		analysis.beats = analysis.beats.filter(
			(beat) =>
				beat.timeMs !== firstBridgeTimeMs &&
				(revealSecondBridge || beat.timeMs !== secondBridgeTimeMs),
		);
		return {
			analysis,
			firstBridgeTimeMs,
			secondBridgeTimeMs,
			finalCoveredTimeMs,
		};
	};

	const hidden = prepareHiddenChain({ revealSecondBridge: false });
	for (const timeMs of [hidden.firstBridgeTimeMs, hidden.secondBridgeTimeMs]) {
		assert.equal(
			sampleStrongBeatTarget(hidden.analysis, timeMs),
			0,
			`隐藏证据 ${timeMs}ms 被直接升级成强旋转`,
		);
	}
	assert.equal(
		sampleStrongBeatTarget(hidden.analysis, hidden.finalCoveredTimeMs),
		0,
		"隐藏证据链跨越 12.5 个拍周期后仍让强旋转复活",
	);

	const revealed = prepareHiddenChain({ revealSecondBridge: true });
	assert.ok(
		sampleStrongBeatTarget(revealed.analysis, revealed.secondBridgeTimeMs) >
			0.1 &&
			sampleStrongBeatTarget(revealed.analysis, revealed.finalCoveredTimeMs) >
				0.1,
		"对照组没有证明同一声学链在可见重拍续期后仍然有效",
	);
});

test("略强但暂不可见的严格候选不会反而吞掉下一次重拍", () => {
	const prepareThresholdProbe = (strength) => {
		const { analysis, recoveryCandidates } = makeStrongRecoveryAnalysis({
			uncoveredSupportTimes: [56_200, 58_200, 60_200, 62_200],
			coveredSupportTimes: [],
		});
		const probeTimeMs = recoveryCandidates[14]?.timeMs ?? 0;
		const nextTimeMs = recoveryCandidates[15]?.timeMs ?? 0;
		analysis.onsets = analysis.onsets.map((onset) =>
			onset.timeMs === probeTimeMs ? { ...onset, strength } : onset,
		);
		return { analysis, probeTimeMs, nextTimeMs };
	};

	const belowStrictFloor = prepareThresholdProbe(0.79);
	const justInsideStrictGate = prepareThresholdProbe(0.812);
	for (const probe of [belowStrictFloor, justInsideStrictGate]) {
		assert.equal(
			sampleStrongBeatTarget(probe.analysis, probe.probeTimeMs),
			0,
			"测试候选自身意外进入了可见强旋转",
		);
		assert.ok(
			sampleStrongBeatTarget(probe.analysis, probe.nextTimeMs) > 0.1,
			"暂不可见的严格候选关闭了仍有恢复余量的证据链",
		);
	}
});

test("局部样本不足时不会仅凭一次旧 seed 继续升级强拍", () => {
	const narrowBands = [0.1, 0.1, 0.1, 0.1, 0.1];
	const wideBands = [0.92, 0.98, 1, 0.96, 0.9];
	const coveredBaseline = Array.from({ length: 20 }, (_, index) => ({
		timeMs: 10_000 + index * 500,
		strength: 0.99,
		bands: narrowBands,
	}));
	const clusteredSeeds = [
		43_500, 43_700, 43_900, 44_100, 44_300, 44_500, 44_700, 47_400,
	].map((timeMs) => ({ timeMs, strength: 0.99, bands: wideBands }));
	const probe = { timeMs: 49_400, strength: 0.99, bands: wideBands };
	const analysis = {
		analyzerVersion: 1,
		durationMs: 52_000,
		globalBpm: 180,
		confidence: 0.6,
		beats: [...coveredBaseline, probe]
			.map((onset) => ({
				timeMs: onset.timeMs,
				strength: 0.2,
				confidence: 0.3,
			}))
			.sort((left, right) => left.timeMs - right.timeMs),
		onsets: [...coveredBaseline, ...clusteredSeeds, probe].sort(
			(left, right) => left.timeMs - right.timeMs,
		),
		tempoSegments: [],
		energyEnvelope: [
			{ timeMs: 0, value: 0.25 },
			...Array.from({ length: 121 }, (_, index) => ({
				timeMs: 40_000 + index * 100,
				value: 0.85,
			})),
		],
	};
	assert.ok(
		sampleStrongBeatTarget(analysis, 47_400) >= 0.64,
		"测试没有建立有效的局部失准 seed",
	);
	assert.equal(
		sampleStrongBeatTarget(analysis, probe.timeMs),
		0,
		"不足 8 个局部显著样本时仍延续了旧 seed",
	);
});

test("Faded 的 420ms 限流会用后到的强重拍替换先到的弱候选", () => {
	const analysis = makeFadedMisphaseAnalysis();
	analysis.onsets = analysis.onsets.map((onset) => {
		if (onset.timeMs === 59_443) {
			return {
				...onset,
				strength: 0.83,
				bands: [0.9, 0.9, 0.9, 0.9, 0.9],
			};
		}
		if (onset.timeMs === 59_791) {
			return { ...onset, strength: 1, bands: [1, 1, 1, 1, 1] };
		}
		return onset;
	});
	assert.equal(sampleStrongBeatTarget(analysis, 59_443), 0);
	assert.ok(
		sampleStrongBeatTarget(analysis, 59_791) >= 0.64,
		"420ms 窗口内后到的极强重拍仍被先到弱候选吞掉",
	);
});

test("普通拍可以驱动呼吸，但不会触发极重拍旋转", () => {
	const analysis = {
		...makeAnalysis({ beatStrength: 0.95, onsetTime: 1_000 }),
		energyEnvelope: [
			{ timeMs: 700, value: 0.45 },
			{ timeMs: 954, value: 0.45 },
			{ timeMs: 1_000, value: 0.9 },
			{ timeMs: 1_046, value: 0.45 },
			{ timeMs: 1_300, value: 0.45 },
		],
	};
	assert.ok(
		sampleAnalysisTarget(analysis, 1_000) >= 0.7,
		"测试拍点未能驱动普通呼吸通道",
	);
	assert.equal(sampleStrongBeatTarget(analysis, 1_000), 0);
	assert.equal(sampleStrongBeatTarget(analysis, Number.NaN), 0);
});

test("低动态分位与极弱拍阈值保持连续", () => {
	const makeLowDynamicAnalysis = (upperStrength) => ({
		...makeAnalysis(),
		beats: [0.5, upperStrength].map((strength, index) => ({
			timeMs: 500 + index * 500,
			strength,
			confidence: 0.8,
		})),
	});
	const below = normalizeBeatStrength(makeLowDynamicAnalysis(0.561538), 0.5);
	const above = normalizeBeatStrength(makeLowDynamicAnalysis(0.561539), 0.5);
	assert.ok(Math.abs(below - above) < 0.001, "分位动态范围边界仍存在跳变");

	const barelyVisible = normalizeBeatStrength(
		makeLowDynamicAnalysis(0.0010000001),
		0.0010000001,
	);
	assert.ok(barelyVisible < 0.001, `极弱拍被放大到 ${barelyVisible}`);
});

test("能量平滑会滤除约 46ms 的交替折点", () => {
	const analysis = {
		...makeAnalysis(),
		beats: [],
		onsets: [],
		energyEnvelope: Array.from({ length: 55 }, (_, index) => ({
			timeMs: index * 46,
			value: index % 2,
		})),
	};
	const samples = [];
	for (let timeMs = 600; timeMs <= 1_800; timeMs += 46) {
		samples.push(sampleAnalysisTarget(analysis, timeMs));
	}
	assert.ok(
		Math.max(...samples) - Math.min(...samples) < 0.015,
		"短周期能量折点仍造成明显呼吸抖动",
	);
	assert.ok(Math.max(...samples) > 0.1, "无拍点音乐的能量呼吸被静音");
});

test("能量呼吸不会提前数百毫秒预响", () => {
	const analysis = {
		...makeAnalysis(),
		beats: [],
		onsets: [],
		energyEnvelope: Array.from({ length: 50 }, (_, index) => ({
			timeMs: index * 46,
			value: index * 46 >= 1_000 ? 1 : 0,
		})),
	};
	assert.ok(
		sampleAnalysisTarget(analysis, 800) < 0.001,
		"响度阶跃前 200ms 已出现明显呼吸",
	);
});

test("能量平滑窗口边缘连续且非法时间不会触发视觉信号", () => {
	const analysis = {
		...makeAnalysis(),
		beats: [],
		onsets: [],
		energyEnvelope: [
			{ timeMs: 0, value: 1 },
			...Array.from({ length: 31 }, (_, index) => ({
				timeMs: 46 * (index + 1),
				value: 0,
			})),
		],
	};
	const beforeEdge = sampleAnalysisTarget(analysis, 719.999);
	const afterEdge = sampleAnalysisTarget(analysis, 720.001);
	assert.ok(
		Math.abs(beforeEdge - afterEdge) < 1e-5,
		"能量点进出平滑窗口时仍产生突跳",
	);
	for (const invalidTime of [Number.NaN, Number.POSITIVE_INFINITY, -Infinity]) {
		assert.equal(sampleAnalysisTarget(analysis, invalidTime), 0);
		assert.equal(sampleSmoothPulse(invalidTime, 1_000, 100, 300), 0);
	}
});

function simulateAtFPS(fps) {
	const analysis = makeAnalysis();
	const deltaMs = 1_000 / fps;
	let current = 0;
	const checkpoints = new Map();
	for (let frame = 1; frame <= fps * 2; frame++) {
		const timeMs = frame * deltaMs;
		const target = mapRhythmTargetToVolume(
			sampleAnalysisTarget(analysis, timeMs),
		);
		current = advanceRhythmVisualVolume(current, target, deltaMs);
		if (frame % (fps / 60) === 0) {
			checkpoints.set(Math.round(timeMs * 1_000), current);
		}
	}
	return checkpoints;
}

test("60/120/240Hz 下的视觉轨迹保持一致", () => {
	const at60 = simulateAtFPS(60);
	for (const fps of [120, 240]) {
		const candidate = simulateAtFPS(fps);
		for (const [timeMs, expected] of at60) {
			assert.ok(
				Math.abs((candidate.get(timeMs) ?? 0) - expected) < 0.02,
				`${fps}Hz 在 ${timeMs / 1_000}ms 偏差过大`,
			);
		}
	}
});

function simulateTripletAccentAtFPS(fps) {
	const analysis = makeLowCoverageAccentAnalysis({
		rows: TRIPLET_ACCENT_ROWS,
		beats: [
			{ timeMs: 125_341, strength: 0.465, confidence: 0.353 },
			{ timeMs: 126_154, strength: 0.467, confidence: 0.354 },
		],
		durationMs: 150_000,
	});
	const deltaMs = 1_000 / fps;
	let smoothedVolume = 0;
	let maxStrongBeat = 0;
	let maxVolume = 0;
	for (let timeMs = 124_900; timeMs <= 126_650; timeMs += deltaMs) {
		const target = mapRhythmTargetToVolume(
			sampleAnalysisTarget(analysis, timeMs),
		);
		smoothedVolume = advanceRhythmVisualVolume(smoothedVolume, target, deltaMs);
		maxStrongBeat = Math.max(
			maxStrongBeat,
			sampleStrongBeatTarget(analysis, timeMs),
		);
		maxVolume = Math.max(maxVolume, smoothedVolume);
	}
	return { maxStrongBeat, maxVolume };
}

test("三声停顿三声的完整信号链在 60/120/240Hz 下保持一致", () => {
	const expected = simulateTripletAccentAtFPS(60);
	assert.ok(
		expected.maxStrongBeat >= 0.34 && expected.maxStrongBeat <= 0.36,
		`三连击旋转峰值异常：${expected.maxStrongBeat}`,
	);
	assert.ok(
		expected.maxVolume >= 0.31 && expected.maxVolume <= 0.33,
		`三连击呼吸峰值异常：${expected.maxVolume}`,
	);
	for (const fps of [120, 240]) {
		const candidate = simulateTripletAccentAtFPS(fps);
		assert.ok(
			Math.abs(candidate.maxStrongBeat - expected.maxStrongBeat) < 0.002,
			`${fps}Hz 的三连击旋转峰值漂移过大`,
		);
		assert.ok(
			Math.abs(candidate.maxVolume - expected.maxVolume) < 0.002,
			`${fps}Hz 的三连击呼吸峰值漂移过大`,
		);
	}
});

test("长帧恢复只推进一个有限视觉步长，不追赶未显示的动画", () => {
	assert.equal(limitRhythmVisualDelta(1_000), 50);
	assert.equal(limitRhythmVisualDelta(-10), 0);
	assert.equal(limitRhythmVisualDelta(Number.NaN), 0);

	const attacked = advanceRhythmVisualVolume(
		0,
		0.4,
		limitRhythmVisualDelta(1_000),
	);
	const released = advanceRhythmVisualVolume(
		0.4,
		0,
		limitRhythmVisualDelta(1_000),
	);
	assert.ok(attacked < 0.25, `长帧后 attack 瞬跳到 ${attacked}`);
	assert.ok(released > 0.3, `长帧后 release 瞬跳到 ${released}`);
});

function createMeshHarness() {
	const noop = () => {};
	const uniforms = new Map();
	MeshGradientRenderer.setRhythmVisualIntensity(1);
	MeshGradientRenderer.setRhythmVisualSignal(0, 0);
	const gl = {
		ARRAY_BUFFER: 0x8892,
		BLEND: 0x0be2,
		COLOR_BUFFER_BIT: 0x4000,
		FLOAT: 0x1406,
		FRAMEBUFFER: 0x8d40,
		ONE: 1,
		ONE_MINUS_SRC_ALPHA: 0x0303,
		SRC_ALPHA: 0x0302,
		TEXTURE0: 0x84c0,
		TEXTURE_2D: 0x0de1,
		TRIANGLES: 4,
		activeTexture: noop,
		bindBuffer: noop,
		bindFramebuffer: noop,
		bindTexture: noop,
		blendFuncSeparate: noop,
		clear: noop,
		clearColor: noop,
		disable: noop,
		disableVertexAttribArray: noop,
		drawArrays: noop,
		enable: noop,
		enableVertexAttribArray: noop,
		flush: noop,
		vertexAttribPointer: noop,
	};
	const mainProgram = {
		attrs: { a_pos: 0 },
		setUniform1f(name, value) {
			uniforms.set(name, value);
		},
		setUniform1i: noop,
		use: noop,
	};
	const renderer = Object.create(MeshGradientRenderer.prototype);
	Object.assign(renderer, {
		canvas: { height: 1_080, width: 1_920 },
		fbo: {},
		fboTexture: {},
		gl,
		isNoCover: false,
		mainProgram,
		manualControl: false,
		meshStates: [
			{
				alpha: 1.1,
				mesh: { bind: noop, dispose: noop, draw: noop },
				texture: { bind: noop, dispose: noop },
			},
		],
		quadBuffer: {},
		quadProgram: {
			attrs: { a_pos: 0 },
			setUniform1f: noop,
			setUniform1i: noop,
			use: noop,
		},
		rhythmBreath: 0,
		rhythmKick: 0,
		kickVelocity: 0,
		lastKickDrive: 0,
		maxFPS: 240,
		smoothedVolume: 0,
		volume: 0,
	});
	renderer.checkIfResize = noop;

	return {
		renderer,
		step(
			timeMs,
			deltaMs,
			{ breath = 0, strongBeat = 0, rawBass = 0, intensity = 1 } = {},
		) {
			MeshGradientRenderer.setRhythmVisualIntensity(intensity);
			MeshGradientRenderer.setRhythmVisualSignal(breath, strongBeat);
			renderer.setLowFreqVolume(rawBass);
			renderer.onRedraw(timeMs, deltaMs);
			const renderedBreath = uniforms.get("u_volume") ?? 0;
			const alpha = uniforms.get("u_alpha") ?? 1;
			const kick = renderer.rhythmKick;
			const safeIntensity = Number.isFinite(intensity)
				? Math.min(2, Math.max(0, intensity))
				: 1;
			const ambientAngle = (timeMs / 1e4) * 2;
			const expectedAngle =
				ambientAngle + renderer.volume * 2 * safeIntensity;
			const sinAngle = uniforms.get("u_sinAngle");
			const cosAngle = uniforms.get("u_cosAngle");
			const actualAngle =
				typeof sinAngle === "number" && typeof cosAngle === "number"
					? Math.atan2(sinAngle, cosAngle)
					: Number.NaN;
			return {
				alpha,
				ambientAngle,
				angle: actualAngle,
				angleUniformError:
					typeof sinAngle === "number" && typeof cosAngle === "number"
						? Math.max(
								Math.abs(sinAngle - Math.sin(expectedAngle)),
								Math.abs(cosAngle - Math.cos(expectedAngle)),
							)
						: Number.POSITIVE_INFINITY,
				breath: renderedBreath,
				brightness: alpha * Math.max(0.5, 1 - renderedBreath * 0.5),
				cosAngle,
				flowOffsetX: uniforms.get("u_flowOffsetX"),
				flowOffsetY: uniforms.get("u_flowOffsetY"),
				kick,
				rawBassVolume: renderer.volume,
				sinAngle,
			};
		},
	};
}

test("歌词背景动画强度倍率保持呼吸基准并恢复原版低频转动幅度", () => {
	const sample = (intensity) => {
		const harness = createMeshHarness();
		harness.step(0, 0, {
			breath: 0.4,
			strongBeat: 1,
			rawBass: 1,
			intensity,
		});
		return harness.step(16, 16, {
			breath: 0.4,
			strongBeat: 0,
			rawBass: 1,
			intensity,
		});
	};

	const disabled = sample(0);
	const gentle = sample(0.5);
	const normal = sample(1);
	const strong = sample(2);
	const negative = sample(-10);
	const excessive = sample(10);
	const invalid = sample(Number.NaN);
	const beatRotation = (result) => result.angle - result.ambientAngle;

	assert.equal(disabled.breath, 0);
	assert.equal(beatRotation(disabled), 0);
	assert.ok(normal.breath > 0);
	assert.ok(beatRotation(normal) > 0);
	assert.ok(
		Math.abs(
			beatRotation(normal) - normal.rawBassVolume * 2,
		) < 1e-12,
	);
	assert.ok(Math.abs(gentle.breath - normal.breath * 0.5) < 1e-12);
	assert.ok(Math.abs(strong.breath - normal.breath * 2) < 1e-12);
	assert.ok(
		Math.abs(beatRotation(gentle) - beatRotation(normal) * 0.5) < 1e-12,
	);
	assert.ok(Math.abs(beatRotation(strong) - beatRotation(normal) * 2) < 1e-12);
	assert.equal(negative.breath, disabled.breath);
	assert.equal(beatRotation(negative), beatRotation(disabled));
	assert.equal(excessive.breath, strong.breath);
	assert.equal(beatRotation(excessive), beatRotation(strong));
	assert.equal(invalid.breath, normal.breath);
	assert.equal(beatRotation(invalid), beatRotation(normal));
	for (const result of [disabled, gentle, normal, strong]) {
		assert.ok(Math.abs(result.brightness - 1) < 1e-12);
		assert.ok(result.angleUniformError < 1e-12);
	}
});

function mapMeshUV(sample, [u, v]) {
	const x = u - 0.5;
	const y = v - 0.5;
	const scale = Math.max(0.001, 1 - sample.breath * 2);
	return [
		0.5 + scale * (sample.cosAngle * x - sample.sinAngle * y) + sample.flowOffsetX,
		0.5 + scale * (sample.sinAngle * x + sample.cosAngle * y) + sample.flowOffsetY,
	];
}

test("没有额外呼吸和极重拍时，常规低频区间的 UV 轨迹与 fork 前原版一致", () => {
	for (const timeMs of [0, 1_000, 9_000, 31_000]) {
		for (const rawBass of [0, 0.4, 1, 1.6]) {
			const sample = createMeshHarness().step(timeMs, 16, { rawBass });
			const originalVolume = rawBass / 10;
			const originalAngle = timeMs / 1e4 * 2 + originalVolume * 2;
			for (const [u, v] of [[0, 0], [0.5, 0.5], [1, 1], [0.2, 0.8]]) {
				// Independent reference: the original shader rotates around (.2, .2).
				const x = u - 0.2;
				const y = v - 0.2;
				const scale = Math.max(0.001, 1 - originalVolume * 2);
				const expected = [
					0.5 + scale * (Math.cos(originalAngle) * x - Math.sin(originalAngle) * y),
					0.5 + scale * (Math.sin(originalAngle) * x + Math.cos(originalAngle) * y),
				];
				const actual = mapMeshUV(sample, [u, v]);
				assert.ok(actual.every((value, axis) => Math.abs(value - expected[axis]) < 1e-12));
			}
		}
	}
});

test("极重拍只沿原版轨道推动纹理，不增加纹理旋转或改变点间距离", () => {
	const quiet = createMeshHarness().step(1_000, 16, { rawBass: 0.6 });
	const heavy = createMeshHarness().step(1_000, 16, { rawBass: 0.6, strongBeat: 1 });
	assert.equal(quiet.sinAngle, heavy.sinAngle);
	assert.equal(quiet.cosAngle, heavy.cosAngle);
	const displacement = [heavy.flowOffsetX - quiet.flowOffsetX, heavy.flowOffsetY - quiet.flowOffsetY];
	assert.ok(Math.hypot(...displacement) > 0.001);
	for (const point of [[0, 0], [0.5, 0.5], [1, 1], [0.2, 0.8]]) {
		const before = mapMeshUV(quiet, point);
		const after = mapMeshUV(heavy, point);
		assert.ok(after.every((value, axis) => Math.abs(value - before[axis] - displacement[axis]) < 1e-12));
	}
});

test("额外呼吸保持中心缩放，不改变原版流动偏移", () => {
	const quiet = createMeshHarness().step(1_000, 16, { rawBass: 0.6 });
	const breath = createMeshHarness().step(1_000, 16, { rawBass: 0.6, breath: 0.4 });
	assert.ok(breath.breath > quiet.breath);
	assert.equal(breath.flowOffsetX, quiet.flowOffsetX);
	assert.equal(breath.flowOffsetY, quiet.flowOffsetY);
	assert.deepEqual(mapMeshUV(breath, [0.5, 0.5]), mapMeshUV(quiet, [0.5, 0.5]));
	assert.notDeepEqual(mapMeshUV(breath, [0, 0]), mapMeshUV(quiet, [0, 0]));
});

test("强度为零时保留基础流动，低频和极重拍均不改变 UV", () => {
	const quiet = createMeshHarness().step(1_000, 16, { intensity: 0 });
	const loud = createMeshHarness().step(1_000, 16, { intensity: 0, rawBass: 2, breath: 0.4, strongBeat: 1 });
	assert.ok(Math.hypot(quiet.flowOffsetX, quiet.flowOffsetY) > 0.4);
	assert.equal(loud.breath, 0);
	for (const point of [[0, 0], [0.5, 0.5], [1, 1]]) {
		assert.deepEqual(mapMeshUV(loud, point), mapMeshUV(quiet, point));
	}
});

test("真实 Mesh 的 resume 只重置当前实例的重拍边沿", () => {
	const resumed = createMeshHarness();
	const sibling = createMeshHarness();
	resumed.step(0, 0, { strongBeat: 1 });
	sibling.step(0, 0, { strongBeat: 1 });
	Object.assign(resumed.renderer, {
		paused: true,
		requestTick() {},
	});

	resumed.renderer.resume();
	sibling.step(0, 0, { strongBeat: 1 });
	resumed.step(0, 0, { strongBeat: 1 });

	assert.ok(
		Math.abs(resumed.renderer.kickVelocity - 4.8) < 1e-12,
		"恢复实例没有重新接收当前重拍的首个冲量",
	);
	assert.ok(
		Math.abs(sibling.renderer.kickVelocity - 2.4) < 1e-12,
		"其他 Mesh 实例错误消费了恢复状态",
	);
});

test("真实 Mesh 在离屏缓冲不可用时不会累积未显示的重拍冲量", () => {
	const harness = createMeshHarness();
	harness.renderer.fbo = null;

	for (let pulse = 0; pulse < 4; pulse++) {
		harness.step(pulse * 2, 0, { strongBeat: 1 });
		harness.step(pulse * 2 + 1, 0, { strongBeat: 0 });
	}
	assert.equal(harness.renderer.kickVelocity, 0);

	harness.renderer.fbo = {};
	harness.step(10, 0, { strongBeat: 0 });
	assert.equal(
		harness.renderer.kickVelocity,
		0,
		"离屏期间积累的冲量在缓冲恢复后被异常释放",
	);
});

test("歌词页静态关闭再重开后首个高 strongBeat 只恢复一次冲量", () => {
	const harness = createMeshHarness();
	Object.assign(harness.renderer, {
		lastFrameTime: 0,
		requestTick() {},
	});
	harness.step(0, 0, { strongBeat: 1 });

	MeshGradientRenderer.setRhythmVisualSignal(0, 0);
	harness.renderer.setStaticMode(true);
	harness.renderer.onRedraw(1, 0);
	harness.renderer.setStaticMode(false);

	harness.step(2, 0, { strongBeat: 1 });
	const reopenedVelocity = harness.renderer.kickVelocity;
	harness.step(3, 0, { strongBeat: 1 });

	assert.ok(
		Math.abs(reopenedVelocity - 4.8) < 1e-12,
		"重开后的首个高 strongBeat 没有恢复冲量",
	);
	assert.ok(
		Math.abs(harness.renderer.kickVelocity - reopenedVelocity) < 1e-12,
		"持续高 strongBeat 被逐帧重复施加冲量",
	);
});

function median(values) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
		: (sorted[middle] ?? 0);
}

function simulateWeakPreludeEndToEnd(
	analysis,
	endMs = 7_000,
	probeBeats = analysis.beats,
) {
	const harness = createMeshHarness();
	const fps = 240;
	const deltaMs = 1_000 / fps;
	let smoothedVolume = 0;
	const samples = [];
	for (let frame = 0; frame <= Math.round((endMs * fps) / 1_000); frame++) {
		const musicTimeMs = frame * deltaMs;
		smoothedVolume = advanceRhythmVisualVolume(
			smoothedVolume,
			mapRhythmTargetToVolume(sampleAnalysisTarget(analysis, musicTimeMs)),
			deltaMs,
		);
		samples.push({
			...harness.step(musicTimeMs, deltaMs, {
				breath: smoothedVolume,
				strongBeat: sampleStrongBeatTarget(analysis, musicTimeMs),
			}),
			musicTimeMs,
		});
	}

	const sampleRange = (startMs, rangeEndMs) => {
		const start = Math.max(0, Math.floor((startMs * fps) / 1_000));
		const end = Math.min(
			samples.length,
			Math.ceil((rangeEndMs * fps) / 1_000) + 1,
		);
		return samples.slice(start, end);
	};
	const beats = probeBeats.filter((point) => point.timeMs < endMs);
	const modulations = [];
	for (let index = 1; index < beats.length; index++) {
		const previous = beats[index - 1];
		const beat = beats[index];
		if (!(previous && beat)) continue;
		const midpoint = (previous.timeMs + beat.timeMs) * 0.5;
		const valley = Math.min(
			...sampleRange(midpoint - 50, midpoint + 50).map(
				(sample) => sample.breath,
			),
		);
		const peak = Math.max(
			...sampleRange(beat.timeMs, beat.timeMs + 180).map(
				(sample) => sample.breath,
			),
		);
		modulations.push(Math.max(0, peak - valley));
	}
	const breathDifferences = samples
		.slice(1)
		.map(
			(sample, index) =>
				sample.breath - (samples[index]?.breath ?? sample.breath),
		);
	const breathSecondDifferences = breathDifferences
		.slice(1)
		.map((difference, index) =>
			Math.abs(difference - (breathDifferences[index] ?? difference)),
		);
	return {
		samples,
		maxBreath: Math.max(...samples.map((sample) => sample.breath)),
		maxBreathStep: Math.max(...breathDifferences.map(Math.abs)),
		maxBreathSecondDifference: Math.max(...breathSecondDifferences),
		maxStrongBeat: Math.max(
			...samples.map((sample) =>
				sampleStrongBeatTarget(analysis, sample.musicTimeMs),
			),
		),
		medianModulation: median(modulations),
		modulationDuty004:
			modulations.filter((value) => value >= 0.004).length /
			Math.max(1, modulations.length),
	};
}

test("爱错的弱前奏保持克制但肉眼可见的呼吸动作", () => {
	const analysis = makeWeakPreludeAnalysis("love");
	const result = simulateWeakPreludeEndToEnd(analysis);
	const noEvents = simulateWeakPreludeEndToEnd(
		{
			...analysis,
			beats: [],
			onsets: [],
		},
		7_000,
		analysis.beats,
	);
	assert.ok(result.maxBreath >= 0.025 && result.maxBreath <= 0.06);
	assert.ok(
		result.medianModulation >= 0.006,
		`爱错前奏的拍间呼吸变化仍只有 ${result.medianModulation}`,
	);
	assert.ok(
		result.medianModulation >= noEvents.medianModulation + 0.008,
		"可见变化只是持续呼吸基线而不是可信拍点",
	);
	assert.equal(result.maxStrongBeat, 0, "弱前奏被错误升级成强旋转");
	assert.ok(result.maxBreathStep < 0.002, "弱前奏呼吸出现单帧闪跳");
	assert.ok(
		result.maxBreathSecondDifference < 0.0002,
		"弱前奏呼吸出现高频方向突变",
	);
});

test("Shots 前奏多数稳定拍点拥有可见峰谷且不触发额外旋转", () => {
	const result = simulateWeakPreludeEndToEnd(makeWeakPreludeAnalysis("shots"));
	assert.ok(result.maxBreath >= 0.025 && result.maxBreath <= 0.09);
	assert.ok(
		result.medianModulation >= 0.004 && result.modulationDuty004 >= 0.5,
		`Shots 前奏可见拍仅 ${result.modulationDuty004}，中位峰谷 ${result.medianModulation}`,
	);
	assert.equal(result.maxStrongBeat, 0, "Shots 前奏被错误升级成强旋转");
	assert.ok(result.maxBreathStep < 0.002, "Shots 前奏呼吸出现单帧闪跳");
	assert.ok(
		result.maxBreathSecondDifference < 0.0002,
		"Shots 前奏呼吸出现高频方向突变",
	);
});

test("Shots 前奏后半段的代表性弱拍也保持可见峰谷", () => {
	const analysis = makeExtendedShotsPreludeAnalysis();
	const summarizePair = (rows, endMs) =>
		simulateWeakPreludeEndToEnd(
			analysis,
			endMs,
			rows.map(([timeMs]) => ({ timeMs })),
		);
	const firstWindow = summarizePair(SHOTS_LATER_WEAK_ROWS.slice(0, 2), 14_000);
	const secondWindow = summarizePair(SHOTS_LATER_WEAK_ROWS.slice(2), 39_000);
	for (const [name, result, minimumModulation] of [
		["12–24 秒", firstWindow, 0.004],
		["24–49 秒", secondWindow, 0.0045],
	]) {
		assert.ok(
			result.medianModulation >= minimumModulation &&
				result.modulationDuty004 === 1,
			`Shots ${name}的弱拍经过平滑后仍不可见：${result.medianModulation}`,
		);
		assert.equal(result.maxStrongBeat, 0, `Shots ${name}错误触发额外旋转`);
		assert.ok(result.maxBreathStep < 0.002, `Shots ${name}出现单帧闪跳`);
		assert.ok(
			result.maxBreathSecondDifference < 0.00015,
			`Shots ${name}出现高频方向突变`,
		);
	}
});

test("劣等上等的局部快拍经过完整 Mesh 平滑后仍有可见峰谷", () => {
	const analysis = makeInferioritySuperiorityAnalysis();
	const probeEvents = INFERIORITY_SUPERIORITY_ONSET_ROWS.slice(0, 5).map(
		([timeMs]) => ({ timeMs }),
	);
	const result = simulateWeakPreludeEndToEnd(analysis, 80_500, probeEvents);
	const control = simulateWeakPreludeEndToEnd(
		{
			...analysis,
			tempoSegments: [
				{ startMs: 0, endMs: 90_000, bpm: 63.962917, confidence: 0.6 },
			],
		},
		80_500,
		probeEvents,
	);
	const breathAt = (samples, timeMs) =>
		samples[Math.round((timeMs * 240) / 1_000)]?.breath ?? 0;
	const earlyEventDeltas = probeEvents
		.slice(0, 3)
		.map(
			({ timeMs }) =>
				breathAt(result.samples, timeMs) - breathAt(control.samples, timeMs),
		);
	assert.ok(
		median(earlyEventDeltas) >= 0.002,
		`局部快拍没有在真实事件时刻产生额外呼吸：${earlyEventDeltas}`,
	);
	assert.ok(
		result.medianModulation >= 0.01 && result.modulationDuty004 >= 0.5,
		`局部快拍经过两级平滑后仍过弱：${result.medianModulation}, ${result.modulationDuty004}`,
	);
	assert.equal(result.maxStrongBeat, 0, "局部补拍被错误升级成强旋转");
	assert.ok(result.maxBreathStep < 0.002, "局部快拍呼吸出现单帧闪跳");
	assert.ok(
		result.maxBreathSecondDifference < 0.0002,
		"局部快拍呼吸出现高频方向突变",
	);
});

test("Faded 的宽频重拍进入 240Hz Mesh 后明显但不会单帧闪跳", () => {
	const analysis = makeFadedMisphaseAnalysis();
	const harness = createMeshHarness();
	const deltaMs = 1_000 / 240;
	const startMs = 59_200;
	const endMs = 62_600;
	let smoothedVolume = 0;
	const samples = [];
	for (
		let musicTimeMs = startMs;
		musicTimeMs <= endMs;
		musicTimeMs += deltaMs
	) {
		const targetVolume = mapRhythmTargetToVolume(
			sampleAnalysisTarget(analysis, musicTimeMs),
		);
		smoothedVolume = advanceRhythmVisualVolume(
			smoothedVolume,
			targetVolume,
			deltaMs,
		);
		samples.push({
			...harness.step(musicTimeMs - startMs, deltaMs, {
				breath: smoothedVolume,
				strongBeat: sampleStrongBeatTarget(analysis, musicTimeMs),
			}),
			musicTimeMs,
		});
	}
	const firstDifferences = samples
		.slice(1)
		.map((sample, index) =>
			Math.abs(sample.kick - (samples[index]?.kick ?? sample.kick)),
		);
	const secondDifferences = samples
		.slice(2)
		.map((sample, index) =>
			Math.abs(
				sample.kick -
					2 * (samples[index + 1]?.kick ?? sample.kick) +
					(samples[index]?.kick ?? sample.kick),
			),
		);
	const maxKick = Math.max(...samples.map((sample) => sample.kick));
	const kickPeaks = samples.filter(
		(sample, index) =>
			sample.kick >= 0.07 &&
			sample.kick > (samples[index - 1]?.kick ?? sample.kick) &&
			sample.kick >= (samples[index + 1]?.kick ?? sample.kick),
	);
	const strongRotationFraction =
		samples.filter((sample) => sample.kick >= (5 * Math.PI) / 180).length /
		samples.length;

	// 冲量-弹簧物理下,冲击同步点是速度峰值(落在拍上),位移顶点比拍点
	// 晚约 100ms——这是"推出去漂到顶"的物理过程,不是延迟缺陷。
	const expectedPeakTimes = [59_550, 60_212, 60_875, 61_550, 62_208];
	assert.equal(kickPeaks.length, expectedPeakTimes.length);
	for (let index = 0; index < expectedPeakTimes.length; index++) {
		assert.ok(
			Math.abs(
				(kickPeaks[index]?.musicTimeMs ?? 0) - (expectedPeakTimes[index] ?? 0),
			) <= 60,
			`第 ${index + 1} 个 Mesh 前冲没有跟随预期重拍`,
		);
	}
	assert.ok(
		maxKick >= (5 * Math.PI) / 180 && maxKick <= 0.115,
		`Faded 宽频重拍实际前冲为 ${maxKick}rad`,
	);
	// 慢回程弹簧下,密集重拍段会保持"被推出"的姿态更久;上限只防
	// 失控累积,不再限制正常的持续倾斜。
	assert.ok(
		strongRotationFraction >= 0.05 && strongRotationFraction <= 0.35,
		`Faded 高于 5° 的时长占比为 ${strongRotationFraction}`,
	);
	assert.ok(
		Math.max(...firstDifferences) < 0.0065,
		`Faded 旋转单帧跳变 ${Math.max(...firstDifferences)}rad`,
	);
	assert.ok(
		Math.max(...secondDifferences) < 0.0012,
		`Faded 旋转二阶跳变 ${Math.max(...secondDifferences)}rad`,
	);
});

function simulateMeshPulse(
	fps,
	{
		beatTimes = [500],
		breathAmplitude = 0.4,
		durationMs = 1_600,
		rawBass = 0,
		strongBeatAmplitude = 1,
	} = {},
) {
	const harness = createMeshHarness();
	const deltaMs = 1_000 / fps;
	const samples = [];
	for (let timeMs = deltaMs; timeMs <= durationMs; timeMs += deltaMs) {
		const breath =
			breathAmplitude *
			Math.max(
				...beatTimes.map((beatTime) =>
					sampleSmoothPulse(timeMs, beatTime, 140, 250),
				),
			);
		const strongBeat =
			strongBeatAmplitude *
			Math.max(
				...beatTimes.map((beatTime) =>
					sampleSmoothPulse(timeMs, beatTime, 65, 130),
				),
			);
		samples.push({
			...harness.step(timeMs, deltaMs, { breath, rawBass, strongBeat }),
			timeMs,
		});
	}
	const frameSteps = samples
		.slice(1)
		.map((sample, index) =>
			Math.abs(sample.kick - (samples[index]?.kick ?? sample.kick)),
		);
	const breathFrameSteps = samples
		.slice(1)
		.map((sample, index) =>
			Math.abs(sample.breath - (samples[index]?.breath ?? sample.breath)),
		);
	return {
		breathFrameSteps,
		frameSteps,
		maxAngleUniformError: Math.max(
			...samples.map((sample) => sample.angleUniformError),
		),
		maxBreath: Math.max(...samples.map((sample) => sample.breath)),
		maxBreathFrameStep: Math.max(0, ...breathFrameSteps),
		maxBrightnessError: Math.max(
			...samples.map((sample) => Math.abs(1 - sample.brightness)),
		),
		maxFrameStep: Math.max(0, ...frameSteps),
		maxKick: Math.max(...samples.map((sample) => sample.kick)),
		minKick: Math.min(...samples.map((sample) => sample.kick)),
		samples,
	};
}

test("安装后的 Mesh 会分离呼吸与非负的极重拍冲量", () => {
	const ordinary = simulateMeshPulse(240, { strongBeatAmplitude: 0 });
	const heavy = simulateMeshPulse(240);

	assert.equal(ordinary.maxKick, 0, "普通呼吸信号泄漏到额外旋转通道");
	assert.ok(heavy.maxKick >= 0.11, `极重拍前冲仅 ${heavy.maxKick}rad`);
	assert.ok(heavy.maxKick <= 0.18, `极重拍前冲越界到 ${heavy.maxKick}rad`);
	assert.ok(heavy.minKick >= 0, `极重拍冲量反向越界：${heavy.minKick}rad`);
	assert.ok(
		ordinary.maxBreath >= 0.09,
		`无重拍时呼吸缩放不明显：${ordinary.maxBreath}`,
	);
	// 极重拍期间呼吸主动避让旋转:幅度压低但不清零。
	assert.ok(
		heavy.maxBreath >= 0.045 && heavy.maxBreath <= ordinary.maxBreath * 0.8,
		`重拍避让后的呼吸幅度异常：${heavy.maxBreath} / ${ordinary.maxBreath}`,
	);
	assert.ok(heavy.maxBreath <= 0.12, "呼吸幅度越界");
	assert.ok(
		heavy.maxAngleUniformError < 1e-12,
		"极重拍冲量没有写入旋转 uniform",
	);
	assert.ok(heavy.maxBrightnessError < 1e-12, "节拍仍在直接改变着色器乘法亮度");
	assert.ok(
		heavy.maxBreathFrameStep < 0.006,
		`呼吸单帧跳变 ${heavy.maxBreathFrameStep}`,
	);
});

function nearestSample(samples, timeMs) {
	return samples.reduce((nearest, sample) =>
		Math.abs(sample.timeMs - timeMs) < Math.abs(nearest.timeMs - timeMs)
			? sample
			: nearest,
	);
}

test("极重拍会快速单向推开、慢速部分回落，下一拍在未回零时再推", () => {
	const beatTimes = [500, 1_000, 1_500, 2_000];
	const result = simulateMeshPulse(240, {
		beatTimes,
		breathAmplitude: 0,
		durationMs: 2_200,
	});
	const beatTime = 1_500;
	const before = nearestSample(result.samples, beatTime - 65).kick;
	const peakSamples = result.samples.filter(
		(sample) => sample.timeMs >= beatTime && sample.timeMs <= beatTime + 100,
	);
	const peak = peakSamples.reduce((best, sample) =>
		sample.kick > best.kick ? sample : best,
	);
	const beforeNextBeat = nearestSample(result.samples, beatTime + 430).kick;
	const signedSteps = result.samples
		.slice(1)
		.map((sample, index) => sample.kick - (result.samples[index]?.kick ?? 0));
	const maxRiseStep = Math.max(...signedSteps);
	const maxFallStep = Math.max(...signedSteps.map((step) => -step));
	const nextPeak = Math.max(
		...result.samples
			.filter(
				(sample) =>
					sample.timeMs >= beatTime + 500 && sample.timeMs <= beatTime + 600,
			)
			.map((sample) => sample.kick),
	);

	// 冲量-弹簧物理:速度峰值在拍点,位移顶点随惯性滑出,延迟属预期。
	assert.ok(
		peak.timeMs - beatTime <= 130,
		`前冲峰值延迟 ${peak.timeMs - beatTime}ms`,
	);
	assert.ok(peak.kick - before >= 0.06, `前冲增量仅 ${peak.kick - before}rad`);
	assert.ok(
		beforeNextBeat >= peak.kick * 0.4 && beforeNextBeat <= peak.kick * 0.6,
		`下一拍前回落比例为 ${beforeNextBeat / peak.kick}`,
	);
	// 回程速度轮廓是钟形(顶点零速缓启),用瞬时峰值速度比较推出与回程。
	assert.ok(
		maxRiseStep >= maxFallStep * 2.5,
		`回程峰值速度未明显低于推出：${maxRiseStep} / ${maxFallStep}`,
	);
	assert.ok(beforeNextBeat > 0, "反作用力把旋转强制拉回了原点");
	assert.ok(
		nextPeak - beforeNextBeat >= 0.06,
		"下一拍未能在残留角度上再次推进",
	);
	assert.ok(result.minKick >= 0, "慢速回落期间出现了反向角度");
});

test("弱强拍冲量用更长预滚缓慢起势，极重拍保持锐利前冲", () => {
	const heavy = makeStrongKickAnalysis();
	const quiet = makeStrongKickAnalysis(0.12);
	const beatTime = 1_000;

	// 满强度冲量的预滚仍是 65ms，80ms 前完全为零。
	assert.equal(
		sampleStrongBeatTarget(heavy, beatTime - 80),
		0,
		"极重拍的预滚被误拉长",
	);
	// 门控后的弱冲量提前约 145ms 就开始缓慢起势。
	assert.ok(
		sampleStrongBeatTarget(quiet, beatTime - 100) > 0,
		"弱冲量没有获得更长的预滚",
	);
	// 峰值时刻的数值不因预滚变化而改变。
	const quietPeak = sampleStrongBeatTarget(quiet, beatTime);
	assert.ok(
		quietPeak > 0.08 && quietPeak <= 0.15,
		`弱冲量峰值漂移：${quietPeak}`,
	);

	const normalizedRiseSlope = (analysis, peak) => {
		const deltaMs = 1_000 / 240;
		let maxStep = 0;
		for (let timeMs = beatTime - 200; timeMs < beatTime; timeMs += deltaMs) {
			const step =
				sampleStrongBeatTarget(analysis, timeMs + deltaMs) -
				sampleStrongBeatTarget(analysis, timeMs);
			maxStep = Math.max(maxStep, step);
		}
		return maxStep / peak;
	};
	const heavyPeak = sampleStrongBeatTarget(heavy, beatTime);
	assert.ok(
		normalizedRiseSlope(quiet, quietPeak) <=
			normalizedRiseSlope(heavy, heavyPeak) * 0.6,
		"弱冲量的归一化上升斜率没有明显放缓",
	);
});

test("原作者低频输入与转动保持原公式，呼吸和极重拍流动独立叠加", () => {
	const baseHarness = createMeshHarness();
	const base = baseHarness.step(1_000, 16, { breath: 0.4 });
	const bassHarness = createMeshHarness();
	const bass = bassHarness.step(1_000, 16, { breath: 0.4, rawBass: 0.8 });
	const combinedHarness = createMeshHarness();
	const combined = combinedHarness.step(1_000, 16, {
		breath: 0.4,
		rawBass: 0.8,
		strongBeat: 1,
	});
	const baseAngle = Math.atan2(base.sinAngle, base.cosAngle);
	const bassAngle = Math.atan2(bass.sinAngle, bass.cosAngle);

	assert.ok(
		Math.abs(bass.rawBassVolume - 0.08) < 1e-12,
		"原低频 volume / 10 被改变",
	);
	assert.ok(
		Math.abs(bassAngle - baseAngle - 0.16) < 1e-12,
		`原低频转动增量应为 0.16，实际为 ${bassAngle - baseAngle}`,
	);
	assert.ok(combined.kick > 0, "极重拍流动冲量没有生成");
	assert.equal(combined.angle, bass.angle, "极重拍不应额外旋转整幅纹理");
	assert.notEqual(combined.flowOffsetX, bass.flowOffsetX);
	assert.ok(
		combined.angleUniformError < 1e-12,
		"三通道合成后旋转 uniform 错误",
	);
	assert.ok(bass.breath > base.breath, "原低频没有保留原作者的缩放呼吸反馈");
});

test("持续强呼吸与原作者低频使用软膝叠加，不会在 0.16 处截平", () => {
	const harness = createMeshHarness();
	let sample;
	for (let timeMs = 16; timeMs <= 1_600; timeMs += 16) {
		sample = harness.step(timeMs, 16, { breath: 0.4, rawBass: 1 });
	}
	assert.ok(sample, "未生成 Mesh 样本");
	assert.ok(sample.breath > 0.19, `低频与呼吸合成仍被压平到 ${sample.breath}`);
	assert.ok(sample.breath <= 0.2, `软膝合成越过安全上限 ${sample.breath}`);
	assert.ok(Math.abs(1 - sample.brightness) < 1e-12, "软膝合成破坏亮度补偿");
});

function simulateShotsEndToEnd(fps = 240) {
	const analysis = makeShotsSegmentAnalysis();
	const harness = createMeshHarness();
	const deltaMs = 1_000 / fps;
	const startMs = 48_500;
	const endMs = 63_000;
	let smoothedVolume = 0;
	const samples = [];

	for (
		let musicTimeMs = startMs;
		musicTimeMs <= endMs;
		musicTimeMs += deltaMs
	) {
		const elapsedMs = musicTimeMs - startMs;
		const targetVolume = mapRhythmTargetToVolume(
			sampleAnalysisTarget(analysis, musicTimeMs),
		);
		smoothedVolume = advanceRhythmVisualVolume(
			smoothedVolume,
			targetVolume,
			deltaMs,
		);
		const strongBeat = sampleStrongBeatTarget(analysis, musicTimeMs);
		samples.push({
			...harness.step(elapsedMs, deltaMs, {
				breath: smoothedVolume,
				strongBeat,
			}),
			musicTimeMs,
			smoothedVolume,
			strongBeat,
		});
	}

	const firstDifferences = samples
		.slice(1)
		.map((sample, index) =>
			Math.abs(sample.kick - (samples[index]?.kick ?? sample.kick)),
		);
	const secondDifferences = samples
		.slice(2)
		.map((sample, index) =>
			Math.abs(
				sample.kick -
					2 * (samples[index + 1]?.kick ?? sample.kick) +
					(samples[index]?.kick ?? sample.kick),
			),
		);

	return {
		maxAngleUniformError: Math.max(
			...samples.map((sample) => sample.angleUniformError),
		),
		maxBreath: Math.max(...samples.map((sample) => sample.breath)),
		maxFrameStep: Math.max(...firstDifferences),
		maxKick: Math.max(...samples.map((sample) => sample.kick)),
		maxSmoothedVolume: Math.max(
			...samples.map((sample) => sample.smoothedVolume),
		),
		maxSecondDifference: Math.max(...secondDifferences),
		minKick: Math.min(...samples.map((sample) => sample.kick)),
		strongRotationFraction:
			samples.filter((sample) => sample.kick >= (5 * Math.PI) / 180).length /
			samples.length,
	};
}

test("Shots 真实片段的呼吸与极重拍冲量都能进入 Mesh", () => {
	const result = simulateShotsEndToEnd();
	assert.ok(
		result.maxSmoothedVolume >= 0.3,
		`完整呼吸链路输出仅 ${result.maxSmoothedVolume}`,
	);
	assert.ok(
		result.maxKick >= 0.14 && result.maxKick <= 0.21,
		`完整极重拍链路峰值为 ${result.maxKick}rad`,
	);
	assert.ok(result.minKick >= 0, `完整链路出现反向冲量 ${result.minKick}rad`);
	assert.ok(
		result.strongRotationFraction >= 0.5,
		`Shots 重低音段高于 5° 的时长仅 ${result.strongRotationFraction}`,
	);
	// 重低音段呼吸对旋转避让后仍需保持可见(不清零)。
	assert.ok(result.maxBreath >= 0.05, `完整链路呼吸仅 ${result.maxBreath}`);
	assert.ok(
		result.maxFrameStep < 0.012,
		`单帧旋转跳变 ${result.maxFrameStep}rad`,
	);
	assert.ok(
		result.maxSecondDifference < 0.004,
		`旋转二阶跳变 ${result.maxSecondDifference}rad`,
	);
	assert.ok(
		result.maxAngleUniformError < 1e-12,
		"完整链路冲量没有进入 Mesh 旋转 uniform",
	);
});

test("真实 Mesh 极重拍冲量在 60/120/240Hz 下峰值一致且无单帧闪跳", () => {
	const options = {
		beatTimes: [500, 1_000, 1_500, 2_000],
		breathAmplitude: 0,
		durationMs: 2_200,
	};
	const expected = simulateMeshPulse(60, options);
	assert.ok(
		expected.maxFrameStep < 0.04,
		`60Hz 单帧跳变 ${expected.maxFrameStep}rad`,
	);
	for (const [fps, maxStep] of [
		[120, 0.02],
		[240, 0.012],
	]) {
		const candidate = simulateMeshPulse(fps, options);
		assert.ok(
			Math.abs(candidate.maxKick - expected.maxKick) < 0.002,
			`${fps}Hz 的正向摆幅漂移过大`,
		);
		assert.ok(candidate.minKick >= 0, `${fps}Hz 出现反向角度`);
		assert.ok(
			candidate.maxFrameStep < maxStep,
			`${fps}Hz 单帧跳变 ${candidate.maxFrameStep}rad`,
		);
	}
});

test("真实 Mesh 遇到长帧时不会积分未显示的一整段旋转", () => {
	const harness = createMeshHarness();
	harness.renderer.meshStates[0].alpha = 0;
	harness.step(0, 16);
	const before = harness.renderer.rhythmKick;
	const after = harness.step(1_000, 1_000, { strongBeat: 1 }).kick;
	assert.ok(
		Math.abs(after - before) < 0.12,
		`长帧单步旋转 ${after - before}rad`,
	);
	assert.ok(
		harness.renderer.meshStates[0].alpha <= 0.21,
		`长帧让封面淡入瞬跳到 ${harness.renderer.meshStates[0].alpha}`,
	);
});

test("真实 Mesh 的基础旋转也不会追赶未显示的长帧", () => {
	const renderer = Object.create(MeshGradientRenderer.prototype);
	let redrawDelta = -1;
	Object.assign(renderer, {
		_disposed: false,
		flowSpeed: 1,
		frameTime: 0,
		lastFrameTime: 0,
		lastTickTime: 0,
		maxFPS: 240,
		paused: false,
		requestTick() {},
		staticMode: false,
		tickHandle: 1,
		updatePerformanceStats() {},
	});
	renderer.onRedraw = (_timeMs, deltaMs) => {
		redrawDelta = deltaMs;
		return false;
	};
	renderer.onTick(1_000);
	assert.equal(renderer.frameTime, 50);
	assert.equal(redrawDelta, 50);
});

test("真实 Mesh 会尊重合法低帧率，而不是固定截断到 50ms", () => {
	const renderer = Object.create(MeshGradientRenderer.prototype);
	let redrawDelta = -1;
	Object.assign(renderer, {
		_disposed: false,
		flowSpeed: 1,
		frameTime: 0,
		lastFrameTime: 0,
		lastTickTime: 0,
		maxFPS: 10,
		paused: false,
		requestTick() {},
		staticMode: false,
		tickHandle: 1,
		updatePerformanceStats() {},
	});
	renderer.onRedraw = (_timeMs, deltaMs) => {
		redrawDelta = deltaMs;
		return false;
	};
	renderer.onTick(100);
	assert.equal(renderer.frameTime, 100);
	assert.equal(redrawDelta, 100);
});

test("重新打开歌词页会沿用当前节奏状态而不是先硬切静音", () => {
	const source = readFileSync(
		new URL(
			"../src/components/LocalMusicContext/rhythm-visual.tsx",
			import.meta.url,
		),
		"utf8",
	);
	assert.match(source, /const initialMusicId = store\.get\(musicIdAtom\)/);
	assert.match(source, /let lastMusicId = initialMusicId/);
	assert.doesNotMatch(source, /let lastMusicId = ["']{2}/);
});

test("播放器挂载低频桥，并独立同步 Mesh 节拍信号与强度倍率", () => {
	const visualSource = readFileSync(
		new URL(
			"../src/components/LocalMusicContext/rhythm-visual.tsx",
			import.meta.url,
		),
		"utf8",
	);
	const contextSource = readFileSync(
		new URL("../src/components/LocalMusicContext/index.tsx", import.meta.url),
		"utf8",
	);
	const videoBackgroundSource = readFileSync(
		new URL("../src/components/SongVideoBackground/index.tsx", import.meta.url),
		"utf8",
	);
	assert.match(
		visualSource,
		/MeshGradientRenderer\.setRhythmVisualSignal\(\s*Math\.max\(SILENT_RHYTHM_VOLUME, smoothedValue\),\s*strongBeatTarget,?\s*\)/,
	);
	assert.match(
		visualSource,
		/MeshGradientRenderer\.setRhythmVisualSignal\(0, 0\)/,
	);
	assert.match(contextSource, /<FFTToLowPassContext\s*\/>/);
	assert.match(
		videoBackgroundSource,
		/const backgroundAnimationIntensity = useAtomValue\(\s*lyricBackgroundAnimationIntensityAtom,?\s*\)/,
	);
	assert.match(
		videoBackgroundSource,
		/useEffect\(\(\) => \{\s*MeshGradientRenderer\.setRhythmVisualIntensity\(\s*rendererOptions\.animationIntensity,?\s*\);\s*\}, \[rendererOptions\.animationIntensity\]\)/,
	);
});

test("歌词背景设置持久化并限制动画强度倍率", () => {
	const atomsSource = readFileSync(
		new URL("../src/states/appAtoms.ts", import.meta.url),
		"utf8",
	);
	const settingsSource = readFileSync(
		new URL("../src/pages/settings/player.tsx", import.meta.url),
		"utf8",
	);

	assert.match(atomsSource, /LYRIC_BACKGROUND_ANIMATION_INTENSITY_MIN = 0/);
	assert.match(atomsSource, /LYRIC_BACKGROUND_ANIMATION_INTENSITY_MAX = 2/);
	assert.match(atomsSource, /LYRIC_BACKGROUND_ANIMATION_INTENSITY_DEFAULT = 1/);
	assert.match(atomsSource, /"amll-player\.lyricBackgroundAnimationIntensity"/);
	assert.match(
		atomsSource,
		/Number\.isFinite\(value\)[\s\S]*?Math\.min\([\s\S]*?LYRIC_BACKGROUND_ANIMATION_INTENSITY_MAX[\s\S]*?Math\.max\(LYRIC_BACKGROUND_ANIMATION_INTENSITY_MIN, value\)/,
	);
	assert.match(
		settingsSource,
		/baseRendererString === "mesh"[\s\S]*?<SliderSettings[\s\S]*?configAtom=\{lyricBackgroundAnimationIntensityAtom\}[\s\S]*?step=\{0\.05\}/,
	);
	const fpsIndex = settingsSource.indexOf(
		"configAtom={lyricBackgroundFPSAtom}",
	);
	const intensityIndex = settingsSource.indexOf(
		"configAtom={lyricBackgroundAnimationIntensityAtom}",
	);
	const renderScaleIndex = settingsSource.indexOf(
		"configAtom={lyricBackgroundRenderScaleAtom}",
	);
	assert.ok(fpsIndex >= 0 && fpsIndex < intensityIndex);
	assert.ok(intensityIndex < renderScaleIndex);

	for (const locale of ["en-US", "ja-JP", "vi-VN", "zh-CN", "zh-TW"]) {
		const translations = JSON.parse(
			readFileSync(
				new URL(`../locales/${locale}/translation.json`, import.meta.url),
				"utf8",
			),
		);
		const entry =
			translations.page.settings.lyricBackground
				.lyricBackgroundAnimationIntensity;
		assert.equal(typeof entry?.label, "string", `${locale} 缺少倍率标签`);
		assert.equal(typeof entry?.description, "string", `${locale} 缺少倍率说明`);
		assert.ok(entry.label.length > 0 && entry.description.length > 0);
	}
});

test("节拍动画倍率输入框与滑杆组成同一行的右对齐控制组", () => {
	const settingsSource = readFileSync(
		new URL("../src/pages/settings/player.tsx", import.meta.url),
		"utf8",
	);
	assert.match(
		settingsSource,
		/<Flex width="100%" minWidth="0" align="center" gap="2" wrap="nowrap">[\s\S]*?\{slider\}[\s\S]*?\{children\}/,
	);
	assert.match(
		settingsSource,
		/style=\{\{ flex: "0 0 auto", marginInlineStart: "auto" \}\}/,
	);
	assert.match(
		settingsSource,
		/configAtom=\{lyricBackgroundAnimationIntensityAtom\}[\s\S]*?inlineValue/,
	);
	assert.match(
		settingsSource,
		/querySelectorAll<HTMLElement>\('\[role="slider"\]'\)[\s\S]*?setAttribute\([\s\S]*?"aria-label"/,
		"实际的滑杆 Thumb 必须获得无障碍名称",
	);
	assert.doesNotMatch(
		settingsSource,
		/thumb\.removeAttribute\("aria-label"\)/,
		"没有自定义名称时必须保留 Radix 双滑块自带的无障碍名称",
	);
	assert.match(
		settingsSource,
		/value=\{backgroundAnimationIntensityInput\}[\s\S]*?onBlur=\{commitBackgroundAnimationIntensity\}/,
		"数值框应保留小数输入草稿并在失焦时提交",
	);
});

test("安装后的 Mesh 补丁使用低频、呼吸、极重拍三通道和亮度补偿", () => {
	for (const fileName of ["amll-core.mjs", "amll-core.cjs"]) {
		const source = readFileSync(
			new URL(
				`../node_modules/@applemusic-like-lyrics/core/dist/${fileName}`,
				import.meta.url,
			),
			"utf8",
		);
		assert.match(source, /static setRhythmVisualIntensity\(intensity = 1\) \{/);
		assert.match(
			source,
			/MeshGradientRenderer\.rhythmVisualIntensity = Number\.isFinite\(intensity\) \? Math\.min\(2, Math\.max\(0, intensity\)\) : 1/,
		);
		assert.match(
			source,
			/static setRhythmVisualSignal\(breath, heavyBeat\) \{/,
		);
		assert.match(
			source,
			/const signal = Math\.min\(1, Math\.max\(0, MeshGradientRenderer\.rhythmVisualVolume \* 2\.5\)\)/,
		);
		assert.match(
			source,
			/this\.kickVelocity \+= 2\.4 \* Math\.max\(0, kickDrive - this\.lastKickDrive\)/,
		);
		assert.match(
			source,
			/this\.kickVelocity -= \(30 \* this\.rhythmKick \+ 16 \* this\.kickVelocity\) \* kickStepS/,
		);
		assert.match(
			source,
			/this\.rhythmKick \+= this\.kickVelocity \* kickStepS/,
		);
		assert.match(source, /mesh_frag_default\.replace\(.*vec2\(0\.5\)/);
		assert.ok(
			source.indexOf("var mesh_frag_default") <
				source.indexOf("mesh_frag_default = mesh_frag_default.replace"),
			`${fileName} 在 shader 声明前执行了替换`,
		);
		assert.match(source, /const maxFrameDelta = Math\.max\(50,/);
		assert.match(
			source,
			/const safeDelta = Number\.isFinite\(delta\) \? Math\.min\(maxFrameDelta, Math\.max\(0, delta\)\) : 0/,
		);
		assert.match(
			source,
			/const safeFrameDelta = Number\.isFinite\(frameDelta\) \? Math\.min\(maxFrameDelta, Math\.max\(0, frameDelta\)\) : 0/,
		);
		assert.match(
			source,
			/this\.frameTime \+= safeFrameDelta \* this\.flowSpeed/,
		);
		assert.match(source, /this\.onRedraw\(this\.frameTime, safeFrameDelta\)/);
		assert.match(source, /const deltaFactor = safeDelta \/ 500/);
		assert.match(source, /u_cosAngle \* centeredUV\.x/);
		assert.match(
			source,
			/const animatedBreathVolume = Math\.min\(\.4, breathVolume \* rhythmVisualIntensity\)/,
		);
		assert.match(
			source,
			/const bassMotion = this\.volume \* rhythmVisualIntensity/,
		);
		assert.match(source, /"u_volume", animatedBreathVolume/);
		assert.match(source, /"u_alpha", compensatedAlpha/);
		assert.match(
			source,
			/const combinedBreath = Math\.max\(0, this\.volume\) \+ this\.rhythmBreath/,
		);
		assert.match(source, /const breathKnee = Math\.min\(1,/);
		assert.match(source, /const breathVolume = combinedBreath <= \.16/);
		assert.match(
			source,
			/const angle = uTime \* 2 \+ bassMotion \* 2/,
		);
		assert.match(source, /const flowAngle = angle \+ this\.rhythmKick \* rhythmVisualIntensity/);
		assert.match(source, /vec2\(0\.5\) \+ vec2\(u_flowOffsetX, u_flowOffsetY\)/);
		assert.match(source, /"u_flowOffsetX", flowRadius \* \(flowCos - flowSin\)/);
		assert.match(source, /"u_flowOffsetY", flowRadius \* \(flowSin \+ flowCos\)/);
		assert.match(
			source,
			/this\.volume = Number\.isFinite\(volume\) \? volume \/ 10 : 0/,
		);
		assert.doesNotMatch(
			source,
			/this\.(?:rhythmSwing|rhythmBaseline|rhythmPhase)/,
		);
		assert.match(
			source,
			/resume\(\) \{[\s\S]*?this\.lastFrameTime = now;[\s\S]*?this\.lastTickTime = now;/,
		);
	}

	for (const fileName of ["amll-core.d.mts", "amll-core.d.cts"]) {
		const source = readFileSync(
			new URL(
				`../node_modules/@applemusic-like-lyrics/core/dist/${fileName}`,
				import.meta.url,
			),
			"utf8",
		);
		assert.match(
			source,
			/static setRhythmVisualIntensity\(intensity\?: number\): void;/,
			`${fileName} 缺少强度倍率静态 API 类型`,
		);
		assert.match(
			source,
			/static setRhythmVisualSignal\(breath: number, heavyBeat: number\): void;/,
			`${fileName} 缺少节拍信号静态 API 类型`,
		);
	}
});

test("安装后的 ESM 与 CJS core 包可以真实加载", () => {
	const mjsUrl = new URL(
		"../node_modules/@applemusic-like-lyrics/core/dist/amll-core.mjs",
		import.meta.url,
	).href;
	const cjsPath = fileURLToPath(
		new URL(
			"../node_modules/@applemusic-like-lyrics/core/dist/amll-core.cjs",
			import.meta.url,
		),
	);
	execFileSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`globalThis.MouseEvent = class {}; await import(${JSON.stringify(mjsUrl)});`,
		],
		{ stdio: "pipe" },
	);
	execFileSync(
		process.execPath,
		[
			"--eval",
			`globalThis.MouseEvent = class {}; require(${JSON.stringify(cjsPath)});`,
		],
		{ stdio: "pipe" },
	);
});

const impactSegmentFixtures = JSON.parse(
	readFileSync(
		new URL("./fixtures/rhythm-impact-segments.json", import.meta.url),
		"utf8",
	),
);

function simulateImpactSegment(fixture, fps, includeRawBass = false) {
	const harness = createMeshHarness();
	const deltaMs = 1_000 / fps;
	const startMs = Math.max(0, fixture.window[0] - 1_000);
	const endMs = fixture.window[1];
	let volume = 0;
	const samples = [];
	for (let frame = 0; startMs + frame * deltaMs <= endMs; frame++) {
		const elapsedMs = frame * deltaMs;
		const musicTimeMs = startMs + elapsedMs;
		volume = advanceRhythmVisualVolume(
			volume,
			mapRhythmTargetToVolume(
				sampleAnalysisTarget(fixture.analysis, musicTimeMs),
			),
			deltaMs,
		);
		// The cache contains no live FFT; this smooth control signal checks coexistence only.
		const rawBass = includeRawBass ? 0.4 + 0.2 * Math.sin(elapsedMs / 190) : 0;
		const sample = harness.step(elapsedMs, deltaMs, {
			breath: volume,
			strongBeat: sampleStrongBeatTarget(fixture.analysis, musicTimeMs),
			rawBass,
		});
		if (musicTimeMs >= fixture.window[0])
			samples.push({ ...sample, musicTimeMs });
	}
	return samples;
}

test("四类真实分析片段进入 Mesh 后保持有界、连续且跨帧率一致", () => {
	for (const [key, fixture] of Object.entries(impactSegmentFixtures)) {
		for (const includeRawBass of [false, true]) {
			let reference;
			for (const fps of [60, 120, 240]) {
				const samples = simulateImpactSegment(fixture, fps, includeRawBass);
				const maxKick = Math.max(...samples.map((sample) => sample.kick));
				const meanKick =
					samples.reduce((sum, sample) => sum + sample.kick, 0) /
					samples.length;
				for (let index = 0; index < samples.length; index++) {
					const sample = samples[index];
					const context = `${key}/${fps}Hz/rawBass=${includeRawBass}/${sample.musicTimeMs}ms`;
					assert.ok(
						Number.isFinite(sample.kick) &&
							sample.kick >= 0 &&
							sample.kick < 0.4,
						`${context}: kick=${sample.kick}`,
					);
					assert.ok(
						sample.breath >= 0 && sample.breath <= 0.2,
						`${context}: breath=${sample.breath}`,
					);
					assert.ok(
						sample.angleUniformError < 1e-12,
						`${context}: rotation uniform mismatch`,
					);
					assert.ok(
						Math.abs(sample.brightness - 1) < 1e-12,
						`${context}: brightness=${sample.brightness}`,
					);
					if (index > 0) {
						assert.ok(
							Math.abs(sample.kick - samples[index - 1].kick) < 2 / fps,
							`${context}: one-frame kick jump`,
						);
					}
				}
				if (reference) {
					assert.ok(
						Math.abs(maxKick - reference.maxKick) < 0.008,
						`${key}/${fps}Hz: peak drift ${maxKick - reference.maxKick}`,
					);
					assert.ok(
						Math.abs(meanKick - reference.meanKick) < 0.004,
						`${key}/${fps}Hz: motion drift ${meanKick - reference.meanKick}`,
					);
				} else reference = { maxKick, meanKick };
			}
		}
	}
});

test("Shots 半速网格片段在真实 Mesh 中每次低音都有推进，收尾后自然回落", () => {
	const fixture = impactSegmentFixtures["half-time-bass"];
	const samples = simulateImpactSegment(fixture, 120);
	const anchors = [
		136_777, 137_288, 137_787, 138_286, 138_786, 139_285, 139_784, 140_283,
		140_783, 141_282, 141_781, 142_280, 142_780, 143_279, 143_778, 144_289,
		144_776, 145_287, 145_798, 146_286, 146_785, 147_284, 147_783, 148_283,
		148_782, 149_281, 149_780,
	];
	for (const timeMs of anchors) {
		const before = samples.filter(
			(sample) =>
				sample.musicTimeMs >= timeMs - 180 && sample.musicTimeMs < timeMs,
		);
		const after = samples.filter(
			(sample) =>
				sample.musicTimeMs >= timeMs && sample.musicTimeMs <= timeMs + 150,
		);
		const excursion =
			Math.max(...after.map((sample) => sample.kick)) -
			Math.min(...before.map((sample) => sample.kick));
		assert.ok(
			excursion > 0.012,
			`${timeMs}ms: rotation excursion=${excursion}`,
		);
	}
	const body = samples.filter(
		(sample) => sample.musicTimeMs >= 145_000 && sample.musicTimeMs <= 149_000,
	);
	const tail = samples.filter((sample) => sample.musicTimeMs >= 150_500);
	assert.ok(
		Math.max(...tail.map((sample) => sample.kick)) <
			Math.max(...body.map((sample) => sample.kick)) * 0.6,
		"收尾后仍维持重低音段摆幅",
	);
});
