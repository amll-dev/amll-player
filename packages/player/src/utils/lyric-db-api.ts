import { invoke } from "@tauri-apps/api/core";

/**
 * 搜索字段过滤器
 */
export interface SearchFilter {
	field: "title" | "artist" | "album" | "lyric_text" | "bg_vocal_text";
	keyword: string;
}

/**
 * 歌词搜索结果
 */
export interface LyricSearchResult {
	file_path: string;
	title: string;
	artist: string;
	album: string;
	matched_line_preview: string[];
}

/**
 * 同步状态枚举
 */
export enum SyncStatus {
	/** 因版本一致而跳过 */
	Skipped = "Skipped",
	/** 发现新版本并成功更新 */
	Updated = "Updated",
	/** 词库没有数据或者解压出来是空的 */
	Empty = "Empty",
	/** 发生了错误 */
	Failed = "Failed",
}

/**
 * 同步结果
 */
export interface SyncResult {
	status: SyncStatus;
	count?: number;
	error?: string;
	strategy?: "full" | "incremental";
}

/**
 * 触发歌词数据库同步
 */
export async function syncLyrics(): Promise<SyncResult> {
	return invoke("sync_lyrics");
}

/**
 * 搜索歌词
 * @param filters 搜索过滤器数组，多个过滤器之间是 OR 关系（任意字段匹配即可）
 * @returns 匹配的歌词搜索结果列表
 */
export async function searchLyrics(
	filters: SearchFilter[],
): Promise<LyricSearchResult[]> {
	return invoke("search_lyrics", { filters });
}

/**
 * 获取歌词详情（完整歌词文本）
 * @param filePath 歌词文件路径
 * @returns 歌词文本，如果不存在返回 null
 */
export async function getLyricDetail(filePath: string): Promise<string | null> {
	return invoke("get_lyric_detail", { filePath });
}
