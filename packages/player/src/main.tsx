import "./styles.css";
import "react-toastify/dist/ReactToastify.css";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Provider } from "jotai";
import { createRoot } from "react-dom/client";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import "./i18n";
import { toError } from "./utils/error.ts";
import "./utils/player";
import App from "./App.tsx";

const ErrorRender = (props: FallbackProps) => {
	console.error(props.error);
	const normalizedError = toError(props.error);

	return (
		<div>
			<h2>An unrecoverable error has occured</h2>
			<code>
				<pre>
					{normalizedError.message}
					{"\n"}
					{normalizedError.stack}
				</pre>
			</code>
		</div>
	);
};

addEventListener("on-system-titlebar-click-close", async () => {
	const win = getCurrentWindow();
	await win.close();
});

addEventListener("on-system-titlebar-click-resize", async () => {
	const wrapperMaximized = await invoke<boolean | null>(
		"toggle_openbox_maximize",
	);
	if (wrapperMaximized !== null) {
		document.documentElement.dataset.amllOpenboxMaximized =
			wrapperMaximized.toString();
		setSystemTitlebarResizeAppearance(
			wrapperMaximized
				? SystemTitlebarResizeAppearance.Restore
				: SystemTitlebarResizeAppearance.Maximize,
		);
		return;
	}

	const win = getCurrentWindow();
	if (await win.isMaximizable()) {
		if (await win.isMaximized()) {
			await win.unmaximize();
			setSystemTitlebarResizeAppearance(
				SystemTitlebarResizeAppearance.Maximize,
			);
		} else {
			await win.maximize();
			setSystemTitlebarResizeAppearance(SystemTitlebarResizeAppearance.Restore);
		}
	}
});

const win = getCurrentWindow();
async function checkWindow() {
	const wrapperMaximized = await invoke<boolean | null>("is_openbox_maximized");
	if (wrapperMaximized !== null) {
		document.documentElement.dataset.amllOpenboxMaximized =
			wrapperMaximized.toString();
	}
	const maximized = wrapperMaximized ?? (await win.isMaximized());
	if (maximized) {
		setSystemTitlebarResizeAppearance(SystemTitlebarResizeAppearance.Restore);
	} else {
		setSystemTitlebarResizeAppearance(SystemTitlebarResizeAppearance.Maximize);
	}
}
checkWindow();
win.onResized(checkWindow);

addEventListener("on-system-titlebar-click-minimize", async () => {
	if (await invoke<boolean>("minimize_openbox_wrapper")) return;
	const win = getCurrentWindow();
	await win.minimize();
});

createRoot(document.getElementById("root") as HTMLElement).render(
	<ErrorBoundary fallbackRender={ErrorRender}>
		<Provider>
			<App />
		</Provider>
	</ErrorBoundary>,
);
