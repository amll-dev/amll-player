import { invoke } from "@tauri-apps/api/core";
import { db } from "../dexie";

const BATCH_SIZE = 30;
export const MIGRATION_KEY = "amll-player.dexie-data-migrated";

export interface MigrateBatchResult {
	imported: number;
	failed: number;
	failedIds: string[];
}

export interface MigrationProgress {
	phase: "songs" | "playlists" | "done";
	current: number;
	total: number;
	imported: number;
	failed: number;
	errors: string[];
}

async function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onloadend = () => {
			const dataUrl = reader.result as string;
			const base64 = dataUrl.split(",")[1];
			resolve(base64);
		};
		reader.onerror = reject;
		reader.readAsDataURL(blob);
	});
}

export function isDexieDataMigrationCompleted(): boolean {
	return localStorage.getItem(MIGRATION_KEY) === "true";
}

export async function hasDexieData(): Promise<boolean> {
	try {
		const count = await db.songs.count();
		return count > 0;
	} catch {
		return false;
	}
}

export async function getDexieDataCounts(): Promise<{
	songs: number;
	playlists: number;
}> {
	const songs = await db.songs.count();
	const playlists = await db.playlists.count();
	return { songs, playlists };
}

export async function* runMigration(): AsyncGenerator<MigrationProgress> {
	const totalSongs = await db.songs.count();
	let processedSongs = 0;
	let totalImported = 0;
	let totalFailed = 0;
	const errors: string[] = [];

	while (processedSongs < totalSongs) {
		const batch = await db.songs
			.offset(processedSongs)
			.limit(BATCH_SIZE)
			.toArray();

		if (batch.length === 0) break;

		const songsPayload = await Promise.all(
			batch.map(async (song) => {
				let coverBase64: string | undefined;
				let coverType: string | undefined;
				if (song.cover && song.cover.size > 0) {
					coverBase64 = await blobToBase64(song.cover);
					coverType = song.cover.type || undefined;
				}
				return {
					id: song.id,
					filePath: song.filePath,
					songName: song.songName,
					songArtists: song.songArtists,
					songAlbum: song.songAlbum,
					duration: song.duration,
					lyricFormat: song.lyricFormat,
					lyric: song.lyric,
					translatedLrc: song.translatedLrc ?? null,
					romanLrc: song.romanLrc ?? null,
					coverBase64: coverBase64 ?? null,
					coverType: coverType ?? null,
				};
			}),
		);

		const result: MigrateBatchResult = await invoke("migrate_songs_batch", {
			songs: songsPayload,
		});

		totalImported += result.imported;
		totalFailed += result.failed;
		for (const id of result.failedIds) {
			errors.push(`Song ${id}`);
		}
		processedSongs += batch.length;

		yield {
			phase: "songs",
			current: processedSongs,
			total: totalSongs,
			imported: totalImported,
			failed: totalFailed,
			errors,
		};
	}

	const totalPlaylists = await db.playlists.count();
	let processedPlaylists = 0;

	while (processedPlaylists < totalPlaylists) {
		const batch = await db.playlists
			.offset(processedPlaylists)
			.limit(BATCH_SIZE)
			.toArray();

		if (batch.length === 0) break;

		const playlistsPayload = await Promise.all(
			batch.map(async (playlist) => {
				let coverBase64: string | undefined;
				let coverType: string | undefined;
				if (playlist.playlistCover && playlist.playlistCover.size > 0) {
					coverBase64 = await blobToBase64(playlist.playlistCover);
					coverType = playlist.playlistCover.type || undefined;
				}
				return {
					id: playlist.id,
					name: playlist.name,
					createTime: playlist.createTime,
					updateTime: playlist.updateTime,
					playTime: playlist.playTime,
					songIds: playlist.songIds,
					coverBase64: coverBase64 ?? null,
					coverType: coverType ?? null,
				};
			}),
		);

		const result: MigrateBatchResult = await invoke("migrate_playlists_batch", {
			playlists: playlistsPayload,
		});

		totalImported += result.imported;
		totalFailed += result.failed;
		for (const id of result.failedIds) {
			errors.push(`Playlist ${id}`);
		}
		processedPlaylists += batch.length;

		yield {
			phase: "playlists",
			current: processedPlaylists,
			total: totalPlaylists,
			imported: totalImported,
			failed: totalFailed,
			errors,
		};
	}

	localStorage.setItem(MIGRATION_KEY, "true");

	yield {
		phase: "done",
		current: 0,
		total: 0,
		imported: totalImported,
		failed: totalFailed,
		errors,
	};
}

export async function deleteOldDexieData(): Promise<void> {
	await db.delete();
}
