export type FullscreenControlMotionKind =
	| "shuffle"
	| "repeat"
	| "lyrics"
	| "playlist";

export interface FullscreenControlMotion {
	kind: FullscreenControlMotionKind;
	keyframes: Keyframe[];
	duration: number;
	easing: string;
}

const EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";

export const getFullscreenControlMotion = (
	action?: string,
	toggleType?: string,
): FullscreenControlMotion | null => {
	if (action === "shuffle") {
		return {
			kind: "shuffle",
			duration: 230,
			easing: EASING,
			keyframes: [
				{ transform: "translateX(0) rotate(0deg)", offset: 0 },
				{
					transform: "translateX(-0.04em) rotate(-3deg)",
					offset: 0.36,
				},
				{
					transform: "translateX(0.025em) rotate(1.5deg)",
					offset: 0.68,
				},
				{ transform: "translateX(0) rotate(0deg)", offset: 1 },
			],
		};
	}

	if (action === "repeat") {
		return {
			kind: "repeat",
			duration: 250,
			easing: EASING,
			keyframes: [
				{ transform: "rotate(0deg)", offset: 0 },
				{ transform: "rotate(-5deg)", offset: 0.4 },
				{ transform: "rotate(2deg)", offset: 0.7 },
				{ transform: "rotate(0deg)", offset: 1 },
			],
		};
	}

	if (toggleType === "lyrics") {
		return {
			kind: "lyrics",
			duration: 210,
			easing: EASING,
			keyframes: [
				{ transform: "rotate(0deg) scale(1)", offset: 0 },
				{ transform: "rotate(-1.5deg) scale(0.96)", offset: 0.38 },
				{ transform: "rotate(0.6deg) scale(1.015)", offset: 0.72 },
				{ transform: "rotate(0deg) scale(1)", offset: 1 },
			],
		};
	}

	if (toggleType === "playlist") {
		return {
			kind: "playlist",
			duration: 190,
			easing: EASING,
			keyframes: [
				{ transform: "scale(1)", offset: 0 },
				{ transform: "scale(0.96)", offset: 0.42 },
				{ transform: "scale(1.015)", offset: 0.72 },
				{ transform: "scale(1)", offset: 1 },
			],
		};
	}

	return null;
};
