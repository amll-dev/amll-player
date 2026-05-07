/**
 * 清理旧版本的 IndexedDB 数据库
 *
 * 旧版本使用 IndexedDB (dexie) 存储歌词数据库.
 * 新版本迁移到 Rust 后端的二进制文件存储后, 需要清理旧数据以释放磁盘空间
 */

const OLD_DB_NAME = "amll-player";

export async function cleanupOldIndexedDB(): Promise<void> {
	try {
		if (typeof indexedDB === "undefined") {
			console.log("[Migration] IndexedDB not available, skipping cleanup");
			return;
		}

		const db = await openDatabase(OLD_DB_NAME);
		if (db) {
			const transaction = db.transaction("ttmlDB", "readwrite");
			const store = transaction.objectStore("ttmlDB");
			await objectStoreClear(store);
			console.log("[Migration] Cleared old ttmlDB data from IndexedDB");
			db.close();
		}

		localStorage.setItem("amll-player.indexeddb-migrated", "true");
		console.log("[Migration] IndexedDB cleanup completed");
	} catch (error) {
		console.warn("[Migration] Failed to cleanup IndexedDB:", error);
	}
}

export function isMigrationCompleted(): boolean {
	return localStorage.getItem("amll-player.indexeddb-migrated") === "true";
}

function openDatabase(name: string): Promise<IDBDatabase | null> {
	return new Promise((resolve) => {
		const request = indexedDB.open(name);

		request.onsuccess = () => {
			resolve(request.result);
		};

		request.onerror = () => {
			console.warn("[Migration] Failed to open database:", request.error);
			resolve(null);
		};

		request.onblocked = () => {
			console.warn("[Migration] Database open blocked");
			resolve(null);
		};
	});
}

function objectStoreClear(store: IDBObjectStore): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = store.clear();

		request.onsuccess = () => {
			resolve();
		};

		request.onerror = () => {
			reject(request.error);
		};
	});
}
