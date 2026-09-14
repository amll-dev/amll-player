import { invoke } from "@tauri-apps/api/core";
import type { Update } from "@tauri-apps/plugin-updater";
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import i18n from "../i18n";
import type { RhythmAnalysis } from "../utils/db-client.ts";
import type { PlayQueueManager } from "../utils/play-queue-manager.ts";
import {
	DEFAULT_WINDOW_CLOSE_BEHAVIOR,
	normalizeWindowCloseBehavior,
	type WindowCloseBehaviorMode,
} from "../utils/window-lifecycle.ts";

export enum DarkMode {
	Auto = "auto",
	Light = "light",
	Dark = "dark",
}

export enum MusicContextMode {
	Local = "local",
	WSProtocol = "ws-protocol",
}

export const darkModeAtom = atomWithStorage(
	"amll-player.darkMode",
	DarkMode.Auto,
);

export const LYRIC_BACKGROUND_ANIMATION_INTENSITY_MIN = 0;
export const LYRIC_BACKGROUND_ANIMATION_INTENSITY_MAX = 2;
export const LYRIC_BACKGROUND_ANIMATION_INTENSITY_DEFAULT = 1;

export function normalizeLyricBackgroundAnimationIntensity(
	value: number,
): number {
	if (!Number.isFinite(value)) {
		return LYRIC_BACKGROUND_ANIMATION_INTENSITY_DEFAULT;
	}
	return Math.min(
		LYRIC_BACKGROUND_ANIMATION_INTENSITY_MAX,
		Math.max(LYRIC_BACKGROUND_ANIMATION_INTENSITY_MIN, value),
	);
}

const lyricBackgroundAnimationIntensityStorageAtom = atomWithStorage<number>(
	"amll-player.lyricBackgroundAnimationIntensity",
	LYRIC_BACKGROUND_ANIMATION_INTENSITY_DEFAULT,
	undefined,
	{ getOnInit: true },
);

export const lyricBackgroundAnimationIntensityAtom = atom(
	(get) =>
		normalizeLyricBackgroundAnimationIntensity(
			get(lyricBackgroundAnimationIntensityStorageAtom),
		),
	(_get, set, value: number) => {
		set(
			lyricBackgroundAnimationIntensityStorageAtom,
			normalizeLyricBackgroundAnimationIntensity(value),
		);
	},
);

export const musicContextModeAtom = atomWithStorage(
	"amll-player.musicContextMode",
	MusicContextMode.Local,
);

export const advanceLyricDynamicLyricTimeAtom = atomWithStorage(
	"amll-player.advanceLyricDynamicLyricTimeAtom",
	false,
);

const enableMediaControlsInternalAtom = atomWithStorage(
	"amll-player.enableMediaControls",
	true,
);

export const enableLoudnessNormalizationAtom = atomWithStorage(
	"amll-player.enableLoudnessNormalization",
	false,
	undefined,
	{ getOnInit: true },
);

export const enableGaplessPlaybackAtom = atomWithStorage(
	"amll-player.enableGaplessPlayback",
	false,
	undefined,
	{ getOnInit: true },
);

const windowCloseBehaviorStorageAtom = atomWithStorage<unknown>(
	"amll-player.windowCloseBehavior",
	DEFAULT_WINDOW_CLOSE_BEHAVIOR,
	undefined,
	{ getOnInit: true },
);

export const windowCloseBehaviorAtom = atom(
	(get) => normalizeWindowCloseBehavior(get(windowCloseBehaviorStorageAtom)),
	(_get, set, value: WindowCloseBehaviorMode) => {
		set(windowCloseBehaviorStorageAtom, normalizeWindowCloseBehavior(value));
	},
);

export const enableMediaControlsAtom = atom(
	(get) => get(enableMediaControlsInternalAtom),
	(_get, set, enabled: boolean) => {
		set(enableMediaControlsInternalAtom, enabled);
		invoke("set_media_controls_enabled", { enabled }).catch((err) => {
			console.error("设置媒体控件的启用状态失败", err);
		});
	},
);

const enableAlwaysOnTopInternalAtom = atomWithStorage(
	"amll-player.enableAlwaysOnTop",
	false,
);

export const enableAlwaysOnTopAtom = atom(
	(get) => get(enableAlwaysOnTopInternalAtom),
	(_get, set, enabled: boolean) => {
		set(enableAlwaysOnTopInternalAtom, enabled);
		invoke("set_window_always_on_top", { enabled }).catch((err) => {
			console.error("设置窗口置顶状态失败", err);
		});
	},
);

export const wsProtocolListenAddrAtom = atomWithStorage(
	"amll-player.wsProtocolListenAddr",
	"localhost:11444",
);

export const showStatJSFrameAtom = atomWithStorage(
	"amll-player.showStatJSFrame",
	false,
);

export const enableExperimentalFeaturesAtom = atomWithStorage(
	"amll-player.enableExperimentalFeatures",
	false,
	undefined,
	{ getOnInit: true },
);

export interface MusicTimelineJump {
	sequence: number;
	positionMs: number;
	reason: "seek" | "lyric-click" | "track-change" | "remote-jump";
}

export const musicTimelineJumpAtom = atom<MusicTimelineJump>({
	sequence: 0,
	positionMs: 0,
	reason: "track-change",
});

export const emitMusicTimelineJumpAtom = atom(
	null,
	(get, set, event: Omit<MusicTimelineJump, "sequence">) => {
		set(musicTimelineJumpAtom, {
			...event,
			sequence: get(musicTimelineJumpAtom).sequence + 1,
		});
	},
);

export const autoDarkModeAtom = atom(true);

export const isDarkThemeAtom = atom(
	(get) =>
		get(darkModeAtom) === DarkMode.Auto
			? get(autoDarkModeAtom)
			: get(darkModeAtom) === DarkMode.Dark,
	(_get, set, newIsDark: boolean) =>
		set(darkModeAtom, newIsDark ? DarkMode.Dark : DarkMode.Light),
);

export const hasBackgroundAtom = atom(false);

export const playlistCardOpenedAtom = atom(false);

export const recordPanelOpenedAtom = atom(false);

export const amllMenuOpenedAtom = atom(false);

export const hideNowPlayingBarAtom = atom(false);

export const wsProtocolConnectedAddrsAtom = atom(new Set<string>());

export const isCheckingUpdateAtom = atom(false);

export const updateInfoAtom = atom<Update | false>(false);

export const autoUpdateAtom = atomWithStorage("amll-player.autoUpdate", true);

export const enableTaskbarLyricAtom = atomWithStorage(
	"amll-player.enableTaskbarLyric",
	false,
);

export const taskbarLyricWordProgressAtom = atomWithStorage(
	"amll-player.taskbarLyricWordProgress",
	false,
);

export const audioQualityDialogOpenedAtom = atom(false);

export const taskbarLyricThemeSettingAtom = atomWithStorage<
	"auto" | "light" | "dark"
>("amll-player.taskbarLyricTheme", "auto");
export const taskbarLyricAlignSettingAtom = atomWithStorage<
	"auto" | "left" | "right"
>("amll-player.taskbarLyricAlign", "auto");

export const taskbarLyricModeSettingAtom = atomWithStorage<
	"auto" | "single" | "double"
>("amll-player.taskbarLyricMode", "auto");

export enum BottomLyricDisplayMode {
	None = "none",
	OnlyLyricAuthors = "only-lyric-authors",
	OnlySongWriters = "only-song-writers",
	PreferLyricAuthors = "prefer-lyric-authors",
	PreferSongWriters = "prefer-song-writers",
}

export const bottomLyricDisplayModeAtom =
	atomWithStorage<BottomLyricDisplayMode>(
		"amll-player.bottomLyricDisplayMode",
		BottomLyricDisplayMode.PreferSongWriters,
	);

export const currentLyricAuthorsAtom = atom<string[]>([]);

export const currentSongWritersAtom = atom<string[]>([]);

export const queueManagerAtom = atom<PlayQueueManager | null>(null);

export interface CurrentRhythmAnalysisState {
	musicId: string;
	generation: number;
	analysis: RhythmAnalysis | null;
}

/**
 * 当前本地歌曲的节奏分析结果。持久化由 SQLite 负责，这里只保存播放期状态。
 */
export const currentRhythmAnalysisAtom =
	atom<CurrentRhythmAnalysisState | null>(null);

/** 让节奏视觉包络在 seek 等时间轴跳变后立即重新采样。 */
export const rhythmVisualResetAtom = atom(0);

const _languageBaseAtom = atom(i18n.language);
export const languageAtom = atom(
	(get) => get(_languageBaseAtom),
	(_get, set, newLang: string) => {
		i18n.changeLanguage(newLang).then(() => {
			set(_languageBaseAtom, newLang);
		});
	},
);

export const availableLanguagesAtom = atom((get) => {
	const currentLang = get(languageAtom);
	const resources = i18n.options.resources ?? {};

	const languages = Object.keys(resources)
		.map((langId) => {
			try {
				const name =
					new Intl.DisplayNames(currentLang, { type: "language" }).of(langId) ||
					langId;
				const origName =
					new Intl.DisplayNames(langId, { type: "language" }).of(langId) ||
					langId;
				return {
					label: origName === name ? origName : `${origName} (${name})`,
					value: langId,
				};
			} catch {
				return { label: langId, value: langId };
			}
		})
		.filter((item) => item.label);

	languages.push({
		label: i18n.t("page.settings.general.displayLanguage.cimode", "本地化 ID"),
		value: "cimode",
	});

	return languages;
});
