import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getFullscreenControlMotion } from "../src/components/AMLLWrapper/fullscreen-control-motion.ts";
import { calculateFullscreenPlaylistPlacement } from "../src/components/AMLLWrapper/fullscreen-playlist-position.ts";

const readProjectFile = (path) =>
	readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const wrapper = readProjectFile("../src/components/AMLLWrapper/index.tsx");
const wrapperStyle = readProjectFile(
	"../src/components/AMLLWrapper/index.module.css",
);
const nowPlayingBar = readProjectFile(
	"../src/components/NowPlayingBar/index.tsx",
);
const reactFullPatch = readProjectFile(
	"../../../patches/@applemusic-like-lyrics__react-full@0.4.2.patch",
);
const installedReactFull = readProjectFile(
	"../node_modules/@applemusic-like-lyrics/react-full/dist/amll-react-framework.mjs",
);
test("全屏切换按钮只重启自身动画且不取消依赖组件动画", () => {
	for (const source of [reactFullPatch, installedReactFull]) {
		assert.match(source, /data-amll-toggle-type/);
	}
	assert.match(wrapper, /FULLSCREEN_ANIMATED_CONTROL_SELECTOR/);
	assert.match(wrapper, /new WeakMap/);
	assert.match(wrapper, /getComputedStyle\(button\)\.transform/);
	assert.match(wrapper, /button\.animate\(keyframes/);
	assert.doesNotMatch(wrapper, /\.getAnimations\(\)/);
	assert.doesNotMatch(wrapper, /icon\.animate/);
	assert.match(wrapper, /prefers-reduced-motion: reduce/);
});

test("随机、循环、歌词和队列按钮使用克制的独立反馈", () => {
	for (const source of [reactFullPatch, installedReactFull]) {
		assert.match(source, /data-amll-media-action[^\n]+shuffle/);
		assert.match(source, /data-amll-media-action[^\n]+repeat/);
	}
	const shuffle = getFullscreenControlMotion("shuffle");
	const repeat = getFullscreenControlMotion("repeat");
	const lyrics = getFullscreenControlMotion(undefined, "lyrics");
	const playlist = getFullscreenControlMotion(undefined, "playlist");
	assert.equal(shuffle?.duration, 230);
	assert.equal(repeat?.duration, 250);
	assert.equal(lyrics?.duration, 210);
	assert.equal(playlist?.duration, 190);
	assert.equal(getFullscreenControlMotion(undefined, "airplay"), null);
	assert.equal(getFullscreenControlMotion(undefined, "star"), null);
	const serialized = JSON.stringify([shuffle, repeat, lyrics, playlist]);
	assert.doesNotMatch(serialized, /360deg|scale\(0\.[0-8]|scale\(1\.0[2-9]/);
	assert.match(wrapperStyle, /opacity 0\.18s ease/);
});

test("全屏队列按钮接入现有播放队列并显示在全屏层内", () => {
	const dismissLayerRule =
		wrapperStyle.match(
			/\.fullscreenPlaylistDismissLayer\s*\{[\s\S]*?\}/,
		)?.[0] ?? "";
	const panelRule =
		wrapperStyle.match(/\.fullscreenPlaylistPanel\s*\{[\s\S]*?\}/)?.[0] ?? "";

	assert.match(wrapper, /FULLSCREEN_PLAYLIST_TOGGLE_SELECTOR/);
	assert.match(wrapper, /setPlaylistOpened\(\(opened\) => !opened\)/);
	assert.match(wrapper, /<NowPlaylistCard/);
	assert.match(wrapper, /id="fullscreen-now-playlist-card"/);
	assert.match(wrapper, /data-amll-playlist-panel=""/);
	assert.match(wrapper, /aria-expanded/);
	assert.match(wrapperStyle, /\.fullscreenPlaylistPanel/);
	assert.match(wrapper, /fullscreenPlaylistPanelRef/);
	assert.match(wrapper, /ResizeObserver\(schedulePlacement\)/);
	assert.match(wrapperStyle, /--amll-fullscreen-playlist-bottom/);
	assert.match(wrapperStyle, /--amll-fullscreen-playlist-max-height/);
	assert.match(wrapperStyle, /data-amll-playlist-opened="true"/);
	assert.match(dismissLayerRule, /background:\s*rgb\(0 0 0 \/ 0\.16\)/);
	assert.doesNotMatch(dismissLayerRule, /backdrop-filter/);
	assert.match(panelRule, /isolation:\s*isolate/);
	assert.match(panelRule, /background-color:\s*transparent/);
	assert.doesNotMatch(panelRule, /backdrop-filter/);
	assert.match(wrapper, /fullscreenPlaylistSnapshotSupported/);
	assert.match(wrapper, /fullscreenPlaylistSurfaceReady/);
	assert.match(wrapper, /fullscreenPlaylistPanelSnapshot/);
	assert.match(wrapper, /fullscreenPlaylistPanelLive/);
	assert.match(
		wrapperStyle,
		/\.fullscreenPlaylistPanelSnapshot\s*\{[\s\S]*background-color:\s*var\(--gray-2\)/,
	);
	assert.match(
		wrapperStyle,
		/\.fullscreenPlaylistPanelLive\s*\{[\s\S]*backdrop-filter:\s*blur\(18px\)/,
	);
	assert.match(wrapper, /<PlaylistSnapshotBackdrop/);
	assert.match(wrapper, /variant="fullscreen"/);
	assert.match(
		wrapperStyle,
		/\.cursorHiddenOverlay\s*\{[\s\S]*pointer-events:\s*none/,
	);
	assert.match(
		nowPlayingBar,
		/playlistOpened\s*&&\s*!isLyricPageOpened/,
		"全屏打开时不应在底栏后方重复渲染队列",
	);
	assert.match(nowPlayingBar, /!playlistOpened \|\| isLyricPageOpened/);
	assert.match(nowPlayingBar, /data-amll-playlist-panel/);
});

test("全屏队列始终锚定在可见按钮上方并限制可用高度", () => {
	const container = {
		left: 0,
		top: 0,
		right: 1200,
		bottom: 800,
		width: 1200,
		height: 800,
	};
	const horizontalTrigger = {
		left: 1080,
		top: 720,
		right: 1128,
		bottom: 768,
		width: 48,
		height: 48,
	};
	const horizontal = calculateFullscreenPlaylistPlacement(
		container,
		horizontalTrigger,
		400,
		12,
		12,
	);
	assert.equal(container.bottom - horizontal.bottom, 708);
	assert.equal(
		horizontalTrigger.top - (container.bottom - horizontal.bottom),
		12,
	);
	assert.equal(horizontal.maxHeight, 696);
	assert.equal(horizontal.left, 728);

	const verticalTrigger = {
		left: 80,
		top: 520,
		right: 128,
		bottom: 568,
		width: 48,
		height: 48,
	};
	const vertical = calculateFullscreenPlaylistPlacement(
		container,
		verticalTrigger,
		400,
		12,
		32,
	);
	assert.equal(vertical.left, 12, "面板不应越过左侧安全区");
	assert.equal(vertical.maxHeight, 476);
	assert.equal(verticalTrigger.top - (container.bottom - vertical.bottom), 12);
});
