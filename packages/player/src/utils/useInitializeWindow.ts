import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform, version } from "@tauri-apps/plugin-os";
import { useStore } from "jotai";
import { useEffect, useRef } from "react";
import semverGt from "semver/functions/gt";
import { hasBackgroundAtom } from "../states/appAtoms";
import { CMD_SHOW_MAIN_WINDOW_FROM_BACKGROUND } from "./window-lifecycle.ts";

const waitForCommittedFrames = () =>
	new Promise<void>((resolve) => {
		let completed = false;
		const finish = () => {
			if (completed) return;
			completed = true;
			window.clearTimeout(fallback);
			resolve();
		};
		const fallback = window.setTimeout(finish, 80);
		window.requestAnimationFrame(() => {
			window.requestAnimationFrame(finish);
		});
	});

export const useInitializeWindow = () => {
	const store = useStore();
	const isInitializedRef = useRef(false);

	useEffect(() => {
		const initializeWindow = async () => {
			if (isInitializedRef.current) return;
			isInitializedRef.current = true;

			try {
				const appWindow = getCurrentWindow();

				if (platform() === "windows" && !semverGt(version(), "10.0.22000")) {
					store.set(hasBackgroundAtom, true);
					await appWindow.clearEffects();
				}

				if (platform() === "windows") {
					const enabled =
						localStorage.getItem("amll-player.enableAlwaysOnTop") === "true";
					invoke("set_window_always_on_top", { enabled }).catch((err) => {
						console.error("同步窗口置顶状态失败", err);
					});

					// React 提交首帧后再由原生层一次性呈现最终窗口状态。
					// 隐藏页面可能暂停 rAF，因此保留短超时作为兜底。
					await waitForCommittedFrames();
					try {
						await invoke("present_main_window");
					} catch (err) {
						console.error("原生窗口呈现失败，回退到普通显示:", err);
						await invoke(CMD_SHOW_MAIN_WINDOW_FROM_BACKGROUND);
					}
				} else {
					await appWindow.show();
					await appWindow.setFocus();
				}
			} catch (err) {
				console.error("初始化窗口失败:", err);
			}
		};

		initializeWindow();
	}, [store]);
};
