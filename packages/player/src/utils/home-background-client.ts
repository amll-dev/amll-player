import { invoke } from "@tauri-apps/api/core";
import {
	type HomeBackgroundAssetKind,
	type HomeBackgroundConfig,
	type ImportedHomeBackgroundAsset,
	normalizeHomeBackgroundConfig,
} from "./home-background-state.ts";

let lastHomeBackgroundMutationId = Date.now() * 1000;

export function nextHomeBackgroundMutationId(): number {
	lastHomeBackgroundMutationId = Math.max(
		Date.now() * 1000,
		lastHomeBackgroundMutationId + 1,
	);
	return lastHomeBackgroundMutationId;
}

export async function getHomeBackgroundConfig(): Promise<HomeBackgroundConfig> {
	return normalizeHomeBackgroundConfig(
		await invoke("get_home_background_config"),
	);
}

export async function pickAndImportHomeBackgroundAsset(
	kind: HomeBackgroundAssetKind,
	title: string,
): Promise<ImportedHomeBackgroundAsset | null> {
	return invoke("pick_and_import_home_background_asset", { kind, title });
}

export async function applyHomeBackgroundAsset(
	assetId: string,
	kind: HomeBackgroundAssetKind,
	mutationId: number,
): Promise<HomeBackgroundConfig> {
	return normalizeHomeBackgroundConfig(
		await invoke("apply_home_background_asset", { assetId, kind, mutationId }),
	);
}

export async function discardHomeBackgroundAsset(
	assetId: string,
): Promise<void> {
	await invoke("discard_home_background_asset", { assetId });
}

export async function setHomeBackgroundColor(
	color: string,
	mutationId: number,
): Promise<HomeBackgroundConfig> {
	return normalizeHomeBackgroundConfig(
		await invoke("set_home_background_color", { color, mutationId }),
	);
}

export async function resetHomeBackground(
	mutationId: number,
): Promise<HomeBackgroundConfig> {
	return normalizeHomeBackgroundConfig(
		await invoke("reset_home_background", { mutationId }),
	);
}
