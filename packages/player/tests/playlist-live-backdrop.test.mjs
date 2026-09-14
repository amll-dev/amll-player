import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	createCanvasFrameSource,
	getVideoDrawRect,
} from "../src/components/PlaylistSnapshotBackdrop/live-frame.ts";

test("视频背景保持长宽比并与居中的 contain / cover / fill 对齐", () => {
	assert.deepEqual(getVideoDrawRect(1920, 1080, 800, 800, "contain"), {
		x: 0,
		y: 175,
		width: 800,
		height: 450,
	});
	const covered = getVideoDrawRect(1920, 1080, 800, 800, "cover");
	assert.ok(covered.width >= 800 && covered.height >= 800);
	assert.equal(covered.width / covered.height, 1920 / 1080);
	assert.equal(covered.x + covered.width / 2, 400);
	assert.equal(covered.y + covered.height / 2, 400);
	assert.deepEqual(getVideoDrawRect(1920, 1080, 800, 800, "fill"), {
		x: 0,
		y: 0,
		width: 800,
		height: 800,
	});
	assert.deepEqual(getVideoDrawRect(100, 200, 800, 400, "contain"), {
		x: 300,
		y: 0,
		width: 200,
		height: 400,
	});
});

test("尚未就绪或失效的视频尺寸不会进入 drawImage", () => {
	for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		for (let index = 0; index < 4; index++) {
			const dimensions = [1920, 1080, 800, 600];
			dimensions[index] = value;
			assert.equal(getVideoDrawRect(...dimensions, "cover"), null);
		}
	}
});

for (const rejectBeforeDispose of [false, true]) {
	test(
		rejectBeforeDispose
			? "取帧播放失败立即释放媒体资源"
			: "关闭队列释放取帧媒体且重复清理不重复停止轨道",
		async (t) => {
			const stopped = [0, 0];
			const stream = {
				getTracks: () =>
					stopped.map((_, index) => ({ stop: () => stopped[index]++ })),
			};
			let playCalls = 0;
			let pauseCalls = 0;
			let rejectPlay;
			const video = {
				play: () => {
					playCalls++;
					return new Promise((_, reject) => {
						rejectPlay = reject;
					});
				},
				pause: () => {
					pauseCalls++;
				},
			};
			const previousDocument = Object.getOwnPropertyDescriptor(
				globalThis,
				"document",
			);
			Object.defineProperty(globalThis, "document", {
				configurable: true,
				value: {
					createElement: (tag) => {
						assert.equal(tag, "video");
						return video;
					},
				},
			});
			t.after(() => {
				if (previousDocument)
					Object.defineProperty(globalThis, "document", previousDocument);
				else delete globalThis.document;
			});
			const source = createCanvasFrameSource(
				{
					captureStream: (fps) => {
						assert.equal(fps, 15);
						return stream;
					},
				},
				15,
			);
			assert.equal(source.video, video);
			assert.equal(video.srcObject, stream);
			assert.equal(video.muted, true);
			assert.equal(video.playsInline, true);
			assert.equal(playCalls, 1);
			if (rejectBeforeDispose) {
				rejectPlay(new Error("Playback rejected"));
				await Promise.resolve();
				assert.equal(video.srcObject, null);
				assert.deepEqual(stopped, [1, 1]);
			}
			source.dispose();
			source.dispose();
			rejectPlay(new Error("Playback aborted while queue closed"));
			await Promise.resolve();
			assert.equal(pauseCalls, 1);
			assert.equal(video.srcObject, null);
			assert.deepEqual(stopped, [1, 1]);
		},
	);
}

test("全屏队列保留打开快照并连接持续更新的背景层", () => {
	const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
	const wrapper = read("../src/components/AMLLWrapper/index.tsx");
	const live = read("../src/components/PlaylistSnapshotBackdrop/live.tsx");
	const background = read("../src/components/SongVideoBackground/index.tsx");
	assert.match(wrapper, /<PlaylistSnapshotBackdrop/);
	assert.match(
		wrapper,
		/<PlaylistLiveBackdrop sourceContainerRef=\{lyricPageRef\}/,
	);
	assert.match(background, /data-amll-song-background-base/);
	assert.match(background, /data-amll-css-background/);
	assert.match(live, /cancelAnimationFrame\(frameId\)/);
	assert.match(live, /observer\.disconnect\(\)/);
	assert.match(live, /frameSource\?\.dispose\(\)/);
	assert.doesNotMatch(live, /take_screenshot|beginCaptureGuard/);
});
