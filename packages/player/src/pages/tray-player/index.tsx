import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
	KeyboardEvent as ReactKeyboardEvent,
	ReactNode,
	PointerEvent as ReactPointerEvent,
} from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import IconForward from "../../assets/icon_forward.svg?react";
import IconRewind from "../../assets/icon_rewind.svg?react";
import { AnimatedPlayPauseIcon } from "../../components/AnimatedPlayPauseIcon/index.tsx";
import {
	BACKGROUND_TRAY_STATE_EVENT,
	type BackgroundTrayAction,
	type BackgroundTrayMenuState,
	CMD_BACKGROUND_TRAY_PLAYER_ACTION,
	CMD_BACKGROUND_TRAY_PLAYER_READY,
} from "../../components/TrayBridge/types.ts";
import styles from "./index.module.css";
import { getTrayControlPressReleaseDelay } from "./press-feedback.ts";
import { resolveTrayPlayerText } from "./text.ts";

const EMPTY_STATE: BackgroundTrayMenuState = {
	alwaysTray: false,
	musicName: "",
	artist: "",
	lyric: "",
	playing: false,
	canControl: false,
	taskbarLyricEnabled: false,
	cover: null,
	displayCover: "",
	labels: {
		appName: "AMLL Player",
		unknownSong: "未知歌曲",
		unknownArtist: "未知艺术家",
		noLyrics: "暂无歌词",
		previous: "上一首",
		play: "播放",
		pause: "暂停",
		next: "下一首",
		taskbarLyric: "任务栏歌词",
		showWindow: "显示窗口",
		exit: "退出",
	},
};

interface TrayControlButtonProps {
	ariaPressed?: boolean;
	children: ReactNode;
	className: string;
	disabled: boolean;
	label: string;
	onAction: () => void;
}

function TrayControlButton({
	ariaPressed,
	children,
	className,
	disabled,
	label,
	onAction,
}: TrayControlButtonProps) {
	const [visuallyPressed, setVisuallyPressed] = useState(false);
	const visuallyPressedRef = useRef(false);
	const pressedAtRef = useRef(0);
	const activePointerIdRef = useRef<number | null>(null);
	const hasPointerCaptureRef = useRef(false);
	const interactionSourceRef = useRef<"keyboard" | "pointer" | null>(null);
	const releaseTimerRef = useRef<number | null>(null);
	const pressGenerationRef = useRef(0);

	const clearReleaseTimer = useCallback(() => {
		if (releaseTimerRef.current === null) return;
		window.clearTimeout(releaseTimerRef.current);
		releaseTimerRef.current = null;
	}, []);

	const finishPress = useCallback(
		(generation: number) => {
			if (generation !== pressGenerationRef.current) return;
			clearReleaseTimer();
			if (!visuallyPressedRef.current) return;
			visuallyPressedRef.current = false;
			setVisuallyPressed(false);
		},
		[clearReleaseTimer],
	);

	const beginPress = useCallback(() => {
		clearReleaseTimer();
		pressGenerationRef.current += 1;
		pressedAtRef.current = performance.now();
		if (!visuallyPressedRef.current) {
			visuallyPressedRef.current = true;
			setVisuallyPressed(true);
		}
	}, [clearReleaseTimer]);

	const releasePress = useCallback(() => {
		if (!visuallyPressedRef.current || releaseTimerRef.current !== null) return;
		const generation = pressGenerationRef.current;
		const delay = getTrayControlPressReleaseDelay(
			pressedAtRef.current,
			performance.now(),
		);
		if (delay === 0) {
			finishPress(generation);
			return;
		}
		releaseTimerRef.current = window.setTimeout(
			() => finishPress(generation),
			delay,
		);
	}, [finishPress]);

	const resetPress = useCallback(() => {
		clearReleaseTimer();
		pressGenerationRef.current += 1;
		activePointerIdRef.current = null;
		hasPointerCaptureRef.current = false;
		interactionSourceRef.current = null;
		if (!visuallyPressedRef.current) return;
		visuallyPressedRef.current = false;
		setVisuallyPressed(false);
	}, [clearReleaseTimer]);

	useEffect(() => {
		if (disabled) resetPress();
	}, [disabled, resetPress]);

	const finishPointer = useCallback(
		(pointerId: number, cancelled: boolean) => {
			if (activePointerIdRef.current !== pointerId) return;
			activePointerIdRef.current = null;
			hasPointerCaptureRef.current = false;
			if (cancelled) interactionSourceRef.current = null;
			releasePress();
		},
		[releasePress],
	);

	useEffect(() => {
		const onWindowPointerUp = (event: PointerEvent) =>
			finishPointer(event.pointerId, false);
		const onWindowPointerCancel = (event: PointerEvent) =>
			finishPointer(event.pointerId, true);
		const onVisibilityChange = () => {
			if (document.hidden) resetPress();
		};
		window.addEventListener("pointerup", onWindowPointerUp);
		window.addEventListener("pointercancel", onWindowPointerCancel);
		window.addEventListener("blur", resetPress);
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => {
			window.removeEventListener("pointerup", onWindowPointerUp);
			window.removeEventListener("pointercancel", onWindowPointerCancel);
			window.removeEventListener("blur", resetPress);
			document.removeEventListener("visibilitychange", onVisibilityChange);
			clearReleaseTimer();
			pressGenerationRef.current += 1;
			activePointerIdRef.current = null;
			hasPointerCaptureRef.current = false;
			interactionSourceRef.current = null;
			visuallyPressedRef.current = false;
		};
	}, [clearReleaseTimer, finishPointer, resetPress]);

	const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
		if (!event.isPrimary || event.button !== 0) return;
		activePointerIdRef.current = event.pointerId;
		hasPointerCaptureRef.current = false;
		interactionSourceRef.current = "pointer";
		beginPress();
		try {
			event.currentTarget.setPointerCapture(event.pointerId);
			hasPointerCaptureRef.current = true;
		} catch {
			// Synthetic WebView pointer messages may not expose a capturable pointer.
		}
	};

	const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) =>
		finishPointer(event.pointerId, false);

	const onPointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) =>
		finishPointer(event.pointerId, true);

	const onPointerLeave = (event: ReactPointerEvent<HTMLButtonElement>) => {
		if (!hasPointerCaptureRef.current) finishPointer(event.pointerId, true);
	};

	const onLostPointerCapture = (
		event: ReactPointerEvent<HTMLButtonElement>,
	) => {
		hasPointerCaptureRef.current = false;
		finishPointer(event.pointerId, true);
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		interactionSourceRef.current = "keyboard";
		if (event.repeat) return;
		beginPress();
	};

	const onKeyUp = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
		if (event.key === "Enter" || event.key === " ") releasePress();
	};

	const onClick = () => {
		const followedInputSequence = interactionSourceRef.current !== null;
		interactionSourceRef.current = null;
		if (!followedInputSequence) beginPress();
		try {
			onAction();
		} finally {
			if (!followedInputSequence) releasePress();
		}
	};

	return (
		<button
			type="button"
			className={className}
			disabled={disabled}
			aria-label={label}
			aria-pressed={ariaPressed}
			data-pressed={visuallyPressed ? "true" : "false"}
			onPointerDown={onPointerDown}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerCancel}
			onPointerLeave={onPointerLeave}
			onLostPointerCapture={onLostPointerCapture}
			onKeyDown={onKeyDown}
			onKeyUp={onKeyUp}
			onBlur={resetPress}
			onClick={onClick}
		>
			{children}
		</button>
	);
}

export function TrayPlayerApp() {
	const [state, setState] = useState(EMPTY_STATE);

	useEffect(() => {
		let disposed = false;
		let unlisten: (() => void) | undefined;
		void listen<BackgroundTrayMenuState>(BACKGROUND_TRAY_STATE_EVENT, (event) =>
			setState(event.payload),
		)
			.then((dispose) => {
				if (disposed) {
					dispose();
					return;
				}
				unlisten = dispose;
				return invoke(CMD_BACKGROUND_TRAY_PLAYER_READY);
			})
			.catch((error) => console.error("初始化托盘播放器失败", error));
		return () => {
			disposed = true;
			unlisten?.();
		};
	}, []);

	const runAction = useCallback((action: BackgroundTrayAction) => {
		if (action === "toggle-playback") {
			setState((current) => ({ ...current, playing: !current.playing }));
		} else if (action === "toggle-taskbar-lyric") {
			setState((current) => ({
				...current,
				taskbarLyricEnabled: !current.taskbarLyricEnabled,
			}));
		}
		void invoke(CMD_BACKGROUND_TRAY_PLAYER_ACTION, { action }).catch((error) =>
			console.error("托盘播放器操作失败", error),
		);
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") runAction("hide");
		};
		addEventListener("keydown", onKeyDown);
		return () => removeEventListener("keydown", onKeyDown);
	}, [runAction]);

	const { title, secondary } = resolveTrayPlayerText(state);

	return (
		<main className={styles.viewport}>
			<section className={styles.card} aria-label={state.labels.appName}>
				<div className={styles.coverShell}>
					{state.displayCover ? (
						<img className={styles.cover} src={state.displayCover} alt="" />
					) : (
						<div className={styles.coverFallback} aria-hidden="true">
							<span>♪</span>
						</div>
					)}
				</div>

				<div className={styles.content}>
					<div className={styles.textBlock}>
						<div className={styles.title}>{title}</div>
						<div className={styles.lyric} role="status" aria-live="polite">
							{secondary}
						</div>
					</div>

					<div className={styles.controls}>
						<TrayControlButton
							className={styles.controlButton}
							disabled={!state.canControl}
							label={state.labels.previous}
							onAction={() => runAction("previous")}
						>
							<IconRewind />
						</TrayControlButton>
						<TrayControlButton
							className={`${styles.controlButton} ${styles.playButton}`}
							disabled={!state.canControl}
							label={state.playing ? state.labels.pause : state.labels.play}
							ariaPressed={state.playing}
							onAction={() => runAction("toggle-playback")}
						>
							<AnimatedPlayPauseIcon playing={state.playing} />
						</TrayControlButton>
						<TrayControlButton
							className={styles.controlButton}
							disabled={!state.canControl}
							label={state.labels.next}
							onAction={() => runAction("next")}
						>
							<IconForward />
						</TrayControlButton>
					</div>
				</div>

				<footer className={styles.footer}>
					<button
						type="button"
						className={styles.footerButton}
						data-active={state.taskbarLyricEnabled}
						aria-pressed={state.taskbarLyricEnabled}
						onClick={() => runAction("toggle-taskbar-lyric")}
					>
						{state.labels.taskbarLyric}
					</button>
					<span className={styles.footerSpacer} />
					<button
						type="button"
						className={styles.footerButton}
						onClick={() => runAction("show")}
					>
						{state.labels.showWindow}
					</button>
					<button
						type="button"
						className={`${styles.footerButton} ${styles.exitButton}`}
						onClick={() => runAction("exit")}
					>
						{state.labels.exit}
					</button>
				</footer>
			</section>
		</main>
	);
}
