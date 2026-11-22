import { atom } from "jotai";

/**
 * 设置页当前显示的标签，形如 `player.general` / `player.about` / `extension.<id>`。
 *
 * 放在设置页之外，是为了让菜单、深度链接等外部入口能直接切换标签，不必依赖设置页模块。
 */
export const settingsPageAtom = atom("player.general");
