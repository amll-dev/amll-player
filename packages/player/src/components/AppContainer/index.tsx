import classNames from "classnames";
import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import {
	type FC,
	type PropsWithChildren,
	type ReactNode,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { ScrollViewport } from "../ScrollViewport/index.tsx";
import styles from "./index.module.css";

const sidebarWidthAtom = atomWithStorage("sidebarWidth", 256);

export const AppContainer: FC<
	PropsWithChildren<{
		sidebar?: ReactNode;
		playbar?: ReactNode;
		playbarExpanded?: boolean;
		playbarExpandedContent?: ReactNode;
	}>
> = ({
	sidebar,
	playbar,
	playbarExpanded = false,
	playbarExpandedContent,
	children,
}) => {
	const [sidebarWidth, setSidebarWidth] = useAtom(sidebarWidthAtom);
	const [dragging, setDragging] = useState(false);
	const playbarRef = useRef<HTMLDivElement>(null);
	const previousExpandedRef = useRef(playbarExpanded);
	const [sheetTransitioning, setSheetTransitioning] = useState(false);
	const routeScrollLocked = playbarExpanded || sheetTransitioning;

	useLayoutEffect(() => {
		if (previousExpandedRef.current === playbarExpanded) return;
		previousExpandedRef.current = playbarExpanded;
		setSheetTransitioning(true);
		let cancelled = false;
		let frame = 0;
		const waitForSettledHeight = () => {
			if (cancelled) return;
			const transitions =
				playbarRef.current
					?.getAnimations()
					.filter(
						(animation) =>
							"transitionProperty" in animation &&
							animation.transitionProperty === "height" &&
							(animation.playState === "running" || animation.pending),
					) ?? [];
			if (!transitions.length) {
				setSheetTransitioning(false);
				return;
			}
			// Resize may replace a transition. Recheck before releasing the route.
			void Promise.allSettled(
				transitions.map((animation) => animation.finished),
			).then(() => {
				if (!cancelled) frame = requestAnimationFrame(waitForSettledHeight);
			});
		};
		frame = requestAnimationFrame(waitForSettledHeight);
		return () => {
			cancelled = true;
			cancelAnimationFrame(frame);
		};
	}, [playbarExpanded]);
	const onSidebarDraggerMouseDown = () => {
		setDragging(true);
		const onMouseMove = (evt: MouseEvent) => {
			setSidebarWidth(
				Math.max(192, Math.min(512, window.innerWidth / 2, evt.clientX)),
			);
		};
		const onMouseUp = () => {
			window.removeEventListener("mousemove", onMouseMove);
			window.removeEventListener("mouseup", onMouseUp);
			setDragging(false);
		};
		window.addEventListener("mousemove", onMouseMove);
		window.addEventListener("mouseup", onMouseUp);
	};

	return (
		<div className={styles.appContainer} data-amll-contained-scroll="">
			<div className={styles.sidebar} style={{ width: `${sidebarWidth}px` }}>
				{sidebar}
			</div>
			<div
				className={classNames(
					styles.sidebarDivider,
					dragging && styles.dragging,
				)}
				style={{
					cursor:
						sidebarWidth === 192
							? "e-resize"
							: sidebarWidth === 512
								? "w-resize"
								: "ew-resize",
				}}
				onMouseDown={onSidebarDraggerMouseDown}
			/>
			<ScrollViewport
				className={styles.main}
				data-amll-player-main=""
				data-amll-route-scroll-locked={routeScrollLocked ? "" : undefined}
				inert={routeScrollLocked ? true : undefined}
			>
				<div className={styles.mainContent} data-amll-scroll-content="">
					{children}
				</div>
			</ScrollViewport>
			{(playbar || playbarExpandedContent) && (
				<div
					ref={playbarRef}
					className={classNames(
						styles.playbar,
						playbarExpanded && styles.playbarExpanded,
					)}
					data-amll-playbar-boundary=""
					data-amll-playbar-expanded={playbarExpanded ? "" : undefined}
				>
					{playbar}
					{playbarExpandedContent}
				</div>
			)}
		</div>
	);
};
