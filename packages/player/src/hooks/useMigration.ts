import { useCallback, useEffect, useRef, useState } from "react";
import {
	deleteOldDexieData,
	getDexieDataCounts,
	hasDexieData,
	isDexieDataMigrationCompleted,
	MIGRATION_KEY,
	type MigrationProgress,
	runMigration,
} from "../utils/dexie-data-migration";

export type MigrationStatus =
	| "idle"
	| "checking"
	| "prompt"
	| "migrating"
	| "completed"
	| "failed"
	| "skipped";

export interface MigrationState {
	status: MigrationStatus;
	progress: MigrationProgress | null;
	totalSongs: number;
	totalPlaylists: number;
	fatalError: string | null;
}

export function useMigration() {
	const [state, setState] = useState<MigrationState>({
		status: "idle",
		progress: null,
		totalSongs: 0,
		totalPlaylists: 0,
		fatalError: null,
	});
	const migrationRef = useRef(false);

	useEffect(() => {
		if (migrationRef.current) return;
		migrationRef.current = true;

		(async () => {
			if (isDexieDataMigrationCompleted()) return;

			const hasData = await hasDexieData();
			if (!hasData) {
				localStorage.setItem(MIGRATION_KEY, "true");
				return;
			}

			const counts = await getDexieDataCounts();
			setState({
				status: "prompt",
				progress: null,
				totalSongs: counts.songs,
				totalPlaylists: counts.playlists,
				fatalError: null,
			});
		})();
	}, []);

	const startMigration = useCallback(async () => {
		setState((prev) => ({ ...prev, status: "migrating" }));

		try {
			for await (const progress of runMigration()) {
				setState((prev) => ({ ...prev, progress }));
			}
			setState((prev) => ({ ...prev, status: "completed" }));
		} catch (error) {
			console.error("[Migration] Fatal error:", error);
			const message = error instanceof Error ? error.message : String(error);
			// Don't mark as completed so user can retry next time
			setState((prev) => ({
				...prev,
				status: "failed",
				fatalError: message,
			}));
		}
	}, []);

	const skipMigration = useCallback(
		async (opts?: { persist?: boolean; deleteOld?: boolean }) => {
			if (opts?.persist) {
				localStorage.setItem(MIGRATION_KEY, "true");
			}
			if (opts?.deleteOld) {
				try {
					await deleteOldDexieData();
				} catch (error) {
					console.warn("[Migration] Failed to delete old data:", error);
				}
			}
			setState((prev) => ({ ...prev, status: "skipped" }));
		},
		[],
	);

	const deleteOldData = useCallback(async () => {
		try {
			await deleteOldDexieData();
		} catch (error) {
			console.warn("[Migration] Failed to delete old data:", error);
		}
		setState({
			status: "idle",
			progress: null,
			totalSongs: 0,
			totalPlaylists: 0,
			fatalError: null,
		});
	}, []);

	const dismiss = useCallback(() => {
		setState({
			status: "idle",
			progress: null,
			totalSongs: 0,
			totalPlaylists: 0,
			fatalError: null,
		});
	}, []);

	return {
		...state,
		startMigration,
		skipMigration,
		deleteOldData,
		dismiss,
	};
}
