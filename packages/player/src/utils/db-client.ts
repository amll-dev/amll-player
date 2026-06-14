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
		return invoke("scan_and_create_playlist", {
			folderPath,
			playlistName: playlistName ?? null,
		});
	}

	async getFolders(playlistId: number): Promise<string[]> {
		return invoke("get_playlist_folders", { playlistId });
	}

	async linkFolder(
		playlistId: number,
		folderPath: string,
	): Promise<ScanFolderResult> {
		return invoke("link_playlist_folder", { playlistId, folderPath });
	}

	async unlinkFolder(playlistId: number, folderPath: string): Promise<void> {
		return invoke("unlink_playlist_folder", { playlistId, folderPath });
	}

	async refresh(playlistId: number): Promise<RefreshResult> {
		return invoke("refresh_playlist", { playlistId });
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
}

class MiscClient {
	async cleanupOrphanedCovers(): Promise<CoverGcResult> {
		return invoke("cleanup_orphaned_covers");
	}
}

class DbClient {
	playlists = new PlaylistsClient();
	songs = new SongsClient();
	misc = new MiscClient();
}

export const db = new DbClient();
