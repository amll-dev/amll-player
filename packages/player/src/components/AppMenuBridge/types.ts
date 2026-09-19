/** 点击自定义应用菜单项时，Tauri 侧发给主窗口的事件名；负载为菜单项 id。 */
export const MENU_ACTION_EVENT = "app-menu:action";

/**
 * 自定义菜单项的 id，与 Tauri 侧 `src-tauri/src/app_menu.rs` 保持一致
 * （Tauri 只转发 `amll.` 前缀的菜单项）。
 */
export const MENU_ACTION_IDS = {
	about: "amll.about",
	settings: "amll.settings",
	checkUpdate: "amll.check-update",
	playPause: "amll.play-pause",
	prevSong: "amll.prev-song",
	nextSong: "amll.next-song",
	cycleRepeat: "amll.cycle-repeat",
	toggleShuffle: "amll.toggle-shuffle",
	githubRepo: "amll.github-repo",
	reportIssue: "amll.report-issue",
} as const;

/** 帮助菜单里的外部链接。 */
export const GITHUB_REPO_URL = "https://github.com/amll-dev/amll-player";
export const REPORT_ISSUE_URL = `${GITHUB_REPO_URL}/issues`;

/** macOS 应用菜单的文案，缺省字段由 Tauri 侧回退到英文；`{appName}` 为应用名称占位符。 */
export interface MenuLabels {
	about?: string;
	checkUpdate?: string;
	closeWindow?: string;
	copy?: string;
	cut?: string;
	cycleRepeat?: string;
	edit?: string;
	file?: string;
	fullscreen?: string;
	githubRepo?: string;
	help?: string;
	hide?: string;
	hideOthers?: string;
	minimize?: string;
	nextSong?: string;
	paste?: string;
	playback?: string;
	playPause?: string;
	prevSong?: string;
	quit?: string;
	redo?: string;
	reportIssue?: string;
	selectAll?: string;
	services?: string;
	settings?: string;
	showAll?: string;
	toggleShuffle?: string;
	undo?: string;
	view?: string;
	window?: string;
	zoom?: string;
}
