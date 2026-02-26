import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAtomValue, useSetAtom } from "jotai";
import { type FC, useEffect } from "react";
import {
	autoDarkModeAtom,
	DarkMode,
	darkModeAtom,
} from "../../states/appAtoms";

export const ThemeManager: FC = () => {
	const setAutoDarkMode = useSetAtom(autoDarkModeAtom);
	const darkMode = useAtomValue(darkModeAtom);

	useEffect(() => {
		const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

		setAutoDarkMode(mediaQuery.matches);

		const handleChange = (e: MediaQueryListEvent) => {
			setAutoDarkMode(e.matches);
		};

		mediaQuery.addEventListener("change", handleChange);
		return () => mediaQuery.removeEventListener("change", handleChange);
	}, [setAutoDarkMode]);

	useEffect(() => {
		const syncThemeToWindow = async () => {
			try {
				const appWindow = getCurrentWindow();
				if (darkMode === DarkMode.Auto) {
					await appWindow.setTheme(null);
				} else {
					const theme = darkMode === DarkMode.Dark ? "dark" : "light";
					await appWindow.setTheme(theme);
				}
			} catch (e) {
				console.error("同步窗口主题失败", e);
			}
		};

		syncThemeToWindow();
	}, [darkMode]);

	return null;
};
