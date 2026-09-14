import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { atom, createStore } from "jotai";
import { DEFAULT_HOME_BACKGROUND_CONFIG } from "../src/utils/home-background-state.ts";

const enabledAtom = atom(false);
globalThis.__experimentalBackgroundTestAtom = enabledAtom;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (
			specifier === "./appAtoms.ts" &&
			context.parentURL?.endsWith("/states/homeBackgroundAtoms.ts")
		) {
			return {
				url: "data:text/javascript,export const enableExperimentalFeaturesAtom = globalThis.__experimentalBackgroundTestAtom;",
				shortCircuit: true,
			};
		}
		return nextResolve(specifier, context);
	},
});
const { effectiveHomeBackgroundConfigAtom, homeBackgroundConfigAtom } =
	await import("../src/states/homeBackgroundAtoms.ts");

test("实验功能关闭时忽略已保存背景，重新开启恢复且不改写配置", () => {
	for (const mode of ["color", "image", "video"]) {
		const store = createStore();
		const saved = {
			mode,
			color: "#123456",
			assetId: "saved-asset",
			filePath: "C:/appdata/saved-asset",
			mimeType: "video/mp4",
			bytes: 123,
			updatedAt: 100,
		};
		store.set(homeBackgroundConfigAtom, saved);
		assert.equal(
			store.get(effectiveHomeBackgroundConfigAtom),
			DEFAULT_HOME_BACKGROUND_CONFIG,
		);
		store.set(enabledAtom, true);
		assert.equal(store.get(effectiveHomeBackgroundConfigAtom), saved);
		store.set(enabledAtom, false);
		assert.equal(
			store.get(effectiveHomeBackgroundConfigAtom),
			DEFAULT_HOME_BACKGROUND_CONFIG,
		);
		assert.equal(store.get(homeBackgroundConfigAtom), saved);
		store.set(enabledAtom, true);
		assert.equal(store.get(effectiveHomeBackgroundConfigAtom), saved);
	}
});

test("关闭期间迟到的背景加载结果不影响画面和主题", () => {
	const store = createStore();
	const unsubscribe = store.sub(effectiveHomeBackgroundConfigAtom, () => {
		assert.fail("disabled configuration should not update visual consumers");
	});
	store.set(homeBackgroundConfigAtom, {
		...DEFAULT_HOME_BACKGROUND_CONFIG,
		mode: "color",
		color: "#ff0000",
	});
	assert.equal(
		store.get(effectiveHomeBackgroundConfigAtom),
		DEFAULT_HOME_BACKGROUND_CONFIG,
	);
	unsubscribe();
});

test("首页画面、应用主题、原生主题和队列背景统一读取有效配置", () => {
	for (const file of [
		"../src/App.tsx",
		"../src/components/HomeBackground/index.tsx",
		"../src/components/ThemeManager/index.tsx",
		"../src/components/NowPlayingBar/index.tsx",
	]) {
		const source = readFileSync(new URL(file, import.meta.url), "utf8");
		assert.match(
			source,
			/useAtomValue\(effectiveHomeBackgroundConfigAtom\)/,
			file,
		);
		assert.doesNotMatch(
			source,
			/useAtomValue\(homeBackgroundConfigAtom\)/,
			file,
		);
	}
});
