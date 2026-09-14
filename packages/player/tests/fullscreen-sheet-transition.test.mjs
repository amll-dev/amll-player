import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const readProjectFile = (path) =>
	readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const wrapper = readProjectFile("../src/components/AMLLWrapper/index.tsx");
const wrapperStyle = readProjectFile(
	"../src/components/AMLLWrapper/index.module.css",
);
const nowPlayingBar = readProjectFile(
	"../src/components/NowPlayingBar/index.tsx",
);
const nowPlayingBarStyle = readProjectFile(
	"../src/components/NowPlayingBar/index.module.css",
);
const app = readProjectFile("../src/App.tsx");
const appStyle = readProjectFile("../src/App.module.css");
const appContainer = readProjectFile(
	"../src/components/AppContainer/index.tsx",
);
const appContainerStyle = readProjectFile(
	"../src/components/AppContainer/index.module.css",
);
const reactFullPatch = readProjectFile(
	"../../../patches/@applemusic-like-lyrics__react-full@0.4.2.patch",
);
const installedReactFull = readProjectFile(
	"../node_modules/@applemusic-like-lyrics/react-full/dist/amll-react-framework.mjs",
);
test("底栏边界、底色与歌词内容由同一个播放面板承载", () => {
	assert.match(appStyle, /\.body\s*\{[\s\S]*height:\s*100dvh/);
	assert.doesNotMatch(appStyle, /height:\s*100vh/);
	assert.match(
		nowPlayingBar,
		/playbarEl\.closest<HTMLElement>\([\s\S]*data-amll-playbar-boundary/,
	);
	assert.match(
		nowPlayingBar,
		/"--amll-player-playbar-top",\s*`\$\{sheetTop\}px`/,
	);
	assert.match(
		nowPlayingBar,
		/getPropertyValue\([\s\S]*"--amll-player-separator-height"/,
	);
	assert.match(nowPlayingBar, /Math\.max\(0, top - separatorHeight\)/);
	assert.doesNotMatch(nowPlayingBar, /borderTopWidth/);
	assert.match(nowPlayingBar, /"--amll-player-playbar-height"/);
	assert.doesNotMatch(nowPlayingBar, /observer\.observe\(playbarBoundary\)/);
	assert.match(app, /playbarExpandedContent=\{[\s\S]*<AMLLWrapper \/>/);
	assert.match(
		appContainer,
		/data-amll-playbar-boundary=""[\s\S]*\{playbar\}[\s\S]*\{playbarExpandedContent\}/,
	);
	assert.match(
		appContainer,
		/data-amll-playbar-expanded=\{playbarExpanded \? "" : undefined\}/,
	);
	assert.match(
		appContainer,
		/className=\{styles\.main\}[\s\S]*inert=\{routeScrollLocked \? true : undefined\}/,
	);
	assert.match(
		appContainerStyle,
		/grid-template-rows:\s*minmax\(0, 1fr\) auto/,
	);
	assert.match(
		appContainerStyle,
		/\.playbar\s*\{[\s\S]*--amll-player-separator-height:\s*1px[\s\S]*z-index:\s*3[\s\S]*height:\s*var\([\s\S]*--amll-player-playbar-height[\s\S]*background-color:\s*var\([\s\S]*--color-panel-solid[\s\S]*rgb\(17 17 17 \/ 0\.78\)[\s\S]*height var\(--amll-fullscreen-sheet-duration\)[\s\S]*background-color 0\.18s 0\.24s ease-out[\s\S]*z-index 0s var\(--amll-fullscreen-sheet-duration\)/,
	);
	assert.doesNotMatch(appContainerStyle, /border-top:\s*solid 1px/);
	assert.match(
		appContainerStyle,
		/&::before\s*\{[\s\S]*height:\s*var\(--amll-player-separator-height\)[\s\S]*background-color:\s*var\(--gray-6\)[\s\S]*opacity:\s*1[\s\S]*pointer-events:\s*none[\s\S]*opacity 0\.08s 0\.42s ease-out/,
	);
	assert.match(
		appContainerStyle,
		/\.playbarExpanded\s*\{[\s\S]*z-index:\s*9999[\s\S]*height:\s*100dvh[\s\S]*background-color:\s*#111[\s\S]*background-color 0\.16s ease-out[\s\S]*z-index 0s[\s\S]*&::before\s*\{[\s\S]*opacity:\s*0/,
	);
	assert.match(
		appContainerStyle,
		/\.playbar\[data-amll-playbar-expanded\]\[data-amll-viewport-resizing\][\s\S]*transition:\s*none/,
	);
	assert.match(
		appContainerStyle,
		/:global\(#amll-lyric-player-wrapper \*\)[\s\S]*transition:\s*none !important;[\s\S]*animation:\s*none !important/,
	);
	assert.match(nowPlayingBar, /VIEWPORT_RESIZE_SETTLE_DELAY\s*=\s*120/);
	assert.match(
		nowPlayingBar,
		/handleViewportResize[\s\S]*data-amll-playbar-expanded[\s\S]*amllViewportResizing[\s\S]*window\.setTimeout[\s\S]*requestAnimationFrame[\s\S]*delete playbarBoundary\.dataset\.amllViewportResizing[\s\S]*VIEWPORT_RESIZE_SETTLE_DELAY/,
	);
	assert.match(
		nowPlayingBar,
		/window\.clearTimeout\(viewportResizeTimeout\)[\s\S]*cancelAnimationFrame\(viewportResizeFrame\)[\s\S]*cancelAnimationFrame\(secondViewportResizeFrame\)/,
	);
	assert.match(
		nowPlayingBar,
		/window\.addEventListener\("resize", handleViewportResize\)[\s\S]*visualViewport\?\.addEventListener\("resize", handleViewportResize\)/,
	);
	assert.match(
		nowPlayingBar,
		/if \(isLyricPageOpened\) return;[\s\S]*delete playbarBoundary\.dataset\.amllViewportResizing;[\s\S]*\[isLyricPageOpened\]/,
	);
	assert.match(
		wrapperStyle,
		/\.lyricPage\s*\{[\s\S]*position:\s*absolute[\s\S]*inset:\s*0/,
	);
	assert.doesNotMatch(wrapperStyle, /position:\s*fixed/);
	assert.doesNotMatch(wrapperStyle, /\.lyricPage\s*\{[^}]*border-top:/);
	assert.doesNotMatch(wrapperStyle, /\.lyricPage\s*\{[^}]*background-color:/);
	assert.doesNotMatch(wrapperStyle, /border-radius:\s*1em 1em 0 0/);
	assert.doesNotMatch(wrapperStyle, /border-radius 0\.24s/);
});

test("同一面板扩展时歌词内容与底栏文字都有可见的双向位移", () => {
	assert.match(wrapperStyle, /--amll-fullscreen-sheet-duration:\s*0\.5s/);
	assert.match(
		wrapperStyle,
		/--amll-fullscreen-sheet-easing:\s*cubic-bezier\(0\.25, 1, 0\.5, 1\)/,
	);
	assert.match(wrapperStyle, /\.lyricPage\s*\{[\s\S]*overflow:\s*hidden/);
	assert.match(wrapper, /className=\{styles\.lyricContent\}/);
	assert.match(wrapper, /data-amll-fullscreen-content=""/);
	assert.match(wrapper, /inert=\{isLyricPageOpened \? undefined : true\}/);
	assert.match(
		wrapper,
		/useLayoutEffect\(\(\) => \{[\s\S]*previousLyricPageOpenedRef\.current[\s\S]*setPlaylistOpened\(false\)/,
	);
	assert.match(
		wrapperStyle,
		/\.lyricContent\s*\{[\s\S]*position:\s*absolute[\s\S]*bottom:\s*0[\s\S]*height:\s*100dvh/,
	);
	assert.match(
		wrapperStyle,
		/\.lyricContent\s*\{[\s\S]*transform:\s*translateY\(var\(--amll-player-playbar-top, 100dvh\)\)[\s\S]*transition:\s*transform var\(--amll-fullscreen-sheet-duration\)[\s\S]*var\(--amll-fullscreen-sheet-easing\)/,
	);
	assert.match(
		wrapperStyle,
		/\.lyricPage\.opened \.lyricContent\s*\{[\s\S]*transform:\s*translateY\(0\)/,
	);
	assert.doesNotMatch(wrapperStyle, /backdrop-filter:\s*blur\(24px\)/);
	assert.match(app, /playbarExpanded=\{isLyricPageOpened\}/);
	assert.match(appContainer, /playbarExpanded && styles\.playbarExpanded/);
	assert.match(appContainer, /data-amll-playbar-boundary=""/);
	assert.match(nowPlayingBar, /data-amll-playbar-content=""/);
	assert.match(
		nowPlayingBar,
		/inert=\{isLyricPageOpened \? true : undefined\}/,
	);
	assert.match(nowPlayingBar, /isLyricPageOpened && styles\.lyricPageOpened/);
	const coverSource = nowPlayingBar.match(
		/<button\s+ref=\{coverButtonRef\}[\s\S]*?<\/button>/,
	)?.[0];
	assert.ok(coverSource);
	assert.doesNotMatch(coverSource, /data-amll-playbar-reveal/);
	assert.match(
		nowPlayingBarStyle,
		/\.playBar\s*\{[\s\S]*position:\s*absolute[\s\S]*bottom:\s*0[\s\S]*opacity:\s*1[\s\S]*opacity 0\.18s 0\.32s cubic-bezier\(0\.22, 1, 0\.36, 1\)/,
	);
	assert.match(
		nowPlayingBarStyle,
		/&\.lyricPageOpened\s*\{[\s\S]*opacity:\s*0[\s\S]*pointer-events:\s*none[\s\S]*opacity 0\.16s cubic-bezier\(0\.22, 1, 0\.36, 1\)/,
	);
	assert.equal(nowPlayingBar.match(/data-amll-playbar-reveal=""/g)?.length, 3);
	assert.match(
		nowPlayingBarStyle,
		/\.playBar \[data-amll-playbar-reveal\][\s\S]*transform:\s*translateY\(0\)[\s\S]*transform 0\.18s 0\.32s cubic-bezier\(0\.22, 1, 0\.36, 1\)/,
	);
	assert.match(
		nowPlayingBarStyle,
		/\.playBar\.lyricPageOpened \[data-amll-playbar-reveal\][\s\S]*transform:\s*translateY\(-36px\)[\s\S]*transform 0\.16s cubic-bezier\(0\.22, 1, 0\.36, 1\)/,
	);
});

test("面板在接近底栏的同一高度交接动态底色且减弱动画没有延迟", () => {
	assert.match(wrapperStyle, /opacity 0\.16s 0\.3s ease-out/);
	assert.match(
		wrapperStyle,
		/visibility 0s var\(--amll-fullscreen-sheet-duration\)/,
	);
	assert.match(wrapperStyle, /&\.opened[\s\S]*opacity:\s*1/);
	assert.match(wrapperStyle, /&\.opened[\s\S]*opacity 0\.16s ease-out/);
	assert.doesNotMatch(
		wrapperStyle,
		/&\.opened[\s\S]*opacity 0\.16s 0\.\d+s ease-out/,
	);
	assert.match(nowPlayingBarStyle, /coverTransitionSourceHidden/);
	assert.doesNotMatch(nowPlayingBarStyle, /exit-handoff/);
	assert.match(reactFullPatch, /data-amll-control-thumb/);
	assert.match(installedReactFull, /"data-amll-control-thumb": ""/);
	assert.match(
		wrapperStyle,
		/\.lyricPage :global\(\[data-amll-control-thumb\]\)[\s\S]*translateY\([\s\S]*calc\(20px - var\(--amll-player-playbar-top, 100dvh\)\)[\s\S]*pointer-events:\s*none[\s\S]*transition:\s*transform var\(--amll-fullscreen-sheet-duration\)/,
	);
	assert.match(
		wrapperStyle,
		/\.lyricPage\.opened :global\(\[data-amll-control-thumb\]\)[\s\S]*translateY\(0\)[\s\S]*pointer-events:\s*auto[\s\S]*transition:\s*transform var\(--amll-fullscreen-sheet-duration\)/,
	);
	assert.match(wrapperStyle, /@media \(prefers-reduced-motion: reduce\)/);
	assert.doesNotMatch(
		wrapperStyle,
		/\.lyricPage :global\(\[data-amll-control-thumb\]\),\s*\.lyricPage\.opened :global\(\[data-amll-control-thumb\]\)\s*\{\s*transform:/,
	);
	assert.match(nowPlayingBarStyle, /@media \(prefers-reduced-motion: reduce\)/);
	assert.match(wrapperStyle, /transition-duration:\s*1ms/);
	assert.match(wrapperStyle, /transition-delay:\s*0s/);
});
