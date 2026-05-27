import { type InvokeArgs, invoke } from "@tauri-apps/api/core";
import type ExtensionEnv from "../../extension-env.ts";

type NativeExtensionWindowInfo = {
	extensionId: string;
	windowId: string;
	label: string;
};

function buildWindowCommandArgs(
	extensionId: string,
	windowId?: string,
	extra?: Record<string, unknown>,
): InvokeArgs {
	return {
		extensionId,
		...(typeof windowId === "string" ? { windowId } : {}),
		...extra,
	};
}

function toExtensionWindowHandle(
	info: NativeExtensionWindowInfo,
	extensionId: string,
	isActive: () => boolean,
): ExtensionEnv.ExtensionWindowHandle {
	const callWindowCommand = <T>(
		command: string,
		extra?: Record<string, unknown>,
	) => {
		if (!isActive()) {
			return Promise.reject(
				new Error(`Extension ${extensionId} has already been unloaded`),
			);
		}

		return invoke<T>(
			command,
			buildWindowCommandArgs(extensionId, info.windowId, extra),
		);
	};

	return {
		id: info.windowId,
		label: info.label,
		close: () => callWindowCommand<void>("extension_window_close"),
		show: () => callWindowCommand<void>("extension_window_show"),
		hide: () => callWindowCommand<void>("extension_window_hide"),
		focus: () => callWindowCommand<void>("extension_window_focus"),
		center: () => callWindowCommand<void>("extension_window_center"),
		setTitle: (title) =>
			callWindowCommand<void>("extension_window_set_title", { title }),
		setSize: (width, height) =>
			callWindowCommand<void>("extension_window_set_size", { width, height }),
		setPosition: (x, y) =>
			callWindowCommand<void>("extension_window_set_position", { x, y }),
	};
}

export function createExtensionWindowsApi(
	extensionId: string,
	isActive: () => boolean = () => true,
): ExtensionEnv.ExtensionWindowsApi {
	const invokeWindowCommand = <T>(
		command: string,
		windowId?: string,
		extra?: Record<string, unknown>,
	) => {
		if (!isActive()) {
			return Promise.reject(
				new Error(`Extension ${extensionId} has already been unloaded`),
			);
		}

		return invoke<T>(
			command,
			buildWindowCommandArgs(extensionId, windowId, extra),
		);
	};

	return {
		async create(id, options) {
			const info = await invokeWindowCommand<NativeExtensionWindowInfo>(
				"extension_window_create",
				id,
				options ? { options } : undefined,
			);
			return toExtensionWindowHandle(info, extensionId, isActive);
		},
		async get(id) {
			const info = await invokeWindowCommand<NativeExtensionWindowInfo | null>(
				"extension_window_get",
				id,
			);
			return info
				? toExtensionWindowHandle(info, extensionId, isActive)
				: undefined;
		},
		close(id) {
			return invokeWindowCommand<void>("extension_window_close", id);
		},
		closeAll() {
			return invokeWindowCommand<void>("extension_window_close_all");
		},
	};
}
