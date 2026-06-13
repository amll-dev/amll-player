import { listen } from "@tauri-apps/api/event";
import {
	type DependencyList,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

interface DbEventPayload {
	table: string;
	action: string;
	id: number | string | Record<string, unknown>;
}

interface UseDbQueryResult<T> {
	data: T;
	loading: boolean;
	error: Error | null;
	refetch: () => void;
}

export function useDbQuery<T>(
	queryFn: () => Promise<T>,
	deps: DependencyList,
	defaultValue: T,
	watchTables?: string[],
): UseDbQueryResult<T> {
	const [data, setData] = useState<T>(defaultValue);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<Error | null>(null);
	const queryFnRef = useRef(queryFn);
	const fetchIdRef = useRef(0);
	const watchTablesRef = useRef(watchTables);

	queryFnRef.current = queryFn;
	watchTablesRef.current = watchTables;

	const fetchData = useCallback(() => {
		const currentFetchId = ++fetchIdRef.current;
		setLoading(true);
		setError(null);

		queryFnRef
			.current()
			.then((result) => {
				if (fetchIdRef.current === currentFetchId) {
					setData(result);
					setLoading(false);
				}
			})
			.catch((err) => {
				if (fetchIdRef.current === currentFetchId) {
					setError(err instanceof Error ? err : new Error(String(err)));
					setLoading(false);
				}
			});
	}, deps);

	useEffect(() => {
		fetchData();
	}, [fetchData]);

	useEffect(() => {
		if (!watchTablesRef.current?.length) return;

		const unlisten = listen<DbEventPayload>("db-row-changed", (event) => {
			const tables = watchTablesRef.current;
			if (tables?.includes(event.payload.table)) {
				fetchData();
			}
		});

		return () => {
			unlisten.then((fn) => fn());
		};
	}, [fetchData]);

	return { data, loading, error, refetch: fetchData };
}
