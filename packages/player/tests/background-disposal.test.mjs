import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

globalThis.MouseEvent ??= class {};
for (const key of [
	"HTMLImageElement",
	"HTMLVideoElement",
	"window",
	"document",
	"createImageBitmap",
]) {
	if (!(key in globalThis)) globalThis[key] = undefined;
}
const esm = await import(
	"../node_modules/@applemusic-like-lyrics/core/dist/amll-core.mjs"
);
const cjs = createRequire(import.meta.url)(
	"../node_modules/@applemusic-like-lyrics/core/dist/amll-core.cjs",
);

class TestImage extends EventTarget {
	complete = true;
	naturalWidth = 64;
	naturalHeight = 64;
	removed = [];
	removeAttribute(name) {
		this.removed.push(name);
	}
}
class TestVideo extends EventTarget {
	paused = false;
	removed = [];
	loads = 0;
	play() {
		return Promise.resolve();
	}
	pause() {
		this.paused = true;
	}
	removeAttribute(name) {
		this.removed.push(name);
	}
	load() {
		this.loads++;
	}
}
function makeRenderer(MeshGradientRenderer) {
	const renderer = Object.create(MeshGradientRenderer.prototype);
	const released = [];
	Object.assign(renderer, {
		_disposed: false,
		albumLoadController: null,
		observer: { disconnect: () => released.push("observer") },
		canvas: { remove: () => released.push("canvas") },
		mainProgram: { dispose: () => released.push("main-program") },
		quadProgram: { dispose: () => released.push("quad-program") },
		meshStates: [
			{
				mesh: { dispose: () => released.push("mesh") },
				texture: { dispose: () => released.push("texture") },
			},
		],
		gl: {
			deleteBuffer: () => released.push("buffer"),
			getExtension: () => ({ loseContext: () => released.push("context") }),
		},
		reduceImageSizeCanvas: {
			width: 32,
			height: 32,
			getContext: () => ({
				clearRect() {},
				drawImage() {
					assert.fail("Disposed renderer drew a late bitmap");
				},
			}),
		},
	});
	return { renderer, released };
}

function makePixiRenderer(PixiRenderer) {
	const renderer = Object.create(PixiRenderer.prototype);
	const containers = [];
	Object.assign(renderer, {
		_disposed: false,
		albumLoadController: null,
		observer: { disconnect() {} },
		canvas: { remove() {} },
		lastContainer: new Set(),
		app: {
			stage: {
				filters: [],
				addChild: (container) => containers.push(container),
			},
			ticker: { start() {}, remove() {} },
			destroy: (_removeView, options) => {
				for (const container of containers) {
					if (!container.destroyed) container.destroy(options);
				}
			},
		},
	});
	return renderer;
}

for (const [format, { MeshGradientRenderer, PixiRenderer }] of [
	["ESM", esm],
	["CJS", cjs],
]) {
	test(`${format}: late bitmap is closed after disposal without recreating GPU resources`, async (t) => {
		t.mock.property(globalThis, "HTMLImageElement", TestImage);
		t.mock.property(globalThis, "HTMLVideoElement", TestVideo);
		t.mock.property(globalThis, "window", { createImageBitmap: true });
		let finishBitmap;
		let markStarted;
		const started = new Promise((resolve) => {
			markStarted = resolve;
		});
		t.mock.property(globalThis, "createImageBitmap", () => {
			markStarted();
			return new Promise((resolve) => {
				finishBitmap = resolve;
			});
		});
		const { renderer, released } = makeRenderer(MeshGradientRenderer);
		const source = new TestImage();
		const loading = renderer.setAlbum(source, false);
		await started;
		const signal = renderer.albumLoadController.signal;
		renderer.dispose();
		renderer.dispose();
		let closed = 0;
		finishBitmap({ close: () => closed++ });
		await loading;
		assert.equal(signal.aborted, true);
		assert.equal(closed, 1);
		assert.equal(renderer.meshStates.length, 0);
		assert.equal(renderer.reduceImageSizeCanvas.width, 1);
		assert.equal(released.filter((item) => item === "context").length, 1);
		assert.deepEqual(
			source.removed,
			[],
			"Borrowed image source must remain intact",
		);
	});

	test(`${format}: disposing an in-flight owned video stops and releases its media source`, async (t) => {
		t.mock.property(globalThis, "HTMLImageElement", TestImage);
		t.mock.property(globalThis, "HTMLVideoElement", TestVideo);
		t.mock.property(globalThis, "window", {});
		const video = new TestVideo();
		t.mock.property(globalThis, "document", {
			createElement: (kind) => {
				assert.equal(kind, "video");
				return video;
			},
		});
		const { renderer } = makeRenderer(MeshGradientRenderer);
		const loading = renderer.setAlbum("fixture.webm", true);
		renderer.dispose();
		await loading;
		assert.equal(video.paused, true);
		assert.deepEqual(video.removed, ["src"]);
		assert.equal(video.loads, 1);
		video.dispatchEvent(new Event("playing"));
		video.dispatchEvent(new Event("timeupdate"));
		assert.equal(renderer.meshStates.length, 0);
	});

	test(`${format}: Pixi reusing a borrowed image creates independent textures and preserves its handlers`, async (t) => {
		t.mock.property(globalThis, "HTMLImageElement", TestImage);
		t.mock.property(globalThis, "HTMLVideoElement", TestVideo);
		const source = new TestImage();
		const onload = () => {};
		const onerror = () => {};
		source.onload = onload;
		source.onerror = onerror;
		const renderer = makePixiRenderer(PixiRenderer);
		await renderer.setAlbum(source, false);
		const first = renderer.curContainer;
		const firstTexture = first.children[0].texture;
		await renderer.setAlbum(source, false);
		const nextTexture = renderer.curContainer.children[0].texture;
		assert.notEqual(firstTexture, nextTexture);
		first.destroy({ children: true, texture: true, baseTexture: true });
		assert.equal(nextTexture.valid, true);
		const nextResource = nextTexture.baseTexture.resource;
		renderer.dispose();
		renderer.dispose();
		assert.equal(nextResource.destroyed, true);
		assert.equal(nextResource.source, null);
		assert.equal(source.onload, onload);
		assert.equal(source.onerror, onerror);
		assert.deepEqual(source.removed, []);
	});

	test(`${format}: Pixi disposal detaches its frame callback without stopping a borrowed video`, async (t) => {
		t.mock.property(globalThis, "HTMLImageElement", TestImage);
		t.mock.property(globalThis, "HTMLVideoElement", TestVideo);
		const video = new TestVideo();
		const cancelled = [];
		Object.assign(video, {
			readyState: 4,
			HAVE_ENOUGH_DATA: 4,
			HAVE_FUTURE_DATA: 3,
			videoWidth: 64,
			videoHeight: 64,
			src: "borrowed.webm",
			requestVideoFrameCallback: () => 42,
			cancelVideoFrameCallback: (handle) => cancelled.push(handle),
		});
		const renderer = makePixiRenderer(PixiRenderer);
		await renderer.setAlbum(video, true);
		const resource =
			renderer.curContainer.children[0].texture.baseTexture.resource;
		renderer.dispose();
		assert.equal(resource.destroyed, true);
		assert.equal(resource.source, null);
		assert.deepEqual(cancelled, [42]);
		assert.equal(video.paused, false);
		assert.equal(video.src, "borrowed.webm");
		assert.equal(video.loads, 0);
		video.dispatchEvent(new Event("play"));
	});
}
