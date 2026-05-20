import { atom } from "jotai";
import {
	getExtensionDir,
	loadExtensionMetas,
} from "../utils/extension-loader.ts";
import { reloadExtensionMetaAtom } from "./extensionsAtoms.ts";

export const extensionDirAtom = atom(async () => {
	return await getExtensionDir();
});

export const extensionMetaAtom = atom(
	async (get) => {
		get(reloadExtensionMetaAtom);
		const extensionDir = await get(extensionDirAtom);
		return await loadExtensionMetas(extensionDir);
	},
	(_get, set) => {
		set(reloadExtensionMetaAtom, (c) => c + 1);
	},
);
