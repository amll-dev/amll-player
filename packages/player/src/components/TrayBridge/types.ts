export const BACKGROUND_TRAY_COMMAND_EVENT =
	"amll-player://background-tray-command";
export const BACKGROUND_TRAY_STATE_EVENT =
	"amll-player://background-tray-state";

export const CMD_UPDATE_BACKGROUND_TRAY_MENU = "update_background_tray_menu";
export const CMD_BACKGROUND_TRAY_PLAYER_READY = "background_tray_player_ready";
export const CMD_BACKGROUND_TRAY_PLAYER_ACTION =
	"background_tray_player_action";

export interface BackgroundTrayCover {
	rgba: number[];
	width: number;
	height: number;
}

export interface BackgroundTrayMenuLabels {
	appName: string;
	unknownSong: string;
	unknownArtist: string;
	noLyrics: string;
	previous: string;
	play: string;
	pause: string;
	next: string;
	taskbarLyric: string;
	showWindow: string;
	exit: string;
}

export interface BackgroundTrayMenuState {
	alwaysTray: boolean;
	musicName: string;
	artist: string;
	lyric: string;
	playing: boolean;
	canControl: boolean;
	taskbarLyricEnabled: boolean;
	cover: BackgroundTrayCover | null;
	displayCover: string;
	labels: BackgroundTrayMenuLabels;
}

export type BackgroundTrayAction =
	| "previous"
	| "toggle-playback"
	| "next"
	| "toggle-taskbar-lyric"
	| "show"
	| "exit"
	| "hide";

export interface BackgroundTrayCommandPayload {
	command: Exclude<BackgroundTrayAction, "show" | "exit" | "hide">;
}
