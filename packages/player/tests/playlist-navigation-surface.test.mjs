import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const readProjectFile = (path) =>
	readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const playlistPage = readProjectFile("../src/pages/playlist/index.tsx");
const playlistPageStyle = readProjectFile(
	"../src/pages/playlist/index.module.css",
);

test("歌单路由在提交前加载数据且备用加载面保持系统材质", () => {
	assert.match(
		playlistPage,
		/export const loader = \(\{ params \}: LoaderFunctionArgs\) =>[\s\S]*db\.playlists\.get\(Number\(params\.id\)\)/,
	);
	assert.match(
		playlistPage,
		/const routePlaylist = useLoaderData\(\) as Playlist \| undefined/,
	);
	assert.match(
		playlistPage,
		/const \{ data: queriedPlaylist, loading: playlistLoading \} = useDbQuery\([\s\S]*\[param\.id\],[\s\S]*routePlaylist/,
	);
	assert.match(
		playlistPage,
		/const playlist =[\s\S]*queriedPlaylist\?\.id === Number\(param\.id\)[\s\S]*\? queriedPlaylist[\s\S]*: routePlaylist/,
	);
	assert.match(
		playlistPage,
		/if \(playlistLoading && playlist === undefined\) \{[\s\S]*className=\{styles\.loadingSurface\}[\s\S]*<Spinner size="3" \/>/,
	);
	assert.match(playlistPage, /i18nKey="page\.main\.loadingPlaylist"/);
	assert.match(
		playlistPageStyle,
		/\.loadingSurface\s*\{[\s\S]*width:\s*100%;[\s\S]*height:\s*100%;[\s\S]*background-color:\s*transparent/,
	);
	assert.doesNotMatch(
		playlistPageStyle,
		/\.loadingSurface\s*\{[^}]*background-color:\s*var\(--color-background\)/,
	);
});
