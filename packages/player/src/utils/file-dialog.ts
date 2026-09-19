import { invoke } from "@tauri-apps/api/core";
import {
	type OpenDialogOptions,
	open as openPluginDialog,
} from "@tauri-apps/plugin-dialog";
import { platform } from "@tauri-apps/plugin-os";

const CMD_PICK_FILES_OWNERLESS = "pick_files_ownerless";

type SupportedOpenDialogOptions = Pick<
	OpenDialogOptions,
	"title" | "filters" | "directory" | "multiple" | "recursive"
>;
type SingleSelectionOptions = SupportedOpenDialogOptions & { multiple?: false };
type MultipleSelectionOptions = SupportedOpenDialogOptions & { multiple: true };

let windowsDialogInFlight = false;

export function openFileDialog(
	options: MultipleSelectionOptions,
): Promise<string[] | null>;
export function openFileDialog(
	options: SingleSelectionOptions,
): Promise<string | null>;
export async function openFileDialog(
	options: SupportedOpenDialogOptions,
): Promise<string | string[] | null> {
	if (platform() !== "windows") {
		return openPluginDialog(options);
	}

	// The native dialog is ownerless to avoid the Windows Shell owner deadlock;
	// Rust temporarily disables the main window to retain modal semantics.
	// Keep one renderer-wide picker active to prevent duplicate Shell dialogs.
	if (windowsDialogInFlight) return null;
	windowsDialogInFlight = true;
	try {
		const selected = await invoke<string[] | null>(CMD_PICK_FILES_OWNERLESS, {
			options,
		});
		if (options.multiple) return selected;
		return selected?.[0] ?? null;
	} finally {
		windowsDialogInFlight = false;
	}
}
