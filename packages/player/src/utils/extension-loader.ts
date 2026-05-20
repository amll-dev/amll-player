import { appDataDir, join } from "@tauri-apps/api/path";
import { mkdir, readDir, readTextFile } from "@tauri-apps/plugin-fs";
import i18n from "../i18n.ts";
import {
	ExtensionLoadResult,
	type ExtensionMetaState,
} from "../states/extensionsAtoms.ts";

const META_REGEX = /^\/\/\s*@(\S+)\s*(.+)$/;

export async function getExtensionDir() {
	const appDir = await appDataDir();
	return await join(appDir, "extensions");
}

function createEmptyExtensionMeta(fileName: string): ExtensionMetaState {
	return {
		loadResult: ExtensionLoadResult.Loadable,
		id: "",
		fileName,
		scriptData: "",
		dependency: [],
	};
}

function applyExtensionMetaLine(
	extensionMeta: ExtensionMetaState,
	key: string,
	value: string,
) {
	if (key in extensionMeta) {
		if (Array.isArray(extensionMeta[key])) {
			(extensionMeta[key] as string[]).push(value);
		} else if (extensionMeta[key]) {
			extensionMeta[key] = [extensionMeta[key] as string, value];
		} else {
			extensionMeta[key] = value;
		}
	} else {
		extensionMeta[key] = value;
	}
}

function registerExtensionLocale(extensionMeta: ExtensionMetaState) {
	for (const localeKey of ["name", "description"]) {
		for (const key in extensionMeta) {
			if (key.startsWith(`${localeKey}:`)) {
				const [, lng] = key.split(":", 2);
				i18n.addResource(
					lng,
					extensionMeta.id,
					localeKey,
					String(extensionMeta[key]),
				);
			}
		}
	}
}

async function loadExtensionMeta(
	extensionDir: string,
	fileName: string,
): Promise<ExtensionMetaState> {
	const extensionMeta = createEmptyExtensionMeta(fileName);
	if (fileName.endsWith(".js.disabled") || fileName.endsWith(".js")) {
		if (fileName.endsWith(".js.disabled")) {
			extensionMeta.loadResult = ExtensionLoadResult.Disabled;
		}
		const extensionData = await readTextFile(
			await join(extensionDir, fileName),
		);
		for (const line of extensionData.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.length > 0) {
				const matched = META_REGEX.exec(trimmed);
				if (matched) {
					applyExtensionMetaLine(extensionMeta, matched[1], matched[2]);
				} else {
					break;
				}
			}
		}
		extensionMeta.fileName = fileName;
		extensionMeta.scriptData = extensionData;

		for (const key of ["id", "version", "icon"]) {
			if (!(key in extensionMeta)) {
				extensionMeta.loadResult = ExtensionLoadResult.MissingMetadata;
				break;
			}
		}

		registerExtensionLocale(extensionMeta);
	} else {
		extensionMeta.loadResult = ExtensionLoadResult.InvaildExtensionFile;
	}

	return Object.seal(extensionMeta);
}

function applyExtensionLoadResults(extensionMetas: ExtensionMetaState[]) {
	const extensionIds = new Set<string>();
	const conflitsIds = new Set<string>();
	for (const extensionMeta of extensionMetas) {
		if (extensionIds.has(extensionMeta.id)) {
			conflitsIds.add(extensionMeta.id);
		} else {
			extensionIds.add(extensionMeta.id);
		}
	}
	for (const extensionMeta of extensionMetas) {
		for (const d of extensionMeta.dependency) {
			if (!extensionIds.has(d)) {
				extensionMeta.loadResult = ExtensionLoadResult.MissingDependency;
				break;
			}
		}
	}
	for (const extensionMeta of extensionMetas) {
		if (
			extensionMeta.loadResult === ExtensionLoadResult.Loadable &&
			conflitsIds.has(extensionMeta.id)
		) {
			extensionMeta.loadResult = ExtensionLoadResult.ExtensionIdConflict;
		}
	}
}

function sortExtensionMetas(extensionMetas: ExtensionMetaState[]) {
	extensionMetas.sort((a, b) => {
		if (a.loadResult === b.loadResult)
			return a.fileName.localeCompare(b.fileName);

		if (a.loadResult === ExtensionLoadResult.Loadable) return -1;
		if (b.loadResult === ExtensionLoadResult.Loadable) return 1;
		if (a.loadResult === ExtensionLoadResult.Disabled) return -1;
		if (b.loadResult === ExtensionLoadResult.Disabled) return 1;
		return 0;
	});
}

export async function loadExtensionMetas(extensionDir?: string) {
	const resolvedExtensionDir = extensionDir ?? (await getExtensionDir());
	await mkdir(resolvedExtensionDir, { recursive: true });
	const extensions = await readDir(resolvedExtensionDir);
	const extensionMetas = await Promise.all(
		extensions
			.filter((v) => v.isFile)
			.map((extensionEntry) =>
				loadExtensionMeta(resolvedExtensionDir, extensionEntry.name),
			),
	);
	applyExtensionLoadResults(extensionMetas);
	sortExtensionMetas(extensionMetas);
	return extensionMetas;
}
