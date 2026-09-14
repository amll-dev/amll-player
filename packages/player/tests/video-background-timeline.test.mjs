import assert from "node:assert/strict";
import test from "node:test";
import {
	circularVideoDriftMs,
	clamp,
	isVideoTimeInSegment,
	normalizeVideoSegment,
	positiveModulo,
	resolveVideoTimeMs,
} from "../src/components/SongVideoBackground/timeline.ts";

test("基础钳制与正模运算覆盖端点、负数和无效输入", () => {
	assert.equal(clamp(-1, 0, 10), 0);
	assert.equal(clamp(5, 0, 10), 5);
	assert.equal(clamp(11, 0, 10), 10);
	assert.equal(clamp(Number.NEGATIVE_INFINITY, 0, 10), 0);
	assert.equal(clamp(Number.POSITIVE_INFINITY, 0, 10), 10);
	assert.ok(Number.isNaN(clamp(Number.NaN, 0, 10)));

	assert.equal(positiveModulo(0, 3_000), 0);
	assert.equal(positiveModulo(6_001, 3_000), 1);
	assert.equal(positiveModulo(-1, 3_000), 2_999);
	assert.equal(positiveModulo(-6_001, 3_000), 2_999);
	for (const [value, divisor] of [
		[Number.NaN, 3_000],
		[Number.POSITIVE_INFINITY, 3_000],
		[1, Number.NaN],
		[1, Number.POSITIVE_INFINITY],
		[1, 0],
		[1, -1],
	]) {
		assert.equal(positiveModulo(value, divisor), 0);
	}
});

test("循环时间映射支持精确出点、负时间和多周期偏移", () => {
	const segment = { inPointMs: 2_000, outPointMs: 5_000, loopEnabled: true };
	assert.equal(resolveVideoTimeMs(2_000, segment), 2_000);
	assert.equal(resolveVideoTimeMs(5_000, segment), 2_000);
	assert.equal(resolveVideoTimeMs(5_001, segment), 2_001);
	assert.equal(resolveVideoTimeMs(6_250, segment), 3_250);
	assert.equal(resolveVideoTimeMs(-250, segment), 2_750);
	assert.equal(resolveVideoTimeMs(14_250, segment), 2_250);
	assert.equal(resolveVideoTimeMs(Number.NaN, segment), 2_000);
});

test("非循环片段钳制在首帧和出点前 16ms 的最后一帧", () => {
	const segment = { inPointMs: 1_000, outPointMs: 4_000, loopEnabled: false };
	assert.equal(resolveVideoTimeMs(0, segment), 1_000);
	assert.equal(resolveVideoTimeMs(1_000, segment), 1_000);
	assert.equal(resolveVideoTimeMs(2_500, segment), 2_500);
	assert.equal(resolveVideoTimeMs(4_000, segment), 3_984);
	assert.equal(resolveVideoTimeMs(4_500, segment), 3_984);
	assert.equal(resolveVideoTimeMs(Number.NEGATIVE_INFINITY, segment), 1_000);
	assert.equal(resolveVideoTimeMs(Number.POSITIVE_INFINITY, segment), 3_984);
	assert.ok(Number.isNaN(resolveVideoTimeMs(Number.NaN, segment)));

	for (const invalidSegment of [
		{ inPointMs: 900, outPointMs: 900, loopEnabled: false },
		{ inPointMs: 900, outPointMs: 800, loopEnabled: true },
	]) {
		assert.equal(resolveVideoTimeMs(2_000, invalidSegment), 900);
	}
});

test("片段边界判定把精确出点、非有限值和循环同相越界视为越界", () => {
	const segment = { inPointMs: 1_000, outPointMs: 5_000, loopEnabled: true };
	assert.equal(isVideoTimeInSegment(999.999, segment), false);
	assert.equal(isVideoTimeInSegment(1_000, segment), true);
	assert.equal(isVideoTimeInSegment(4_999.999, segment), true);
	assert.equal(isVideoTimeInSegment(5_000, segment), false);
	assert.equal(isVideoTimeInSegment(Number.NaN, segment), false);
	assert.equal(isVideoTimeInSegment(Number.POSITIVE_INFINITY, segment), false);

	// 循环漂移只比较相位；调用方仍必须用边界判定触发硬校正。
	assert.equal(circularVideoDriftMs(5_100, 1_100, segment), 0);
	assert.equal(isVideoTimeInSegment(5_100, segment), false);
});

test("配置归一化拒绝非有限值、反向范围和短于 100ms 的片段", () => {
	const validSegment = {
		inPointMs: 500,
		outPointMs: 1_500,
		loopEnabled: false,
	};
	for (const durationMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(normalizeVideoSegment(validSegment, durationMs), null);
	}
	for (const segment of [
		{ inPointMs: Number.NaN, outPointMs: 1_000, loopEnabled: false },
		{ inPointMs: 0, outPointMs: Number.POSITIVE_INFINITY, loopEnabled: true },
		{ inPointMs: 900, outPointMs: 800, loopEnabled: false },
		{ inPointMs: 500, outPointMs: 599, loopEnabled: false },
	]) {
		assert.equal(normalizeVideoSegment(segment, 10_000), null);
	}

	assert.deepEqual(
		normalizeVideoSegment(
			{ inPointMs: 500.49, outPointMs: 599.5, loopEnabled: false },
			10_000,
		),
		{ inPointMs: 500, outPointMs: 600, loopEnabled: false },
	);
});

test("配置归一化钳制到媒体时长并保留循环策略", () => {
	assert.deepEqual(
		normalizeVideoSegment(
			{ inPointMs: -50, outPointMs: 20_000, loopEnabled: true },
			10_000,
		),
		{ inPointMs: 0, outPointMs: 10_000, loopEnabled: true },
	);
	assert.deepEqual(
		normalizeVideoSegment(
			{ inPointMs: 100.4, outPointMs: 2_999.6, loopEnabled: false },
			3_000,
		),
		{ inPointMs: 100, outPointMs: 3_000, loopEnabled: false },
	);
});

test("短视频只有达到 100ms 最小片段后才能归一化", () => {
	assert.equal(
		normalizeVideoSegment(
			{ inPointMs: 0, outPointMs: 500, loopEnabled: true },
			99,
		),
		null,
	);
	assert.deepEqual(
		normalizeVideoSegment(
			{ inPointMs: -20, outPointMs: 500, loopEnabled: true },
			100,
		),
		{ inPointMs: 0, outPointMs: 100, loopEnabled: true },
	);
});

test("关闭 seek 同步时以音乐和视频锚点连续推进，不回到歌曲绝对时间", () => {
	const segment = { inPointMs: 2_000, outPointMs: 8_000, loopEnabled: true };
	const anchor = { musicMs: 30_000, videoMs: 6_500 };
	const targetFromAnchor = (musicMs) =>
		resolveVideoTimeMs(anchor.videoMs + (musicMs - anchor.musicMs), segment);

	assert.equal(targetFromAnchor(30_000), 6_500);
	assert.equal(targetFromAnchor(30_250), 6_750);
	assert.equal(targetFromAnchor(31_500), 2_000);
	assert.equal(targetFromAnchor(29_000), 5_500);
});

test("漂移计算区分线性片段并为循环片段选择最短方向", () => {
	const segment = { inPointMs: 1_000, outPointMs: 5_000, loopEnabled: true };
	assert.equal(circularVideoDriftMs(4_950, 1_050, segment), 100);
	assert.equal(circularVideoDriftMs(1_050, 4_950, segment), -100);
	assert.equal(circularVideoDriftMs(1_000, 3_000, segment), 2_000);
	assert.equal(
		circularVideoDriftMs(4_000, 1_000, { ...segment, loopEnabled: false }),
		-3_000,
	);
	assert.equal(
		circularVideoDriftMs(1_000, 2_000, {
			inPointMs: 1_000,
			outPointMs: 1_000,
			loopEnabled: true,
		}),
		0,
	);
	assert.equal(circularVideoDriftMs(Number.NaN, 2_000, segment), 0);
});
