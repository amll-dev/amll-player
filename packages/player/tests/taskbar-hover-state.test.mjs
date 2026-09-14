import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	hasPointerMoved,
	isPointerOutsideRect,
	shouldReactivateHover,
} from "../src/pages/taskbar-lyric/hover-state.ts";

const taskbarSource = readFileSync(
	fileURLToPath(
		new URL("../src/pages/taskbar-lyric/index.tsx", import.meta.url),
	),
	"utf8",
);

test("贴近屏幕底边退出后原路返回可以重新激活悬停", () => {
	const viewportHeight = 40;
	const surfaceRect = {
		left: 70,
		right: 300,
		top: 3,
		bottom: viewportHeight - 3,
	};
	const exitPointer = { x: 180, y: viewportHeight - 1 };
	const returnedPointer = { x: 180, y: viewportHeight - 4 };

	assert.equal(
		isPointerOutsideRect(exitPointer, surfaceRect),
		false,
		"屏幕边界内没有足够空间越过旧的 2px 外边距",
	);
	assert.equal(hasPointerMoved(returnedPointer, exitPointer), true);
	assert.equal(
		shouldReactivateHover(returnedPointer, exitPointer, surfaceRect),
		true,
	);
});

test("贴近屏幕右边退出后原路返回可以重新激活悬停", () => {
	const viewportWidth = 340;
	const surfaceRect = {
		left: 80,
		right: viewportWidth - 3,
		top: 3,
		bottom: 37,
	};
	const exitPointer = { x: viewportWidth - 1, y: 20 };
	const returnedPointer = { x: viewportWidth - 4, y: 20 };

	assert.equal(isPointerOutsideRect(exitPointer, surfaceRect), false);
	assert.equal(
		shouldReactivateHover(returnedPointer, exitPointer, surfaceRect),
		true,
	);
});

test("一 CSS 像素的真实回移可以重新激活悬停", () => {
	const surfaceRect = { left: 70, right: 300, top: 3, bottom: 37 };
	const exitPointer = { x: 180, y: 38 };
	const returnedPointer = { x: 180, y: 37 };

	assert.equal(hasPointerMoved(returnedPointer, exitPointer), true);
	assert.equal(
		shouldReactivateHover(returnedPointer, exitPointer, surfaceRect),
		true,
	);
});

test("百分之一百五十缩放下跨过自动隐藏边带即可重新激活悬停", () => {
	const scaleFactor = 1.5;
	const autoHideBandPhysicalPixels = 2;
	const autoHideBandCssPixels = autoHideBandPhysicalPixels / scaleFactor;
	const surfaceRect = { left: 70, right: 300, top: 3, bottom: 37 };
	const exitPointer = {
		x: 180,
		y: surfaceRect.bottom + autoHideBandCssPixels,
	};
	const returnedPointer = { x: 180, y: surfaceRect.bottom };

	assert.ok(autoHideBandCssPixels < 2);
	assert.equal(hasPointerMoved(returnedPointer, exitPointer), true);
	assert.equal(
		shouldReactivateHover(returnedPointer, exitPointer, surfaceRect),
		true,
	);
});

test("布局移动到静止指针下方时仍然不会重新激活悬停", () => {
	const surfaceRect = { left: 70, right: 300, top: 3, bottom: 37 };
	const pointer = { x: 180, y: 37 };

	assert.equal(hasPointerMoved(pointer, pointer), false);
	assert.equal(shouldReactivateHover(pointer, pointer, surfaceRect), false);
});

test("已经重新就绪时，仅移动事件回到歌词区域也能展开", () => {
	const surfaceRect = { left: 70, right: 300, top: 3, bottom: 37 };
	assert.equal(
		shouldReactivateHover({ x: 180, y: 20 }, null, surfaceRect, true),
		true,
	);
});

test("退场保护区内先重新就绪再返回，不依赖新的 mouseenter", () => {
	const surfaceRect = { left: 70, right: 300, top: 3, bottom: 37 };
	const guardPointer = { x: 320, y: 20 };
	assert.equal(isPointerOutsideRect(guardPointer, surfaceRect, 0), true);
	assert.equal(
		shouldReactivateHover(guardPointer, null, surfaceRect, true),
		false,
	);
	assert.equal(
		shouldReactivateHover({ x: 299, y: 20 }, null, surfaceRect, true),
		true,
	);
});

test("未重新就绪时仍要求真实移动，重新就绪后不受旧退出坐标阻挡", () => {
	const surfaceRect = { left: 70, right: 300, top: 3, bottom: 37 };
	const pointer = { x: 180, y: 20 };
	assert.equal(
		shouldReactivateHover(pointer, pointer, surfaceRect, false),
		false,
	);
	assert.equal(
		shouldReactivateHover(pointer, pointer, surfaceRect, true),
		true,
	);
});

test("重新就绪后同坐标鼠标回流不会因布局变化误展开", () => {
	const surfaceRect = { left: 70, right: 300, top: 3, bottom: 37 };
	const pointer = { x: 180, y: 20 };
	assert.equal(
		shouldReactivateHover(pointer, null, surfaceRect, true, pointer),
		false,
	);
});

test("保护区内重新就绪后的真实回移仍然可以展开", () => {
	const surfaceRect = { left: 70, right: 300, top: 3, bottom: 37 };
	assert.equal(
		shouldReactivateHover({ x: 299, y: 20 }, null, surfaceRect, true, {
			x: 320,
			y: 20,
		}),
		true,
	);
});

test("静止指针和仍在控件外的指针不会误触发悬停", () => {
	const surfaceRect = { left: 70, right: 300, top: 3, bottom: 37 };
	const exitPointer = { x: 180, y: 39 };

	assert.equal(
		shouldReactivateHover({ x: 180, y: 38 }, exitPointer, surfaceRect),
		false,
	);
	assert.equal(
		shouldReactivateHover({ x: 180, y: 42 }, exitPointer, surfaceRect),
		false,
	);
});

test("重新激活视觉悬停时同步恢复原生点击拦截", () => {
	const activateHoverBody = taskbarSource.match(
		/const activateHover = useCallback\(([\s\S]*?)const handleMouseEnter/,
	)?.[1];

	assert.ok(activateHoverBody, "应能找到统一的悬停激活逻辑");
	assert.match(
		activateHoverBody,
		/!isPointerOutsideRect\(pointer, surfaceRect, 0\)[\s\S]*setClickInterception\(true\)/,
	);
});
