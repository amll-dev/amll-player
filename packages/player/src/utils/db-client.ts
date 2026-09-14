import { invoke } from "@tauri-apps/api/core";

export interface Playlist {
	id: number;
	name: string;
	createTime: number;
	updateTime: number;
	playTime: number;
	coverPath?: string | null;
	songIds: string[];
}

export interface Song {
	id: string;
	filePath: string;
	songName: string;
	songArtists: string;
	songAlbum: string;
	duration: number;
	lyricFormat: string;
	lyric: string;
	translatedLrc?: string | null;
	romanLrc?: string | null;
	coverPath?: string | null;
	modifiedAt?: number | null;
}

export type SongVideoBackgroundFitMode = "cover" | "contain" | "fill";
export type SongBackgroundRendererMode = "mesh" | "pixi" | "css-bg" | "video";
export type SongVideoBaseRendererMode = Exclude<
	SongBackgroundRendererMode,
	"video"
>;

export interface SongBackgroundOverride {
	songId: string;
	overrideEnabled: boolean;
	rendererMode: SongBackgroundRendererMode;
	dualLayer: boolean;
	videoOpacity: number;
	videoBaseRendererMode: SongVideoBaseRendererMode;
	videoBaseCssBackground: string;
	rendererOptions?:
		| import("./background-renderer-options.ts").BackgroundRendererOptions
		| null;
	updatedAt: number;
}

export interface SaveSongBackgroundOverridePayload {
	songId: string;
	rendererMode: SongBackgroundRendererMode;
	dualLayer: boolean;
	videoOpacity: number;
	videoBaseRendererMode: SongVideoBaseRendererMode;
	videoBaseCssBackground: string;
	rendererOptions?:
		| import("./background-renderer-options.ts").BackgroundRendererOptions
		| null;
}

export interface ImportedSongVideoBackground {
	assetId: string;
	filePath: string;
	mimeType: "video/mp4" | "video/webm";
	bytes: number;
}

export interface SongVideoBackground {
	songId: string;
	assetId: string;
	filePath: string;
	mimeType: "video/mp4" | "video/webm";
	durationMs: number;
	width: number;
	height: number;
	fitMode: SongVideoBackgroundFitMode;
	inPointMs: number;
	outPointMs: number;
	loopEnabled: boolean;
	syncOnSeek: boolean;
	updatedAt: number;
}

export interface SaveSongVideoBackgroundPayload {
	songId: string;
	assetId: string;
	durationMs: number;
	width: number;
	height: number;
	fitMode: SongVideoBackgroundFitMode;
	inPointMs: number;
	outPointMs: number;
	loopEnabled: boolean;
	syncOnSeek: boolean;
}

export interface VideoBackgroundGcResult {
	totalScanned: number;
	deleted: number;
	errors: string[];
}

export interface RhythmBeatPoint {
	timeMs: number;
	strength: number;
	confidence: number;
}

export interface RhythmOnsetPoint {
	timeMs: number;
	strength: number;
	bands: [number, number, number, number, number];
	/**
	 * v3 分析新增：各频带的绝对线性电平(近似 PCM RMS 标尺)。bands 是各频带
	 * 内部归一化的 novelty,天然响度无关;该字段用于恢复跨频带的响度排序。
	 * 旧缓存没有此字段。
	 */
	bandLevels?: [number, number, number, number, number];
}

export interface RhythmTempoSegment {
	startMs: number;
	endMs: number;
	bpm: number;
	confidence: number;
}

export interface RhythmTimedValue {
	timeMs: number;
	value: number;
}

export interface TrackLoudnessAnalysis {
	analyzerVersion: number;
	integratedLoudnessLufs: number | null;
	samplePeak: number;
}

export const LOUDNESS_ANALYZER_VERSION = 1;

export interface RhythmAnalysis {
	analyzerVersion: number;
	durationMs: number;
	globalBpm: number | null;
	confidence: number;
	beats: RhythmBeatPoint[];
	onsets: RhythmOnsetPoint[];
	tempoSegments: RhythmTempoSegment[];
	energyEnvelope: RhythmTimedValue[];
	/** energyEnvelope 归一化前的全曲帧 RMS P95，用于跨歌曲比较实际能量。 */
	energyScale: number;
	/** 旧节奏缓存可能没有该字段，开启音量平衡后会在后台补充。 */
	loudness?: TrackLoudnessAnalysis | null;
}

export function getCurrentTrackLoudness(
	analysis: RhythmAnalysis | null | undefined,
): TrackLoudnessAnalysis | null {
	const loudness = analysis?.loudness;
	if (
		loudness?.analyzerVersion !== LOUDNESS_ANALYZER_VERSION ||
		!Number.isFinite(loudness.samplePeak) ||
		loudness.samplePeak < 0 ||
		(loudness.integratedLoudnessLufs !== null &&
			!Number.isFinite(loudness.integratedLoudnessLufs))
	) {
		return null;
	}
	return loudness;
}

export interface RhythmPrecacheProgress {
	active: boolean;
	total: number;
	done: number;
	failed: number;
	currentSongName?: string | null;
}

/**
 * 触发一次曲库预扫:缓存缺失、分析器版本过期或源文件已变化的歌曲会被
 * 加入后台分析队列;进度经 rhythm-precache-progress 事件推送。
 */
export function startRhythmPrecache(): Promise<RhythmPrecacheProgress> {
	return invoke("start_rhythm_precache");
}

export function getRhythmPrecacheProgress(): Promise<RhythmPrecacheProgress> {
	return invoke("get_rhythm_precache_progress");
}

interface UpdatePlaylistPayload {
	name?: string;
	playTime?: number;
}

interface UpdateSongPayload {
	songName?: string;
	songArtists?: string;
	songAlbum?: string;
	lyricFormat?: string;
	lyric?: string;
	translatedLrc?: string | null;
	romanLrc?: string | null;
	coverPath?: string | null;
}

export interface CoverGcResult {
	totalScanned: number;
	deleted: number;
	errors: string[];
}

export interface ScanFolderResult {
	playlistId: number;
	totalScanned: number;
	imported: number;
	failed: number;
	failedPaths: string[];
}

export interface RefreshResult {
	added: number;
	updated: number;
	removed: number;
	failed: number;
}

export interface ImportPathIssue {
	path: string;
	stage: string;
	message: string;
}

export interface ImportMusicResult {
	playlistId: number | null;
	playlistName: string | null;
	totalCandidates: number;
	parsed: number;
	reused: number;
	added: number;
	alreadyPresent: number;
	addedSongIds: string[];
	skipped: ImportPathIssue[];
	failed: ImportPathIssue[];
	warnings: ImportPathIssue[];
}

class PlaylistsClient {
	async getAll(): Promise<Playlist[]> {
		return invoke("get_all_playlists");
	}

	async get(id: number): Promise<Playlist | undefined> {
		return invoke("get_playlist", { id });
	}

	async create(name: string): Promise<number> {
		return invoke("create_playlist", { name });
	}

	async update(id: number, changes: UpdatePlaylistPayload): Promise<void> {
		return invoke("update_playlist", { id, changes });
	}

	async delete(id: number): Promise<void> {
		return invoke("delete_playlist", { id });
	}

	async getSongs(playlistId: number): Promise<Song[]> {
		return invoke("get_playlist_songs", { playlistId });
	}

	async addSongs(playlistId: number, songIds: string[]): Promise<void> {
		return invoke("add_songs_to_playlist", { playlistId, songIds });
	}

	async removeSong(playlistId: number, songId: string): Promise<void> {
		return invoke("remove_song_from_playlist", { playlistId, songId });
	}

	async saveCover(playlistId: number, sourcePath: string): Promise<string> {
		return invoke("save_playlist_cover", { playlistId, sourcePath });
	}

	async clearCover(playlistId: number): Promise<void> {
		return invoke("clear_playlist_cover", { playlistId });
	}

	async scanFolder(
		folderPath: string,
		playlistName?: string,
	): Promise<ScanFolderResult> {
		const result = await invoke<ScanFolderResult>("scan_and_create_playlist", {
			folderPath,
			playlistName: playlistName ?? null,
		});
		// 导入完成立即预建节奏缓存,进度由全局提示组件展示。
		void startRhythmPrecache().catch(() => {});
		return result;
	}

	async getFolders(playlistId: number): Promise<string[]> {
		return invoke("get_playlist_folders", { playlistId });
	}

	async linkFolder(
		playlistId: number,
		folderPath: string,
	): Promise<ScanFolderResult> {
		const result = await invoke<ScanFolderResult>("link_playlist_folder", {
			playlistId,
			folderPath,
		});
		void startRhythmPrecache().catch(() => {});
		return result;
	}

	async unlinkFolder(playlistId: number, folderPath: string): Promise<void> {
		return invoke("unlink_playlist_folder", { playlistId, folderPath });
	}

	async refresh(playlistId: number): Promise<RefreshResult> {
		const result = await invoke<RefreshResult>("refresh_playlist", {
			playlistId,
		});
		void startRhythmPrecache().catch(() => {});
		return result;
	}

	async importPaths(
		playlistId: number,
		paths: string[],
	): Promise<ImportMusicResult> {
		const result = await invoke<ImportMusicResult>(
			"import_music_paths_to_playlist",
			{ playlistId, paths },
		);
		if (result.added > 0) {
			void startRhythmPrecache().catch(() => {});
		}
		return result;
	}

	async createFromFolder(
		folderPath: string,
		playlistName?: string,
	): Promise<ImportMusicResult> {
		const result = await invoke<ImportMusicResult>(
			"create_playlist_from_music_folder",
			{
				folderPath,
				playlistName: playlistName ?? null,
			},
		);
		if (result.added > 0) {
			void startRhythmPrecache().catch(() => {});
		}
		return result;
	}
}

class SongsClient {
	async get(id: string): Promise<Song | undefined> {
		return invoke("get_song", { id });
	}

	async getByIds(ids: string[]): Promise<Song[]> {
		return invoke("get_songs_by_ids", { ids });
	}

	async upsert(songs: Song[]): Promise<void> {
		return invoke("upsert_songs", { songs });
	}

	async update(id: string, changes: UpdateSongPayload): Promise<void> {
		return invoke("update_song", { id, changes });
	}

	async getOrAnalyzeRhythm(
		songId: string,
		force = false,
		requireLoudness = false,
		nonBlocking = false,
	): Promise<RhythmAnalysis> {
		return invoke("get_or_analyze_song_rhythm", {
			songId,
			force,
			requireLoudness,
			nonBlocking,
		});
	}

	async getCachedLoudness(
		songId: string,
	): Promise<TrackLoudnessAnalysis | null> {
		return invoke("get_cached_song_loudness", { songId });
	}
}

class SongVideoBackgroundsClient {
	async pickAndImport(
		title: string,
	): Promise<ImportedSongVideoBackground | null> {
		return invoke("pick_and_import_song_video_background", { title });
	}

	async import(sourcePath: string): Promise<ImportedSongVideoBackground> {
		return invoke("import_song_video_background", { sourcePath });
	}

	async get(songId: string): Promise<SongVideoBackground | null> {
		return invoke("get_song_video_background", { songId });
	}

	async save(
		payload: SaveSongVideoBackgroundPayload,
	): Promise<SongVideoBackground> {
		return invoke("save_song_video_background", { payload });
	}

	async delete(songId: string): Promise<void> {
		return invoke("delete_song_video_background", { songId });
	}

	async discard(assetId: string): Promise<void> {
		return invoke("discard_song_video_background_asset", { assetId });
	}

	async cleanup(): Promise<VideoBackgroundGcResult> {
		return invoke("cleanup_orphaned_song_video_backgrounds");
	}
}

class SongBackgroundOverridesClient {
	async get(songId: string): Promise<SongBackgroundOverride | null> {
		return invoke("get_song_background_override", { songId });
	}

	async save(
		payload: SaveSongBackgroundOverridePayload,
	): Promise<SongBackgroundOverride> {
		return invoke("save_song_background_override", { payload });
	}

	async delete(songId: string): Promise<void> {
		return invoke("delete_song_background_override", { songId });
	}
}

class MiscClient {
	async cleanupOrphanedCovers(): Promise<CoverGcResult> {
		return invoke("cleanup_orphaned_covers");
	}
}

class DbClient {
	playlists = new PlaylistsClient();
	songs = new SongsClient();
	songBackgroundOverrides = new SongBackgroundOverridesClient();
	videoBackgrounds = new SongVideoBackgroundsClient();
	misc = new MiscClient();
}

export const db = new DbClient();
