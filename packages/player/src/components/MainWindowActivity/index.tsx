import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform } from "@tauri-apps/plugin-os";
import { useSetAtom } from "jotai";
import { useEffect } from "react";
import {
	MAIN_WINDOW_ACTIVITY_EVENT,
	mainWindowActiveAtom,
} from "../../states/windowAtoms.ts";

export const MainWindowActivity = () => {
	const setActive = useSetAtom(mainWindowActiveAtom);

	useEffect(() => {
		if (platform() !== "windows") {
			const update = () => setActive(document.visibilityState !== "hidden");
			update();
			document.addEventListener("visibilitychange", update);
			return () => document.removeEventListener("visibilitychange", update);
		}

		let cancelled = false;
		let eventRevision = 0;
		const unlisten = listen<boolean>(MAIN_WINDOW_ACTIVITY_EVENT, (event) => {
			if (cancelled) return;
			eventRevision += 1;
			setActive(event.payload);
		});
		void unlisten
			.then(async () => {
				if (cancelled) return;
				const revision = eventRevision;
				const appWindow = getCurrentWindow();
				const [visible, minimized] = await Promise.all([
					appWindow.isVisible(),
					appWindow.isMinimized(),
				]);
				// A native transition delivered during the initial query is newer
				// than its snapshot and must remain authoritative.
				if (!cancelled && revision === eventRevision) {
					setActive(visible && !minimized);
				}
			})
			.catch((error) => {
				console.error("Failed to observe main window activity", error);
			});

		return () => {
			cancelled = true;
			void unlisten.then(
				(stop) => stop(),
				() => undefined,
			);
		};
	}, [setActive]);

	return null;
};
