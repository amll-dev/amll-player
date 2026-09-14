import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	getQueueAutoScrollSpeed,
	getQueueDragShift,
	getQueueDropIndex,
	QUEUE_DRAG_THRESHOLD_PX,
} from "../src/components/NowPlaylistCard/queue-drag.ts";
import { getPlaylistUnderlayClip } from "../src/components/PlaylistSnapshotBackdrop/underlay-clip.ts";

const readProjectFile = (path) =>
	readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const app = readProjectFile("../src/App.tsx");
const queueCard = readProjectFile(
	"../src/components/NowPlaylistCard/index.tsx",
);
const queueCardStyle = readProjectFile(
	"../src/components/NowPlaylistCard/index.module.css",
);
const nowPlayingBar = readProjectFile(
	"../src/components/NowPlayingBar/index.tsx",
);
const nowPlayingBarStyle = readProjectFile(
	"../src/components/NowPlayingBar/index.module.css",
);
const playlistSnapshotBackdrop = readProjectFile(
	"../src/components/PlaylistSnapshotBackdrop/index.tsx",
);
const playlistSnapshotBackdropStyle = readProjectFile(
	"../src/components/PlaylistSnapshotBackdrop/index.module.css",
);
const appContainerStyle = readProjectFile(
	"../src/components/AppContainer/index.module.css",
);
const appContainer = readProjectFile(
	"../src/components/AppContainer/index.tsx",
);
const nativePlaylistUnderlay = readProjectFile(
	"../src/components/PlaylistSnapshotBackdrop/useNativePlaylistUnderlay.ts",
);
const settingsPage = readProjectFile("../src/pages/settings/index.tsx");
const settingsPageStyle = readProjectFile(
	"../src/pages/settings/index.module.css",
);

test("设置页保持在普通播放队列的播放栏层级之下", () => {
	const settingsLayer = Number(
		settingsPage.match(/position:\s*"fixed"[\s\S]*?zIndex:\s*(\d+)/)?.[1],
	);
	const playbarLayer = Number(
		appContainerStyle.match(/\.playbar\s*\{[\s\S]*?z-index:\s*(\d+)/)?.[1],
	);

	assert.ok(Number.isFinite(settingsLayer), "未找到设置页层级");
	assert.ok(Number.isFinite(playbarLayer), "未找到播放栏层级");
	assert.ok(
		settingsLayer < playbarLayer,
		`设置页层级 ${settingsLayer} 必须低于播放栏层级 ${playbarLayer}`,
	);
});

test("设置页底边跟随真实播放栏高度而不是固定留出八十像素", () => {
	assert.match(
		settingsPage,
		/bottom:\s*[\r\n\t ]*"var\(--amll-player-playbar-bottom,\s*calc\(100px \+ env\(safe-area-inset-bottom\)\)\)"/,
	);
	assert.doesNotMatch(settingsPage, /bottom:\s*"80px"/);
	assert.match(
		settingsPageStyle,
		/\.dialogContent\s*\{[\s\S]*?bottom:\s*var\([\s\S]*?--amll-player-playbar-bottom,[\s\S]*?calc\(100px \+ env\(safe-area-inset-bottom\)\)[\s\S]*?\);/,
	);
});

test("队列行单击即可播放且当前歌曲有明确状态", () => {
	assert.match(queueCard, /onClick=\{onPlay\}/);
	assert.match(queueCard, /queueManager\?\.playAt\(virtualItem\.index\)/);
	assert.doesNotMatch(queueCard, /onDoubleClick/);
	assert.match(queueCard, /aria-current=\{isCurrent \? "true" : undefined\}/);
	assert.match(queueCard, /data-current=\{isCurrent \? "true" : "false"\}/);
	assert.match(queueCard, /role="list"/);
	assert.match(queueCard, /role="listitem"/);
	assert.match(queueCard, /aria-posinset=\{virtualItem\.index \+ 1\}/);
	assert.match(queueCard, /aria-setsize=\{playlist\.length\}/);
	assert.match(queueCardStyle, /\.playlistSongItem\.current\s*\{/);
	assert.match(queueCardStyle, /border-left-color:\s*var\(--accent-9\)/);
});

test("Windows 队列弹层统一使用打开前快照并遮住未模糊的页面", () => {
	const rootRule = queueCardStyle.match(/\.root\s*\{[\s\S]*?\}/)?.[0] ?? "";
	const panelRule =
		nowPlayingBarStyle.match(/\.playlistPanel\s*\{[\s\S]*?\}/)?.[0] ?? "";
	const snapshotPanelRule =
		nowPlayingBarStyle.match(/\.playlistPanelSnapshot\s*\{[\s\S]*?\}/)?.[0] ??
		"";
	const livePanelRule =
		nowPlayingBarStyle.match(/\.playlistPanelLive\s*\{[\s\S]*?\}/)?.[0] ?? "";
	const currentRule =
		queueCardStyle.match(/\.playlistSongItem\.current\s*\{[\s\S]*?\}/)?.[0] ??
		"";

	assert.match(rootRule, /background-color:\s*transparent/);
	assert.doesNotMatch(rootRule, /backdrop-filter/);
	assert.match(panelRule, /isolation:\s*isolate/);
	assert.match(panelRule, /background-color:\s*transparent/);
	assert.doesNotMatch(panelRule, /backdrop-filter/);
	assert.match(snapshotPanelRule, /background-color:\s*var\(--gray-2\)/);
	assert.doesNotMatch(nowPlayingBarStyle, /\.playlistPanelNative/);
	assert.match(
		playlistSnapshotBackdropStyle,
		/\.root\s*\{[\s\S]*background:\s*var\(--gray-2\)/,
	);
	assert.match(livePanelRule, /background-color:\s*color-mix/);
	assert.match(livePanelRule, /backdrop-filter:\s*blur\(14px\)/);
	assert.match(
		playlistSnapshotBackdrop,
		/invoke<string>\("take_screenshot",\s*\{[\s\S]*resizeWindow:\s*false[\s\S]*recoverSize:\s*false/,
	);
	assert.match(playlistSnapshotBackdrop, /waitForUnobscuredFrame\(\)/);
	assert.match(playlistSnapshotBackdrop, /waitForTransientPlayerMotion\(\)/);
	assert.match(playlistSnapshotBackdrop, /beginCaptureGuard\(\)/);
	assert.match(
		playlistSnapshotBackdrop,
		/withTimeout\([\s\S]*SNAPSHOT_CAPTURE_TIMEOUT_MS/,
	);
	assert.match(
		playlistSnapshotBackdrop,
		/placementObserver\.observe\(document\.body,[\s\S]*attributeFilter:\s*\["style"\]/,
	);
	assert.match(
		playlistSnapshotBackdropStyle,
		/html\[data-amll-playlist-capturing\][\s\S]*data-amll-playlist-panel/,
	);
	assert.match(
		playlistSnapshotBackdrop,
		/await withTimeout\(decodeSnapshot\(source\), SNAPSHOT_CAPTURE_TIMEOUT_MS\)/,
	);
	assert.match(
		playlistSnapshotBackdropStyle,
		/filter:\s*blur\(var\(--playlist-snapshot-blur\)\)[\s\S]*brightness\(var\(--playlist-snapshot-brightness\)\)/,
	);
	assert.match(
		playlistSnapshotBackdropStyle,
		/\.root\[data-variant="compact"\][\s\S]*--playlist-snapshot-blur:\s*clamp\(10px,\s*1\.6vh,\s*16px\)[\s\S]*--playlist-snapshot-brightness:\s*0\.74[\s\S]*--playlist-snapshot-saturation:\s*1\.22[\s\S]*--playlist-snapshot-scale:\s*1\.06[\s\S]*--playlist-snapshot-tint:\s*30%/,
	);
	assert.match(
		playlistSnapshotBackdropStyle,
		/--playlist-snapshot-blur:\s*26px[\s\S]*--playlist-snapshot-brightness:\s*0\.72[\s\S]*--playlist-snapshot-saturation:\s*1\.15[\s\S]*--playlist-snapshot-tint:\s*46%[\s\S]*saturate\(var\(--playlist-snapshot-saturation\)\)/,
	);
	assert.match(currentRule, /background-color:\s*var\(--accent-4\)/);
	assert.doesNotMatch(currentRule, /--accent-a3/);
});

test("普通队列挂载到播放栏合成边界之外并保留主题上下文", () => {
	assert.match(app, /data-amll-player-overlay-root=""/);
	assert.match(nowPlayingBar, /createPortal/);
	assert.match(
		nowPlayingBar,
		/closest<HTMLElement>\("\[data-amll-player-overlay-root\]"\)/,
	);
	assert.match(nowPlayingBar, /position="fixed"/);
	assert.match(nowPlayingBar, /homeBackgroundLoadedAtom/);
	assert.match(nowPlayingBar, /useNativeHomeMaterial/);
	assert.match(nowPlayingBar, /playlistSnapshotSupported/);
	assert.match(nowPlayingBar, /usePlaylistSnapshot/);
	assert.match(
		nowPlayingBar,
		/!playlistSnapshotSupported \|\| playlistBackdrop\.isReady/,
	);
	assert.match(nowPlayingBar, /homeBackgroundConfig\.updatedAt/);
	assert.match(
		nowPlayingBar,
		/homeBackgroundConfig\.updatedAt\}:\$\{isDarkTheme\}/,
	);
	assert.match(
		nowPlayingBar,
		/playlistSnapshotSupported\s*\? styles\.playlistPanelSnapshot\s*: styles\.playlistPanelLive/,
	);
	assert.match(nowPlayingBar, /styles\.playlistPanelSnapshot/);
	assert.match(nowPlayingBar, /styles\.playlistPanelLive/);
	assert.match(nowPlayingBar, /<PlaylistSnapshotBackdrop/);
	assert.match(appContainerStyle, /\.playbar\s*\{[\s\S]*?isolation:\s*isolate/);
});

test("默认 Windows 材质保留透明快照并只裁切其下方的页面", () => {
	assert.match(appContainer, /data-amll-player-main=""/);
	assert.match(
		nowPlayingBar,
		/const useNativeHomeMaterial =[\s\S]*playlistSnapshotSupported &&[\s\S]*!hasBackground &&[\s\S]*!isCustomHomeBackground\(homeBackgroundConfig\)/,
	);
	assert.match(
		nowPlayingBar,
		/useNativePlaylistUnderlay\([\s\S]*playlistSurfaceReady &&[\s\S]*useNativeHomeMaterial &&[\s\S]*playlistBackdrop\.source !== null/,
	);
	assert.match(
		nowPlayingBarStyle,
		/\.playlistPanelSnapshot\[data-amll-playlist-native-surface\]\s*\{[^}]*background-color:\s*transparent/,
	);
	assert.match(
		playlistSnapshotBackdropStyle,
		/\[data-amll-playlist-native-surface\]\) > \.root\s*\{\s*background:\s*transparent/,
	);
	assert.match(nativePlaylistUnderlay, /CSS\.supports\("clip-path", clip\)/);
	assert.match(nativePlaylistUnderlay, /resizeObserver\.observe\(panel\)/);
	assert.match(nativePlaylistUnderlay, /underlay\.contains\(panel\)/);
	assert.match(
		nativePlaylistUnderlay,
		/delete panel\.dataset\.amllPlaylistNativeSurface/,
	);
	assert.match(
		appContainerStyle,
		/html\[data-amll-playlist-capturing\]\) \.main\s*\{[^}]*clip-path:\s*none/,
	);
});

test("圆角裁切使用页面局部坐标并保留整个页面外框", () => {
	const clip = getPlaylistUnderlayClip(
		{ left: 20, top: 30, width: 900, height: 700 },
		{ left: 520, top: 50, width: 380, height: 640 },
		8,
	);
	assert.match(clip, /^path\(evenodd, "M 0 0 H 900 V 700 H 0 Z /);
	assert.match(clip, /M 508 20 H 872 A 8 8 0 0 1 880 28/);
	assert.match(clip, /V 652 A 8 8 0 0 1 872 660/);
	assert.match(clip, /H 508 A 8 8 0 0 1 500 652/);
});

test("无效或超出页面的裁切保持不透明回退", () => {
	const page = { left: 0, top: 0, width: 900, height: 700 };
	const panel = { left: 500, top: 20, width: 380, height: 640 };
	for (const invalid of [
		{ ...panel, left: -1 },
		{ ...panel, top: -1 },
		{ ...panel, left: 600 },
		{ ...panel, height: 800 },
		{ ...panel, width: 0 },
		{ ...panel, left: Number.NaN },
	]) {
		assert.equal(getPlaylistUnderlayClip(page, invalid, 8), null);
	}
	assert.equal(getPlaylistUnderlayClip({ ...page, height: 0 }, panel, 8), null);
	assert.equal(getPlaylistUnderlayClip(page, panel, Number.NaN), null);
});

test("裁切圆角不会超过较短边的一半", () => {
	const clip = getPlaylistUnderlayClip(
		{ left: 0, top: 0, width: 900, height: 700 },
		{ left: 500.5, top: 20.5, width: 20, height: 100 },
		40,
	);
	assert.match(clip, /M 510\.5 20\.5 H 510\.5 A 10 10 0 0 1 520\.5 30\.5/);
});

test("队列弹层只保留逐项移除并通过整行拖动调整顺序", () => {
	assert.match(queueCard, /queueManager\?\.removeSong\(song\.id\)/);
	assert.match(
		queueCard,
		/beginQueueDrag\(event, song\.id, virtualItem\.index\)/,
	);
	assert.match(
		queueCard,
		/captureTarget\.setPointerCapture\(event\.pointerId\)/,
	);
	assert.match(queueCard, /viewport\.setPointerCapture\(event\.pointerId\)/);
	assert.match(queueCard, /QUEUE_DRAG_THRESHOLD_PX/);
	assert.match(queueCard, /getQueueDropIndex/);
	assert.match(queueCard, /getQueueDragShift/);
	assert.match(queueCard, /getQueueAutoScrollSpeed/);
	assert.match(queueCard, /queueManager\.moveSong\(fromIndex, toIndex\)/);
	assert.match(queueCard, /queueManager\?\.clearUpcoming\(\)/);
	assert.match(queueCard, /playbar\.playlist\.removeSong/);
	assert.match(queueCard, /data-queue-action/);
	assert.match(
		queueCard,
		/onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/,
	);
	assert.doesNotMatch(queueCard, /SpeakerLoudIcon/);
	assert.doesNotMatch(queueCard, /ChevronUpIcon/);
	assert.doesNotMatch(queueCard, /ChevronDownIcon/);
	assert.doesNotMatch(queueCard, /disabled=\{index === 0\}/);
});

test("拖动排序保留稳定身份、平滑反馈和安全取消", () => {
	assert.match(queueCard, /itemIds: playlistRef\.current\.map/);
	assert.match(queueCard, /playlist\[index\]\?\.id !== songId/);
	assert.match(queueCard, /suppressedClickSongIdRef/);
	assert.match(queueCard, /activeDragRef\.current/);
	assert.match(queueCard, /className=\{styles\.dragOverlay\}/);
	assert.match(queueCard, /className=\{classNames\([\s\S]*styles\.rowMotion/);
	assert.match(queueCard, /style=\{\{ y: overlayY \}\}/);
	assert.match(queueCard, /requestAnimationFrame\(scrollAtEdge\)/);
	assert.match(queueCard, /event\.key !== "Escape"/);
	assert.match(queueCard, /cancelQueueDrag/);
	assert.match(queueCard, /event\.altKey/);
	assert.match(queueCard, /"Alt\+ArrowUp Alt\+ArrowDown"/);
	assert.match(queueCard, /event\.target === event\.currentTarget/);
	assert.match(queueCard, /flushSync/);
	assert.match(queueCard, /getItemKey: getPlaylistItemKey/);
	assert.match(
		queueCard,
		/<div\s+key=\{virtualItem\.key\}[\s\S]*transform: `translateY\(\$\{virtualItem\.start \+ dragShift\}px\)`/,
	);
	assert.doesNotMatch(queueCard, /rowMotionGeneration/);
	assert.doesNotMatch(queueCard, /key=\{`\$\{song\.id\}:\$\{/);
	assert.match(queueCardStyle, /\.dragOverlay[\s\S]*pointer-events:\s*none/);
	assert.match(queueCardStyle, /\.dragSource\s*\{[\s\S]*opacity:\s*0/);
	assert.match(
		queueCardStyle,
		/\.playlistSongItem\.dragOverlayItem\s*\{[\s\S]*background-color:\s*var\(--gray-a4\)/,
	);
	assert.match(
		queueCardStyle,
		/\.playlistSongItem\.dragOverlayItem\.current\s*\{[\s\S]*background-color:\s*var\(--accent-a4\)/,
	);
	assert.match(queueCardStyle, /@media \(prefers-reduced-motion: reduce\)/);
});

test("拖动卡片保留背景透色且不显示正在播放的蓝色边线", () => {
	assert.match(
		queueCard,
		/className=\{styles\.dragOverlay\}[\s\S]*initial=\{false\}[\s\S]*animate=\{\{ opacity: 1 \}\}/,
	);
	assert.doesNotMatch(queueCard, /scale:\s*1\.015/);
	assert.match(
		queueCardStyle,
		/\.playlistSongItem\.dragOverlayItem\s*\{[^}]*backdrop-filter:\s*blur\(12px\)/,
	);
	assert.match(
		queueCardStyle,
		/\.playlistSongItem\.dragOverlayItem\s*\{[\s\S]*border-left-color:\s*transparent/,
	);
});

test("松手采用最终指针坐标并在提交前再次核对整个队列", () => {
	assert.match(
		queueCard,
		/finishQueueDrag\(event\.pointerId, false, event\.clientY\)/,
	);
	assert.match(
		queueCard,
		/updateDragPosition\(pointerClientY\);[\s\S]*const droppingDrag/,
	);
	assert.match(
		queueCard,
		/const currentPlaylist =\s*queueManager\?\.getPlayList\(\) \?\? playlistRef\.current/,
	);
	assert.match(
		queueCard,
		/currentPlaylist\.length !== droppingDrag\.itemCount/,
	);
	assert.match(
		queueCard,
		/droppingDrag\.itemIds\.some\([\s\S]*currentPlaylist\[index\]\?\.id !== songId/,
	);
	assert.match(
		queueCard,
		/!activeDrag\.dropping &&\s*!prefersReducedMotion &&\s*styles\.queueRowShifting/,
	);
	assert.doesNotMatch(queueCard, /animate=\{\{ y: virtualItem\.start/);
});

test("拖动卡片松手落位后保留短暂淡出动画", () => {
	assert.match(queueCard, /AnimatePresence/);
	assert.match(queueCard, /QUEUE_DROP_EXIT_DURATION_SECONDS = 0\.12/);
	assert.match(queueCard, /exit=\{\{ opacity: 0 \}\}/);
	assert.match(queueCard, /dropExitActiveRef\.current = !prefersReducedMotion/);
	assert.match(
		queueCard,
		/activeDragRef\.current \|\|\s*dropExitActiveRef\.current/,
	);
	assert.match(
		queueCard,
		/onExitComplete=\{\(\) => \{[\s\S]*dropExitActiveRef\.current = false/,
	);
});

test("拖动松手后等待真实鼠标移动再恢复悬停颜色", () => {
	assert.match(queueCard, /candidate\.captureTarget\.blur\(\)/);
	assert.match(queueCard, /suppressHoverRef\.current = true/);
	assert.match(
		queueCard,
		/if \(!candidate\) \{[\s\S]*suppressHoverRef\.current = false[\s\S]*setSuppressHover\(false\)/,
	);
	assert.match(queueCard, /suppressHover && styles\.suppressHover/);
	assert.match(
		queueCardStyle,
		/\.queueViewport\.suppressHover[\s\S]*\.playlistSongItem:not\(\.current\):not\(\.dragOverlayItem\)[\s\S]*background-color:\s*transparent/,
	);
});

test("拖动目标按固定行高计算并限制在队列范围内", () => {
	assert.equal(QUEUE_DRAG_THRESHOLD_PX, 6);
	assert.equal(getQueueDropIndex(0, -100, 0, 36, 72, 5), 0);
	assert.equal(getQueueDropIndex(0, 100, 0, 36, 72, 5), 1);
	assert.equal(getQueueDropIndex(144, 36, 0, 36, 72, 5), 2);
	assert.equal(getQueueDropIndex(0, 1_000, 0, 36, 72, 5), 4);
	assert.equal(getQueueDropIndex(0, 100, 0, 36, 72, 0), -1);
});

test("拖动跨行时只让被跨过的相邻歌曲让位", () => {
	assert.equal(getQueueDragShift(1, 1, 3, 72), 0);
	assert.equal(getQueueDragShift(2, 1, 3, 72), -72);
	assert.equal(getQueueDragShift(3, 1, 3, 72), -72);
	assert.equal(getQueueDragShift(4, 1, 3, 72), 0);
	assert.equal(getQueueDragShift(1, 3, 1, 72), 72);
	assert.equal(getQueueDragShift(2, 3, 1, 72), 72);
	assert.equal(getQueueDragShift(3, 3, 1, 72), 0);
});

test("队列重排只改变当前索引时不会强制滚回正在播放项", () => {
	assert.match(queueCard, /lastAutoScrolledSongIdRef/);
	assert.match(
		queueCard,
		/lastAutoScrolledSongIdRef\.current === currentSongId/,
	);
	assert.match(
		queueCard,
		/lastAutoScrolledSongIdRef\.current = currentSongId;[\s\S]*rowVirtualizer\.scrollToIndex\(playlistIndex, \{ align: "auto" \}\)/,
	);
	assert.doesNotMatch(queueCard, /scrollToIndex\([^\n]+align: "center"/);
});

test("拖到可视区边缘时按距离连续调节自动滚动速度", () => {
	assert.equal(getQueueAutoScrollSpeed(100, 100, 400), -16);
	assert.equal(getQueueAutoScrollSpeed(124, 100, 400), -8);
	assert.equal(getQueueAutoScrollSpeed(250, 100, 400), 0);
	assert.equal(getQueueAutoScrollSpeed(376, 100, 400), 8);
	assert.equal(getQueueAutoScrollSpeed(400, 100, 400), 16);
});

test("虚拟列表估算行高与实际行盒保持一致", () => {
	const rowHeight = queueCard.match(/NOW_PLAYLIST_ROW_HEIGHT = (\d+)/)?.[1];
	assert.equal(rowHeight, "72");
	assert.match(queueCard, /estimateSize:\s*\(\) => NOW_PLAYLIST_ROW_HEIGHT/);
	assert.match(
		queueCard,
		/const getPlaylistItemKey = useCallback\([\s\S]*playlist\[index\]\?\.id \?\? index[\s\S]*\[playlist\]/,
	);
	assert.doesNotMatch(queueCard, /measureElement/);
	assert.match(queueCard, /data-index=\{virtualItem\.index\}/);
	assert.match(queueCard, /height: `\$\{NOW_PLAYLIST_ROW_HEIGHT\}px`/);
	assert.match(queueCardStyle, /\.queueRowSlot[\s\S]*box-sizing:\s*border-box/);
	assert.match(queueCardStyle, /\.playlistSongItem[\s\S]*height:\s*100%/);
});

test("播放队列按歌曲数量延展并只在接近播放栏时滚动", () => {
	assert.match(queueCardStyle, /\.root\s*\{[\s\S]*height:\s*auto/);
	assert.match(
		queueCardStyle,
		/max-height:\s*calc\([\s\S]*100dvh[\s\S]*--amll-player-playbar-bottom/,
	);
	assert.match(
		queueCardStyle,
		/max-height:\s*calc\([\s\S]*--system-titlebar-height,\s*0px/,
	);
	assert.match(queueCardStyle, /\.queueViewport\s*\{[\s\S]*flex:\s*0 1 auto/);
	assert.doesNotMatch(queueCardStyle, /height:\s*min\(500px,\s*50vh\)/);
});

test("播放队列封面与卡片左边缘保留足够间距", () => {
	assert.match(
		queueCardStyle,
		/\.playlistSongItem\s*\{[\s\S]*padding-inline-start:\s*var\(--space-3\)/,
	);
});

test("标题展示队列计数并覆盖空队列和待播数量", () => {
	assert.match(queueCard, /playbar\.playlist\.count/);
	assert.match(queueCard, /playlist\.length === 0/);
	assert.match(queueCard, /playbar\.playlist\.emptyTitle/);
	assert.match(queueCard, /playbar\.playlist\.clearUpcomingLabel/);
});

test("播放队列新增文案在所有内置语言中都有翻译", () => {
	const requiredKeys = [
		"clearUpcoming",
		"clearUpcomingLabel",
		"close",
		"count",
		"current",
		"emptyHint",
		"emptyTitle",
		"moveDown",
		"moveUp",
		"open",
		"playSong",
		"queueLabel",
		"removeSong",
		"replaySong",
		"title",
		"unknownArtist",
		"unknownSong",
	];
	for (const locale of ["en-US", "ja-JP", "vi-VN", "zh-CN", "zh-TW"]) {
		const messages = JSON.parse(
			readProjectFile(`../locales/${locale}/translation.json`),
		).playbar.playlist;
		for (const key of requiredKeys) {
			assert.equal(
				typeof messages[key],
				"string",
				`${locale} 缺少 playbar.playlist.${key}`,
			);
			assert.notEqual(messages[key].length, 0);
		}
	}
});

test("Esc 和外部指针关闭弹层且内部交互不会被当作外部点击", () => {
	assert.match(
		nowPlayingBar,
		/playlistPanelRef\.current\?\.contains\(target\)/,
	);
	assert.match(
		nowPlayingBar,
		/playlistDismissLayerRef\.current\?\.contains\(target\)/,
	);
	assert.match(
		nowPlayingBar,
		/playlistToggleButtonRef\.current\?\.contains\(target\)/,
	);
	assert.match(nowPlayingBar, /className=\{styles\.playlistDismissLayer\}/);
	assert.match(
		nowPlayingBar,
		/onPointerDown=\{\(event\) => event\.preventDefault\(\)\}/,
	);
	assert.match(nowPlayingBar, /event\.stopPropagation\(\)/);
	assert.match(nowPlayingBar, /event\.key !== "Escape"/);
	assert.match(
		nowPlayingBar,
		/document\.addEventListener\("pointerdown", handlePointerDown, true\)/,
	);
	assert.match(
		nowPlayingBar,
		/document\.addEventListener\("keydown", handleKeyDown, true\)/,
	);
	assert.match(nowPlayingBar, /aria-expanded=\{playlistOpened\}/);
	assert.match(nowPlayingBar, /aria-controls="now-playlist-card"/);
	assert.match(nowPlayingBar, /aria-haspopup="dialog"/);
	assert.match(queueCard, /autoFocus/);
	assert.match(queueCard, /onRequestClose/);
});
