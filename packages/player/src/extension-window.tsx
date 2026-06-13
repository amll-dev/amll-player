import * as lyric from "@applemusic-like-lyrics/lyric";
import * as amllStates from "@applemusic-like-lyrics/react-full";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import { invoke } from "@tauri-apps/api/core";
import * as http from "@tauri-apps/plugin-http";
import { Provider, useStore } from "jotai";
import {
	type ComponentType,
	type CSSProperties,
	useEffect,
	useState,
} from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import { useTranslation } from "react-i18next";
import { PlayerExtensionContext } from "./components/ExtensionContext/ext-ctx.ts";
import {
	EXTENSION_LOG_TAG,
	runExtensionScript,
} from "./components/ExtensionContext/runtime.ts";
import { db } from "./utils/db-client.ts";
import "./i18n";
import * as appAtoms from "./states/appAtoms.ts";
import * as extensionsAtoms from "./states/extensionsAtoms.ts";
import {
	ExtensionLoadResult,
	type ExtensionMetaState,
} from "./states/extensionsAtoms.ts";
import { toError } from "./utils/error.ts";
import {
	type ExtensionScriptFile,
	loadExtensionMetasFromFiles,
} from "./utils/extension-loader.ts";

type ExtensionWindowInfo = {
	extensionId: string;
	windowId: string;
	label: string;
};

type LoadedWindowComponent = {
	current: ExtensionWindowInfo;
	contexts: PlayerExtensionContext[];
	WindowComponent: ComponentType;
};

type HostState =
	| { status: "loading" }
	| { status: "ready"; component: LoadedWindowComponent }
	| { status: "error"; error: Error };

function WindowReadySignal() {
	useEffect(() => {
		const timer = window.setTimeout(() => {
			void invoke("extension_window_mark_ready").catch((err) => {
				console.warn(EXTENSION_LOG_TAG, "标记扩展窗口就绪失败", err);
			});
		}, 0);
		return () => window.clearTimeout(timer);
	}, []);
	return null;
}

async function cleanupLoadedContexts(contexts: PlayerExtensionContext[]) {
	for (let index = contexts.length - 1; 0 <= index; index -= 1) {
		const context = contexts[index];
		if (!context) continue;
		context.dispatchEvent(new Event("extension-unload"));
		try {
			await context.dispose();
		} catch (err) {
			console.warn(
				EXTENSION_LOG_TAG,
				"关闭扩展窗口失败",
				context.extensionMeta.id,
				err,
			);
			context.deactivate();
		}
	}
}

function getLoadableExtensionMeta(
	extensionMetaById: Map<string, ExtensionMetaState>,
	extensionId: string,
) {
	const extensionMeta = extensionMetaById.get(extensionId);
	if (!extensionMeta) {
		throw new Error(`Missing extension metadata: ${extensionId}`);
	}
	if (extensionMeta.loadResult !== ExtensionLoadResult.Loadable) {
		throw new Error(
			`Extension ${extensionId} is not loadable: ${extensionMeta.loadResult}`,
		);
	}
	return extensionMeta;
}

function resolveExtensionLoadOrder(
	extensionMetas: ExtensionMetaState[],
	targetExtensionId: string,
) {
	const extensionMetaById = new Map(
		extensionMetas.map((meta) => [meta.id, meta]),
	);
	const loaded = new Set<string>();
	const loading = new Set<string>();
	const orderedMetas: ExtensionMetaState[] = [];

	const visit = (extensionId: string) => {
		if (loaded.has(extensionId)) return;
		if (loading.has(extensionId)) {
			throw new Error(`Circular extension dependency: ${extensionId}`);
		}
		const extensionMeta = getLoadableExtensionMeta(
			extensionMetaById,
			extensionId,
		);
		loading.add(extensionId);
		for (const dependencyId of extensionMeta.dependency) {
			visit(dependencyId);
		}
		loading.delete(extensionId);
		loaded.add(extensionId);
		orderedMetas.push(extensionMeta);
	};

	visit(targetExtensionId);
	return orderedMetas;
}

async function loadWindowComponent(
	current: ExtensionWindowInfo,
	store: ReturnType<typeof useStore>,
	i18n: ReturnType<typeof useTranslation>["i18n"],
): Promise<LoadedWindowComponent> {
	const extensionFiles = await invoke<ExtensionScriptFile[]>(
		"extension_window_get_current_extension_files",
	);
	const extensionMetas = loadExtensionMetasFromFiles(extensionFiles);
	const orderedMetas = resolveExtensionLoadOrder(
		extensionMetas,
		current.extensionId,
	);
	const loadedExtensionIds = new Set<string>();
	const playerStatesObject = Object.freeze({
		...appAtoms,
		...extensionsAtoms,
	});
	const amllStatesObject = Object.freeze({ ...amllStates });
	const contexts: PlayerExtensionContext[] = [];
	const waitForDependency = async (extensionId: string) => {
		if (!loadedExtensionIds.has(extensionId)) {
			throw new Error(`Missing Dependency: ${extensionId}`);
		}
	};

	try {
		for (const extensionMeta of orderedMetas) {
			const extI18n = i18n.cloneInstance({
				ns: extensionMeta.id,
			});
			const context = new PlayerExtensionContext(
				playerStatesObject,
				amllStatesObject,
				extI18n,
				store,
				extensionMeta,
				lyric,
				db,
				http,
				{ kind: "extension-window" },
				{ id: current.windowId, label: current.label },
			);

			console.log(
				EXTENSION_LOG_TAG,
				"正在加载扩展窗口扩展程序",
				extensionMeta.id,
				extensionMeta.fileName,
			);

			await runExtensionScript({
				extensionMeta,
				context,
				waitForDependency,
			});
			context.dispatchEvent(new Event("extension-load"));
			loadedExtensionIds.add(extensionMeta.id);
			contexts.push(context);

			console.log(
				EXTENSION_LOG_TAG,
				"扩展窗口扩展程序",
				extensionMeta.id,
				extensionMeta.fileName,
				"加载完成",
			);
		}
	} catch (err) {
		await cleanupLoadedContexts(contexts);
		throw err;
	}

	const targetContext = contexts.find(
		(context) => context.extensionMeta.id === current.extensionId,
	);
	const WindowComponent =
		targetContext?.registeredWindowComponent[current.windowId];
	if (!WindowComponent) {
		await cleanupLoadedContexts(contexts);
		throw new Error(
			`Extension ${current.extensionId} did not register window component: ${current.windowId}`,
		);
	}

	return {
		current,
		contexts: [...contexts],
		WindowComponent,
	};
}

const pageStyle = {
	display: "flex",
	minHeight: "100vh",
	boxSizing: "border-box",
	padding: "24px",
	alignItems: "center",
	justifyContent: "center",
	color: "#f8fafc",
	background:
		"radial-gradient(circle at 20% 20%, rgba(56, 189, 248, 0.28), transparent 32%), linear-gradient(135deg, #111827, #020617)",
} satisfies CSSProperties;

const cardStyle = {
	width: "min(720px, 100%)",
	boxSizing: "border-box",
	padding: "24px",
	borderRadius: "18px",
	background: "rgba(15, 23, 42, 0.82)",
	boxShadow: "0 20px 80px rgba(0, 0, 0, 0.32)",
	border: "1px solid rgba(148, 163, 184, 0.22)",
} satisfies CSSProperties;

const codeStyle = {
	display: "block",
	marginTop: "14px",
	padding: "14px",
	maxHeight: "40vh",
	overflow: "auto",
	whiteSpace: "pre-wrap",
	borderRadius: "12px",
	background: "rgba(2, 6, 23, 0.72)",
	color: "#cbd5e1",
} satisfies CSSProperties;

function InfoPage({
	title,
	detail,
	error,
}: {
	title: string;
	detail?: string;
	error?: Error;
}) {
	return (
		<div style={pageStyle}>
			<section style={cardStyle}>
				<h1 style={{ margin: 0, fontSize: 20 }}>{title}</h1>
				{detail && <p style={{ color: "#cbd5e1" }}>{detail}</p>}
				{error && (
					<code style={codeStyle}>
						{error.message}
						{error.stack ? `\n\n${error.stack}` : ""}
					</code>
				)}
			</section>
		</div>
	);
}

function ComponentErrorPage({
	error,
	current,
}: FallbackProps & {
	current: ExtensionWindowInfo;
}) {
	const normalizedError = toError(error);
	return (
		<InfoPage
			title="Extension window component crashed"
			detail={`Extension: ${current.extensionId} / Window: ${current.windowId}`}
			error={normalizedError}
		/>
	);
}

const ExtensionWindowApp = () => {
	const store = useStore();
	const { i18n } = useTranslation();
	const [state, setState] = useState<HostState>({ status: "loading" });

	useEffect(() => {
		let canceled = false;
		let loadedContexts: PlayerExtensionContext[] = [];

		(async () => {
			try {
				const current = await invoke<ExtensionWindowInfo>(
					"extension_window_get_current",
				);
				const component = await loadWindowComponent(current, store, i18n);
				loadedContexts = component.contexts;
				if (canceled) {
					await cleanupLoadedContexts(loadedContexts);
					return;
				}
				setState({ status: "ready", component });
			} catch (err) {
				if (canceled) return;
				setState({ status: "error", error: toError(err) });
			}
		})();

		return () => {
			canceled = true;
			const contextsToCleanup = loadedContexts;
			loadedContexts = [];
			void cleanupLoadedContexts(contextsToCleanup);
		};
	}, [i18n, store]);

	if (state.status === "loading") {
		return <InfoPage title="Loading extension window" />;
	}

	if (state.status === "error") {
		return (
			<>
				<InfoPage title="Failed to load extension window" error={state.error} />
				<WindowReadySignal />
			</>
		);
	}

	const { WindowComponent, current } = state.component;
	return (
		<Theme appearance="dark" panelBackground="solid" hasBackground={false}>
			<ErrorBoundary
				fallbackRender={(props) => (
					<>
						<ComponentErrorPage {...props} current={current} />
						<WindowReadySignal />
					</>
				)}
			>
				<WindowComponent />
				<WindowReadySignal />
			</ErrorBoundary>
		</Theme>
	);
};

createRoot(document.getElementById("root") as HTMLElement).render(
	<Provider>
		<ExtensionWindowApp />
	</Provider>,
);
