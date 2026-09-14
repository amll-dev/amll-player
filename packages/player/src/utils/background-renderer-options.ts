import type { SongBackgroundOverride } from "./db-client.ts";

export interface BackgroundRendererOptions {
	fps: number;
	animationIntensity: number;
	renderScale: number;
	staticMode: boolean;
	cssBackground: string;
}

export function getBackgroundColorPickerValue(
	value: string,
	fallback = "#111111",
): string {
	const normalized = value.trim().toLowerCase();
	if (/^#[0-9a-f]{6}$/.test(normalized)) return normalized;
	if (/^#[0-9a-f]{3}$/.test(normalized)) {
		return `#${normalized
			.slice(1)
			.split("")
			.map((part) => part.repeat(2))
			.join("")}`;
	}
	const rgb = normalized.match(
		/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/,
	);
	if (!rgb) return fallback;
	return `#${rgb
		.slice(1)
		.map((part) => Math.min(255, Number(part)).toString(16).padStart(2, "0"))
		.join("")}`;
}

/** Old rows inherit globals until their renderer options are first saved. */
export function resolveBackgroundRendererOptions(
	globalOptions: BackgroundRendererOptions,
	override: SongBackgroundOverride | null,
	musicId: string,
	experimentalEnabled: boolean,
): BackgroundRendererOptions {
	if (
		!experimentalEnabled ||
		!musicId ||
		!override?.overrideEnabled ||
		override.songId !== musicId
	) {
		return globalOptions;
	}
	const options = override.rendererOptions;
	if (!options) return globalOptions;
	const numberOrGlobal = (
		value: number,
		fallback: number,
		min: number,
		max: number,
	) =>
		Number.isFinite(value) && value >= min && value <= max ? value : fallback;
	return {
		fps: Number.isInteger(options.fps)
			? numberOrGlobal(options.fps, globalOptions.fps, 1, 1000)
			: globalOptions.fps,
		animationIntensity: numberOrGlobal(
			options.animationIntensity,
			globalOptions.animationIntensity,
			0,
			2,
		),
		renderScale: numberOrGlobal(
			options.renderScale,
			globalOptions.renderScale,
			0.01,
			10,
		),
		staticMode:
			typeof options.staticMode === "boolean"
				? options.staticMode
				: globalOptions.staticMode,
		cssBackground:
			typeof options.cssBackground === "string" && options.cssBackground.trim()
				? options.cssBackground
				: globalOptions.cssBackground,
	};
}
