import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

function readProjectFile(relativePath) {
	return fs
		.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8")
		.replaceAll("\r\n", "\n");
}

const app = readProjectFile("../src/App.tsx");
const appStyles = readProjectFile("../src/App.module.css");
const component = readProjectFile("../src/components/HomeBackground/index.tsx");
const componentStyles = readProjectFile(
	"../src/components/HomeBackground/index.module.css",
);
const themeManager = readProjectFile(
	"../src/components/ThemeManager/index.tsx",
);
const settingsIndex = readProjectFile("../src/pages/settings/index.tsx");
const settingsPlayer = readProjectFile("../src/pages/settings/player.tsx");
const settings = readProjectFile("../src/pages/settings/home-background.tsx");
const client = readProjectFile("../src/utils/home-background-client.ts");
const rust = readProjectFile("../src-tauri/src/home_background.rs");
const rustLib = readProjectFile("../src-tauri/src/lib.rs");

test("custom background is mounted once below app content without changing default mode", () => {
	assert.equal((app.match(/<HomeBackground\s*\/>/g) ?? []).length, 1);
	assert.match(app, /isCustomHomeBackground\(homeBackgroundConfig\)/);
	assert.match(
		app,
		/const useDarkAppearance = isDarkTheme \|\| hasCustomHomeBackground/,
	);
	assert.match(app, /appearance=\{useDarkAppearance \? "dark" : "light"\}/);
	assert.match(
		app,
		/hasCustomHomeBackground && styles\.bodyWithHomeBackground/,
	);
	assert.match(appStyles, /\.bodyWithHomeBackground\s*\{[\s\S]*z-index:\s*1/);
	assert.match(
		appStyles,
		/\.body\.bodyWithHomeBackground\s*\{[\s\S]*--color-panel:\s*rgba[\s\S]*--color-panel-solid:\s*rgba/,
	);
	assert.match(component, /if \(config\.mode === "default"\) return null/);
	assert.match(componentStyles, /z-index:\s*0/);
	assert.match(componentStyles, /pointer-events:\s*none/);
	assert.match(
		componentStyles,
		/\.background::after\s*\{[\s\S]*linear-gradient/,
	);
	assert.match(
		themeManager,
		/const forceDarkWindowTheme = isCustomHomeBackground\(homeBackgroundConfig\)/,
	);
	assert.match(
		themeManager,
		/if \(forceDarkWindowTheme\) \{\s*await appWindow\.setTheme\("dark"\)/,
	);
	assert.match(
		themeManager,
		/else if \(darkMode === DarkMode\.Auto\) \{\s*await appWindow\.setTheme\(null\)/,
	);
	assert.match(themeManager, /darkMode === DarkMode\.Dark \? "dark" : "light"/);
});

test("image, video, and solid color renderers use safe media defaults", () => {
	assert.match(component, /config\.mode === "color"/);
	assert.match(component, /config\.mode === "image"/);
	assert.match(component, /config\.mode === "video"/);
	for (const attribute of [
		"muted",
		"autoPlay",
		"loop",
		"playsInline",
		'preload="auto"',
		"disablePictureInPicture",
	]) {
		assert.ok(
			component.includes(attribute),
			`missing video attribute ${attribute}`,
		);
	}
	assert.match(component, /document\.visibilityState/);
	assert.match(component, /lyricPageOpened/);
	assert.match(component, /prefers-reduced-motion: reduce/);
	assert.match(component, /prefersReducedMotion/);
	assert.match(component, /config\.mimeType === "image\/gif"/);
	assert.match(component, /video\.removeAttribute\("src"\)/);
	assert.match(component, /style=\{\{ backgroundColor: config\.color \}\}/);
	assert.match(component, /failedSource !== source/);
	assert.match(componentStyles, /object-fit:\s*cover/);
});

test("settings expose home background controls inside general and all four modes", () => {
	assert.doesNotMatch(settingsIndex, /id:\s*"homeBackground"/);
	assert.doesNotMatch(settingsIndex, /category === "homeBackground"/);
	assert.doesNotMatch(settingsIndex, /<HomeBackgroundSettings\s*\/>/);
	assert.match(
		settingsPlayer,
		/import \{ HomeBackgroundSettings \} from "\.\/home-background\.tsx"/,
	);
	assert.equal(
		(settingsPlayer.match(/<HomeBackgroundSettings\s*\/>/g) ?? []).length,
		1,
	);
	const generalSettings = settingsPlayer.match(
		/const GeneralSettings = \(\) => \{[\s\S]*?\n\};\n\nconst LyricContentSettings/,
	)?.[0];
	assert.ok(generalSettings, "missing GeneralSettings section");
	assert.match(generalSettings, /<HomeBackgroundSettings\s*\/>/);
	assert.doesNotMatch(settings, /page\.settings\.homeBackground\.subtitle/);
	assert.doesNotMatch(settings, /page\.settings\.homeBackground\.description/);
	assert.match(
		settings,
		/page\.settings\.homeBackground\.mode\.menu\.default", "默认"/,
	);
	assert.match(
		settingsPlayer,
		/case "general":\s*return <GeneralSettings\s*\/>/,
	);
	for (const mode of ["default", "image", "video", "color"]) {
		assert.ok(
			settings.includes(`value="${mode}"`),
			`missing settings mode ${mode}`,
		);
	}
	assert.match(settings, /pickAndImportHomeBackgroundAsset/);
	assert.match(settings, /convertFileSrc\(imported\.filePath\)/);
	assert.match(settings, /probeImage\(source\)/);
	assert.match(settings, /probeVideo\(source\)/);
	assert.match(settings, /discardHomeBackgroundAsset/);
	assert.match(settings, /queuedColorRef/);
	assert.match(settings, /colorSaveRunningRef/);
	assert.match(settings, /latestPublishedHomeBackgroundMutationId/);
	assert.match(settings, /publishHomeBackgroundConfig/);
});

test("frontend commands map to registered native handlers", () => {
	const commands = [
		"get_home_background_config",
		"pick_and_import_home_background_asset",
		"apply_home_background_asset",
		"discard_home_background_asset",
		"set_home_background_color",
		"reset_home_background",
	];
	for (const command of commands) {
		assert.ok(
			client.includes(`invoke("${command}"`),
			`client missing ${command}`,
		);
		assert.ok(rust.includes(`fn ${command}`), `Rust missing ${command}`);
		assert.ok(
			rustLib.includes(`home_background::${command}`),
			`handler missing ${command}`,
		);
	}
	assert.match(client, /nextHomeBackgroundMutationId/);
	assert.match(client, /mutationId/);
	assert.match(rust, /LATEST_HOME_BACKGROUND_MUTATION_ID/);
	assert.match(rust, /claim_home_background_mutation\(mutation_id\)/);
});

test("native asset storage validates content and publishes through AppData", () => {
	assert.match(rust, /const HOME_BACKGROUND_DIR: &str = "home-backgrounds"/);
	assert.match(rust, /BaseDirectory::AppData/);
	assert.match(rust, /symlink_metadata/);
	assert.match(rust, /detect_supported_asset_from_reader/);
	assert.match(rust, /persist_noclobber/);
	assert.match(rust, /mark_asset_pending/);
	assert.match(rust, /HOME_BACKGROUND_MANIFEST/);
	assert.match(rust, /ORPHAN_GRACE_PERIOD/);
	assert.match(rust, /dialog\.pick_file/);
});

test("all bundled locales include the home background controls", () => {
	for (const locale of ["en-US", "ja-JP", "vi-VN", "zh-CN", "zh-TW"]) {
		const translation = JSON.parse(
			readProjectFile(`../locales/${locale}/translation.json`),
		);
		const home = translation.page.settings.homeBackground;
		assert.equal(typeof home.subtitle, "string", `${locale} subtitle`);
		assert.equal(typeof home.mode.menu.default, "string", `${locale} default`);
		assert.equal(typeof home.mode.menu.image, "string", `${locale} image`);
		assert.equal(typeof home.mode.menu.video, "string", `${locale} video`);
		assert.equal(typeof home.mode.menu.color, "string", `${locale} color`);
		assert.equal(typeof home.color.picker, "string", `${locale} picker`);
	}
});
