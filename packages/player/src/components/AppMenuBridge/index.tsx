import {
	isLyricPageOpenedAtom,
	onCycleRepeatModeAtom,
	onPlayOrResumeAtom,
	onRequestNextSongAtom,
	onRequestPrevSongAtom,
	onToggleShuffleAtom,
} from "@applemusic-like-lyrics/react-full";
import { getName } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { platform } from "@tauri-apps/plugin-os";
import { useStore } from "jotai";
import { type FC, useEffect } from "react";
import i18n from "../../i18n.ts";
import { router } from "../../router.tsx";
import { settingsPageAtom } from "../../states/settingsAtoms.ts";
import { checkUpdateAtom } from "../../states/updater.ts";
import {
	GITHUB_REPO_URL,
	MENU_ACTION_EVENT,
	MENU_ACTION_IDS,
	type MenuLabels,
	REPORT_ISSUE_URL,
} from "./types.ts";

/** 应用菜单只由 macOS 上的 Tauri 侧创建。 */
const isMacos = () => platform() === "macos";

/** 按当前语言收集菜单文案并同步给 Tauri 侧，未同步前菜单显示英文。 */
const syncMenuLabels = async () => {
	try {
		const appName = await getName();
		const labels: MenuLabels = {
			about: i18n.t("menu.about", { appName }),
			checkUpdate: i18n.t("menu.checkUpdate"),
			closeWindow: i18n.t("menu.closeWindow"),
			copy: i18n.t("menu.copy"),
			cut: i18n.t("menu.cut"),
			cycleRepeat: i18n.t("menu.cycleRepeat"),
			edit: i18n.t("menu.edit"),
			file: i18n.t("menu.file"),
			fullscreen: i18n.t("menu.fullscreen"),
			githubRepo: i18n.t("menu.githubRepo"),
			help: i18n.t("menu.help"),
			hide: i18n.t("menu.hide", { appName }),
			hideOthers: i18n.t("menu.hideOthers"),
			minimize: i18n.t("menu.minimize"),
			nextSong: i18n.t("menu.nextSong"),
			paste: i18n.t("menu.paste"),
			playback: i18n.t("menu.playback"),
			playPause: i18n.t("menu.playPause"),
			prevSong: i18n.t("menu.prevSong"),
			quit: i18n.t("menu.quit", { appName }),
			redo: i18n.t("menu.redo"),
			reportIssue: i18n.t("menu.reportIssue"),
			selectAll: i18n.t("menu.selectAll"),
			services: i18n.t("menu.services"),
			settings: i18n.t("menu.settings"),
			showAll: i18n.t("menu.showAll"),
			toggleShuffle: i18n.t("menu.toggleShuffle"),
			undo: i18n.t("menu.undo"),
			view: i18n.t("menu.view"),
			window: i18n.t("menu.window"),
			zoom: i18n.t("menu.zoom"),
		};
		await invoke("update_app_menu", { labels });
	} catch (err) {
		console.error("同步 macOS 应用菜单失败:", err);
	}
};

/** 把 macOS 应用菜单接到前端：文案跟随语言，被接管的菜单项按 id 分派到界面或动作。 */
export const AppMenuBridge: FC = () => {
	const store = useStore();

	useEffect(() => {
		if (!isMacos()) return;

		/**
		 * 跳到应用内设置页；`anchor` 是 URL hash 锚点（`about` / `updater`），
		 * `page` 缺省时保留上次停留的标签，与侧边栏入口一致。
		 */
		const openSettings = (page?: string, anchor?: string) => {
			if (page) store.set(settingsPageAtom, page);
			// 歌词页是全屏遮罩，不先关掉就会盖住要跳转的设置页
			store.set(isLyricPageOpenedAtom, false);

			const target = anchor ? `/settings#${anchor}` : "/settings";
			const current = `${router.state.location.pathname}${router.state.location.hash}`;
			// 目标与当前地址一致时用 replace 再导航一次，好让设置页重新对齐落点
			// （比如滚下去后又点了一次「关于」），同时不堆历史记录。
			router
				.navigate(target, current === target ? { replace: true } : undefined)
				.catch(console.error);
		};

		// 播放类动作由当前音乐上下文注册，未注册时 onEmit 为空，所以回调都在点击时现取，
		// 避免把过期的上下文闭包留在监听器里。
		const handlers: Record<string, () => void> = {
			[MENU_ACTION_IDS.about]: () => openSettings("player.about", "about"),
			[MENU_ACTION_IDS.settings]: () => openSettings(),
			[MENU_ACTION_IDS.checkUpdate]: () => {
				openSettings("player.about", "updater");
				// 更新信息到得比滚动晚，设置页会在区块出现时再对齐一次
				store.set(checkUpdateAtom);
			},
			[MENU_ACTION_IDS.playPause]: () =>
				store.get(onPlayOrResumeAtom).onEmit?.(),
			[MENU_ACTION_IDS.prevSong]: () =>
				store.get(onRequestPrevSongAtom).onEmit?.(),
			[MENU_ACTION_IDS.nextSong]: () =>
				store.get(onRequestNextSongAtom).onEmit?.(),
			[MENU_ACTION_IDS.cycleRepeat]: () =>
				store.get(onCycleRepeatModeAtom).onEmit?.(),
			[MENU_ACTION_IDS.toggleShuffle]: () =>
				store.get(onToggleShuffleAtom).onEmit?.(),
			[MENU_ACTION_IDS.githubRepo]: () => {
				openUrl(GITHUB_REPO_URL).catch((err) =>
					console.error("打开项目仓库链接失败:", err),
				);
			},
			[MENU_ACTION_IDS.reportIssue]: () => {
				openUrl(REPORT_ISSUE_URL).catch((err) =>
					console.error("打开问题反馈链接失败:", err),
				);
			},
		};

		const unlisten = listen<string>(MENU_ACTION_EVENT, (evt) => {
			const handler = handlers[evt.payload];
			if (!handler) {
				console.warn("收到未知的应用菜单事件:", evt.payload);
				return;
			}
			handler();
		});

		return () => {
			unlisten.then((off) => off());
		};
	}, [store]);

	useEffect(() => {
		if (!isMacos()) return;

		syncMenuLabels();
		i18n.on("languageChanged", syncMenuLabels);

		return () => {
			i18n.off("languageChanged", syncMenuLabels);
		};
	}, []);

	return null;
};
