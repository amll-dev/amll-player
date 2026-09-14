import { atom } from "jotai";
import {
	DEFAULT_HOME_BACKGROUND_CONFIG,
	type HomeBackgroundConfig,
} from "../utils/home-background-state.ts";
import { enableExperimentalFeaturesAtom } from "./appAtoms.ts";

export const homeBackgroundConfigAtom = atom<HomeBackgroundConfig>(
	DEFAULT_HOME_BACKGROUND_CONFIG,
);

export const homeBackgroundLoadedAtom = atom(false);

// Keep the saved configuration available to the editor, but only publish it
// to renderers and theme consumers while experimental features are enabled.
export const effectiveHomeBackgroundConfigAtom = atom((get) =>
	get(enableExperimentalFeaturesAtom)
		? get(homeBackgroundConfigAtom)
		: DEFAULT_HOME_BACKGROUND_CONFIG,
);
