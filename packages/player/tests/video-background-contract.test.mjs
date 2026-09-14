import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const readProjectFile = (path) =>
	readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const compactSource = (source) => source.replace(/\s+/g, "");

function assertSourceContains(source, label, snippets) {
	const compact = compactSource(source);
	for (const snippet of snippets) {
		const expected = compactSource(snippet);
		assert.ok(compact.includes(expected), `${label} 缺少契约：${expected}`);
	}
}

function countSourceOccurrences(source, snippet) {
	return compactSource(source).split(compactSource(snippet)).length - 1;
}

function assertSourceOrder(source, label, snippets) {
	const compact = compactSource(source);
	let previousIndex = -1;
	for (const snippet of snippets) {
		const expected = compactSource(snippet);
		const currentIndex = compact.indexOf(expected, previousIndex + 1);
		assert.ok(currentIndex > previousIndex, `${label} 顺序错误：${expected}`);
		previousIndex = currentIndex;
	}
}

const wrapper = readProjectFile("../src/components/AMLLWrapper/index.tsx");
const runtime = readProjectFile(
	"../src/components/SongVideoBackground/index.tsx",
);
const runtimeStyle = readProjectFile(
	"../src/components/SongVideoBackground/index.module.css",
);
const appAtoms = readProjectFile("../src/states/appAtoms.ts");
const localMusicContext = readProjectFile(
	"../src/components/LocalMusicContext/index.tsx",
);
const wsMusicContext = readProjectFile(
	"../src/components/WSProtocolMusicContext/index.tsx",
);
const settings = readProjectFile("../src/pages/settings/player.tsx");
const songPage = readProjectFile("../src/pages/song/index.tsx");
const songMetadata = readProjectFile("../src/pages/song/metadata.tsx");
const editor = readProjectFile("../src/pages/song/video-background.tsx");
const editorStyle = readProjectFile(
	"../src/pages/song/video-background.module.css",
);
const dbClient = readProjectFile("../src/utils/db-client.ts");
const rust = readProjectFile("../src-tauri/src/db/video_background.rs");
const overrideRust = readProjectFile(
	"../src-tauri/src/db/song_background_override.rs",
);
const migration = readProjectFile(
	"../src-tauri/src/db/migration/m20260813_000005_add_song_video_backgrounds.rs",
);
const migrationRegistry = readProjectFile(
	"../src-tauri/src/db/migration/mod.rs",
);
const overrideMigration = readProjectFile(
	"../src-tauri/src/db/migration/m20260820_000006_add_song_background_overrides.rs",
);
const videoBaseMigration = readProjectFile(
	"../src-tauri/src/db/migration/m20260820_000007_add_video_base_background.rs",
);
const entity = readProjectFile(
	"../src-tauri/src/db/entity/song_video_background.rs",
);
const overrideEntity = readProjectFile(
	"../src-tauri/src/db/entity/song_background_override.rs",
);
const tauriLib = readProjectFile("../src-tauri/src/lib.rs");
const tauriConfig = JSON.parse(readProjectFile("../src-tauri/tauri.conf.json"));

test("视频背景 slot 位于全屏歌词和录屏目标内部", () => {
	assertSourceContains(wrapper, "AMLLWrapper", [
		'import { SongVideoBackground } from "../SongVideoBackground/index.tsx";',
		'id="amll-lyric-player"',
		"backgroundSlot={<SongVideoBackground />}",
	]);
	assertSourceContains(runtime, "视频背景根节点", [
		'data-amll-song-video-background=""',
	]);
	assertSourceContains(runtimeStyle, "视频背景层", [
		".layers { position: absolute;",
		"pointer-events: none;",
		"contain: strict;",
	]);
});

test("mediaKey 同时隔离歌曲、资产、范围和版本状态", () => {
	assertSourceContains(runtime, "mediaKey", [
		"const mediaKey = useMemo(",
		`JSON.stringify([
			background.songId,
			background.assetId,
			background.filePath,
			background.durationMs,
			segment.inPointMs,
			segment.outPointMs,
			segment.loopEnabled,
			background.updatedAt,
		])`,
		"activeMediaKeyRef.current = mediaKey;",
		"mediaState.key === mediaKey",
		"key={mediaKey}",
	]);
	assertSourceContains(runtime, "视频元素", [
		"ref={setVideoElement}",
		"src={source}",
		"muted",
		"playsInline",
		"disablePictureInPicture",
		'preload="auto"',
		'aria-hidden="true"',
		"tabIndex={-1}",
		"objectFit: fitMode,",
		'objectPosition: "center center",',
		"opacity: videoOpacity,",
	]);
	assertSourceContains(runtime, "object-fit 归一化", [
		'function resolveObjectFit(value: unknown): "cover" | "contain" | "fill"',
		'return value === "contain" || value === "fill" ? value : "cover";',
		"const fitMode = resolveObjectFit(background?.fitMode);",
	]);
	assert.doesNotMatch(runtime, /\bcontrols\b/);
});

test("首帧在当前媒体解码后通过 rVFC 或双 RAF 兜底发布 ready", () => {
	assertSourceContains(runtime, "首帧 guard", [
		"const queuePresentedFrame = useCallback(",
		"const currentState = mediaStateRef.current;",
		"!lyricPageOpened",
		"!pageVisible",
		"activeMediaKeyRef.current !== expectedKey",
		"videoRef.current !== video",
		"video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA",
		'(currentState.key === expectedKey && currentState.status !== "loading")',
		'mediaStateRef.current.key === expectedKey && mediaStateRef.current.status === "failed"',
		"initialTarget?.key === expectedKey",
		"Math.abs(video.currentTime * 1_000 - initialTarget.timeMs) > FIRST_FRAME_DRIFT_MS",
	]);
	assertSourceContains(runtime, "首帧呈现确认", [
		'typeof video.requestVideoFrameCallback === "function"',
		"video.requestVideoFrameCallback(confirmPresentedFrame,)",
		"video.cancelVideoFrameCallback(videoFrameCallbackId)",
		"firstFrame = requestAnimationFrame(() => {",
		"secondFrame = requestAnimationFrame(confirmPresentedFrame);",
		"const finishAttempt = () => {",
		'updateMediaState({ key: expectedKey, status: "ready" });',
	]);
	assertSourceOrder(runtime, "rVFC 与双 RAF 必须并行竞争首帧", [
		"videoFrameCallbackId = video.requestVideoFrameCallback(",
		"firstFrame = requestAnimationFrame(() => {",
		"cancelFirstFrameRef.current = () => {",
	]);
	assertSourceContains(runtime, "首帧事件接线", [
		"initialFrameTargetRef.current = { key: mediaKey, timeMs: targetMs };",
		"onLoadedData={(event) => recoverPresentableVideo(",
		"onSeeked={(event) => queuePresentedFrame(",
		"onCanPlay={(event) => recoverPresentableVideo(",
	]);
	assert.doesNotMatch(runtime, /\bsetVideoReady\b|\bsetVideoFailed\b/);
});

test("自动播放策略拒绝只保留静态首帧，不把可解码视频回退为 Mesh", () => {
	assertSourceContains(runtime, "NotAllowedError 回退", [
		"let playbackBlocked = false;",
		"playPending || playbackBlocked",
		'error.name === "NotAllowedError"',
		"playbackBlocked = true;",
		"video.playbackRate = 1;",
	]);
	assertSourceOrder(runtime, "播放拒绝分类", [
		'error.name === "NotAllowedError"',
		"playbackBlocked = true;",
		"markVideoFailed(mediaKey, video, error);",
	]);
});

test("失败、停滞、切源和卸载都按当前 mediaKey 安全回退", () => {
	assertSourceContains(runtime, "失败隔离", [
		"const markVideoFailed = useCallback(",
		"activeMediaKeyRef.current !== expectedKey",
		'error.name === "AbortError"',
		"video.pause();",
		"video.playbackRate = 1;",
		'updateMediaState({ key: expectedKey, status: "failed" });',
	]);
	assertSourceContains(runtime, "stall watchdog", [
		"const scheduleStallFallback = useCallback(",
		"video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA",
		"markVideoFailed(expectedKey, video);",
		"}, 2_000);",
		"onStalled={(event) => scheduleStallFallback(mediaKey, event.currentTarget)}",
		"onPlaying={() => cancelStallFallback()}",
	]);
	assertSourceContains(runtime, "媒体事件失败处理", [
		"onError={(event) => markVideoFailed(mediaKey, event.currentTarget)}",
		"onAbort={(event) => markVideoFailed(mediaKey, event.currentTarget)}",
		"markVideoFailed(mediaKey, video, error);",
	]);
	assertSourceContains(runtime, "切源与卸载", [
		'updateMediaState({ key: mediaKey, status: "loading" });',
		"cancelFirstFrame();",
		"cancelStallFallback();",
		'video.removeAttribute("src");',
		"video.load();",
	]);
});

test("越界校正、显式 seek 与关闭同步后的 anchor 使用同一时间模型", () => {
	assertSourceContains(runtime, "每帧时间模型", [
		`const rawTargetMs = syncOnSeek
			? segment.inPointMs + musicMs
			: anchorRef.current.videoMs + (musicMs - anchorRef.current.musicMs);`,
		"const targetMs = resolveVideoTimeMs(rawTargetMs, segment);",
		"const actualInSegment = isVideoTimeInSegment(actualMs, segment);",
		"if (!actualInSegment) { video.currentTime = targetMs / 1_000;",
		"!segment.loopEnabled && rawTargetMs >= segment.outPointMs",
		"segment.outPointMs - VIDEO_END_FRAME_OFFSET_MS",
		"video.pause();",
	]);
	assertSourceContains(runtime, "显式 seek", [
		"const handleTimelineJump = () => {",
		"const timelineJump = store.get(musicTimelineJumpAtom);",
		"const unsubscribe = store.sub(musicTimelineJumpAtom, handleTimelineJump);",
		"if (syncOnSeek) {",
		"segment.inPointMs + timelineJump.positionMs",
		`anchorRef.current = {
			musicMs: timelineJump.positionMs,
			videoMs: video.currentTime * 1_000,
		};`,
	]);
	assertSourceContains(runtime, "媒体结束时遵守片段循环设置", [
		"onEnded={(event) => {",
		"if (!segment.loopEnabled) {",
		"segment.outPointMs - VIDEO_END_FRAME_OFFSET_MS",
		"const rawTargetMs = syncOnSeek",
		"video.currentTime = resolveVideoTimeMs(rawTargetMs, segment) / 1_000;",
	]);

	for (const reason of ["seek", "lyric-click", "track-change", "remote-jump"]) {
		assert.ok(appAtoms.includes(`"${reason}"`), `atom 缺少 ${reason}`);
	}
	for (const [source, reasons] of [
		[localMusicContext, ["seek", "lyric-click", "track-change", "remote-jump"]],
		[wsMusicContext, ["seek", "lyric-click", "track-change", "remote-jump"]],
	]) {
		for (const reason of reasons) {
			assert.ok(source.includes(`"${reason}"`), `context 缺少 ${reason}`);
		}
	}
	assertSourceContains(appAtoms, "timeline jump sequence", [
		"...event,",
		"sequence: get(musicTimelineJumpAtom).sequence + 1,",
	]);
	assertSourceContains(localMusicContext, "队列恢复 seek", [
		`pendingSeekRef.current = {
			targetPosition: position,
			requestedAt,
		};`,
		"store.set(musicPlayingPositionAtom, positionMs);",
		`store.set(emitMusicTimelineJumpAtom, {
			positionMs,
			reason: "seek",
		});`,
		'await emitAudioThread("seekAudio", { position });',
	]);
	assertSourceContains(wsMusicContext, "WS 首个进度样本", [
		"const previous = lastProgressSampleRef.current;",
		"if (!previous || Math.abs(state.progress - expectedPosition) > 500)",
		`store.set(emitMusicTimelineJumpAtom, {
			positionMs: state.progress,
			reason: "remote-jump",
		});`,
	]);
});

test("BackgroundRender 保留 Mesh、Pixi、CSS 和自定义 renderer", () => {
	assertSourceContains(runtime, "renderer 选择", [
		'import { BackgroundRender } from "@applemusic-like-lyrics/react";',
		"const videoBaseRendererMode = resolveVideoBaseRendererMode(",
		"backgroundOverride?.overrideEnabled !== true ? null",
		'backgroundOverride.rendererMode === "video" ? videoBaseRendererMode',
		'overrideBaseRendererMode === "mesh" ? MeshGradientRenderer',
		'overrideBaseRendererMode === "pixi" ? PixiRenderer',
		'overrideBaseRendererMode === "css-bg" ? "css-bg" : null',
		"const baseRendererValue = overrideBaseRenderer ?? rendererValue.renderer;",
		'typeof baseRendererValue !== "string" ? baseRendererValue',
		'baseRendererValue === "css-bg"',
		"resolveVideoBaseCssBackground(backgroundOverride.videoBaseCssBackground)",
		"style={{ background: effectiveCssBackground }}",
	]);
	assertSourceContains(runtime, "按歌曲覆盖与视频启用条件", [
		"db.songBackgroundOverrides.get(musicId)",
		"db.videoBackgrounds.get(musicId)",
		'["song_background_overrides", "song_video_backgrounds"]',
		"backgroundOverride?.overrideEnabled === true",
		'backgroundOverride.rendererMode === "video"',
		"background !== null",
	]);
	assertSourceContains(runtime, "BackgroundRender props", [
		"<BackgroundRender",
		"album={musicCover}",
		"albumIsVideo={musicCoverIsVideo}",
		"renderer={renderer}",
		"playing={basePlaying}",
		"staticMode={baseStatic}",
	]);
	assertSourceContains(runtime, "双层回退", [
		"videoReady && !videoFailed",
		"clampOpacity(configuredVideoOpacity)",
		"const baseOpacity = videoOpacity > 0 && !dualLayer ? 0 : 1;",
		"const videoCoversBase = videoOpacity === 1;",
	]);
	assertSourceContains(runtimeStyle, "图层顺序", [
		"background: #000;",
		".baseLayer { z-index: 0;",
		".videoLayer { z-index: 1;",
		"background: transparent;",
	]);
	assert.doesNotMatch(runtime, /\bset\(\s*musicCover(?:IsVideo)?Atom/);
});

test("reduced-motion、页面可见性和静态模式同时约束视频与基础 renderer", () => {
	assertSourceContains(runtime, "reduced motion 监听", [
		'window.matchMedia("(prefers-reduced-motion: reduce)").matches',
		'query.addEventListener("change", update);',
		'query.removeEventListener("change", update);',
	]);
	assertSourceContains(runtime, "视频 runnable", [
		`const runnable =
			videoOpacity > 0.001 &&
			musicPlaying &&
			lyricPageOpened &&
			pageVisible &&
			!reducedMotion &&
			!effectiveStaticMode;`,
	]);
	assertSourceContains(runtime, "基础 renderer 状态", [
		"!videoCoversBase && lyricPageOpened && pageVisible && !reducedMotion",
		"effectiveStaticMode || !lyricPageOpened || !pageVisible || reducedMotion",
	]);
	assertSourceContains(runtime, "隐藏页不判首帧超时", [
		"!lyricPageOpened",
		"!pageVisible",
		"recoverPresentableVideo(video, mediaKey, segment, syncOnSeek);",
		"}, 12_000);",
	]);
	assertSourceContains(runtimeStyle, "reduced motion 样式", [
		"@media (prefers-reduced-motion: reduce)",
		"transition-duration: 1ms;",
	]);
});

test("编辑器以 generation 隔离候选导入，并清理所有未应用资产", () => {
	assertSourceContains(editor, "候选 generation", [
		"const operationRef = useRef(0);",
		"const candidateAssetsRef = useRef(new Set<string>());",
		"const activeCandidateRef = useRef<string | null>(null);",
		"operationRef.current += 1;",
		"const operation = ++operationRef.current;",
		"operationRef.current !== operation",
	]);
	assertSourceContains(editor, "候选生命周期", [
		"candidateAssetsRef.current.add(imported.assetId);",
		"await discardCandidate(imported.assetId);",
		"void discardCandidate(previousCandidate);",
		"if (imported) await discardCandidate(imported.assetId);",
		"for (const assetId of candidateAssetsRef.current)",
		"void db.videoBackgrounds.discard(assetId)",
		"const candidateWasApplying = candidateAssetsRef.current.delete(",
		"candidateAssetsRef.current.add(snapshot.assetId);",
		"Failed to discard a video candidate after save failure",
	]);
	assertSourceContains(editor, "保存快照", [
		"async (snapshot: VideoBackgroundDraft, announce: boolean) => {",
		"void persistVideoBackground(draft, true);",
		"assetId: snapshot.assetId",
		"durationMs: snapshot.durationMs",
		"inPointMs: snapshot.inPointMs",
		"outPointMs: snapshot.outPointMs",
	]);
	assertSourceContains(editor, "行为选项即时保存", [
		'Pick<VideoBackgroundDraft, "fitMode" | "loopEnabled" | "syncOnSeek">',
		"const nextDraft = { ...draft, ...update };",
		"if (!activeCandidateRef.current) {",
		"void persistVideoBackground(nextDraft, false);",
		"updateBehaviorSetting({ loopEnabled })",
		"updateBehaviorSetting({ syncOnSeek })",
	]);
	assertSourceContains(songPage, "独立背景标签页", [
		'import { SongVideoBackgroundEditor } from "./video-background.tsx";',
		'<Tabs.Trigger value="background">',
		'<Trans i18nKey="page.song.basic.tabs.background">背景</Trans>',
		'<Tabs.Content value="background">',
		'<SongVideoBackgroundEditor key={song?.id ?? "missing-song"} />',
	]);
	assert.doesNotMatch(
		songMetadata,
		/SongVideoBackgroundEditor|\.\/video-background\.tsx/,
	);
});

test("编辑器先完成真实解码，再为短视频生成有效默认范围", () => {
	assertSourceContains(editor, "解码探测", [
		"function probeVideoMetadata(source: string): Promise<VideoMetadata>",
		'document.createElement("video")',
		'video.preload = "auto";',
		"video.muted = true;",
		"video.playsInline = true;",
		"video.onloadeddata = () => {",
		"Math.round(video.duration * 1_000)",
		"durationMs < MIN_VALID_RANGE_MS",
		"video.videoWidth <= 0",
		"video.videoHeight <= 0",
		'video.onerror = () => fail("The selected video cannot be decoded");',
		"15_000",
	]);
	assertSourceContains(editor, "探测资源清理", [
		"window.clearTimeout(timeout);",
		"video.pause();",
		'video.removeAttribute("src");',
		"video.load();",
	]);
	assertSourceContains(editor, "短视频默认范围", [
		"const preferred = Math.min(",
		"songDurationMs > 0 ? songDurationMs : videoDurationMs",
		"return Math.min(videoDurationMs, Math.max(MIN_VALID_RANGE_MS, preferred));",
		"loopEnabled: songDurationMs > outPointMs",
	]);
	assertSourceContains(editor, "预览端点", [
		"if (draft.loopEnabled) { video.currentTime = draft.inPointMs / 1_000;",
		"void video.play().catch(ignorePreviewPlayAbort);",
		"draft.outPointMs - END_FRAME_OFFSET_MS",
		"video.pause();",
		'typeof video.requestVideoFrameCallback === "function"',
		"video.requestVideoFrameCallback(tick)",
		'video.addEventListener("play", handlePlay);',
		"onEnded={(event) => enforcePreviewRange(event.currentTarget, draft)}",
	]);
});

test("编辑器禁用条件一致，复用 Radix 双端滑轨并根据端点定位预览", () => {
	assertSourceContains(editor, "禁用条件", [
		"const controlsDisabled = busy || loading || Boolean(loadError);",
		'<Button size="1" variant="soft" onClick={refetch}>',
		"disabled={!song || controlsDisabled}",
		"disabled={controlsDisabled || Boolean(loadError)}",
		"disabled={controlsDisabled}",
	]);
	assert.ok(
		countSourceOccurrences(editor, "disabled={controlsDisabled}") >= 6,
		"移除、适应方式、范围、重置和两个开关都应共享禁用状态",
	);
	assertSourceContains(editor, "Radix 双端 range", [
		"const RANGE_STEP_MS = 100;",
		"const safeDurationMs = Number.isFinite(durationMs)",
		"const finiteInPointMs = Number.isFinite(inPointMs) ? inPointMs : 0;",
		"const finiteOutPointMs = Number.isFinite(outPointMs)",
		"const minRangeMs = Math.min(MIN_VALID_RANGE_MS, safeDurationMs);",
		"<Slider",
		"ref={rangeSliderRef}",
		"step={RANGE_STEP_MS}",
		"minStepsBetweenThumbs={Math.min(MIN_VALID_RANGE_MS, videoRange.durationMs) / RANGE_STEP_MS}",
		"value={[videoRange.inPointMs, videoRange.outPointMs]}",
		"const source = getChangedVideoRangeEndpoint(",
		"videoRange, nextRange,",
		'if (next.inPointMs === previous.inPointMs) return "out";',
		'if (next.outPointMs === previous.outPointMs) return "in";',
		'return next.inPointMs === previous.outPointMs ? "out" : "in";',
		"rangeSliderRef.current?.querySelectorAll<HTMLElement>('[role=\"slider\"]')",
		'thumb.setAttribute("aria-label", endpoint.label);',
		'thumb.setAttribute("aria-valuetext", formatVideoTime(endpoint.value));',
	]);
	assert.equal(
		editor.includes("VideoBackgroundRange"),
		false,
		"歌曲页不应继续引用独立的双滑块实现",
	);
	assert.equal(
		/\.range(?:Track|Selection|Input)/.test(editorStyle),
		false,
		"歌曲页不应继续维护自定义滑轨、选区或滑块样式",
	);
	assertSourceContains(editor, "范围预览", [
		'source === "out" ? Math.max(inPointMs, outPointMs - END_FRAME_OFFSET_MS) : inPointMs',
		"seekPreviewForRangeChange(",
		"nextRange.inPointMs, nextRange.outPointMs, source,",
	]);
	assertSourceContains(editorStyle, "非 16:9 适应方式预览", [
		"aspect-ratio: 4 / 3;",
	]);
});

test("前端 invoke、Rust command 与 Tauri handler 十项逐一对应", () => {
	const commands = [
		["pick_and_import_song_video_background", /,\s*\{\s*title\s*\}/],
		["import_song_video_background", /,\s*\{\s*sourcePath\s*\}/],
		["get_song_video_background", /,\s*\{\s*songId\s*\}/],
		["save_song_video_background", /,\s*\{\s*payload\s*\}/],
		["delete_song_video_background", /,\s*\{\s*songId\s*\}/],
		["discard_song_video_background_asset", /,\s*\{\s*assetId\s*\}/],
		["cleanup_orphaned_song_video_backgrounds", /\s*/],
	];
	for (const [command, argumentPattern] of commands) {
		const invokePattern = new RegExp(
			`invoke(?:<[^>]+>)?\\("${command}"${argumentPattern.source}\\)`,
		);
		assert.match(dbClient, invokePattern, `${command} 的前端参数应保持一致`);
		assert.match(
			rust,
			new RegExp(`#\\[tauri::command\\]\\s*pub async fn ${command}\\b`),
		);
		assert.ok(
			tauriLib.includes(`db::video_background::${command},`),
			`${command} 未注册到 Tauri handler`,
		);
	}
	assert.ok(
		dbClient.includes("videoBackgrounds = new SongVideoBackgroundsClient()"),
	);

	const overrideCommands = [
		["get_song_background_override", /,\s*\{\s*songId\s*\}/],
		["save_song_background_override", /,\s*\{\s*payload\s*\}/],
		["delete_song_background_override", /,\s*\{\s*songId\s*\}/],
	];
	for (const [command, argumentPattern] of overrideCommands) {
		const invokePattern = new RegExp(
			`invoke(?:<[^>]+>)?\\("${command}"${argumentPattern.source}\\)`,
		);
		assert.match(dbClient, invokePattern, `${command} 的前端参数应保持一致`);
		assert.match(
			overrideRust,
			new RegExp(`#\\[tauri::command\\]\\s*pub async fn ${command}\\b`),
		);
		assert.ok(
			tauriLib.includes(`db::song_background_override::${command},`),
			`${command} 未注册到 Tauri handler`,
		);
	}
	assert.ok(
		dbClient.includes(
			"songBackgroundOverrides = new SongBackgroundOverridesClient()",
		),
	);
});

test("Windows 视频选择器不绑定透明主窗口且不阻塞 Tauri 事件循环", () => {
	assertSourceContains(rust, "ownerless 非阻塞选择器", [
		"use tauri_plugin_dialog::DialogExt;",
		"pub async fn pick_and_import_song_video_background(",
		"let (sender, receiver) = tokio::sync::oneshot::channel();",
		"app.dialog().file()",
		"dialog.pick_file(move |selected| {",
		"let selected = receiver.await",
		"import_song_video_background_into_directory(",
	]);
	assert.doesNotMatch(
		rust,
		/\bblocking_pick_files?\s*\(|\bset_parent\s*\(|\b(?:rx|receiver)\.recv(?:_timeout)?\s*\(/,
	);
	assert.doesNotMatch(editor, /@tauri-apps\/plugin-dialog|\bopen\s*\(\s*\{/);
	assertSourceContains(editor, "picker 取消与候选交接", [
		"busyRef.current = true;",
		"imported = await db.videoBackgrounds.pickAndImport(",
		"if (!imported) return;",
		"await discardCandidate(imported.assetId);",
		"candidateAssetsRef.current.add(imported.assetId);",
		"busyRef.current = false;",
	]);
});

test("Rust 导入只发布完整、受控且内容匹配的 AppData 资产", () => {
	assertSourceContains(rust, "导入边界", [
		'const VIDEO_BACKGROUND_DIR: &str = "song-backgrounds";',
		"const MAX_VIDEO_BACKGROUND_BYTES: u64 = 2 * 1024 * 1024 * 1024;",
		'source_path.starts_with("content://")',
		'validate_regular_file(&source, "selected video")?',
		"metadata.file_type().is_symlink() || !metadata.is_file()",
		"before.len() != opened.len() || before.modified().ok() != opened.modified().ok()",
	]);
	assertSourceContains(rust, "原子导入", [
		"VIDEO_BACKGROUND_STORAGE_LOCK.clone().lock_owned().await",
		"tokio::task::spawn_blocking",
		"let storage_guard = storage_guard;",
		"input.by_ref().take(MAX_VIDEO_BACKGROUND_BYTES + 1)",
		"output.sync_all()",
		"detect_supported_video(&partial_path)",
		"create_staged_asset_file(",
		".create_new(true)",
		"publish_staged_asset_without_overwrite(",
		"std::fs::hard_link(partial, &target)",
		"let (asset_id, target_path, mime_type, storage_guard) = copy_result?;",
		"mark_asset_pending(&asset_id);",
		"drop(storage_guard);",
	]);
	assert.deepEqual(tauriConfig.app.security.assetProtocol.scope.allow, [
		"$APPDATA/**/*",
	]);
});

test("Rust pending、事务与 GC 共同阻止未授权或在用资产丢失", () => {
	assertSourceContains(rust, "pending 与事务", [
		"static PENDING_VIDEO_BACKGROUND_ASSETS",
		"let _storage_guard = VIDEO_BACKGROUND_STORAGE_LOCK.as_ref().lock().await;",
		"let transaction = db.begin().await",
		"let asset_was_imported = is_asset_pending(&payload.asset_id)",
		"transaction.rollback().await",
		"Video background asset was not imported by this application",
		"transaction.commit().await",
		"unmark_asset_pending(&saved.asset_id);",
	]);
	assertSourceContains(rust, "GC 与 discard", [
		"referenced.extend(pending_assets_snapshot());",
		"const ORPHAN_GRACE_PERIOD: Duration",
		"should_collect_orphan(modified, now)",
		"if !file_type.is_file() { continue; }",
		"if !referenced.contains(&file_name)",
		"Cannot discard an active video background asset",
		"remove_asset_if_unreferenced_in_directory(",
	]);

	for (const behaviorTest of [
		"import_is_atomic_and_pending_asset_survives_gc_until_released",
		"concurrent_saves_upsert_one_mapping_and_collect_replaced_asset",
	]) {
		assert.ok(
			rust.includes(`async fn ${behaviorTest}()`),
			`Rust 缺少行为测试 ${behaviorTest}`,
		);
	}
	assertSourceContains(rust, "Rust 行为断言", [
		"assert_eq!(protected.deleted, 0);",
		"assert_eq!(released.deleted, 1);",
		"assert!(!pending_assets_snapshot().contains(first_id));",
		'assert!(forged_error.contains("not imported"));',
	]);
});

test("迁移、实体与独立资产目录保持同一数据契约", () => {
	assertSourceContains(rust, "独立目录", [
		".resolve(VIDEO_BACKGROUND_DIR, BaseDirectory::AppData)",
		"fn ensure_storage_directory(directory: &Path)",
		"std::fs::create_dir_all(directory)",
	]);
	assert.doesNotMatch(rust, /["']covers["']/);
	assert.ok(
		migrationRegistry.includes(
			"pub mod m20260813_000005_add_song_video_backgrounds;",
		),
	);
	assertSourceContains(migrationRegistry, "迁移补跑", [
		"m20260813_000005_add_song_video_backgrounds::Migration .up(&manager)",
	]);
	assert.ok(
		entity.includes('#[sea_orm(table_name = "song_video_backgrounds")]'),
	);
	assert.ok(migration.includes(".table(SongVideoBackgrounds::Table)"));
	for (const column of [
		"SongId",
		"AssetId",
		"MimeType",
		"DurationMs",
		"Width",
		"Height",
		"FitMode",
		"InPointMs",
		"OutPointMs",
		"LoopEnabled",
		"SyncOnSeek",
		"UpdatedAt",
	]) {
		assert.ok(
			migration.includes(`ColumnDef::new(SongVideoBackgrounds::${column})`),
			`迁移缺少列 ${column}`,
		);
	}
	assertSourceContains(migration, "关系与索引", [
		".primary_key()",
		".on_delete(ForeignKeyAction::Cascade)",
		'.name("idx_song_video_background_asset")',
	]);
});

test("按歌曲覆盖独立保存启用状态并兼容降级后新增的视频", () => {
	assertSourceContains(overrideMigration, "覆盖表结构", [
		".table(SongBackgroundOverrides::Table)",
		"ColumnDef::new(SongBackgroundOverrides::SongId)",
		"ColumnDef::new(SongBackgroundOverrides::OverrideEnabled)",
		"ColumnDef::new(SongBackgroundOverrides::RendererMode)",
		"ColumnDef::new(SongBackgroundOverrides::DualLayer)",
		"ColumnDef::new(SongBackgroundOverrides::VideoOpacity)",
		'.is_in(["mesh", "pixi", "css-bg", "video"])',
		".on_delete(ForeignKeyAction::Cascade)",
	]);
	assertSourceContains(overrideMigration, "持续兼容回填与预览结构修复", [
		'let table_already_existed = manager.has_table("song_background_overrides").await?;',
		'.has_column("song_background_overrides", "override_enabled")',
		"table_already_existed && !enabled_column_already_existed",
		"INSERT OR IGNORE INTO song_background_overrides",
		"SELECT song_id, 1, 'video', 1, 0.4, updated_at",
		"FROM song_video_backgrounds",
	]);
	assertSourceContains(videoBaseMigration, "视频基础背景兼容列", [
		'has_column( "song_background_overrides", "video_base_renderer_mode", )',
		"ColumnDef::new(SongBackgroundOverrides::VideoBaseRendererMode)",
		'.default("css-bg")',
		'has_column( "song_background_overrides", "video_base_css_background", )',
		"ColumnDef::new(SongBackgroundOverrides::VideoBaseCssBackground)",
		'.default("#000000")',
		"migration_adds_video_base_defaults_without_overwriting_existing_settings",
	]);
	assertSourceContains(overrideEntity, "覆盖实体", [
		'#[sea_orm(table_name = "song_background_overrides")]',
		"pub song_id: String",
		"pub override_enabled: bool",
		"pub renderer_mode: String",
		"pub dual_layer: bool",
		"pub video_opacity: f64",
		"pub video_base_renderer_mode: String",
		"pub video_base_css_background: String",
	]);
	assertSourceContains(migrationRegistry, "迁移注册", [
		"pub mod m20260820_000006_add_song_background_overrides;",
		"m20260820_000006_add_song_background_overrides::Migration",
		"pub mod m20260820_000007_add_video_base_background;",
		"m20260820_000007_add_video_base_background::Migration",
	]);
	assertSourceContains(rust, "保存视频自动建立覆盖", [
		"song_background_override::Entity::find_by_id(&payload.song_id)",
		"override_enabled: Set(true)",
		'renderer_mode: Set("video".to_owned())',
		"dual_layer: Set(true)",
		"video_opacity: Set(0.4)",
		'video_base_renderer_mode: Set("css-bg".to_owned())',
		'video_base_css_background: Set("#000000".to_owned())',
		'if !existing_override.override_enabled || existing_override.renderer_mode != "video"',
		'"song_background_overrides"',
	]);
	assertSourceContains(overrideRust, "基础背景 payload 校验与保存", [
		"pub video_base_renderer_mode: String",
		"pub video_base_css_background: String",
		'"mesh" | "pixi" | "css-bg"',
		"Song video base CSS background must contain 1 to 1024 bytes",
		"song_background_override::Column::VideoBaseRendererMode",
		"song_background_override::Column::VideoBaseCssBackground",
	]);
});

test("全局设置保留三项，歌曲覆盖提供四项且视频双层只提供三种基础 renderer", () => {
	const optionValues = [
		...settings.matchAll(/value:\s*"(mesh|pixi|css-bg|video)"/g),
	].map((match) => match[1]);
	assert.deepEqual([...new Set(optionValues)], ["mesh", "pixi", "css-bg"]);
	assertSourceContains(settings, "全局 renderer 仍沿用原始持久化", [
		"value={baseRendererString}",
		"onValueChange={handleBaseRendererChange}",
		'localStorage.setItem( "amll-react-full.lyricBackgroundRenderer", selectedString, );',
	]);
	assert.equal(
		countSourceOccurrences(
			settings,
			'"amll-react-full.lyricBackgroundRenderer"',
		),
		1,
	);
	assert.doesNotMatch(settings, /value:\s*"video"|LyricBackgroundMode/);
	assert.doesNotMatch(
		appAtoms,
		/amll-player\.(?:lyricBackgroundMode|videoBackgroundDualLayer|videoBackgroundOpacity)/,
	);

	const songOptionValues = [
		...editor.matchAll(/<Select\.Item\s+value="(mesh|pixi|css-bg|video)"/g),
	].map((match) => match[1]);
	assert.deepEqual(songOptionValues, [
		"mesh",
		"pixi",
		"css-bg",
		"video",
		"mesh",
		"pixi",
		"css-bg",
	]);
	assertSourceContains(editor, "按歌曲覆盖开关与条件内容", [
		"const overrideEnabled = backgroundOverride?.overrideEnabled === true;",
		"checked={overrideEnabled}",
		"onCheckedChange={handleOverrideEnabledChange}",
		"{overrideEnabled && backgroundOverride && (",
		'overrideEnabled && backgroundOverride?.rendererMode === "video"',
		"<VideoBackgroundEditor />",
	]);
	assertSourceContains(editor, "视频独立双层设置", [
		"const DEFAULT_DUAL_LAYER = true;",
		"const DEFAULT_VIDEO_OPACITY = 0.4;",
		'const DEFAULT_VIDEO_BASE_RENDERER: SongVideoBaseRendererMode = "css-bg";',
		'const DEFAULT_VIDEO_BASE_CSS_BACKGROUND = "#000000";',
		"checked={backgroundOverride.dualLayer}",
		"backgroundOverride.videoOpacity",
		"{backgroundOverride.dualLayer && (",
		"value={videoBaseRendererMode}",
		"videoBaseCssBackground",
		'<input type="color"',
		"<TextField.Root",
		"min={0}",
		"max={100}",
		"step={1}",
	]);
	assertSourceOrder(editor, "视频编辑后才显示最后的双层选项", [
		"<VideoBackgroundEditor />",
		'"page.song.backgroundOverride.dualLayer.label"',
	]);
});

test("CSS 纯色选择器不会取代原始 background 字符串输入", () => {
	assertSourceContains(settings, "CSS background", [
		"function getColorPickerValue(value: string): string",
		'<input type="color"',
		"setCssBackgroundProperty(event.currentTarget.value)",
		"<TextField.Root value={cssBackgroundProperty}",
		"setCssBackgroundProperty(e.currentTarget.value)",
	]);
});

function collectLeafEntries(value, prefix = "") {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		return Object.keys(value)
			.sort()
			.flatMap((key) =>
				collectLeafEntries(value[key], prefix ? `${prefix}.${key}` : key),
			);
	}
	return [[prefix, value]];
}

test("五种内置语言的视频背景叶子键结构完整且一致", () => {
	const localeCodes = ["en-US", "ja-JP", "vi-VN", "zh-CN", "zh-TW"];
	const localeEntries = localeCodes.map((localeCode) => {
		const json = JSON.parse(
			readProjectFile(`../locales/${localeCode}/translation.json`),
		);
		return [
			["page.song.basic.tabs.background", json.page.song.basic.tabs.background],
			...collectLeafEntries(
				json.page.song.backgroundOverride,
				"page.song.backgroundOverride",
			),
			...collectLeafEntries(
				json.page.song.videoBackground,
				"page.song.videoBackground",
			),
		].sort(([left], [right]) => left.localeCompare(right));
	});

	const referenceKeys = localeEntries[0].map(([key]) => key);
	for (let index = 0; index < localeCodes.length; index += 1) {
		const entries = localeEntries[index];
		assert.deepEqual(
			entries.map(([key]) => key),
			referenceKeys,
			`${localeCodes[index]} 的视频背景键结构不一致`,
		);
		for (const [key, value] of entries) {
			assert.equal(typeof value, "string", `${localeCodes[index]}:${key}`);
			assert.notEqual(value.trim(), "", `${localeCodes[index]}:${key}`);
		}
	}

	for (const requiredKey of [
		"page.song.basic.tabs.background",
		"page.song.backgroundOverride.enabled.label",
		"page.song.backgroundOverride.renderer.mesh",
		"page.song.backgroundOverride.renderer.pixi",
		"page.song.backgroundOverride.renderer.css",
		"page.song.backgroundOverride.renderer.video",
		"page.song.backgroundOverride.baseRenderer.label",
		"page.song.backgroundOverride.baseCssBackground.label",
		"page.song.backgroundOverride.baseCssBackground.picker",
		"page.song.backgroundOverride.dualLayer.label",
		"page.song.backgroundOverride.opacity.label",
		"page.song.videoBackground.pending",
		"page.song.videoBackground.error.import",
		"page.song.videoBackground.fit.cover",
		"page.song.videoBackground.fit.contain",
		"page.song.videoBackground.fit.fill",
		"page.song.videoBackground.fit.description",
		"page.song.videoBackground.loop.label",
		"page.song.videoBackground.syncOnSeek.label",
	]) {
		assert.ok(referenceKeys.includes(requiredKey), requiredKey);
	}
});
