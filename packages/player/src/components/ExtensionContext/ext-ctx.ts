import { invoke } from "@tauri-apps/api/core";
import type * as TauriHttp from "@tauri-apps/plugin-http";
import type { ComponentType } from "react";
import type ExtensionEnv from "../../extension-env.ts";
import i18n from "../../i18n.ts";
import type { ExtensionMetaState } from "../../states/extensionsAtoms.ts";
import type { db } from "../../utils/db-client.ts";
import { createExtensionWindowsApi } from "./windows.ts";

export class PlayerExtensionContext
	extends EventTarget
	implements ExtensionEnv.ExtensionContext
{
	/**
	 * @internal
	 */
	registeredInjectPointComponent: {
		[injectPointName: string]: ComponentType | undefined;
	} = {};
	registeredWindowComponent: {
		[windowId: string]: ComponentType | undefined;
	} = {};
	private active = true;
	readonly windows: ExtensionEnv.ExtensionWindowsApi;
	constructor(
		readonly playerStates: ExtensionEnv.PlayerStates,
		readonly amllStates: ExtensionEnv.AMLLStates,
		readonly i18n: ExtensionEnv.ExtensionContext["i18n"],
		readonly jotaiStore: ExtensionEnv.ExtensionContext["jotaiStore"],
		readonly extensionMeta: Readonly<ExtensionMetaState>,
		readonly lyric: typeof import("@applemusic-like-lyrics/lyric"),
		readonly playerDB: typeof db,
		readonly http: typeof TauriHttp,
		readonly runtime: ExtensionEnv.ExtensionRuntimeInfo = {
			kind: "main",
		},
		readonly window?: ExtensionEnv.ExtensionWindowRuntimeInfo,
	) {
		super();
		this.windows = createExtensionWindowsApi(
			extensionMeta.id,
			() => this.active,
		);
	}
	extensionApiNumber = 2;
	deactivate() {
		this.active = false;
	}
	async dispose() {
		if (!this.active) return;
		try {
			await invoke<void>("extension_window_close_all", {
				extensionId: this.extensionMeta.id,
			});
		} finally {
			this.deactivate();
		}
	}
	registerLocale<T>(localeData: { [langId: string]: T }) {
		for (const [lng, data] of Object.entries(localeData)) {
			i18n.addResourceBundle(lng, this.extensionMeta.id, data);
		}
	}
	registerComponent(injectPointName: string, injectComponent: ComponentType) {
		this.registeredInjectPointComponent[injectPointName] = injectComponent;
	}
	registerWindowComponent(windowId: string, component: ComponentType) {
		this.registeredWindowComponent[windowId] = component;
	}
	registerPlayerSource(_idPrefix: string) {
		console.warn("Unimplemented");
	}
}
