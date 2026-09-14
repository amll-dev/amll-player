export type HomeBackgroundMode = "default" | "color" | "image" | "video";
export type HomeBackgroundAssetKind = "image" | "video";

export interface ImportedHomeBackgroundAsset {
	assetId: string;
	filePath: string;
	mimeType: string;
	bytes: number;
	kind: HomeBackgroundAssetKind;
}

export interface HomeBackgroundConfig {
	mode: HomeBackgroundMode;
	color: string;
	assetId: string | null;
	filePath: string | null;
	mimeType: string | null;
	bytes: number | null;
	updatedAt: number;
}

export const DEFAULT_HOME_BACKGROUND_COLOR = "#111111";

export const DEFAULT_HOME_BACKGROUND_CONFIG: HomeBackgroundConfig = {
	mode: "default",
	color: DEFAULT_HOME_BACKGROUND_COLOR,
	assetId: null,
	filePath: null,
	mimeType: null,
	bytes: null,
	updatedAt: 0,
};

const HOME_BACKGROUND_MODES = new Set<HomeBackgroundMode>([
	"default",
	"color",
	"image",
	"video",
]);

export function normalizeHomeBackgroundColor(value: unknown): string {
	if (typeof value !== "string") return DEFAULT_HOME_BACKGROUND_COLOR;
	const normalized = value.trim().toLowerCase();
	return /^#[0-9a-f]{6}$/.test(normalized)
		? normalized
		: DEFAULT_HOME_BACKGROUND_COLOR;
}

export function normalizeHomeBackgroundConfig(
	value: unknown,
): HomeBackgroundConfig {
	if (!value || typeof value !== "object") {
		return DEFAULT_HOME_BACKGROUND_CONFIG;
	}
	const candidate = value as Partial<HomeBackgroundConfig>;
	const mode = HOME_BACKGROUND_MODES.has(candidate.mode as HomeBackgroundMode)
		? (candidate.mode as HomeBackgroundMode)
		: "default";
	const color = normalizeHomeBackgroundColor(candidate.color);
	const assetId =
		typeof candidate.assetId === "string" && candidate.assetId.length > 0
			? candidate.assetId
			: null;
	const filePath =
		typeof candidate.filePath === "string" && candidate.filePath.length > 0
			? candidate.filePath
			: null;
	const mimeType =
		typeof candidate.mimeType === "string" && candidate.mimeType.length > 0
			? candidate.mimeType
			: null;
	const bytes =
		typeof candidate.bytes === "number" &&
		Number.isFinite(candidate.bytes) &&
		candidate.bytes > 0
			? candidate.bytes
			: null;
	const updatedAt =
		typeof candidate.updatedAt === "number" &&
		Number.isFinite(candidate.updatedAt) &&
		candidate.updatedAt >= 0
			? candidate.updatedAt
			: 0;

	if ((mode === "image" || mode === "video") && (!assetId || !filePath)) {
		return {
			...DEFAULT_HOME_BACKGROUND_CONFIG,
			color,
		};
	}

	return {
		mode,
		color,
		assetId: mode === "image" || mode === "video" ? assetId : null,
		filePath: mode === "image" || mode === "video" ? filePath : null,
		mimeType: mode === "image" || mode === "video" ? mimeType : null,
		bytes: mode === "image" || mode === "video" ? bytes : null,
		updatedAt,
	};
}

export function isCustomHomeBackground(config: HomeBackgroundConfig): boolean {
	return config.mode !== "default";
}
