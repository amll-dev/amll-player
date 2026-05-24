import { useEffect, useRef } from "react";
import * as Stats from "stats.js";
import { statsHooks } from "../../utils/merge-raf";

export const StatsComponent = () => {
	const containerRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const StatsConstructor = (Stats as any).default || Stats;
		if (typeof StatsConstructor !== "function") {
			console.error("Failed to load stats.js constructor.");
			return;
		}

		// 创建 stats.js 的性能指标监控实例
		const statsInstance = new StatsConstructor();

		// 设置显示面板指标（0表示帧率FPS，1表示单帧耗时MS）
		statsInstance.showPanel(0);

		const domNode = statsInstance.dom || statsInstance.domElement;

		if (!(domNode instanceof Node)) {
			console.error(
				"stats.dom or stats.domElement is not a valid Node. statsInstance:",
				statsInstance,
			);
			return;
		}

		const container = containerRef.current;
		if (!container) return;

		container.appendChild(domNode);

		(domNode as HTMLElement).style.position = "absolute";
		(domNode as HTMLElement).style.left = "0";
		(domNode as HTMLElement).style.top = "0";

		// 绑定生命周期钩子，借助全局动画调度循环记录时间
		statsHooks.begin = () => statsInstance.begin();
		statsHooks.end = () => statsInstance.end();

		return () => {
			// 组件卸载时重置钩子函数，避免引起空引用或内存泄漏
			statsHooks.begin = () => {};
			statsHooks.end = () => {};
			if (container.contains(domNode)) {
				container.removeChild(domNode);
			}
		};
	}, []);

	return (
		<div
			ref={containerRef}
			style={{
				position: "fixed",
				left: "1em",
				top: "3em",
				zIndex: 9999,
				width: "80px",
				height: "48px",
			}}
		/>
	);
};
