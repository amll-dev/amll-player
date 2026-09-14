import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const readProjectFile = (path) =>
	readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const initialization = readProjectFile("../src/utils/useInitializeWindow.ts");
const nativeWindow = readProjectFile("../src-tauri/src/window.rs");
const nativeEntry = readProjectFile("../src-tauri/src/lib.rs");

test("Windows 主窗口只在前端首帧后执行一次原生呈现", () => {
	assert.match(initialization, /waitForCommittedFrames/);
	assert.match(
		initialization,
		/requestAnimationFrame\(\(\) => \{[\s\S]*requestAnimationFrame\(finish\)/,
	);
	assert.match(initialization, /invoke\("present_main_window"\)/);
	assert.match(
		initialization,
		/catch \(err\) \{[\s\S]*CMD_SHOW_MAIN_WINDOW_FROM_BACKGROUND/,
	);
	assert.doesNotMatch(initialization, /appWindow\.(?:unmaximize|maximize)\(/);
});

test("隐藏阶段恢复窗口时明确排除最大化和可见状态", () => {
	assert.match(nativeEntry, /skip_initial_state\("main"\)/);
	assert.match(
		nativeWindow,
		/main_window_restore_flags\(\)[\s\S]*StateFlags::DECORATIONS/,
	);
	assert.match(nativeWindow, /!flags\.contains\(StateFlags::SIZE\)/);
	assert.match(nativeWindow, /!flags\.contains\(StateFlags::POSITION\)/);
	assert.match(nativeWindow, /!flags\.contains\(StateFlags::MAXIMIZED\)/);
	assert.match(nativeWindow, /!flags\.contains\(StateFlags::VISIBLE\)/);
	assert.match(nativeWindow, /!flags\.contains\(StateFlags::FULLSCREEN\)/);
});

test("最终呈现按最大化意图原子显示并校准 WebView 客户区", () => {
	assert.match(
		nativeWindow,
		/#\[tauri::command\(async\)\][\s\S]*present_main_window/,
	);
	assert.match(nativeWindow, /set_dwm_cloaked\(hwnd, true\)/);
	assert.match(nativeWindow, /DwmCloakGuard/);
	assert.match(nativeWindow, /uncloak_dwm_with_retry/);
	assert.match(nativeWindow, /restore_state\(StateFlags::MAXIMIZED\)/);
	assert.match(nativeWindow, /ShowWindow\(hwnd, SW_SHOWMAXIMIZED\)/);
	assert.match(
		nativeWindow,
		/window\.show\(\)[\s\S]*window\.inner_size\(\)[\s\S]*\.set_bounds\(Rect[\s\S]*guard[\s\S]*\.release\(\)/,
	);
	assert.match(
		nativeWindow,
		/should_fullscreen[\s\S]*restore_state\(StateFlags::FULLSCREEN\)/,
	);
	assert.match(nativeWindow, /revealed\.swap\(true, Ordering::AcqRel\)/);
	assert.match(
		nativeWindow,
		/presentation\.presenting\.store\(false, Ordering::Release\);[\s\S]*reconcile_background_restore_entry\(&app\);[\s\S]*result/,
	);
});

test("启动位置读取磁盘快照并在显示前修正越界，不使用初始事件覆盖的几何缓存", () => {
	assert.match(
		nativeWindow,
		/let persisted_presentation = load_persisted_window_presentation\(app, label\);[\s\S]*let win = win\.build\(\)/,
	);
	assert.match(nativeWindow, /persisted_restore_bounds\(persisted_presentation\)/);
	assert.match(nativeWindow, /constrain_main_window_restore_bounds\(&state_window\)/);
});

test("工作线程等待 WebView 尺寸落地后重建透明窗口表面", () => {
	assert.match(nativeWindow, /RDW_INTERNALPAINT\s*\|\s*RDW_UPDATENOW/);
	assert.doesNotMatch(
		nativeWindow,
		/RDW_(?:ERASE|FRAME|INVALIDATE|ALLCHILDREN)/,
	);
	assert.match(
		nativeWindow,
		/\.set_bounds\(Rect[\s\S]*\.bounds\(\)[\s\S]*redraw_main_window_surface\(hwnd\)[\s\S]*DwmFlush\(\)[\s\S]*guard[\s\S]*\.release\(\)/,
	);
});

test("可见窗口缩放不再异步重复校准或强制提交旧表面", () => {
	assert.doesNotMatch(nativeWindow, /SURFACE_REFRESH_DELAYS_MS/);
	assert.doesNotMatch(nativeWindow, /surface_refresh_generation/);
	assert.doesNotMatch(nativeWindow, /refresh_main_window_surface/);
	assert.doesNotMatch(nativeWindow, /schedule_main_window_surface_refresh/);
});

test("窗口状态插件调用回到 Tao 主线程避免缓存锁反转", () => {
	assert.match(
		nativeWindow,
		/run_window_state_task_on_main_thread[\s\S]*run_on_main_thread/,
	);
	assert.match(
		nativeWindow,
		/run_window_state_task_on_main_thread\(&app,[\s\S]*save_window_state/,
	);
	assert.match(
		nativeWindow,
		/run_window_state_task_on_main_thread\(&app,[\s\S]*restore_state\(StateFlags::MAXIMIZED\)/,
	);
});

test("退出时在窗口状态插件保存后归一化主窗口还原坐标", () => {
	assert.match(nativeEntry, /\.build\(context\)/);
	assert.match(
		nativeEntry,
		/RunEvent::Exit[\s\S]*sanitize_persisted_main_window_state/,
	);
	assert.match(nativeWindow, /restore_bounds_generation/);
	assert.match(nativeWindow, /RESTORE_BOUNDS_SETTLE_DELAY/);
	assert.match(
		nativeWindow,
		/normalize_persisted_main_window_state[\s\S]*"prev_x"[\s\S]*"prev_y"/,
	);
});
