import { useEffect, useState } from "react";

export const HIDDEN_VISUAL_RELEASE_DELAY_MS = 1_000;

/** Avoid rebuilding expensive renderers during a quick minimize/restore. */
export function useRetainedVisuals(active: boolean): boolean {
	const [retained, setRetained] = useState(active);

	useEffect(() => {
		if (active) {
			setRetained(true);
			return;
		}
		const timer = window.setTimeout(
			() => setRetained(false),
			HIDDEN_VISUAL_RELEASE_DELAY_MS,
		);
		return () => window.clearTimeout(timer);
	}, [active]);

	// Restore in this render, without waiting for the effect's next commit.
	return active || retained;
}
