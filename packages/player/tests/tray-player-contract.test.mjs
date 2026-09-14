import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	getTrayControlPressReleaseDelay,
	TRAY_CONTROL_MIN_PRESS_MS,
} from "../src/pages/tray-player/press-feedback.ts";
import {
	getReachedTrayLyric,
	resolveTrayPlayerText,
} from "../src/pages/tray-player/text.ts";

const readProjectFile = (path) =>
	readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const html = readProjectFile("../tray-player.html");
const entry = readProjectFile("../src/tray-player.tsx");
const popup = readProjectFile("../src/pages/tray-player/index.tsx");
const popupStyle = readProjectFile("../src/pages/tray-player/index.module.css");
const bridge = readProjectFile("../src/components/TrayBridge/index.tsx");
const types = readProjectFile("../src/components/TrayBridge/types.ts");
const nativeWindow = readProjectFile("../src-tauri/src/window.rs");
const nativeEntry = readProjectFile("../src-tauri/src/lib.rs");
const trayPlayerWatcher = readProjectFile(
	"../src-tauri/src/tray_player_watcher.rs",
);
const vite = readProjectFile("../vite.config.ts");
const capability = readProjectFile(
	"../src-tauri/capabilities/tray-player.toml",
);

const trayTextState = (overrides = {}) => ({
	musicName: "背对背拥抱",
	artist: "林俊杰",
	lyric: "只是相爱的我们",
	playing: true,
	canControl: true,
	taskbarLyricEnabled: false,
	cover: null,
	displayCover: "",
	labels: {
		appName: "AMLL Player",
		unknownSong: "未知歌曲",
		unknownArtist: "未知艺术家",
		noLyrics: "暂无歌词",
		previous: "上一首",
		play: "播放",
		pause: "暂停",
		next: "下一首",
		taskbarLyric: "任务栏歌词",
		showWindow: "显示窗口",
		exit: "退出",
	},
	...overrides,
});

test("自绘托盘播放器拥有独立透明入口与最小权限", () => {
	assert.match(html, /id="root"/);
	assert.match(html, /src="\/src\/tray-player\.tsx"/);
	assert.match(html, /background:\s*transparent/);
	assert.match(entry, /<TrayPlayerApp \/>/);
	assert.match(vite, /"tray-player"[\s\S]*tray-player\.html/);
	assert.match(capability, /windows = \["tray-player"\]/);
	assert.match(capability, /core:event:allow-listen/);
	assert.match(capability, /core:event:allow-unlisten/);
	assert.doesNotMatch(entry, /<App \/>/);
});

test("托盘卡片使用大封面、双行文本与带动画的三个圆形控制按钮", () => {
	assert.match(popup, /className=\{styles\.coverShell\}/);
	assert.match(popup, /className=\{styles\.title\}/);
	assert.match(popup, /className=\{styles\.lyric\}/);
	assert.doesNotMatch(popup, /title=\{(?:title|secondary)\}/);
	assert.match(
		popup,
		/const \{ title, secondary \} = resolveTrayPlayerText\(state\)/,
	);
	assert.equal((popup.match(/<TrayControlButton/g) ?? []).length, 3);
	assert.doesNotMatch(popup, /MediaButton/);
	assert.match(popup, /<AnimatedPlayPauseIcon playing=\{state\.playing\}/);
	assert.match(popup, /disabled=\{!state\.canControl\}/);
	const viewportRule =
		popupStyle.match(/\.viewport\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
	const cardRule = popupStyle.match(/\.card\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
	const contentRule = popupStyle.match(/\.content\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
	const controlsRule =
		popupStyle.match(/\.controls\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
	const coverRule =
		popupStyle.match(/\.coverShell\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
	const footerRule = popupStyle.match(/\.footer\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
	const footerButtonRule =
		popupStyle.match(/\.footerButton\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
	assert.match(viewportRule, /padding:\s*8px/);
	assert.match(cardRule, /grid-template-columns:\s*112px minmax\(0, 1fr\)/);
	assert.match(cardRule, /column-gap:\s*14px/);
	assert.match(cardRule, /padding:\s*12px/);
	assert.match(contentRule, /justify-content:\s*flex-start/);
	assert.match(contentRule, /padding:\s*0/);
	assert.match(controlsRule, /margin-top:\s*auto/);
	assert.match(controlsRule, /margin-bottom:\s*auto/);
	assert.match(coverRule, /width:\s*112px/);
	assert.match(coverRule, /height:\s*112px/);
	assert.match(footerRule, /margin-top:\s*0/);
	assert.match(footerRule, /padding-top:\s*5px/);
	assert.match(footerButtonRule, /padding:\s*4px 9px/);
	assert.match(footerButtonRule, /line-height:\s*1\.2/);
	assert.match(footerButtonRule, /white-space:\s*nowrap/);
	assert.match(popupStyle, /border-radius:\s*999px/);
	assert.match(popupStyle, /transform:\s*scale\(0\.88\)/);
	assert.match(popupStyle, /prefers-reduced-motion/);
	assert.doesNotMatch(cardRule, /backdrop-filter/);
	assert.doesNotMatch(cardRule, /0\s+18px\s+48px/);
	assert.match(popupStyle, /\.viewport\s+\.playButton\s*\{/);
	assert.match(
		popupStyle,
		/\.controlButton:not\(\.playButton\)\s*>\s*svg\s*\{[\s\S]*?width:\s*36px[\s\S]*?height:\s*36px/,
	);
	assert.match(
		popupStyle,
		/\.playButton\s*\{[\s\S]*?width:\s*46px[\s\S]*?height:\s*46px[\s\S]*?min-width:\s*46px/,
	);
	assert.match(
		popupStyle,
		/\.playButton\s*>\s*svg\s*\{[\s\S]*?width:\s*21px[\s\S]*?height:\s*21px/,
	);
	assert.match(
		popupStyle,
		/\.viewport\s+\.playButton\s*\{[\s\S]*?background-color:[\s\S]*?color:\s*#fff/,
	);
	assert.match(
		nativeWindow,
		/BACKGROUND_TRAY_PLAYER_WIDTH:\s*f64\s*=\s*380\.0/,
	);
	assert.match(
		nativeWindow,
		/BACKGROUND_TRAY_PLAYER_HEIGHT:\s*f64\s*=\s*192\.0/,
	);
	assert.match(
		trayPlayerWatcher,
		/ScreenRect::from_xywh\(100, 100, 380, 192\)/,
	);
});

test("托盘圆形按钮的快速点击至少保留下压状态 150 毫秒", () => {
	assert.equal(TRAY_CONTROL_MIN_PRESS_MS, 150);
	assert.equal(getTrayControlPressReleaseDelay(1000, 1000), 150);
	assert.equal(getTrayControlPressReleaseDelay(1000, 1060), 90);
	assert.equal(getTrayControlPressReleaseDelay(1000, 1150), 0);
	assert.equal(getTrayControlPressReleaseDelay(1000, 1400), 0);
	assert.equal(getTrayControlPressReleaseDelay(1000, 900), 150);
	assert.equal(getTrayControlPressReleaseDelay(Number.NaN, 1000), 150);
	assert.match(popup, /data-pressed=\{visuallyPressed \? "true" : "false"\}/);
	assert.match(popup, /onPointerDown=\{onPointerDown\}/);
	assert.match(popup, /setPointerCapture\(event\.pointerId\)/);
	assert.match(popup, /onPointerUp=\{onPointerUp\}/);
	assert.match(popup, /onPointerCancel=\{onPointerCancel\}/);
	assert.match(popup, /onPointerLeave=\{onPointerLeave\}/);
	assert.match(popup, /onLostPointerCapture=\{onLostPointerCapture\}/);
	assert.match(popup, /onKeyDown=\{onKeyDown\}/);
	assert.match(popup, /onKeyUp=\{onKeyUp\}/);
	assert.match(popup, /onClick=\{onClick\}/);
	assert.match(popup, /interactionSourceRef/);
	assert.match(popup, /hasPointerCaptureRef/);
	assert.match(popup, /pressGenerationRef/);
	assert.match(popup, /window\.clearTimeout/);
	assert.match(popup, /window\.addEventListener\("pointerup"/);
	assert.match(popup, /window\.addEventListener\("pointercancel"/);
	assert.match(popup, /window\.addEventListener\("blur"/);
	assert.match(popup, /document\.addEventListener\("visibilitychange"/);
	assert.match(popup, /try\s*\{[\s\S]*onAction\(\)[\s\S]*finally/);
	assert.match(
		popupStyle,
		/\.controlButton\[data-pressed="true"\]:not\(:disabled\)/,
	);
	assert.doesNotMatch(popupStyle, /\.controlButton:active:not\(:disabled\)/);
});

test("托盘卡片按任务栏歌词状态切换作者与已到达歌词", () => {
	assert.deepEqual(
		resolveTrayPlayerText(trayTextState({ taskbarLyricEnabled: true })),
		{
			title: "背对背拥抱",
			secondary: "林俊杰",
			showingLyric: false,
		},
	);
	assert.deepEqual(resolveTrayPlayerText(trayTextState({ lyric: "" })), {
		title: "背对背拥抱",
		secondary: "林俊杰",
		showingLyric: false,
	});
	assert.deepEqual(resolveTrayPlayerText(trayTextState()), {
		title: "背对背拥抱 - 林俊杰",
		secondary: "只是相爱的我们",
		showingLyric: true,
	});
	assert.deepEqual(
		resolveTrayPlayerText(trayTextState({ artist: "", lyric: "" })),
		{
			title: "背对背拥抱",
			secondary: "未知艺术家",
			showingLyric: false,
		},
	);
	assert.deepEqual(
		resolveTrayPlayerText(trayTextState({ canControl: false })),
		{
			title: "AMLL Player",
			secondary: "未知歌曲",
			showingLyric: false,
		},
	);
});

test("托盘歌词只在播放位置真正到达行起点后显示", () => {
	const lines = [
		{ startTime: 500, words: [{ word: "第一句" }] },
		{ startTime: 2000, words: [{ word: "第二句" }] },
	];
	const pendingLyric = getReachedTrayLyric(lines, 499);
	assert.equal(pendingLyric, "");
	assert.deepEqual(
		resolveTrayPlayerText(trayTextState({ lyric: pendingLyric })),
		{
			title: "背对背拥抱",
			secondary: "林俊杰",
			showingLyric: false,
		},
	);
	assert.equal(getReachedTrayLyric(lines, 500), "第一句");
	assert.equal(getReachedTrayLyric(lines, 1999), "第一句");
	assert.equal(getReachedTrayLyric(lines, 2000), "第二句");
	assert.equal(getReachedTrayLyric([], 5000), "");
	assert.equal(
		getReachedTrayLyric([{ startTime: 0, words: [{ word: "   " }] }], 0),
		"",
	);
});

test("托盘卡片状态、七种操作与关闭生命周期完整接线", () => {
	assert.match(popup, /listen<BackgroundTrayMenuState>/);
	assert.match(popup, /BACKGROUND_TRAY_STATE_EVENT/);
	assert.match(popup, /CMD_BACKGROUND_TRAY_PLAYER_READY/);
	assert.match(popup, /CMD_BACKGROUND_TRAY_PLAYER_ACTION/);
	for (const action of [
		"previous",
		"toggle-playback",
		"next",
		"toggle-taskbar-lyric",
		"show",
		"exit",
		"hide",
	]) {
		assert.match(popup, new RegExp(`runAction\\("${action}"\\)`));
		assert.match(nativeWindow, new RegExp(`"${action}"`));
	}
	assert.match(popup, /event\.key === "Escape"/);
	assert.doesNotMatch(popup, /data-tauri-drag-region/);
	assert.match(popup, /role="status"/);
	assert.match(popup, /aria-live="polite"/);
	assert.match(popup, /ariaPressed=\{state\.playing\}/);
	assert.match(popup, /aria-pressed=\{state\.taskbarLyricEnabled\}/);
	assert.match(types, /amll-player:\/\/background-tray-state/);
	assert.doesNotMatch(nativeWindow, /WindowEvent::Focused\(/);
	assert.match(
		nativeWindow,
		/WindowEvent::CloseRequested[\s\S]*api\.prevent_close\(\)/,
	);
	assert.match(nativeWindow, /set_show_menu_on_right_click\(false\)/);
	assert.doesNotMatch(nativeWindow, /set_show_menu_on_right_click\(true\)/);
	const popupWorker = nativeWindow.slice(
		nativeWindow.indexOf("fn apply_background_tray_player_visibility"),
		nativeWindow.indexOf("fn background_tray_player_url"),
	);
	assert.match(popupWorker, /background_tray_is_required/);
	assert.ok(
		(popupWorker.match(/background_tray_player_generation_is_current/g) ?? [])
			.length >= 2,
	);
	assert.match(popupWorker, /BACKGROUND_TRAY_PLAYER_RECONCILE_RUNNING/);
	assert.match(popupWorker, /loop\s*\{/);
	assert.match(popupWorker, /failed_current_generation/);
	assert.doesNotMatch(popupWorker, /BACKGROUND_RESTORE_LOCK/);
	assert.doesNotMatch(popupWorker, /set_focus/);
	assert.doesNotMatch(popupWorker, /window\.show\(\)/);
	const popupShow = nativeWindow.slice(
		nativeWindow.indexOf("fn show_background_tray_player_noactivate"),
		nativeWindow.indexOf("fn apply_background_tray_player_visibility"),
	);
	assert.match(
		popupShow,
		/show_background_tray_player_noactivate[\s\S]*SW_SHOWNOACTIVATE/,
	);
	assert.match(
		popupShow,
		/background_tray_player_visibility_state[\s\S]*state\.generation != generation[\s\S]*SW_SHOWNOACTIVATE/,
	);
	assert.match(
		popupWorker,
		/if let Err\(error\) = harden_background_tray_player_noactivate\(&window, popup_hwnd\)[\s\S]*Keeping the custom player is the primary behavior/,
	);
	const popupBuilder = nativeWindow.slice(
		nativeWindow.indexOf("fn prepare_background_tray_player"),
		nativeWindow.indexOf("fn handle_background_tray_player_window_event"),
	);
	assert.match(
		popupBuilder,
		/WebviewWindowBuilder::new\(&app, BACKGROUND_TRAY_PLAYER_LABEL,[\s\S]*?\.focused\(false\)[\s\S]*?\.focusable\(false\)/,
	);
	assert.match(popupBuilder, /\.owner_raw\(/);
	const trayEventHandlerStart = nativeWindow.indexOf(".on_tray_icon_event");
	const trayEventHandler = nativeWindow.slice(
		trayEventHandlerStart,
		nativeWindow.indexOf(".build(app)", trayEventHandlerStart),
	);
	const rightClickButton = trayEventHandler.indexOf(
		"button: MouseButton::Right",
	);
	const rightClickArm = trayEventHandler.slice(
		trayEventHandler.lastIndexOf("TrayIconEvent::Click", rightClickButton),
		trayEventHandler.indexOf("\n            _ => {}", rightClickButton),
	);
	assert.match(rightClickArm, /\brect,/);
	assert.match(rightClickArm, /physical_tray_icon_rect\(rect\)/);
	assert.match(
		rightClickArm,
		/toggle_background_tray_player_visibility\(icon_rect\)/,
	);
	assert.match(
		rightClickArm,
		/reconcile_background_tray_player_visibility\(&app\)/,
	);
	assert.doesNotMatch(rightClickArm, /\bposition\b|cursor/i);
	const popupPositioner = nativeWindow.slice(
		nativeWindow.indexOf("fn position_background_tray_player"),
		nativeWindow.indexOf("fn background_tray_player_generation_is_current"),
	);
	assert.match(
		popupPositioner,
		/monitor_from_point\(icon_center_x, icon_center_y\)/,
	);
	assert.match(popupPositioner, /tray_player_position\(\s*icon_rect,/);
	assert.match(
		popupPositioner,
		/tray_player_physical_dimension\(BACKGROUND_TRAY_PLAYER_WIDTH, scale_factor\)/,
	);
	assert.match(
		nativeEntry,
		/!matches!\(label, "taskbar-lyric" \| "tray-player"\)/,
	);
});

test("托盘卡片始终使用自绘界面并在任意窗口外点击后关闭", () => {
	assert.doesNotMatch(trayPlayerWatcher, /NotifyWinEvent|EVENT_SYSTEM_MENU/);
	assert.match(trayPlayerWatcher, /SetWindowsHookExW\(WH_MOUSE_LL/);
	assert.match(trayPlayerWatcher, /GetWindowRect/);
	assert.match(trayPlayerWatcher, /anchor_rect\.contains\(point\)/);
	assert.match(nativeWindow, /harden_background_tray_player_noactivate/);
	assert.match(trayPlayerWatcher, /find_webview_hwnd/);
	assert.match(trayPlayerWatcher, /GetParent\(render_hwnd\)/);
	assert.match(trayPlayerWatcher, /GetCurrentProcessId/);
	assert.match(trayPlayerWatcher, /WS_EX_NOACTIVATE/);
	assert.match(trayPlayerWatcher, /hide_background_tray_player_if_generation/);
	assert.match(nativeEntry, /tray_player_watcher::stop\(\)/);
	assert.doesNotMatch(trayPlayerWatcher, /ABM_SETSTATE/);
	assert.match(nativeWindow, /disable_background_tray_native_menu\(app\)/);
	assert.match(
		nativeWindow,
		/if BACKGROUND_TRAY_PLAYER_READY[\s\S]*toggle_background_tray_player_visibility[\s\S]*else[\s\S]*set_background_tray_player_visibility\(true, Some\(icon_rect\)\)[\s\S]*prepare_background_tray_player/,
	);
});

test("隐藏 HMENU 仅作为可降级兼容层并将卡片点击转发给自绘 WebView", () => {
	assert.match(trayPlayerWatcher, /CreatePopupMenu/);
	assert.match(trayPlayerWatcher, /TrackPopupMenuEx/);
	assert.match(trayPlayerWatcher, /SetWindowsHookExW\(WH_CBT/);
	assert.match(trayPlayerWatcher, /EndMenu\(\)/);
	assert.match(trayPlayerWatcher, /MENU_SESSION_DESIRED/);
	assert.match(trayPlayerWatcher, /MENU_ACTIVE_GENERATION/);
	assert.match(
		trayPlayerWatcher,
		/Failed to install the tray HMENU transparency hook; keeping only the custom card/,
	);
	const hook = trayPlayerWatcher.slice(
		trayPlayerWatcher.indexOf('unsafe extern "system" fn mouse_hook_proc'),
		trayPlayerWatcher.indexOf("#[cfg(test)]"),
	);
	assert.match(hook, /CallNextHookEx/);
	assert.match(hook, /forward_menu_pointer_message/);
	assert.match(hook, /message == WM_LBUTTONDOWN/);
	assert.match(hook, /message == WM_LBUTTONUP/);
	assert.match(hook, /return LRESULT\(1\)/);
	assert.match(
		hook,
		/MENU_SESSION_ACTIVE\.load\(Ordering::Acquire\)[\s\S]*MENU_ACTIVE_GENERATION\.load\(Ordering::Relaxed\) == generation/,
	);
	assert.match(
		trayPlayerWatcher,
		/schedule_generation_close\(app\.clone\(\), pending_generation, delay\)/,
	);
	assert.match(trayPlayerWatcher, /prepare_system_menu_creation/);
	assert.match(trayPlayerWatcher, /SWP_FRAMECHANGED/);
	const popupWorker = nativeWindow.slice(
		nativeWindow.indexOf("fn apply_background_tray_player_visibility"),
		nativeWindow.indexOf("fn reconcile_background_tray_player_visibility"),
	);
	assert.match(
		popupWorker,
		/show_background_tray_player_noactivate[\s\S]*begin_menu_session/,
	);
	assert.match(
		popupWorker,
		/It must never replace or take down the custom WebView card/,
	);
});

test("播放进度不会按帧重建系统托盘菜单", () => {
	assert.match(bridge, /const trayLyric = useMemo/);
	assert.doesNotMatch(bridge, /musicPlayingPosition\s*\+\s*300/);
	assert.match(
		bridge,
		/getReachedTrayLyric\(musicLyricLines, musicPlayingPosition\)/,
	);
	const syncEffect = bridge.slice(
		bridge.indexOf("void invoke(CMD_UPDATE_BACKGROUND_TRAY_MENU"),
		bridge.indexOf(
			"useEffect(() => {",
			bridge.indexOf("void invoke(CMD_UPDATE_BACKGROUND_TRAY_MENU") + 1,
		),
	);
	assert.match(syncEffect, /trayLyric/);
	assert.doesNotMatch(syncEffect, /musicPlayingPosition,/);
	assert.match(nativeWindow, /if native_menu_changed/);
});
