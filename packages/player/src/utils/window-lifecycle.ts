export const CMD_HIDE_MAIN_WINDOW_TO_BACKGROUND =
	"hide_main_window_to_background";
export const CMD_SHOW_MAIN_WINDOW_FROM_BACKGROUND =
	"show_main_window_from_background";
export const CMD_EXIT_APPLICATION = "exit_application";

export const WINDOW_CLOSE_BEHAVIOR_EXIT = "exit" as const;
export const WINDOW_CLOSE_BEHAVIOR_MINIMIZE_WHEN_PLAYING =
	"minimize-when-playing" as const;
export const WINDOW_CLOSE_BEHAVIOR_ALWAYS_MINIMIZE = "always-minimize" as const;
export const WINDOW_CLOSE_BEHAVIOR_ALWAYS_TRAY = "always-tray" as const;

export type WindowCloseBehaviorMode =
	| typeof WINDOW_CLOSE_BEHAVIOR_EXIT
	| typeof WINDOW_CLOSE_BEHAVIOR_MINIMIZE_WHEN_PLAYING
	| typeof WINDOW_CLOSE_BEHAVIOR_ALWAYS_MINIMIZE
	| typeof WINDOW_CLOSE_BEHAVIOR_ALWAYS_TRAY;

export const DEFAULT_WINDOW_CLOSE_BEHAVIOR: WindowCloseBehaviorMode =
	WINDOW_CLOSE_BEHAVIOR_MINIMIZE_WHEN_PLAYING;

export function normalizeWindowCloseBehavior(
	value: unknown,
): WindowCloseBehaviorMode {
	if (
		value === WINDOW_CLOSE_BEHAVIOR_EXIT ||
		value === WINDOW_CLOSE_BEHAVIOR_MINIMIZE_WHEN_PLAYING ||
		value === WINDOW_CLOSE_BEHAVIOR_ALWAYS_MINIMIZE ||
		value === WINDOW_CLOSE_BEHAVIOR_ALWAYS_TRAY
	) {
		return value;
	}
	return DEFAULT_WINDOW_CLOSE_BEHAVIOR;
}

export type MainWindowCloseAction = "exit" | "hide";

export function getMainWindowCloseAction(
	behavior: WindowCloseBehaviorMode,
	playbackRequested: boolean,
): MainWindowCloseAction {
	if (behavior === WINDOW_CLOSE_BEHAVIOR_EXIT) return "exit";
	if (
		behavior === WINDOW_CLOSE_BEHAVIOR_ALWAYS_MINIMIZE ||
		behavior === WINDOW_CLOSE_BEHAVIOR_ALWAYS_TRAY
	)
		return "hide";
	return playbackRequested ? "hide" : "exit";
}

export interface RestorePointerPosition {
	pointerId: number;
	x: number;
	y: number;
}

export const TASKBAR_RESTORE_CLICK_MAX_DISTANCE = 5;

export function isTaskbarRestoreClick(
	start: RestorePointerPosition | null,
	end: RestorePointerPosition,
	blocked: boolean,
): boolean {
	if (!start || blocked || start.pointerId !== end.pointerId) return false;
	return (
		Math.hypot(end.x - start.x, end.y - start.y) <=
		TASKBAR_RESTORE_CLICK_MAX_DISTANCE
	);
}
