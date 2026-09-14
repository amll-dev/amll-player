import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const readProjectFile = (path) =>
	readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

function sliceSource(source, startMarker, endMarker) {
	const start = source.indexOf(startMarker);
	assert.notEqual(start, -1);
	const end = source.indexOf(endMarker, start);
	assert.notEqual(end, -1);
	return source.slice(start, end).replaceAll("\r\n", "\n");
}

class FakeClassList {
	values = new Set();

	add(...names) {
		for (const name of names) this.values.add(name);
	}

	remove(...names) {
		for (const name of names) this.values.delete(name);
	}

	contains(name) {
		return this.values.has(name);
	}
}

class FakeElement {
	attributes = new Map();
	children = [];
	classList = new FakeClassList();
	clientHeight = 0;
	clientWidth = 0;
	dataset = {};
	style = {
		opacity: "",
		setProperty() {},
	};

	appendChild(child) {
		this.children.push(child);
		return child;
	}

	addEventListener() {}
	removeEventListener() {}
	remove() {}
	click() {}

	contains(target) {
		return target === this || this.children.includes(target);
	}

	setAttribute(name, value) {
		this.attributes.set(name, value);
	}

	getAttribute(name) {
		return this.attributes.get(name) ?? null;
	}
}

function installFakeDom() {
	globalThis.document = {
		createElement: () => new FakeElement(),
	};
	globalThis.window = {
		addEventListener() {},
		removeEventListener() {},
		devicePixelRatio: 1,
		innerWidth: 1920,
	};
	globalThis.ResizeObserver = class {
		observe() {}
		disconnect() {}
	};
	globalThis.MouseEvent = class {};
	globalThis.CSS = { supports: () => false };
	globalThis.getComputedStyle = () => ({
		fontSize: "24px",
		marginLeft: "0px",
		marginRight: "0px",
	});
}

function parseAnimationSample(dots) {
	const style = dots.element.getAttribute("style") ?? "";
	const scale = Number(style.match(/scale\(([-\d.]+)\)/)?.[1]);
	const spread = Number(
		style.match(/--amll-lp-interlude-dot-spread:([-\d.]+)em/)?.[1],
	);
	return {
		opacities: [dots.dot0, dots.dot1, dots.dot2].map((dot) =>
			Number(dot.style.opacity),
		),
		scale,
		spread,
	};
}

test("间奏点呼吸后短暂停顿，并在下一句入场时完成聚拢", async () => {
	installFakeDom();
	const { LyricPlayer } = await import("@applemusic-like-lyrics/core");
	const player = new LyricPlayer(new FakeElement());
	const dots = player.interludeDots;
	const sampleAt = (time) => {
		dots.setInterlude([0, 6000]);
		dots.update(time);
		return parseAnimationSample(dots);
	};

	const compact = sampleAt(Math.PI * 1500);
	const expanded = sampleAt(Math.PI * 750);
	assert.ok(expanded.scale > compact.scale);
	assert.ok(expanded.spread > compact.spread + 0.1);
	assert.ok(Math.abs(compact.scale - 0.63175) < 1e-10);
	assert.ok(Math.abs(expanded.scale - 0.735) < 1e-10);

	const exitStart = sampleAt(5430);
	const exitExpanded = sampleAt(5890);
	const exitHeld = sampleAt(5940);
	const exitHoldEnd = sampleAt(5990);
	const exitCollapseStart = sampleAt(5991);
	const originalInterludeEnd = sampleAt(6000);
	const exitConverging = sampleAt(6120);
	const beforeLyricMoves = sampleAt(6240);
	const lyricMoveStart = sampleAt(6250);
	const afterLyricMoves = sampleAt(6251);
	const expansionSamples = Array.from({ length: 24 }, (_, index) =>
		sampleAt(5430 + index * 20),
	);
	const collapseSamples = Array.from({ length: 14 }, (_, index) =>
		sampleAt(5990 + index * 20),
	);
	for (let index = 1; index < expansionSamples.length; index += 1) {
		assert.ok(
			expansionSamples[index].spread >= expansionSamples[index - 1].spread,
		);
		assert.ok(
			expansionSamples[index].scale >= expansionSamples[index - 1].scale,
		);
	}
	for (let index = 1; index < collapseSamples.length; index += 1) {
		assert.ok(
			collapseSamples[index].spread <= collapseSamples[index - 1].spread,
		);
		assert.ok(collapseSamples[index].scale <= collapseSamples[index - 1].scale);
	}
	assert.equal(exitExpanded.spread, 0.192);
	assert.ok(Math.abs(exitExpanded.scale - exitStart.scale * 1.05) < 1e-10);
	assert.equal(exitHeld.spread, exitExpanded.spread);
	assert.equal(exitHeld.scale, exitExpanded.scale);
	assert.equal(exitHoldEnd.spread, exitExpanded.spread);
	assert.equal(exitHoldEnd.scale, exitExpanded.scale);
	assert.deepEqual(exitHoldEnd.opacities, exitExpanded.opacities);
	assert.ok(exitCollapseStart.scale < exitHoldEnd.scale);
	assert.ok(exitCollapseStart.opacities[0] < exitHoldEnd.opacities[0]);
	assert.ok(originalInterludeEnd.spread < exitHoldEnd.spread);
	assert.ok(originalInterludeEnd.scale > 0);
	assert.ok(exitConverging.spread < exitExpanded.spread);
	assert.ok(exitConverging.scale < exitExpanded.scale);
	assert.ok(beforeLyricMoves.scale > 0);
	assert.equal(lyricMoveStart.spread, -0.09);
	assert.equal(lyricMoveStart.scale, 0);
	assert.deepEqual(lyricMoveStart.opacities, [0, 0, 0]);
	assert.equal(afterLyricMoves.spread, -0.09);
	assert.equal(afterLyricMoves.scale, 0);
	assert.deepEqual(afterLyricMoves.opacities, [0, 0, 0]);

	player.dispose();
});

test("暂停且尚未起播时隐藏首句前间奏，播放后仍保留正常间奏", async () => {
	installFakeDom();
	const { LyricPlayer } = await import("@applemusic-like-lyrics/core");
	const player = new LyricPlayer(new FakeElement());
	const makeGroup = (startTime, endTime) => ({
		startTime,
		endTime,
		mainLine: {
			getLine: () => ({ isDuet: false }),
			pause() {},
			resume() {},
		},
		posY: { updateParams() {} },
		bgSlideY: { updateParams() {} },
		setTransform() {},
		dispose() {},
	});
	player.pause();
	player.disableSpring = true;
	player.timelineState.initialLayoutFinished = true;
	player.timelineState.currentTime = 0;
	player.timelineState.scrollToIndex = 0;
	player.currentLyricGroups = [
		makeGroup(10000, 11000),
		makeGroup(20000, 21000),
	];
	player.bottomLine.setFocused = () => {};
	player.bottomLine.setTransform = () => {};

	await player.calcLayout(true);
	assert.equal(player.interludeDots.currentInterlude, undefined);
	assert.equal(
		player.interludeDots.element.classList.contains("FmKaba_enabled"),
		false,
	);

	player.resume();
	await player.calcLayout(true);
	assert.deepEqual(player.interludeDots.currentInterlude, [20, 9750]);

	player.pause();
	player.timelineState.currentTime = 5000;
	await player.calcLayout(true);
	assert.deepEqual(player.interludeDots.currentInterlude, [5020, 9750]);

	player.dispose();
});

test("Core 补丁、ESM、CJS 与样式保留同一套间奏退场和衔接参数", () => {
	const patch = readProjectFile(
		"../../../patches/@applemusic-like-lyrics__core@0.5.2.patch",
	);
	const esm = readProjectFile(
		"../node_modules/@applemusic-like-lyrics/core/dist/amll-core.mjs",
	);
	const cjs = readProjectFile(
		"../node_modules/@applemusic-like-lyrics/core/dist/amll-core.cjs",
	);
	const style = readProjectFile(
		"../node_modules/@applemusic-like-lyrics/core/dist/style.css",
	);
	const patchCjs = sliceSource(
		patch,
		"diff --git a/dist/amll-core.cjs",
		"diff --git a/dist/amll-core.d.cts",
	);
	const patchEsm = sliceSource(
		patch,
		"diff --git a/dist/amll-core.mjs",
		"diff --git a/dist/style.css",
	);
	const esmInterlude = sliceSource(
		esm,
		"function smoothInterludeStep",
		"\n\tdispose()",
	);
	const cjsInterlude = sliceSource(
		cjs,
		"function smoothInterludeStep",
		"\n\tdispose()",
	);
	assert.equal(esmInterlude, cjsInterlude);

	for (const source of [patchCjs, patchEsm, esm, cjs]) {
		assert.match(source, /function getInterludeBreatheAmount/);
		assert.match(source, /return \(Math\.sin\(1\.5 \* Math\.PI/);
		assert.match(
			source,
			/const shouldHideInitialInterlude = !this\.timelineState\.isPlaying && this\.timelineState\.currentTime <= 0/,
		);
		assert.match(source, /let scale = \.9025 \+ breatheAmount \* \.1475/);
		assert.match(source, /let dotSpread = -\.03 \+ breatheAmount \* \.11/);
		assert.match(source, /currentDuration <= interludeDuration \+ 250/);
		assert.match(
			source,
			/const expansionDuration = 460, holdDuration = 100, collapseDuration = 260/,
		);
		assert.match(
			source,
			/const exitDuration = expansionDuration \+ holdDuration \+ collapseDuration/,
		);
		assert.match(source, /if \(remainingDuration < exitDuration\)/);
		assert.match(source, /if \(remainingDuration < collapseDuration\)/);
		assert.match(
			source,
			/const expansion = smoothInterludeStep\(\(exitDuration - remainingDuration\) \/ expansionDuration\)/,
		);
		assert.match(
			source,
			/const exitStartScale = \.9025 \+ exitStartBreatheAmount \* \.1475/,
		);
		assert.match(
			source,
			/scale = exitStartScale \* \(1 \+ expansion \* \.05\)/,
		);
		assert.match(source, /dotSpread = \.192 \+ \(-\.09 - \.192\) \* collapse/);
	}
	for (const source of [esm, cjs]) {
		assert.match(
			source,
			/const gapEnd = Math\.max\(gapStart, nextGroup\.startTime - 250\)/,
		);
	}
	for (const source of [patch, style]) {
		assert.match(source, /--amll-lp-interlude-dot-spread/);
		assert.match(source, /> :first-child/);
		assert.match(source, /> :last-child/);
	}
	assert.match(patch, /diff --git a\/dist\/amll-core\.cjs/);
	assert.match(patch, /diff --git a\/dist\/amll-core\.mjs/);
	assert.match(patch, /diff --git a\/dist\/style\.css/);
});
