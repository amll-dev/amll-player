import { musicPlayingAtom } from "@applemusic-like-lyrics/react-full";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform } from "@tauri-apps/plugin-os";
import { useStore } from "jotai";
import { useEffect } from "react";
import {
	queueManagerAtom,
	windowCloseBehaviorAtom,
} from "../../states/appAtoms.ts";
import {
	CMD_EXIT_APPLICATION,
	CMD_HIDE_MAIN_WINDOW_TO_BACKGROUND,
	getMainWindowCloseAction,
} from "../../utils/window-lifecycle.ts";

export function WindowCloseBehavior() {
	const store = useStore();

	useEffect(() => {
		let disposed = false;
		let unlisten: (() => void) | undefined;
		const window = getCurrentWindow();
		const isWindows = platform() === "windows";

		const requestClose = () => {
			if (!isWindows) {
				void window.close();
				return;
			}

			const queueManager = store.get(queueManagerAtom);
			const playbackRequested =
				queueManager?.isPlaybackRequested() ?? store.get(musicPlayingAtom);
			const action = getMainWindowCloseAction(
				store.get(windowCloseBehaviorAtom),
				playbackRequested,
			);
			void invoke(
				action === "hide"
					? CMD_HIDE_MAIN_WINDOW_TO_BACKGROUND
					: CMD_EXIT_APPLICATION,
			).catch((error) => {
				console.error(
					action === "hide" ? "隐藏播放器到后台失败" : "退出播放器失败",
					error,
				);
			});
		};

		addEventListener("on-system-titlebar-click-close", requestClose);

		// The native close request (Alt+F4 and other OS close paths) must use
		// the same explicit decision as the custom title bar. Always preventing
		// Tauri's implicit destroy avoids a second, timing-sensitive close path.
		if (!isWindows) {
			return () => {
				removeEventListener("on-system-titlebar-click-close", requestClose);
			};
		}

		void window
			.onCloseRequested((event) => {
				event.preventDefault();
				requestClose();
			})
			.then((disposeListener) => {
				if (disposed) {
					disposeListener();
				} else {
					unlisten = disposeListener;
				}
			})
			.catch((error) => {
				console.error("监听播放器窗口关闭事件失败", error);
			});

		return () => {
			disposed = true;
			removeEventListener("on-system-titlebar-click-close", requestClose);
			unlisten?.();
		};
	}, [store]);

	return null;
}
