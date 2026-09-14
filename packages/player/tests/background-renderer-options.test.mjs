import assert from "node:assert/strict";
import test from "node:test";
import { resolveBackgroundRendererOptions as resolve } from "../src/utils/background-renderer-options.ts";

const globals = Object.freeze({
	fps: 60,
	animationIntensity: 1,
	renderScale: 1,
	staticMode: false,
	cssBackground: "#111111",
});
const custom = Object.freeze({
	fps: 144,
	animationIntensity: 0,
	renderScale: 0.5,
	staticMode: true,
	cssBackground: "linear-gradient(red, blue)",
});
const override = Object.freeze({
	songId: "a",
	overrideEnabled: true,
	rendererMode: "mesh",
	rendererOptions: custom,
});

test("each renderer uses song options without mutating global settings", () => {
	for (const rendererMode of ["mesh", "pixi", "css-bg", "video"]) {
		assert.deepEqual(
			resolve(globals, { ...override, rendererMode }, "a", true),
			custom,
		);
	}
	assert.equal(globals.animationIntensity, 1);
});

test("disabled experiments, disabled overrides and stale song queries restore globals immediately", () => {
	for (const [row, id, enabled] of [
		[override, "a", false],
		[override, "b", true],
		[override, "", true],
		[null, "a", true],
		[{ ...override, overrideEnabled: false }, "a", true],
	]) {
		assert.equal(resolve(globals, row, id, enabled), globals);
	}
});

test("legacy rows inherit live globals until options are saved", () => {
	for (const rendererOptions of [null, undefined]) {
		assert.equal(
			resolve(globals, { ...override, rendererOptions }, "a", true),
			globals,
		);
	}
	const changedGlobals = { ...globals, fps: 30, cssBackground: "blue" };
	assert.deepEqual(resolve(changedGlobals, override, "a", true), custom);
});

test("invalid stored properties fall back individually, preserving valid zero and false", () => {
	const rendererOptions = {
		fps: 0,
		animationIntensity: Infinity,
		renderScale: 11,
		staticMode: "yes",
		cssBackground: "  ",
	};
	assert.deepEqual(
		resolve(globals, { ...override, rendererOptions }, "a", true),
		globals,
	);
	assert.equal(
		resolve(
			globals,
			{ ...override, rendererOptions: { ...custom, fps: 60.5 } },
			"a",
			true,
		).fps,
		60,
	);
	assert.equal(
		resolve(
			globals,
			{ ...override, rendererOptions: { ...custom, staticMode: false } },
			"a",
			true,
		).staticMode,
		false,
	);
});
