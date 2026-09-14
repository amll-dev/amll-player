import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const readProjectFile = (path) =>
	readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const transition = readProjectFile(
	"../src/components/FullscreenCoverTransition/index.tsx",
);
const transitionStyle = readProjectFile(
	"../src/components/FullscreenCoverTransition/index.module.css",
);
const wrapperStyle = readProjectFile(
	"../src/components/AMLLWrapper/index.module.css",
);
const nowPlayingBar = readProjectFile(
	"../src/components/NowPlayingBar/index.tsx",
);
const reactFullPatch = readProjectFile(
	"../../../patches/@applemusic-like-lyrics__react-full@0.4.2.patch",
);
const installedReactFull = readProjectFile(
	"../node_modules/@applemusic-like-lyrics/react-full/dist/amll-react-framework.mjs",
);

const geometryModuleUrl = pathToFileURL(
	fileURLToPath(
		new URL(
			"../src/components/FullscreenCoverTransition/geometry.ts",
			import.meta.url,
		),
	),
).href;
const geometry = await import(geometryModuleUrl);

test("封面以全屏目标为固定基准做可逆 translate-scale 共享元素变换", () => {
	const base = { left: 120, top: 80, width: 400, height: 400 };
	const source = { left: 20, top: 700, width: 75, height: 75 };
	const transform = geometry.getCoverTransform(base, source);
	assert.deepEqual(transform, {
		translateX: -100,
		translateY: 620,
		scaleX: 0.1875,
		scaleY: 0.1875,
	});
	assert.equal(
		geometry.toCoverTransformCss(transform),
		"translate(-100px, 620px) scale(0.1875, 0.1875)",
	);
	assert.equal(geometry.getUnscaledCornerRadius(6, transform), 32);
	assert.deepEqual(
		geometry.offsetCoverRect(
			{ left: 120, top: 830, width: 400, height: 400 },
			0,
			750,
		),
		base,
	);
	assert.match(transition, /const TRANSITION_DURATION = 500/);
	assert.match(
		transition,
		/FULLSCREEN_CONTENT_SELECTOR = "\[data-amll-fullscreen-content\]"/,
	);
	assert.match(transition, /new DOMMatrixReadOnly\(transform\)/);
	assert.match(transition, /transform:\s*toCoverTransformCss\(fromTransform\)/);
	assert.match(transition, /transform:\s*toCoverTransformCss\(toTransform\)/);
	assert.doesNotMatch(transition, /left:\s*`\$\{rect\.left\}px`/);
});

test("共享封面与增长面板共用时长和缓动，并处理双向端点", () => {
	assert.match(transition, /easing:\s*"cubic-bezier\(0\.25, 1, 0\.5, 1\)"/);
	assert.match(
		transition,
		/end:\s*direction === "enter" \? target\.rect : source/,
	);
	assert.match(
		nowPlayingBar,
		/captureFullscreenCoverTransition\([\s\S]*"enter"/,
	);
	assert.match(
		nowPlayingBar,
		/captureFullscreenCoverTransition\([\s\S]*"exit"/,
	);
	assert.match(nowPlayingBar, /musicCoverIsVideo/);
	assert.match(nowPlayingBar, /prefers-reduced-motion:\s*reduce/);
	assert.match(wrapperStyle, /data-amll-cover-transition="enter"/);
	assert.match(wrapperStyle, /data-amll-cover-transition="enter-handoff"/);
	assert.match(wrapperStyle, /data-amll-cover-transition="exit"/);
	assert.match(wrapperStyle, /data-amll-cover-transition="exit-handoff"/);
	assert.match(reactFullPatch, /"data-amll-cover": ""/);
	assert.match(installedReactFull, /"data-amll-cover": ""/);
});

test("共享封面服从面板裁切，并由单一视觉层平滑交给真实端点", () => {
	assert.match(
		transition,
		/const PANEL_SELECTOR = "#amll-lyric-player-wrapper"/,
	);
	assert.match(transition, /panel\.getBoundingClientRect\(\)\.top/);
	assert.match(
		transition,
		/viewport\.style\.clipPath = `inset\(\$\{panelTop\}px/,
	);
	assert.match(
		transition,
		/clipFrame = requestAnimationFrame\(syncPanelClip\)/,
	);
	assert.match(
		transition,
		/if \(clipFrame\) cancelAnimationFrame\(clipFrame\)/,
	);
	assert.match(
		transition,
		/handoffFrame = requestAnimationFrame\([\s\S]*secondHandoffFrame = requestAnimationFrame/,
	);
	assert.match(transition, /nativeEndpoint\.animate/);
	assert.match(
		transition,
		/if \(!nativeEndpoint\.isConnected\)[\s\S]*retryHandoff\(\)/,
	);
	assert.match(transition, /\[\{ opacity: 1 \}, \{ opacity: 1 \}\]/);
	assert.match(
		transition,
		/const prepareOverlayForHandoff[\s\S]*cover\.style\.filter = computedStyle\.filter[\s\S]*sourceMaterial\.style\.opacity = materialStyle\.opacity[\s\S]*geometryAnimation\?\.cancel\(\)[\s\S]*materialAnimation\?\.cancel\(\)/,
	);
	assert.doesNotMatch(
		transition,
		/const prepareOverlayForHandoff[\s\S]*cover\.style\.filter = "none"/,
	);
	assert.match(
		transition,
		/Promise\.allSettled\(\[[\s\S]*activeGeometryAnimation\.finished[\s\S]*activeMaterialAnimation\.finished[\s\S]*scheduleHandoff\(\)/,
	);
	assert.match(
		transition,
		/const syncSourceMaterial = \(\) => \{[\s\S]*getSourceMaterialStyle\(nativeSource, "::before"\)[\s\S]*backgroundColor:[\s\S]*boxShadow:[\s\S]*backdropFilter:/,
	);
	assert.match(
		transition,
		/const scheduleHandoff = \(\) => \{[\s\S]*snapshot\.direction === "enter"[\s\S]*syncTargetMaterial\(\)[\s\S]*else syncSourceMaterial\(\)[\s\S]*secondHandoffFrame = requestAnimationFrame/,
	);
	assert.match(
		transition,
		/const handleResize = \(\) => \{[\s\S]*const current = getCurrentCoverState\(\)[\s\S]*prepareOverlayForHandoff\(\)[\s\S]*resizeFrame = requestAnimationFrame/,
	);
	assert.match(transition, /const MAX_ENDPOINT_CORRECTIONS = 2/);
	assert.match(transition, /const ENDPOINT_RECT_TOLERANCE = 0\.75/);
	assert.match(transition, /const HANDOFF_RETRY_LIMIT = 8/);
	assert.match(
		transition,
		/const retryHandoff = \(\) => \{[\s\S]*if \(settled\) return[\s\S]*handoffRetries \+= 1[\s\S]*handoffRetries >= HANDOFF_RETRY_LIMIT[\s\S]*fadeOverlayAndFinish\(\)/,
	);
	assert.match(
		transition,
		/getCoverRectDelta\(current\.rect, endpointRect\)[\s\S]*ENDPOINT_CORRECTION_DURATION/,
	);
	assert.match(
		transition,
		/paintedDelta > ENDPOINT_RECT_TOLERANCE[\s\S]*setBaseRect\(cover, paintedEndpointRect\)[\s\S]*getCoverTransform\(paintedEndpointRect, paintedEndpointRect\)/,
	);
	assert.match(
		transition,
		/prepareOverlayForHandoff\(\)[\s\S]*const endpointCornerRadius = getCornerRadius[\s\S]*cover\.style\.borderRadius = `\$\{endpointCornerRadius\}px`[\s\S]*cover\.style\.filter = getVisualFilter\(nativeEndpoint\)/,
	);
	assert.match(
		transition,
		/nativeEndpoint\.animate\([\s\S]*\[\{ opacity: 1 \}, \{ opacity: 1 \}\][\s\S]*nativeHandoffAnimation = nativeAnimation[\s\S]*cover\.style\.opacity = "0"[\s\S]*requestAnimationFrame\([\s\S]*requestAnimationFrame\([\s\S]*finish\(\)/,
	);
	assert.doesNotMatch(transition, /const overlayAnimation = cover\.animate/);
	assert.match(transition, /hasIntrinsicCoverClip\(target\.element\) \? 0/);
	assert.match(
		transition,
		/PLAYBAR_CONTENT_SELECTOR = "\[data-amll-playbar-content\]"/,
	);
	assert.match(
		transition,
		/snapshot\.direction === "exit"[\s\S]*!isSourceSurfaceReady\(nativeEndpoint\)[\s\S]*requestAnimationFrame\(beginHandoff\)/,
	);
	assert.match(transition, /data-amll-cover-source-material/);
	assert.match(
		transition,
		/getSourceMaterialStyle\(sourceElement, "::before"\)/,
	);
	assert.match(transition, /sourceMaterialBackgroundColor/);
	assert.match(transition, /sourceMaterialBoxShadow/);
	assert.match(transition, /sourceMaterialBackdropFilter/);
	assert.match(transition, /data-amll-cover-target-material/);
	assert.match(transition, /nativeTarget\.cloneNode\(true\)/);
	assert.match(
		transition,
		/nativeTarget\.offsetWidth[\s\S]*nativeTarget\.offsetHeight[\s\S]*materialScaleX[\s\S]*materialScaleY[\s\S]*transform: `scale\(\$\{materialScaleX\}, \$\{materialScaleY\}\)`/,
	);
	assert.match(transition, /clone\.removeAttribute\("data-amll-cover"\)/);
	assert.match(transition, /cover\.style\.backgroundImage = "none"/);
	assert.match(transition, /cover\.style\.backgroundColor = "transparent"/);
	assert.match(transition, /cover\.style\.backgroundColor = "#111"/);
	assert.match(
		transitionStyle,
		/\.targetMaterial\s*\{[\s\S]*border-radius:\s*inherit[\s\S]*overflow:\s*hidden/,
	);
	assert.match(transition, /if \(settled \|\| handoffStarted\) return/);
	assert.match(transition, /const ENDPOINT_RETRY_LIMIT = 8/);
	assert.match(
		transition,
		/if \(!nativeEndpoint\)[\s\S]*endpointAttempts \+= 1[\s\S]*requestAnimationFrame\(beginHandoff\)[\s\S]*coverHandoffAnimation/,
	);
	assert.match(
		transition,
		/current = getCurrentCoverState\(\)[\s\S]*Number\.isFinite\(current\.materialOpacity\)/,
	);
	assert.match(
		transitionStyle,
		/\.sourceMaterial\s*\{[\s\S]*box-shadow:\s*inset 0 0 0 1px/,
	);
	assert.match(
		transition,
		/const handleResize = \(\) => \{[\s\S]*if \(handoffStarted\) \{[\s\S]*resetHandoff\(\)[\s\S]*animateGeometry\(/,
	);
	assert.match(
		transition,
		/if \(handoffStarted\) \{[\s\S]*if \(resizeFrame\) cancelAnimationFrame\(resizeFrame\)[\s\S]*resizeFrame = requestAnimationFrame/,
	);
	assert.match(
		transition,
		/if \(handoffFrame\)[\s\S]*cancelAnimationFrame\(handoffFrame\)[\s\S]*if \(secondHandoffFrame\)[\s\S]*cancelAnimationFrame\(secondHandoffFrame\)[\s\S]*if \(endpointFrame\)[\s\S]*cancelAnimationFrame\(endpointFrame\)[\s\S]*endpointAttempts = 0[\s\S]*sourceSurfaceDeadline = 0/,
	);
	assert.match(
		transition,
		/window\.visualViewport\?\.addEventListener\("resize", handleResize\)/,
	);
	assert.match(
		transition,
		/window\.visualViewport\?\.removeEventListener\("resize", handleResize\)/,
	);
});
