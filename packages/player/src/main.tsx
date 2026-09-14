import "./styles.css";
import "react-toastify/dist/ReactToastify.css";
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

addEventListener("on-system-titlebar-click-resize", async () => {
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
	if (await win.isMaximized()) {
		setSystemTitlebarResizeAppearance(SystemTitlebarResizeAppearance.Restore);
	} else {
		setSystemTitlebarResizeAppearance(SystemTitlebarResizeAppearance.Maximize);
	}
}
checkWindow();
win.onResized(checkWindow);

addEventListener("on-system-titlebar-click-minimize", async () => {
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
