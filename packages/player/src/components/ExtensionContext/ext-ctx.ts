import type * as TauriHttp from "@tauri-apps/plugin-http";
import type { ComponentType } from "react";
import type { db } from "../../dexie.ts";
import type ExtensionEnv from "../../extension-env.ts";
import i18n from "../../i18n.ts";
import type { ExtensionMetaState } from "../../states/extensionsAtoms.ts";

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
	constructor(
		readonly playerStates: ExtensionEnv.PlayerStates,
		readonly amllStates: ExtensionEnv.AMLLStates,
		readonly i18n: ExtensionEnv.ExtensionContext["i18n"],
		readonly jotaiStore: ExtensionEnv.ExtensionContext["jotaiStore"],
		readonly extensionMeta: Readonly<ExtensionMetaState>,
		readonly lyric: typeof import("@applemusic-like-lyrics/lyric"),
		readonly playerDB: typeof db,
		readonly http: typeof TauriHttp,
	) {
		super();
	}
	extensionApiNumber = 1;
	registerLocale<T>(localeData: { [langId: string]: T }) {
		for (const [lng, data] of Object.entries(localeData)) {
			i18n.addResourceBundle(lng, this.extensionMeta.id, data);
		}
	}
	registerComponent(injectPointName: string, injectComponent: ComponentType) {
		this.registeredInjectPointComponent[injectPointName] = injectComponent;
	}
	registerPlayerSource(_idPrefix: string) {
		console.warn("Unimplemented");
	}
}
