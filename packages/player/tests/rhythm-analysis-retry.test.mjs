import assert from "node:assert/strict";
import test from "node:test";
import {
	classifyRhythmAnalysisRetry,
	RhythmAnalysisRetryController,
} from "../src/components/LocalMusicContext/rhythm-analysis-retry.ts";

class FakeTimer {
	now = 0;
	nextId = 1;
	tasks = new Map();

	setTimeout(callback, delayMs) {
		const id = this.nextId++;
		this.tasks.set(id, {
			callback,
			dueAt: this.now + delayMs,
		});
		return id;
	}

	clearTimeout(handle) {
		this.tasks.delete(handle);
	}

	advanceBy(delayMs) {
		const target = this.now + delayMs;
		while (true) {
			const next = [...this.tasks.entries()]
				.filter(([, task]) => task.dueAt <= target)
				.sort(
					([leftId, left], [rightId, right]) =>
						left.dueAt - right.dueAt || leftId - rightId,
				)[0];
			if (!next) break;
			const [id, task] = next;
			this.tasks.delete(id);
			this.now = task.dueAt;
			task.callback();
		}
		this.now = target;
	}
}

const firstSong = { musicId: "song-a", generation: 3 };

test("解码器占用和请求被替代使用更充分但有限的快速退避", () => {
	assert.equal(classifyRhythmAnalysisRetry("DECODER_BUSY"), "transient");
	assert.equal(
		classifyRhythmAnalysisRetry(
			new Error("Rhythm analysis request was superseded by a newer song"),
		),
		"transient",
	);

	const timer = new FakeTimer();
	const controller = new RhythmAnalysisRetryController(timer);
	const observedDelays = [];
	let retryCount = 0;
	controller.begin(firstSong);

	for (const expectedDelay of [200, 500, 1_000, 2_000, 4_000]) {
		const schedule = controller.scheduleFailure(
			firstSong,
			"DECODER_BUSY",
			() => {
				retryCount += 1;
			},
		);
		assert.ok(schedule);
		observedDelays.push(schedule.delayMs);
		timer.advanceBy(expectedDelay);
	}

	assert.deepEqual(observedDelays, [200, 500, 1_000, 2_000, 4_000]);
	assert.equal(retryCount, 5);
	assert.equal(
		controller.scheduleFailure(firstSong, "DECODER_BUSY", () => {}),
		null,
		"临时错误也必须有总次数上限",
	);
});

test("普通分析错误只重试两次", () => {
	const timer = new FakeTimer();
	const controller = new RhythmAnalysisRetryController(timer);
	const observedDelays = [];
	controller.begin(firstSong);

	for (const expectedDelay of [750, 2_000]) {
		const schedule = controller.scheduleFailure(
			firstSong,
			new Error("broken file"),
			() => {},
		);
		assert.ok(schedule);
		observedDelays.push(schedule.delayMs);
		timer.advanceBy(expectedDelay);
	}

	assert.deepEqual(observedDelays, [750, 2_000]);
	assert.equal(
		controller.scheduleFailure(firstSong, new Error("broken file"), () => {}),
		null,
	);
});

test("切歌会取消旧曲定时器且旧 generation 不能重新排队", () => {
	const timer = new FakeTimer();
	const controller = new RhythmAnalysisRetryController(timer);
	let retryCount = 0;
	controller.begin(firstSong);
	controller.scheduleFailure(firstSong, "DECODER_BUSY", () => {
		retryCount += 1;
	});

	const secondSong = { musicId: "song-b", generation: 4 };
	controller.begin(secondSong);
	timer.advanceBy(5_000);

	assert.equal(retryCount, 0);
	assert.equal(controller.isCurrent(firstSong), false);
	assert.equal(
		controller.scheduleFailure(firstSong, "DECODER_BUSY", () => {}),
		null,
	);
	assert.equal(controller.isCurrent(secondSong), true);
});

test("成功会清除待执行重试并重置失败计数", () => {
	const timer = new FakeTimer();
	const controller = new RhythmAnalysisRetryController(timer);
	let retryCount = 0;
	controller.begin(firstSong);
	controller.scheduleFailure(firstSong, new Error("temporary I/O"), () => {
		retryCount += 1;
	});

	controller.succeed(firstSong);
	timer.advanceBy(5_000);
	assert.equal(retryCount, 0);

	const schedule = controller.scheduleFailure(
		firstSong,
		new Error("temporary I/O"),
		() => {},
	);
	assert.equal(schedule?.retryNumber, 1);
	assert.equal(schedule?.delayMs, 750);
});
