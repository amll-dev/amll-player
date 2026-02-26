import { atom } from "jotai";
import type { PlayerExtensionContext } from "../components/ExtensionContext/ext-ctx";

export enum ExtensionLoadResult {
	Loadable = "loadable",
	Disabled = "disabled",
	InvaildExtensionFile = "invaild-extension-file",
	ExtensionIdConflict = "extension-id-conflict",
	MissingMetadata = "missing-metadata",
	MissingDependency = "missing-dependency",
	JavaScriptFileCorrupted = "javascript-file-corrupted",
}

export interface ExtensionMetaState {
	loadResult: ExtensionLoadResult;
	id: string;
	fileName: string;
	scriptData: string;
	dependency: string[];
	[key: string]: string | string[] | undefined;
}

export interface LoadedExtension {
	extensionMeta: ExtensionMetaState;
	extensionFunc: () => Promise<void>;
	context: PlayerExtensionContext;
}

export const reloadExtensionMetaAtom = atom(0);

export const loadedExtensionAtom = atom<LoadedExtension[]>([]);
