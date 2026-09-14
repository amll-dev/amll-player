import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_WINDOW_CLOSE_BEHAVIOR,
	getMainWindowCloseAction,
	isTaskbarRestoreClick,
	normalizeWindowCloseBehavior,
	WINDOW_CLOSE_BEHAVIOR_ALWAYS_MINIMIZE,
	WINDOW_CLOSE_BEHAVIOR_ALWAYS_TRAY,
	WINDOW_CLOSE_BEHAVIOR_EXIT,
	WINDOW_CLOSE_BEHAVIOR_MINIMIZE_WHEN_PLAYING,
} from "../src/utils/window-lifecycle.ts";

const readProjectFile = (path) =>
	readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const app = readProjectFile("../src/App.tsx");
const closeBridge = readProjectFile(
	"../src/components/WindowCloseBehavior/index.tsx",
);
const trayBridge = readProjectFile("../src/components/TrayBridge/index.tsx");
const main = readProjectFile("../src/main.tsx");
const queueManager = readProjectFile("../src/utils/play-queue-manager.ts");
const nativeWindow = readProjectFile("../src-tauri/src/window.rs");
const trayPlayerWatcher = readProjectFile(
	"../src-tauri/src/tray_player_watcher.rs",
);
const nativeEntry = readProjectFile("../src-tauri/src/lib.rs");
const nativeTaskbar = readProjectFile("../src-tauri/src/taskbar_lyric/mod.rs");
const taskbar = readProjectFile("../src/pages/taskbar-lyric/index.tsx");
const playerCore = readProjectFile("../../player-core/src/player.rs");
const settings = readProjectFile("../src/pages/settings/player.tsx");
const zhCn = JSON.parse(readProjectFile("../locales/zh-CN/translation.json"));

test("关闭策略覆盖四档模式与同步播放意图", () => {
	const rows = [
		[WINDOW_CLOSE_BEHAVIOR_EXIT, false, "exit"],
		[WINDOW_CLOSE_BEHAVIOR_EXIT, true, "exit"],
		[WINDOW_CLOSE_BEHAVIOR_MINIMIZE_WHEN_PLAYING, false, "exit"],
		[WINDOW_CLOSE_BEHAVIOR_MINIMIZE_WHEN_PLAYING, true, "hide"],
		[WINDOW_CLOSE_BEHAVIOR_ALWAYS_MINIMIZE, false, "hide"],
		[WINDOW_CLOSE_BEHAVIOR_ALWAYS_MINIMIZE, true, "hide"],
		[WINDOW_CLOSE_BEHAVIOR_ALWAYS_TRAY, false, "hide"],
		[WINDOW_CLOSE_BEHAVIOR_ALWAYS_TRAY, true, "hide"],
	];
	for (const [behavior, playing, expected] of rows) {
		assert.equal(getMainWindowCloseAction(behavior, playing), expected);
	}
	assert.equal(
		DEFAULT_WINDOW_CLOSE_BEHAVIOR,
		WINDOW_CLOSE_BEHAVIOR_MINIMIZE_WHEN_PLAYING,
	);
	for (const valid of [
		WINDOW_CLOSE_BEHAVIOR_EXIT,
		WINDOW_CLOSE_BEHAVIOR_MINIMIZE_WHEN_PLAYING,
		WINDOW_CLOSE_BEHAVIOR_ALWAYS_MINIMIZE,
		WINDOW_CLOSE_BEHAVIOR_ALWAYS_TRAY,
	]) {
		assert.equal(normalizeWindowCloseBehavior(valid), valid);
	}
	for (const invalid of [undefined, null, "bad-value"]) {
		assert.equal(
			normalizeWindowCloseBehavior(invalid),
			DEFAULT_WINDOW_CLOSE_BEHAVIOR,
		);
	}
	assert.match(app, /<WindowCloseBehavior \/>/);
	assert.match(app, /<TrayBridge \/>/);
	assert.doesNotMatch(main, /on-system-titlebar-click-close/);
	assert.match(closeBridge, /onCloseRequested/);
	assert.match(
		closeBridge,
		/addEventListener\("on-system-titlebar-click-close"/,
	);
	assert.match(closeBridge, /queueManager\?\.isPlaybackRequested\(\)/);
	assert.match(closeBridge, /store\.get\(musicPlayingAtom\)/);
	assert.match(closeBridge, /store\.get\(windowCloseBehaviorAtom\)/);
	assert.doesNotMatch(closeBridge, /closePending/);
	assert.match(
		closeBridge,
		/event\.preventDefault\(\);[\s\S]*requestClose\(\)/,
	);
	assert.match(
		closeBridge,
		/action === "hide"[\s\S]*CMD_HIDE_MAIN_WINDOW_TO_BACKGROUND[\s\S]*CMD_EXIT_APPLICATION/,
	);
	assert.match(
		queueManager,
		/isPlaybackRequested\(\): boolean \{[\s\S]*return !this\.disposed && this\.desiredPlaying/,
	);
});

test("常驻托盘位于关闭选项首位并保留原有三项顺序", () => {
	const menu = settings.slice(
		settings.indexOf("const windowCloseBehaviorMenu"),
		settings.indexOf(
			"return (",
			settings.indexOf("const windowCloseBehaviorMenu"),
		),
	);
	const alwaysIndex = menu.indexOf("WINDOW_CLOSE_BEHAVIOR_ALWAYS_MINIMIZE");
	const trayIndex = menu.indexOf("WINDOW_CLOSE_BEHAVIOR_ALWAYS_TRAY");
	const playingIndex = menu.indexOf(
		"WINDOW_CLOSE_BEHAVIOR_MINIMIZE_WHEN_PLAYING",
	);
	const exitIndex = menu.indexOf("WINDOW_CLOSE_BEHAVIOR_EXIT");
	assert.ok(alwaysIndex >= 0 && alwaysIndex < playingIndex);
	assert.ok(trayIndex >= 0 && trayIndex < alwaysIndex);
	assert.equal(
		zhCn.page.settings.general.windowCloseBehavior.menu.alwaysTray,
		"常驻托盘",
	);
	assert.ok(playingIndex < exitIndex);
	assert.match(menu, /"播放时最小化"/);
	assert.match(settings, /"选择关闭时播放器是否最小化到任务栏托盘"/);
	assert.equal(
		zhCn.page.settings.general.windowCloseBehavior.description,
		"选择关闭时播放器是否最小化到任务栏托盘",
	);
	assert.equal(
		zhCn.page.settings.general.windowCloseBehavior.menu.minimizeWhenPlaying,
		"播放时最小化",
	);
});

test("后台隐藏始终保留自绘控制卡片与退出入口", () => {
	assert.match(nativeWindow, /TrayIconBuilder::with_id\(BACKGROUND_TRAY_ID\)/);
	assert.doesNotMatch(nativeWindow, /\.menu\(&menu\)/);
	assert.match(nativeWindow, /\.show_menu_on_left_click\(false\)/);
	assert.match(nativeWindow, /set_show_menu_on_right_click\(false\)/);
	assert.doesNotMatch(nativeWindow, /set_show_menu_on_right_click\(true\)/);
	const trayRefreshStart = nativeWindow.indexOf("fn refresh_background_tray");
	const trayRefresh = nativeWindow.slice(
		trayRefreshStart,
		nativeWindow.indexOf("fn hide_background_tray(", trayRefreshStart),
	);
	assert.ok(
		trayRefresh.indexOf("disable_background_tray_native_menu(app)?") <
			trayRefresh.indexOf("tray.set_menu"),
	);
	assert.match(nativeWindow, /BACKGROUND_TRAY_PLAYER_LABEL/);
	assert.match(nativeWindow, /BACKGROUND_TRAY_PLAYER_VISIBILITY_STATE/);
	assert.match(
		nativeWindow,
		/set_background_tray_player_visibility[\s\S]*state\.set_visibility\(desired_visible, anchor_rect\)/,
	);
	assert.match(
		nativeWindow,
		/toggle_background_tray_player_visibility[\s\S]*state\.toggle\(anchor_rect\)/,
	);
	const popupReconcile = nativeWindow.slice(
		nativeWindow.indexOf("fn reconcile_background_tray_player_visibility"),
		nativeWindow.indexOf("fn background_tray_player_url"),
	);
	assert.match(popupReconcile, /BACKGROUND_TRAY_PLAYER_RECONCILE_RUNNING/);
	assert.match(popupReconcile, /loop\s*\{/);
	assert.match(popupReconcile, /apply_background_tray_player_visibility/);
	assert.match(popupReconcile, /state\.generation[\s\S]*continue/);
	assert.match(popupReconcile, /store\(false, Ordering::SeqCst\)/);
	assert.match(popupReconcile, /swap\(true, Ordering::SeqCst\)/);
	assert.doesNotMatch(nativeWindow, /WindowEvent::Focused\(/);
	assert.match(trayPlayerWatcher, /SetWindowsHookExW\(WH_MOUSE_LL/);
	assert.match(
		trayPlayerWatcher,
		/pointer_down_should_dismiss[\s\S]*popup_rect[\s\S]*anchor_rect/,
	);
	assert.match(
		trayPlayerWatcher,
		/hide_background_tray_player_if_generation[\s\S]*generation/,
	);
	const popupHideRequest = nativeWindow.slice(
		nativeWindow.indexOf("fn hide_background_tray_player(app"),
		nativeWindow.indexOf("fn tray_player_position"),
	);
	assert.match(
		popupHideRequest,
		/set_background_tray_player_visibility\(false, None\)/,
	);
	assert.match(
		popupHideRequest,
		/reconcile_background_tray_player_visibility\(app\)/,
	);
	assert.doesNotMatch(popupHideRequest, /window\.hide\(\)/);
	assert.match(nativeWindow, /background_tray_player_ready/);
	assert.match(nativeWindow, /background_tray_player_action/);
	assert.match(nativeWindow, /IconMenuItem::with_id/);
	assert.match(nativeWindow, /CheckMenuItem::with_id/);
	assert.match(nativeWindow, /BACKGROUND_TRAY_PREVIOUS_ID/);
	assert.match(nativeWindow, /BACKGROUND_TRAY_TOGGLE_PLAYBACK_ID/);
	assert.match(nativeWindow, /BACKGROUND_TRAY_NEXT_ID/);
	assert.match(nativeWindow, /BACKGROUND_TRAY_TASKBAR_LYRIC_ID/);
	assert.match(nativeWindow, /BACKGROUND_TRAY_SHOW_ID/);
	assert.match(nativeWindow, /BACKGROUND_TRAY_EXIT_ID/);
	const trayRequirement = nativeWindow.slice(
		nativeWindow.indexOf("fn background_tray_is_required"),
		nativeWindow.indexOf("fn apply_background_tray_requirement"),
	);
	assert.match(trayRequirement, /MAIN_WINDOW_HIDDEN_TO_BACKGROUND/);
	assert.match(trayRequirement, /get_webview_window\("main"\)/);
	assert.doesNotMatch(trayRequirement, /taskbar_lyric_restore_available/);
	assert.match(nativeWindow, /BACKGROUND_RESTORE_LOCK/);
	assert.match(nativeWindow, /reconcile_background_restore_entry/);
	const reconcile = nativeWindow.slice(
		nativeWindow.indexOf("pub(crate) fn reconcile_background_restore_entry"),
		nativeWindow.indexOf("pub(crate) fn try_clear_background_restore_entry"),
	);
	assert.doesNotMatch(reconcile, /BACKGROUND_RESTORE_LOCK/);
	assert.match(reconcile, /BACKGROUND_TRAY_RECONCILE_GENERATION/);
	assert.match(reconcile, /BACKGROUND_TRAY_RECONCILE_RUNNING/);
	assert.match(reconcile, /loop\s*\{/);
	assert.match(reconcile, /apply_background_tray_requirement/);
	assert.match(
		nativeTaskbar,
		/destroy_taskbar_window[\s\S]*reconcile_background_restore_entry/,
	);
	assert.match(
		nativeTaskbar,
		/window\.show\(\)\.is_ok\(\)[\s\S]*reconcile_background_restore_entry/,
	);
	assert.match(
		nativeWindow,
		/hide_main_window_to_background[\s\S]*window\.hide\(\)/,
	);
	assert.match(
		nativeWindow,
		/show_main_window_from_background[\s\S]*window\.unminimize\(\)[\s\S]*window\.show\(\)[\s\S]*window\.set_focus\(\)/,
	);
	const hideCommand = nativeWindow.slice(
		nativeWindow.indexOf("pub async fn hide_main_window_to_background"),
		nativeWindow.indexOf("pub async fn show_main_window_from_background"),
	);
	assert.match(
		hideCommand,
		/BACKGROUND_RESTORE_LOCK\.lock\(\)\.await[\s\S]*window\.hide\(\)[\s\S]*MAIN_WINDOW_HIDDEN_TO_BACKGROUND\.store\(true[\s\S]*reconcile_background_restore_entry\(&app\)/,
	);
	assert.doesNotMatch(hideCommand, /ensure_background_tray\(&app\)/);
	assert.doesNotMatch(hideCommand, /hide_background_tray\(&app\)/);
	const showCommand = nativeWindow.slice(
		nativeWindow.indexOf("pub async fn show_main_window_from_background"),
		nativeWindow.indexOf("mod tests"),
	);
	assert.match(
		showCommand,
		/window\.set_focus\(\)[\s\S]*\}[\s\S]*reconcile_background_restore_entry\(&app\)/,
	);
	assert.doesNotMatch(showCommand, /hide_background_tray\(&app\)/);
	const ensureTray = nativeWindow.slice(
		nativeWindow.indexOf("fn ensure_background_tray"),
		nativeWindow.indexOf("fn background_tray_is_required"),
	);
	const existingTrayBranch =
		ensureTray.match(/if let Some\(tray\)[\s\S]*?return Ok\(\(\)\);/)?.[0] ??
		"";
	assert.doesNotMatch(existingTrayBranch, /refresh_background_tray/);
	assert.match(nativeEntry, /window::hide_main_window_to_background/);
	assert.match(nativeEntry, /window::show_main_window_from_background/);
	assert.match(nativeEntry, /\.on_menu_event\(\|app, event\|/);
	assert.match(nativeEntry, /window::handle_background_tray_menu_event/);
	assert.match(nativeEntry, /window::update_background_tray_menu/);
	assert.match(nativeEntry, /window::background_tray_player_ready/);
	assert.match(nativeEntry, /window::background_tray_player_action/);
	assert.match(nativeEntry, /window::exit_application/);
	assert.match(nativeWindow, /BackgroundTrayAction::Exit => app\.exit\(0\)/);
	assert.match(
		nativeWindow,
		/app\.emit_to\([\s\S]*"main"[\s\S]*BACKGROUND_TRAY_COMMAND_EVENT/,
	);
	assert.match(trayBridge, /onRequestPrevSong\?\.\(\)/);
	assert.match(trayBridge, /onPlayOrResume\?\.\(\)/);
	assert.match(trayBridge, /onRequestNextSong\?\.\(\)/);
	assert.match(trayBridge, /setTaskbarLyricEnabled\(\(enabled\) => !enabled\)/);
	assert.match(
		nativeEntry,
		/WindowEvent::Destroyed[\s\S]*clear_background_restore_entry/,
	);
	assert.match(
		nativeEntry,
		/"taskbar-lyric"[\s\S]*schedule_destroyed_window_recovery/,
	);
	assert.match(
		nativeTaskbar,
		/schedule_destroyed_window_recovery[\s\S]*yield_now[\s\S]*window_matches[\s\S]*reconcile_background_restore_entry[\s\S]*open_taskbar_lyric/,
	);
});

test("任务栏歌词非控制区域短点击唤回播放器，拖动和控制按钮不误触", () => {
	const start = { pointerId: 7, x: 10, y: 20 };
	assert.equal(
		isTaskbarRestoreClick(start, { pointerId: 7, x: 13, y: 23 }, false),
		true,
	);
	assert.equal(
		isTaskbarRestoreClick(start, { pointerId: 7, x: 25, y: 20 }, false),
		false,
	);
	assert.equal(
		isTaskbarRestoreClick(start, { pointerId: 7, x: 10, y: 20 }, true),
		false,
	);
	assert.equal(
		isTaskbarRestoreClick(start, { pointerId: 8, x: 10, y: 20 }, false),
		false,
	);

	assert.match(taskbar, /data-taskbar-lyric-control/);
	assert.match(taskbar, /onPointerDown=\{handleRestorePointerDown\}/);
	assert.match(taskbar, /onPointerUp=\{handleRestorePointerUp\}/);
	assert.match(taskbar, /CMD_SHOW_MAIN_WINDOW_FROM_BACKGROUND/);
});

test("播放状态在无流恢复、加载失败和自然结束时不会残留为播放中", () => {
	assert.match(
		playerCore,
		/let is_actually_playing =[\s\S]*self\.stream_is_running[\s\S]*PlayStatus \{[\s\S]*is_playing: is_actually_playing/,
	);
	const naturalEnd = playerCore.slice(
		playerCore.indexOf("async fn finish_current_track_legacy"),
		playerCore.indexOf("async fn drain_gapless_notifications"),
	);
	assert.match(naturalEnd, /media_manager\.update_play_state\(false\)/);
	assert.match(naturalEnd, /PlayStatus \{ is_playing: false \}/);

	const playAudio = playerCore.slice(
		playerCore.indexOf("AudioThreadMessage::PlayAudio"),
		playerCore.indexOf("AudioThreadMessage::SetGaplessNext"),
	);
	assert.match(
		playAudio,
		/start_playing_song[\s\S]*should_publish_stopped[\s\S]*fail_playback_start/,
	);
	assert.doesNotMatch(playAudio, /return Err\(error\)/);
	const loadFailure = playerCore.slice(
		playerCore.indexOf("async fn fail_playback_start"),
		playerCore.indexOf("async fn drain_gapless_notifications"),
	);
	assert.match(loadFailure, /current_stream = None/);
	assert.match(loadFailure, /transport_intent_playing = false/);
	assert.match(loadFailure, /PlayStatus \{ is_playing: false \}/);
	assert.match(
		loadFailure,
		/let playback_id = self\.current_playback_id\.clone\(\)[\s\S]*current_playback_id\.clear\(\)[\s\S]*AudioThreadEvent::LoadError \{[\s\S]*playback_id/,
	);
});
