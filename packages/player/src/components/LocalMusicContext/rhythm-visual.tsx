import { MeshGradientRenderer } from "@applemusic-like-lyrics/core";
import {
	fftDataAtom,
	isLyricPageOpenedAtom,
	musicIdAtom,
	musicPlayingAtom,
	musicPlayingPositionAtom,
} from "@applemusic-like-lyrics/react-full";
import { useAtomValue, useStore } from "jotai";
import { type FC, useEffect } from "react";
import {
	currentRhythmAnalysisAtom,
	rhythmVisualResetAtom,
} from "../../states/appAtoms.ts";
import {
	advanceRhythmVisualVolume,
	clamp01,
	limitRhythmVisualDelta,
	mapRhythmTargetToVolume,
	sampleAnalysisTarget,
	sampleStrongBeatTarget,
	smootherStep01,
} from "./rhythm-visual-signal.ts";

export const SILENT_RHYTHM_VOLUME = 0.0001;

const ANALYSIS_FADE_IN_MS = 500;

interface SpectralFluxState {
	lastFrame: number[] | null;
	lastSource: number[] | null;
	fluxHistory: number[];
	energyPeak: number;
	target: number;
}

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 0) {
		return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
	}
	return sorted[middle] ?? 0;
}

function resetSpectralFlux(
	state: SpectralFluxState,
	currentSource: number[] | null,
): void {
	state.lastFrame = null;
	state.lastSource = currentSource;
	state.fluxHistory = [];
	state.energyPeak = 0;
	state.target = 0;
}

function updateSpectralFlux(
	state: SpectralFluxState,
	spectrum: number[],
): number {
	if (spectrum === state.lastSource) return state.target;
	state.lastSource = spectrum;
	if (spectrum.length === 0) {
		state.target = 0;
		return 0;
	}

	const frame = spectrum.map((value) => Math.log1p(Math.max(0, value)));
	const previous = state.lastFrame;
	state.lastFrame = frame;

	const energy = frame.reduce((sum, value) => sum + value, 0) / frame.length;
	state.energyPeak = Math.max(energy, state.energyPeak * 0.97);
	const normalizedEnergy =
		state.energyPeak > Number.EPSILON ? energy / state.energyPeak : 0;

	if (!previous || previous.length !== frame.length) {
		state.target = clamp01(normalizedEnergy * 0.2);
		return state.target;
	}

	let squaredFlux = 0;
	for (let index = 0; index < frame.length; index++) {
		const difference = Math.max(
			0,
			(frame[index] ?? 0) - (previous[index] ?? 0),
		);
		squaredFlux += difference * difference;
	}
	const flux = Math.sqrt(squaredFlux / frame.length);
	state.fluxHistory.push(flux);
	if (state.fluxHistory.length > 40) state.fluxHistory.shift();

	const baseline = median(state.fluxHistory);
	const deviations = state.fluxHistory.map((value) =>
		Math.abs(value - baseline),
	);
	const deviation = median(deviations);
	const threshold = baseline + deviation * 1.5;
	const normalizedFlux = clamp01(
		(flux - threshold) / Math.max(deviation * 6, baseline * 0.5, 0.0001),
	);

	state.target = clamp01(normalizedEnergy * 0.25 + normalizedFlux * 0.75);
	return state.target;
}

/**
 * 将本地整轨分析或分析完成前的全频谱 flux 适配到现有背景强度接口。
 */
export const LocalRhythmVisualContext: FC = () => {
	const store = useStore();
	const isLyricPageOpened = useAtomValue(isLyricPageOpenedAtom);

	useEffect(() => {
		if (!isLyricPageOpened) {
			MeshGradientRenderer.setRhythmVisualSignal(0, 0);
			return;
		}

		let animationFrame = 0;
		let lastFrameTime = performance.now();
		let lastPosition: number | null = null;
		const initialMusicId = store.get(musicIdAtom);
		const initialRhythmState = store.get(currentRhythmAnalysisAtom);
		let lastMusicId = initialMusicId;
		let lastGeneration = initialRhythmState?.generation ?? -1;
		let lastResetSignal = store.get(rhythmVisualResetAtom);
		let analysisBlend =
			initialRhythmState?.musicId === initialMusicId &&
			initialRhythmState.analysis
				? 1
				: 0;
		let smoothedValue = SILENT_RHYTHM_VOLUME;
		const spectralState: SpectralFluxState = {
			lastFrame: null,
			lastSource: null,
			fluxHistory: [],
			energyPeak: 0,
			target: 0,
		};

		const resetSampling = (spectrum: number[] | null) => {
			lastPosition = null;
			resetSpectralFlux(spectralState, spectrum);
		};

		const update = (frameTime: number) => {
			const rawDeltaMs = frameTime - lastFrameTime;
			const deltaMs = Number.isFinite(rawDeltaMs) ? Math.max(0, rawDeltaMs) : 0;
			const visualDeltaMs = limitRhythmVisualDelta(deltaMs);
			lastFrameTime = frameTime;

			const musicId = store.get(musicIdAtom);
			const position = store.get(musicPlayingPositionAtom);
			const spectrum = store.get(fftDataAtom);
			const rhythmState = store.get(currentRhythmAnalysisAtom);
			const playing = store.get(musicPlayingAtom);
			const generation = rhythmState?.generation ?? -1;
			const resetSignal = store.get(rhythmVisualResetAtom);

			const musicChanged = musicId !== lastMusicId;
			if (musicChanged || generation !== lastGeneration) {
				lastMusicId = musicId;
				lastGeneration = generation;
				analysisBlend = 0;
				resetSampling(spectrum);
				if (musicChanged) {
					MeshGradientRenderer.setRhythmVisualSignal(smoothedValue, 0);
				}
			}
			if (resetSignal !== lastResetSignal) {
				lastResetSignal = resetSignal;
				resetSampling(spectrum);
			}

			if (
				lastPosition !== null &&
				(position < lastPosition - 20 ||
					Math.abs(position - lastPosition) >
						Math.max(250, Math.min(deltaMs, 100) * 3))
			) {
				resetSampling(spectrum);
			}
			lastPosition = position;

			const fallback = updateSpectralFlux(spectralState, spectrum);
			const analysis =
				rhythmState?.musicId === musicId ? rhythmState.analysis : null;
			let normalizedTarget = playing ? fallback : 0;
			let strongBeatTarget = 0;
			if (playing && analysis) {
				analysisBlend = Math.min(
					1,
					analysisBlend + deltaMs / ANALYSIS_FADE_IN_MS,
				);
				const analyzed = sampleAnalysisTarget(analysis, position);
				strongBeatTarget =
					sampleStrongBeatTarget(analysis, position) *
					smootherStep01(analysisBlend);
				normalizedTarget =
					fallback + (analyzed - fallback) * smootherStep01(analysisBlend);
			}

			const targetVolume = mapRhythmTargetToVolume(normalizedTarget);
			smoothedValue = advanceRhythmVisualVolume(
				smoothedValue,
				targetVolume,
				visualDeltaMs,
			);

			// 第二通道直接写入 Mesh 的共享轻量状态，避免 Jotai/React effect
			// 把高帧率信号离散成不均匀台阶。原作者 FFT 低频通道保持独立。
			MeshGradientRenderer.setRhythmVisualSignal(
				Math.max(SILENT_RHYTHM_VOLUME, smoothedValue),
				strongBeatTarget,
			);

			animationFrame = requestAnimationFrame(update);
		};

		animationFrame = requestAnimationFrame(update);
		return () => {
			cancelAnimationFrame(animationFrame);
			MeshGradientRenderer.setRhythmVisualSignal(0, 0);
		};
	}, [isLyricPageOpened, store]);

	return null;
};
