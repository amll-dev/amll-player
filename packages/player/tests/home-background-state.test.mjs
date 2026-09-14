import assert from "node:assert/strict";
import test from "node:test";

import {
	DEFAULT_HOME_BACKGROUND_CONFIG,
	isCustomHomeBackground,
	normalizeHomeBackgroundColor,
	normalizeHomeBackgroundConfig,
} from "../src/utils/home-background-state.ts";

test("home background defaults preserve the current window style", () => {
	assert.equal(DEFAULT_HOME_BACKGROUND_CONFIG.mode, "default");
	assert.equal(isCustomHomeBackground(DEFAULT_HOME_BACKGROUND_CONFIG), false);
	assert.deepEqual(
		normalizeHomeBackgroundConfig(null),
		DEFAULT_HOME_BACKGROUND_CONFIG,
	);
	assert.deepEqual(
		normalizeHomeBackgroundConfig({ mode: "unknown" }),
		DEFAULT_HOME_BACKGROUND_CONFIG,
	);
});

test("home background colors are normalized to opaque hex values", () => {
	assert.equal(normalizeHomeBackgroundColor(" #A1b2C3 "), "#a1b2c3");
	assert.equal(normalizeHomeBackgroundColor("transparent"), "#111111");
	assert.equal(normalizeHomeBackgroundColor("#1234"), "#111111");
});

test("asset modes require both an application asset id and path", () => {
	assert.equal(
		normalizeHomeBackgroundConfig({
			mode: "image",
			assetId: "asset.png",
			filePath: "C:/appdata/asset.png",
			mimeType: "image/png",
			bytes: 16,
			updatedAt: 4,
		}).mode,
		"image",
	);
	assert.equal(
		normalizeHomeBackgroundConfig({
			mode: "video",
			assetId: "asset.mp4",
		}).mode,
		"default",
	);
});

test("non-asset modes cannot retain stale asset references", () => {
	const normalized = normalizeHomeBackgroundConfig({
		mode: "color",
		color: "#102030",
		assetId: "stale.mp4",
		filePath: "C:/stale.mp4",
		mimeType: "video/mp4",
		bytes: 100,
		updatedAt: 8,
	});
	assert.equal(isCustomHomeBackground(normalized), true);
	assert.equal(normalized.color, "#102030");
	assert.equal(normalized.assetId, null);
	assert.equal(normalized.filePath, null);
});
