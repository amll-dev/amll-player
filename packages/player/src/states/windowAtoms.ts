import { atom } from "jotai";

/** Visible and not minimized; losing keyboard focus does not deactivate it. */
export const mainWindowActiveAtom = atom(true);

export const MAIN_WINDOW_ACTIVITY_EVENT = "amll-player://main-window-activity";
