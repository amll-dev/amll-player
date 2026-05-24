/**
 * @fileoverview
 * 合并调用 requestAnimationFrame 的函数减少原生调用开销
 */

declare global {
	interface Window {
		manualRafEnable: () => void;
		manualRafDisable: () => void;
		manualRafStep: (stepTime: number) => void;
	}
}

const origRaf = window.requestAnimationFrame;
const origCaf = window.cancelAnimationFrame;

const newState = () => ({
	counter: 0,
	rafMap: new Map<number, FrameRequestCallback>(),
	rafRevMap: new WeakMap<FrameRequestCallback, number>(),
	realRafHandle: null as number | null,
});
let manualMode = false;
let manualRafStepTime = 0;
let animateState = newState();

/**
 * 全局性能指标钩子，用于绑定性能监控面板的计时起点与终点
 */
export const statsHooks = {
	begin: () => {},
	end: () => {},
};

function runRafs(time: number) {
	// 记录本帧开始执行渲染和动画逻辑的时间
	statsHooks.begin();
	const curState = animateState;
	animateState = newState();
	for (const raf of curState.rafMap.values()) {
		try {
			raf(time);
		} catch (e) {
			console.error(e);
		}
	}
	// 记录本帧执行结束的时间并进行渲染耗时统计
	statsHooks.end();
}

window.manualRafEnable = () => {
	if (animateState.realRafHandle !== null) {
		origCaf(animateState.realRafHandle);
		animateState.realRafHandle = null;
	}
	manualMode = true;
	manualRafStepTime = 0;
};
window.manualRafDisable = () => {
	manualMode = false;
	if (animateState.rafMap.size > 0 && animateState.realRafHandle === null) {
		animateState.realRafHandle = origRaf(runRafs);
	}
};
window.manualRafStep = (stepTime: number) => {
	if (!manualMode) {
		throw new Error("manualRafStep: manual mode is not enabled");
	}
	manualRafStepTime += stepTime;
	runRafs(manualRafStepTime);
};

window.requestAnimationFrame = (cb) => {
	const existingId = animateState.rafRevMap.get(cb);
	if (existingId !== undefined) return existingId;
	if (animateState.realRafHandle === null && !manualMode) {
		animateState.realRafHandle = origRaf(runRafs);
	}
	animateState.counter += 1;
	const id = animateState.counter;
	animateState.rafMap.set(id, cb);
	animateState.rafRevMap.set(cb, id);
	return id;
};
window.cancelAnimationFrame = (handle) => {
	if (typeof handle !== "number") {
		throw new TypeError("cancelAnimationFrame: handle must be a number");
	}
	const cb = animateState.rafMap.get(handle);
	if (cb !== undefined) {
		animateState.rafMap.delete(handle);
		if (
			animateState.rafMap.size === 0 &&
			animateState.realRafHandle !== null &&
			!manualMode
		) {
			origCaf(animateState.realRafHandle);
			animateState.realRafHandle = null;
		}
	}
};

export {};
