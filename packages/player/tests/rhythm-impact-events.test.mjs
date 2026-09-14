import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getRhythmImpactEvents } from "../src/components/LocalMusicContext/rhythm-impact-events.ts";
import {
	sampleAnalysisTarget,
	sampleStrongBeatTarget,
} from "../src/components/LocalMusicContext/rhythm-visual-signal.ts";

const fixtures = JSON.parse(
	readFileSync(
		new URL("./fixtures/rhythm-impact-segments.json", import.meta.url),
		"utf8",
	),
);

function pulses({
	period = 500,
	count = 12,
	scale = 0.6,
	peak = 1,
	beatOffset = -116,
	highFrequency = false,
} = {}) {
	const times = Array.from(
		{ length: count },
		(_, index) => 1_000 + index * period,
	);
	const durationMs = times.at(-1) + 700;
	return {
		analyzerVersion: 5,
		durationMs,
		globalBpm: 120,
		confidence: 0.7,
		energyScale: scale,
		tempoSegments: [
			{ startMs: 0, endMs: durationMs, bpm: 60, confidence: 0.7 },
		],
		beats: times
			.filter((_, index) => index % 2 === 0)
			.map((timeMs) => ({
				timeMs: timeMs + beatOffset,
				strength: 0.55,
				confidence: 0.7,
			})),
		onsets: times.map((timeMs, index) => ({
			timeMs,
			strength: index % 2 === 0 ? 0.9 : 0.7,
			// Repeated bass attacks need not have low-band spectral novelty.
			bands: [0, 0, 0.6, 0.9, 0.8],
			bandLevels: (highFrequency
				? [0.01, 0.02, 0.1, 0.3, 1]
				: [1, 0.2, 0.1, 0.1, 0.1]
			).map((value) => value * scale),
		})),
		energyEnvelope: Array.from(
			{ length: Math.ceil(durationMs / 20) + 1 },
			(_, index) => {
				const timeMs = index * 20;
				const width = Math.min(55, period * 0.14);
				const pulse = Math.max(
					0,
					...times.map((time) =>
						Math.exp(-0.5 * ((timeMs - time - 20) / width) ** 2),
					),
				);
				return { timeMs, value: peak * (0.25 + 0.75 * pulse) };
			},
		),
	};
}

function eventsIn(analysis, start, end) {
	return getRhythmImpactEvents(analysis).filter(
		(event) => event.timeMs >= start && event.timeMs <= end,
	);
}

test("低频事件不依赖半速、倍速、偏相位或缺失的拍格", () => {
	const reference = pulses();
	const expected = getRhythmImpactEvents(reference);
	assert.equal(expected.length, reference.onsets.length);
	for (const bpm of [null, 60, 120, 240]) {
		const variant = {
			...reference,
			globalBpm: bpm,
			beats:
				bpm === null
					? []
					: Array.from({ length: 20 }, (_, index) => ({
							timeMs: 430 + index * (60_000 / bpm),
							strength: 0.6,
							confidence: 0.6,
						})),
			tempoSegments:
				bpm === null
					? []
					: [{ startMs: 0, endMs: reference.durationMs, bpm, confidence: 0.7 }],
		};
		assert.deepEqual(getRhythmImpactEvents(variant), expected);
		for (const onset of reference.onsets) {
			assert.equal(
				sampleStrongBeatTarget(variant, onset.timeMs),
				sampleStrongBeatTarget(reference, onset.timeMs),
			);
		}
	}
});

test("强拍和普通脉冲在真实敲击处对齐，不在旧拍点留下双峰", () => {
	for (const beatOffset of [-180, -116, -91, -89, 0, 116, 180]) {
		const analysis = pulses({ count: 1, beatOffset });
		assert.ok(sampleStrongBeatTarget(analysis, 1_000) > 0.8);
		const values = Array.from({ length: 201 }, (_, index) =>
			sampleAnalysisTarget(analysis, 800 + index * 2),
		);
		const peaks = values.flatMap((value, index) =>
			index > 0 &&
			index < values.length - 1 &&
			value > values[index - 1] &&
			value >= values[index + 1]
				? [800 + index * 2]
				: [],
		);
		assert.equal(peaks.length, 1, `offset=${beatOffset}: ${peaks}`);
		assert.ok(
			Math.abs(peaks[0] - 1_000) < 20,
			`offset=${beatOffset}: peak=${peaks[0]}`,
		);
	}
});

test("同一能量平台的多个起音只生成一次冲量", () => {
	const analysis = pulses({ count: 1 });
	analysis.onsets.push({ ...analysis.onsets[0], timeMs: 1_070, strength: 0.4 });
	assert.equal(getRhythmImpactEvents(analysis).length, 1);
	assert.equal(getRhythmImpactEvents(analysis)[0].timeMs, 1_000);
});

test("持续低音和铺底上的密集高频声部不制造连续旋转", () => {
	for (const hat of [false, true]) {
		const analysis = pulses({ period: 100, count: 45 });
		analysis.energyEnvelope = analysis.energyEnvelope.map((point, index) => ({
			...point,
			value: hat && index % 5 === 0 ? 0.75 : 0.7,
		}));
		assert.equal(getRhythmImpactEvents(analysis).length, 0);
		assert.equal(sampleStrongBeatTarget(analysis, 2_000), 0);
	}
	const hats = pulses({ highFrequency: true, period: 125, count: 30 });
	assert.equal(
		getRhythmImpactEvents(hats).length,
		0,
		"纯高频 RMS 峰被误认成低音",
	);
});

test("一次能量上升后的长平台只触发一次，平台长度不拖延起音", () => {
	const analysis = pulses({ count: 8 });
	analysis.energyEnvelope = analysis.energyEnvelope.map((point) => ({
		...point,
		value: point.timeMs < 1_000 ? 0.2 : 1,
	}));
	const events = getRhythmImpactEvents(analysis);
	assert.equal(events.length, 1);
	assert.equal(events[0].timeMs, 1_000);
	assert.equal(sampleStrongBeatTarget(analysis, 2_000), 0);
});

test("同样节律按实际电平连续分级，轻声部保留呼吸", () => {
	const quiet = pulses({ scale: 0.03 });
	const medium = pulses({ scale: 0.2 });
	const loud = pulses({ scale: 0.6 });
	const q = sampleStrongBeatTarget(quiet, 2_000);
	const m = sampleStrongBeatTarget(medium, 2_000);
	const l = sampleStrongBeatTarget(loud, 2_000);
	assert.equal(q, 0);
	assert.ok(m > q && l > m, `${q}, ${m}, ${l}`);
	assert.ok(sampleAnalysisTarget(quiet, 2_000) > 0.015);
});

test("相近冲击幅度越过旧强拍阈值时保持连续", () => {
	let previous = null;
	for (let peak = 0.7; peak <= 1; peak += 0.005) {
		const analysis = pulses({ peak });
		const value = sampleStrongBeatTarget(analysis, 2_000);
		if (previous !== null) {
			assert.ok(value >= previous - 1e-9);
			assert.ok(value - previous < 0.025, `${peak}: ${previous} -> ${value}`);
		}
		previous = value;
	}
});

test("密集真实鼓点逐次保留，以连续幅度预算限制旋转堆积", () => {
	const slow = pulses({ period: 500, count: 20 });
	const fast = pulses({ period: 125, count: 20 });
	const slowEvents = getRhythmImpactEvents(slow);
	const fastEvents = getRhythmImpactEvents(fast);
	assert.equal(fastEvents.length, 20);
	assert.ok(fastEvents.every((event) => event.strength > 0.1));
	assert.ok(fastEvents[8].strength < slowEvents[8].strength);
	assert.ok(fastEvents[8].strength > slowEvents[8].strength * 0.25);
});

test("事件与随机跳转、采样顺序和帧率无关，分析数据保持不变", () => {
	const analysis = pulses();
	const original = JSON.stringify(analysis);
	const times = Array.from({ length: 40 }, (_, index) => 790 + index * 71);
	const expected = new Map(
		times.map((timeMs) => [
			timeMs,
			[
				sampleAnalysisTarget(analysis, timeMs),
				sampleStrongBeatTarget(analysis, timeMs),
			],
		]),
	);
	for (const fps of [60, 120, 240]) {
		const clone = structuredClone(analysis);
		for (let timeMs = 0; timeMs < 4_000; timeMs += 1_000 / fps)
			sampleStrongBeatTarget(clone, timeMs);
		for (const timeMs of [...times].reverse()) {
			assert.deepEqual(
				[
					sampleAnalysisTarget(clone, timeMs),
					sampleStrongBeatTarget(clone, timeMs),
				],
				expected.get(timeMs),
			);
		}
	}
	assert.equal(JSON.stringify(analysis), original);
	assert.equal(sampleStrongBeatTarget(analysis, Number.NaN), 0);
});

test("缺少绝对频带的旧缓存使用兼容路径；缺少瞬态的当前缓存不伪造重拍", () => {
	const legacy = pulses();
	legacy.onsets = legacy.onsets.map(({ bandLevels, ...onset }) => onset);
	assert.equal(getRhythmImpactEvents(legacy), null);
	assert.ok(Number.isFinite(sampleStrongBeatTarget(legacy, 1_000)));
	const modern = pulses();
	modern.energyEnvelope = [];
	assert.deepEqual(getRhythmImpactEvents(modern), []);
	assert.equal(sampleStrongBeatTarget(modern, 1_000), 0);
});

test("Shots 2:16–2:31 的同类低音不因半速拍格和 116ms 偏移交替漏检", () => {
	const analysis = fixtures["half-time-bass"].analysis;
	const times = [
		136290, 136777, 137288, 137787, 138286, 138786, 139285, 139784, 140283,
		140783, 141282, 141781, 142280, 142780, 143279, 143778, 144289, 144776,
		145287, 145798, 146286, 146785, 147284, 147783, 148283, 148782, 149281,
		149780,
	];
	const values = times.map((timeMs) =>
		sampleStrongBeatTarget(analysis, timeMs),
	);
	assert.ok(
		values.every((value) => value > 0.7),
		`${values}`,
	);
	assert.ok(Math.max(...values.slice(1)) - Math.min(...values.slice(1)) < 0.12);
	assert.ok(
		sampleStrongBeatTarget(analysis, 150779) < 0.1,
		"真实低音下降被稳定逻辑拖住",
	);
	for (const timeMs of [137787, 139784, 141781, 145798, 147783, 149780]) {
		assert.ok(
			sampleAnalysisTarget(analysis, timeMs) > 0.75,
			`${timeMs}: 呼吸没有同步到真实低音`,
		);
	}
});

test("真实安静前奏保持克制，电子与快速片段有独立于 BPM 的敲击响应", () => {
	const quiet = fixtures["quiet-intro"].analysis;
	assert.ok(eventsIn(quiet, 0, 9_000).every((event) => event.strength < 0.08));
	assert.ok(sampleAnalysisTarget(quiet, 1_126) > 0.02);
	for (const name of ["electronic-attacks", "fast-segment"]) {
		const {
			analysis,
			window: [start, end],
		} = fixtures[name];
		const events = eventsIn(analysis, start, end).filter(
			(event) => event.strength > 0.15,
		);
		assert.ok(events.length >= 4, `${name}: ${events.length}`);
		assert.ok(events.every((event) => event.strength <= 1));
		const noGrid = {
			...analysis,
			beats: [],
			globalBpm: null,
			tempoSegments: [],
		};
		assert.deepEqual(
			getRhythmImpactEvents(noGrid),
			getRhythmImpactEvents(analysis),
		);
	}
});

test("高频大幅起伏叠加稳定低音时，不把帽片连续升级为低音冲量", () => {
	for (const initialBassAttack of [false, true]) {
		const analysis = pulses({ period: 100, count: 20 });
		analysis.onsets = analysis.onsets.map((onset, index) => ({
			...onset,
			bands:
				initialBassAttack && index === 0
					? [1, 0.8, 0.1, 0, 0]
					: [0, 0, 0.9, 0.9, 1],
			bandLevels:
				initialBassAttack && index === 0
					? [0.8, 0.16, 0.1, 0.3, 0.6]
					: [0.6, 0.12, 0.1, 0.3, 0.6],
		}));
		const events = getRhythmImpactEvents(analysis);
		assert.equal(events.length, initialBassAttack ? 1 : 0);
		if (initialBassAttack) assert.equal(events[0].timeMs, 1_000);
		assert.equal(sampleStrongBeatTarget(analysis, 1_200), 0);
	}
});

test("同一能量峰附近的微弱起音不会抢占强起音并被放大至满幅", () => {
	for (const weakStrength of [0.05, 0.1, 0.2]) {
		const analysis = pulses({ count: 1 });
		const onset = analysis.onsets[0];
		analysis.onsets = [
			{ ...onset, timeMs: 900, strength: 0.95 },
			{ ...onset, timeMs: 940, strength: weakStrength },
		];
		analysis.energyEnvelope = analysis.energyEnvelope.map(({ timeMs }) => ({
			timeMs,
			value: 0.2 + 0.8 * Math.exp(-0.5 * ((timeMs - 1_020) / 35) ** 2),
		}));
		const events = getRhythmImpactEvents(analysis);
		assert.equal(events.length, 1);
		assert.equal(events[0].timeMs, 900, `weak strength=${weakStrength}`);
	}
	const weakOnly = pulses({ count: 1 });
	weakOnly.onsets[0].strength = 0.05;
	assert.ok(sampleStrongBeatTarget(weakOnly, 1_000) < 0.1);
});

test("绝对频带部分缺失或损坏时整份缓存回退，真实零电平不会误触发降级", () => {
	for (const bandLevels of [
		undefined,
		[0.6, 0.12],
		[0.6, 0.12, 0, 0, Number.NaN],
	]) {
		const analysis = pulses({ count: 2, beatOffset: 0 });
		analysis.onsets[1].bandLevels = bandLevels;
		assert.equal(getRhythmImpactEvents(analysis), null);
		assert.ok(Number.isFinite(sampleStrongBeatTarget(analysis, 1_500)));
	}
	const withSilence = pulses({ count: 2 });
	withSilence.onsets[1].bandLevels = [0, 0, 0, 0, 0];
	assert.equal(getRhythmImpactEvents(withSilence).length, 1);
	const allSilence = pulses({ count: 2 });
	for (const onset of allSilence.onsets) onset.bandLevels = [0, 0, 0, 0, 0];
	assert.deepEqual(getRhythmImpactEvents(allSilence), []);
	assert.equal(sampleStrongBeatTarget(allSilence, 1_000), 0);
});

test("单个宽能量峰上的细小波动不会生成一串可见重拍", () => {
	for (const jitter of [
		[0.02, -0.02, 0.015, -0.015],
		[0.1, -0.05, 0.05, -0.02],
	]) {
		const analysis = pulses({ count: 1 });
		analysis.onsets = Array.from({ length: 10 }, (_, index) => ({
			...analysis.onsets[0],
			timeMs: 900 + 50 * index,
		}));
		analysis.energyEnvelope = analysis.energyEnvelope.map(
			({ timeMs }, index) => ({
				timeMs,
				value: Math.min(
					1,
					0.2 +
						0.8 * Math.exp(-0.5 * ((timeMs - 1_150) / 140) ** 2) +
						(timeMs >= 900 && timeMs <= 1_400 ? jitter[index % 4] : 0),
				),
			}),
		);
		const visible = getRhythmImpactEvents(analysis).filter(
			(event) => event.strength > 0.05,
		);
		assert.ok(visible.length <= 1, `宽峰被拆成 ${visible.length} 个可见重拍`);
		assert.ok(
			sampleAnalysisTarget(analysis, 1_150) > 0.1,
			"宽峰应仍有普通呼吸",
		);
	}
});
