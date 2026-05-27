import type React from "react";
import { useEffect, useRef } from "react";
import styles from "./index.module.css";

declare global {
	interface Performance {
		memory?: {
			usedJSHeapSize: number;
			jsHeapSizeLimit: number;
		};
	}
}

export const StatsComponent = () => {
	const textRef = useRef<HTMLSpanElement>(null);
	const pathRef = useRef<SVGPolylineElement>(null);
	const modeRef = useRef(0);

	const panelsRef = useRef([
		{
			name: "FPS",
			fg: "#4ade80",
			maxG: 100,
			min: Infinity,
			max: 0,
			history: new Array(74).fill(0),
			latest: 0,
		},
		{
			name: "MS",
			fg: "#facc15",
			maxG: 200,
			min: Infinity,
			max: 0,
			history: new Array(74).fill(0),
			latest: 0,
		},
		{
			name: "MB",
			fg: "#f472b6",
			maxG: 100,
			min: Infinity,
			max: 0,
			history: new Array(74).fill(0),
			latest: 0,
		},
	]);

	const renderUI = (modeIndex: number) => {
		const panel = panelsRef.current[modeIndex];

		if (textRef.current) {
			textRef.current.textContent = `${Math.round(panel.latest)} ${panel.name} (${Math.round(panel.min)}-${Math.round(panel.max)})`;
			textRef.current.style.color = panel.fg;
		}

		if (pathRef.current) {
			const points = panel.history
				.map((val, i) => {
					const normalizedY = Math.max(
						0,
						Math.min(30, (1 - val / panel.maxG) * 30),
					);
					return `${i},${normalizedY}`;
				})
				.join(" ");

			pathRef.current.setAttribute("points", points);
			pathRef.current.setAttribute("stroke", panel.fg);
		}
	};

	useEffect(() => {
		let beginTime = performance.now();
		let prevTime = beginTime;
		let frames = 0;
		let frameId: number;

		const updateData = (
			value: number,
			modeIndex: number,
			dynamicMaxG?: number,
		) => {
			const panel = panelsRef.current[modeIndex];
			panel.latest = value;
			panel.min = Math.min(panel.min, value);
			panel.max = Math.max(panel.max, value);
			if (dynamicMaxG) panel.maxG = dynamicMaxG;

			panel.history.shift();
			panel.history.push(value);

			if (modeRef.current === modeIndex) {
				renderUI(modeIndex);
			}
		};

		const animate = () => {
			const time = performance.now();
			frames++;

			updateData(time - beginTime, 1);

			if (time >= prevTime + 1000) {
				const fps = (frames * 1000) / (time - prevTime);
				updateData(fps, 0);

				if (performance?.memory) {
					const memory = performance.memory;
					updateData(
						memory.usedJSHeapSize / 1048576,
						2,
						memory.jsHeapSizeLimit / 1048576,
					);
				}

				prevTime = time;
				frames = 0;
			}

			beginTime = time;
			frameId = requestAnimationFrame(animate);
		};

		frameId = requestAnimationFrame(animate);

		return () => cancelAnimationFrame(frameId);
	}, []);

	const handleClick = (e: React.MouseEvent) => {
		e.preventDefault();
		const supportsMemory = performance?.memory;
		const maxModes = supportsMemory ? 3 : 2;

		modeRef.current = (modeRef.current + 1) % maxModes;

		renderUI(modeRef.current);
	};

	return (
		<div onClick={handleClick} className={styles.container}>
			<span ref={textRef} className={styles.text}>
				-- FPS
			</span>
			<svg
				width="74"
				height="30"
				viewBox="0 0 74 30"
				preserveAspectRatio="none"
				className={styles.chart}
			>
				<polyline
					ref={pathRef}
					fill="none"
					strokeWidth="1.5"
					strokeLinejoin="round"
					strokeLinecap="round"
					className={styles.line}
				/>
			</svg>
		</div>
	);
};
