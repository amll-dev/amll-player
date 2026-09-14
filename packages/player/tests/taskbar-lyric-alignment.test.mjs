import assert from "node:assert/strict";
import test from "node:test";
import {
	formatEm,
	getCenteredLineStackOffsetEm,
	TASKBAR_LINE_HEIGHT_EM,
} from "../src/pages/taskbar-lyric/line-layout.ts";

test("任务栏双行曲目信息按实际缩放后的可见高度居中", () => {
	const offset = getCenteredLineStackOffsetEm([1, 0.85]);
	assert.ok(Math.abs(offset - 0.09) < Number.EPSILON);
	assert.equal(formatEm(offset), "0.09em");
	assert.equal(formatEm(TASKBAR_LINE_HEIGHT_EM + offset), "1.29em");
});

test("任务栏双行歌词与仅有一行歌词都对齐封面中心", () => {
	const twoLineOffset = getCenteredLineStackOffsetEm([1, 0.8]);
	const oneLineOffset = getCenteredLineStackOffsetEm([1]);

	assert.ok(Math.abs(twoLineOffset - 0.12) < Number.EPSILON);
	assert.equal(formatEm(TASKBAR_LINE_HEIGHT_EM + twoLineOffset), "1.32em");
	assert.equal(oneLineOffset, 0.6);
	assert.equal(formatEm(oneLineOffset), "0.6em");
});
