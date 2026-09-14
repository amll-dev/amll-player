import {
	AudioQualityType,
	fftDataAtom,
	fftDataRangeAtom,
	hideLyricViewAtom,
	isLyricPageOpenedAtom,
	lowFreqVolumeAtom,
	type MusicQualityState,
	musicAlbumNameAtom,
	musicArtistsAtom,
	musicCoverAtom,
	musicCoverIsVideoAtom,
	musicDurationAtom,
	musicIdAtom,
	musicLyricLinesAtom,
	musicNameAtom,
	musicPlayingAtom,
	musicPlayingPositionAtom,
	musicQualityAtom,
	musicQualityTagAtom,
	musicVolumeAtom,
	onChangeVolumeAtom,
	onClickAudioQualityTagAtom,
	onClickControlThumbAtom,
	onCycleRepeatModeAtom,
	onLyricLineClickAtom,
	onPlayOrResumeAtom,
	onRequestNextSongAtom,
	onRequestOpenMenuAtom,
	onRequestPrevSongAtom,
	onSeekPositionAtom,
	onToggleShuffleAtom,
} from "@applemusic-like-lyrics/react-full";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import chalk from "chalk";
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import {
	type FC,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import { useLyricParser } from "../../hooks/useLyricParser.ts";
import {
	audioQualityDialogOpenedAtom,
	currentLyricAuthorsAtom,
	currentRhythmAnalysisAtom,
	currentSongWritersAtom,
	emitMusicTimelineJumpAtom,
	enableGaplessPlaybackAtom,
	enableLoudnessNormalizationAtom,
	enableMediaControlsAtom,
	queueManagerAtom,
	rhythmVisualResetAtom,
} from "../../states/appAtoms.ts";
import {
	db,
	getCurrentTrackLoudness,
	getRhythmPrecacheProgress,
	type RhythmPrecacheProgress,
	startRhythmPrecache,
} from "../../utils/db-client.ts";
import { SyncStatus, syncLyrics } from "../../utils/lyric-db-api.ts";
import {
	PlayQueueManager,
	queueCurrentSongAtom,
	queueLoudnessUpdatePolicyAtom,
	shouldSuppressAutomaticLoudnessUpdate,
} from "../../utils/play-queue-manager.ts";
import {
	type AudioQuality,
	type AudioThreadEvent,
	emitAudioThread,
	initAudioThread,
	listenAudioThreadEvent,
} from "../../utils/player.ts";
import { useDbQuery } from "../../utils/use-db-query.ts";
import {
	type RhythmAnalysisRequestIdentity,
	RhythmAnalysisRetryController,
} from "./rhythm-analysis-retry.ts";
import { LocalRhythmVisualContext } from "./rhythm-visual.tsx";

export const FFTToLowPassContext: FC = () => {
	const store = useStore();
	const fftDataRange = useAtomValue(fftDataRangeAtom);
	// const isLyricPageOpened = useAtomValue(isLyricPageOpenedAtom);

	useEffect(() => {
		emitAudioThread("setFFTRange", {
			fromFreq: fftDataRange[0],
			toFreq: fftDataRange[1],
		});
	}, [fftDataRange]);

	useEffect(() => {
		// if (!isLyricPageOpened) return;
		let rafId: number;
		let curValue = 1;
		let lt = 0;

		const gradient: number[] = [];

		function amplitudeToLevel(amplitude: number): number {
			const normalizedAmplitude = amplitude / 255;
			const level = 0.5 * Math.log10(normalizedAmplitude + 1);
			return level;
		}

		function calculateGradient(fftData: number[]): number {
			const window = 10;
			const volume =
				(amplitudeToLevel(fftData[0]) + amplitudeToLevel(fftData[1])) * 0.5;
			if (gradient.length < window && !gradient.includes(volume)) {
				gradient.push(volume);
				return 0;
			}
			gradient.shift();
			gradient.push(volume);

			const maxInInterval = Math.max(...gradient) ** 2;
			const minInInterval = Math.min(...gradient);
			const difference = maxInInterval - minInInterval;
			// console.log(volume, maxInInterval, minInInterval, difference);
			return difference > 0.35 ? maxInInterval : minInInterval * 0.5 ** 2;
		}

		const onFrame = (dt: number) => {
			const fftData = store.get(fftDataAtom);

			const delta = dt - lt;
			const gradient = calculateGradient(fftData);

			const value = gradient;

			const increasing = curValue < value;

			if (increasing) {
				curValue = Math.min(
					value,
					curValue + (value - curValue) * 0.003 * delta,
				);
			} else {
				curValue = Math.max(
					value,
					curValue + (value - curValue) * 0.003 * delta,
				);
			}

			if (Number.isNaN(curValue)) curValue = 1;

			store.set(lowFreqVolumeAtom, curValue);

			lt = dt;
			rafId = requestAnimationFrame(onFrame);
		};
		rafId = requestAnimationFrame(onFrame);
		return () => {
			cancelAnimationFrame(rafId);
		};
	}, [store]);
	// }, [store, isLyricPageOpened]);

	return null;
};

const RHYTHM_PRECACHE_TOAST_ID = "rhythm-precache-progress";

/**
 * 项目当前的 i18next 版本组合不会对 defaultValue 做变量插值,这里手动
 * 替换 {{name}} 占位符;若未来 i18next 已完成插值,正则匹配不到即原样
 * 返回,两种情况都安全。
 */
function formatPrecacheMessage(
	template: string,
	values: Record<string, string | number>,
): string {
	return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
		name in values ? String(values[name]) : match,
	);
}

/**
 * 后台预建节奏缓存的全局进度提示。挂载时先补拉一次快照,再订阅后端的
 * 进度事件,并触发一次启动扫描——分析器版本升级后的全库重建也由这次
 * 扫描自动完成。
 */
const RhythmPrecacheProgressContext: FC = () => {
	const { t } = useTranslation();

	useEffect(() => {
		let disposed = false;
		const apply = (progress: RhythmPrecacheProgress | null | undefined) => {
			if (disposed || !progress || progress.total === 0) return;
			const finished = progress.done + progress.failed;
			if (progress.active) {
				const render = progress.currentSongName
					? formatPrecacheMessage(
							t("rhythmPrecache.progressWithSong", {
								defaultValue:
									"正在预建节奏缓存 {{finished}}/{{total}}：{{song}}",
							}),
							{
								finished,
								total: progress.total,
								song: progress.currentSongName,
							},
						)
					: formatPrecacheMessage(
							t("rhythmPrecache.progress", {
								defaultValue: "正在预建节奏缓存 {{finished}}/{{total}}",
							}),
							{ finished, total: progress.total },
						);
				if (toast.isActive(RHYTHM_PRECACHE_TOAST_ID)) {
					toast.update(RHYTHM_PRECACHE_TOAST_ID, {
						render,
						autoClose: false,
						type: "info",
					});
				} else {
					toast.info(render, {
						toastId: RHYTHM_PRECACHE_TOAST_ID,
						autoClose: false,
						closeOnClick: false,
					});
				}
			} else if (toast.isActive(RHYTHM_PRECACHE_TOAST_ID)) {
				const render =
					progress.failed > 0
						? formatPrecacheMessage(
								t("rhythmPrecache.doneWithFailures", {
									defaultValue:
										"节奏缓存完成：成功 {{done}} 首，失败 {{failed}} 首",
								}),
								{ done: progress.done, failed: progress.failed },
							)
						: formatPrecacheMessage(
								t("rhythmPrecache.done", {
									defaultValue: "节奏缓存已就绪（{{done}} 首）",
								}),
								{ done: progress.done },
							);
				toast.update(RHYTHM_PRECACHE_TOAST_ID, {
					render,
					type: progress.failed > 0 ? "warning" : "success",
					autoClose: 6000,
				});
			}
		};

		void getRhythmPrecacheProgress()
			.then(apply)
			.catch(() => {});
		const unlistenPromise = listen<RhythmPrecacheProgress>(
			"rhythm-precache-progress",
			(event) => apply(event.payload),
		);
		void startRhythmPrecache().catch((error) => {
			console.warn("[RhythmPrecache] Failed to start precache sweep", error);
		});

		return () => {
			disposed = true;
			void unlistenPromise.then((unlisten) => unlisten());
		};
	}, [t]);

	return null;
};

const MusicQualityTagText: FC = () => {
	const { t } = useTranslation();
	const musicQuality = useAtomValue<MusicQualityState>(musicQualityAtom);
	const setMusicQualityTag = useSetAtom(musicQualityTagAtom);

	useLayoutEffect(() => {
		switch (musicQuality.type) {
			case AudioQualityType.None:
				return setMusicQualityTag(null);

			case AudioQualityType.Lossless:
				return setMusicQualityTag({
					tagIcon: true,
					tagText: t("amll.qualityTag.lossless", "无损"),
					isDolbyAtmos: false,
				});

			case AudioQualityType.HiResLossless:
				return setMusicQualityTag({
					tagIcon: true,
					tagText: t("amll.qualityTag.hires", "高解析度无损"),
					isDolbyAtmos: false,
				});

			case AudioQualityType.DolbyAtmos:
				return setMusicQualityTag({
					tagIcon: false,
					tagText: "",
					isDolbyAtmos: true,
				});

			default:
				return setMusicQualityTag(null);
		}
	}, [t, musicQuality, setMusicQualityTag]);

	return null;
};
const LYRIC_LOG_TAG = chalk.bgHex("#FF4444").hex("#FFFFFF")(" LYRIC ");

const LyricContext: FC = () => {
	const musicId = useAtomValue(musicIdAtom);
	const setLyricLines = useSetAtom(musicLyricLinesAtom);
	const setHideLyricView = useSetAtom(hideLyricViewAtom);
	const setLyricAuthors = useSetAtom(currentLyricAuthorsAtom);
	const setSongWriters = useSetAtom(currentSongWritersAtom);
	const { data: song } = useDbQuery(
		() => (musicId ? db.songs.get(musicId) : Promise.resolve(undefined)),
		[musicId],
		undefined,
		["songs"],
	);

	useEffect(() => {
		syncLyrics().then((result) => {
			switch (result.status) {
				case SyncStatus.Updated:
					console.log(
						LYRIC_LOG_TAG,
						`歌词库更新完成，新增 ${result.count} 个歌词`,
					);
					break;
				// case SyncStatus.Skipped:
				// 	console.log(LYRIC_LOG_TAG, "歌词库已是最新");
				// 	break;
				// case SyncStatus.Failed:
				// 	console.warn(LYRIC_LOG_TAG, "歌词库同步失败", result.error);
				// 	break;
				// case SyncStatus.Empty:
				// 	console.log(LYRIC_LOG_TAG, "远程歌词库为空");
				// 	break;
			}
		});
	}, []);

	const { lyricLines, hasLyrics, metadata } = useLyricParser(
		song?.lyric,
		song?.lyricFormat,
		song?.translatedLrc ?? undefined,
		song?.romanLrc ?? undefined,
	);

	useEffect(() => {
		setLyricLines(lyricLines);
		setHideLyricView(!hasLyrics);

		let lyricAuthors: string[] = [];
		let songWriters: string[] = [];

		if (metadata && metadata.length > 0) {
			for (const [key, values] of metadata) {
				if (key === "ttmlAuthorGithubLogin") {
					lyricAuthors = values;
				} else if (key === "songwriters") {
					songWriters = values;
				}
			}
		}

		setLyricAuthors(lyricAuthors);
		setSongWriters(songWriters);
	}, [
		lyricLines,
		hasLyrics,
		metadata,
		setLyricLines,
		setHideLyricView,
		setLyricAuthors,
		setSongWriters,
	]);

	return null;
};

export const LocalMusicContext: FC = () => {
	const store = useStore();
	const { t } = useTranslation();
	const enableLoudnessNormalization = useAtomValue(
		enableLoudnessNormalizationAtom,
	);
	const currentRhythmAnalysis = useAtomValue(currentRhythmAnalysisAtom);
	const firstPlay = useRef(true);
	const [musicPlaying, setMusicPlaying] = useAtom(musicPlayingAtom);
	const lastSyncRef = useRef({
		position: 0,
		timestamp: performance.now(),
	});
	const rhythmGenerationRef = useRef(0);
	const musicInfoGenerationRef = useRef(0);
	const pendingSeekRef = useRef<{
		targetPosition: number;
		requestedAt: number;
	} | null>(null);
	const rhythmAnalysisRetryRef = useRef<RhythmAnalysisRetryController | null>(
		null,
	);
	if (!rhythmAnalysisRetryRef.current) {
		rhythmAnalysisRetryRef.current = new RhythmAnalysisRetryController();
	}

	const beginRhythmGeneration = useCallback(
		(musicId: string | null): number => {
			const generation = ++rhythmGenerationRef.current;
			rhythmAnalysisRetryRef.current?.begin(
				musicId ? { musicId, generation } : null,
			);
			store.set(
				currentRhythmAnalysisAtom,
				musicId ? { musicId, generation, analysis: null } : null,
			);
			return generation;
		},
		[store],
	);

	const requestRhythmAnalysis = useCallback(
		async function requestCurrentRhythmAnalysis(
			musicId: string,
			generation: number,
			requireLoudness = store.get(enableLoudnessNormalizationAtom),
		) {
			const identity: RhythmAnalysisRequestIdentity = { musicId, generation };
			try {
				const analysis = await db.songs.getOrAnalyzeRhythm(
					musicId,
					false,
					requireLoudness,
				);
				const current = store.get(currentRhythmAnalysisAtom);
				if (
					generation !== rhythmGenerationRef.current ||
					current?.generation !== generation ||
					current.musicId !== musicId ||
					store.get(musicIdAtom) !== musicId
				) {
					return;
				}
				rhythmAnalysisRetryRef.current?.succeed(identity);
				store.set(currentRhythmAnalysisAtom, {
					musicId,
					generation,
					analysis,
				});
			} catch (error) {
				const current = store.get(currentRhythmAnalysisAtom);
				if (
					generation !== rhythmGenerationRef.current ||
					current?.generation !== generation ||
					current.musicId !== musicId ||
					store.get(musicIdAtom) !== musicId
				) {
					return;
				}

				const schedule = rhythmAnalysisRetryRef.current?.scheduleFailure(
					identity,
					error,
					(retryIdentity) => {
						const retryState = store.get(currentRhythmAnalysisAtom);
						if (
							retryIdentity.generation !== rhythmGenerationRef.current ||
							retryState?.generation !== retryIdentity.generation ||
							retryState.musicId !== retryIdentity.musicId ||
							store.get(musicIdAtom) !== retryIdentity.musicId
						) {
							return;
						}
						void requestCurrentRhythmAnalysis(
							retryIdentity.musicId,
							retryIdentity.generation,
							requireLoudness || store.get(enableLoudnessNormalizationAtom),
						);
					},
				);
				console.warn(
					"[RhythmAnalysis] Failed to analyze song",
					musicId,
					error,
					schedule
						? `Retry ${schedule.retryNumber} in ${schedule.delayMs} ms`
						: "Retry limit reached",
				);
			}
		},
		[store],
	);

	useEffect(
		() => () => {
			rhythmAnalysisRetryRef.current?.cancel();
		},
		[],
	);

	useEffect(() => {
		if (!currentRhythmAnalysis) return;
		const loudnessUpdatePolicy = store.get(queueLoudnessUpdatePolicyAtom);
		if (
			!enableLoudnessNormalization &&
			loudnessUpdatePolicy?.musicId === currentRhythmAnalysis.musicId
		) {
			store.set(queueLoudnessUpdatePolicyAtom, null);
		}
		const suppressAutomaticUpdate = shouldSuppressAutomaticLoudnessUpdate(
			loudnessUpdatePolicy,
			currentRhythmAnalysis.musicId,
			enableLoudnessNormalization,
		);
		if (!currentRhythmAnalysis.analysis) {
			if (!enableLoudnessNormalization) {
				void emitAudioThread("setLoudnessNormalization", {
					musicId: currentRhythmAnalysis.musicId,
					enabled: false,
					integratedLoudnessLufs: null,
					samplePeak: null,
				}).catch((error) => {
					console.warn(
						"[VolumeBalance] Failed to disable normalization",
						error,
					);
				});
			}
			return;
		}

		if (suppressAutomaticUpdate) return;

		const loudness = getCurrentTrackLoudness(currentRhythmAnalysis.analysis);
		const hasCurrentLoudness = loudness !== null;

		void emitAudioThread("setLoudnessNormalization", {
			musicId: currentRhythmAnalysis.musicId,
			enabled: enableLoudnessNormalization,
			integratedLoudnessLufs: hasCurrentLoudness
				? (loudness.integratedLoudnessLufs ?? null)
				: null,
			samplePeak: hasCurrentLoudness ? loudness.samplePeak : null,
		}).catch((error) => {
			console.warn(
				"[VolumeBalance] Failed to update track normalization",
				error,
			);
		});

		if (
			enableLoudnessNormalization &&
			currentRhythmAnalysis.analysis &&
			!hasCurrentLoudness
		) {
			void requestRhythmAnalysis(
				currentRhythmAnalysis.musicId,
				currentRhythmAnalysis.generation,
				true,
			);
		}
	}, [
		currentRhythmAnalysis,
		enableLoudnessNormalization,
		requestRhythmAnalysis,
	]);

	const syncMusicInfo = async (
		data: Extract<AudioThreadEvent, { type: "loadAudio" }>["data"],
	) => {
		if (!data?.musicInfo) {
			console.error("[syncMusicInfo] Invalid data, aborting.");
			return;
		}

		const musicId = data.musicId;
		const generation = ++musicInfoGenerationRef.current;

		try {
			store.set(musicIdAtom, musicId);

			const songFromDb = await db.songs.get(musicId);
			if (
				generation !== musicInfoGenerationRef.current ||
				store.get(musicIdAtom) !== musicId
			) {
				return;
			}

			if (songFromDb) {
				store.set(musicNameAtom, songFromDb.songName);
				store.set(musicAlbumNameAtom, songFromDb.songAlbum);
				store.set(
					musicArtistsAtom,
					songFromDb.songArtists.split("/").map((v) => ({
						id: v.trim(),
						name: v.trim(),
					})),
				);

				if (songFromDb.coverPath) {
					const coverPath = songFromDb.coverPath;
					if (
						coverPath.startsWith("http://") ||
						coverPath.startsWith("https://")
					) {
						store.set(musicCoverAtom, coverPath);
					} else {
						store.set(musicCoverAtom, convertFileSrc(coverPath));
					}
					store.set(
						musicCoverIsVideoAtom,
						/\.(?:mp4|webm)(?:$|[?#])/i.test(coverPath),
					);
				} else {
					store.set(
						musicCoverAtom,
						"data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
					);
					store.set(musicCoverIsVideoAtom, false);
				}
			} else {
				store.set(musicNameAtom, data.musicInfo.name);
				store.set(musicAlbumNameAtom, data.musicInfo.album);
				store.set(
					musicArtistsAtom,
					data.musicInfo.artist.split("/").map((v: string) => ({
						id: v.trim(),
						name: v.trim(),
					})),
				);

				store.set(
					musicCoverAtom,
					"data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
				);
				store.set(musicCoverIsVideoAtom, false);
			}
			if (data.musicInfo?.duration) {
				store.set(musicDurationAtom, (data.musicInfo.duration * 1000) | 0);
			} else if (songFromDb?.duration) {
				store.set(musicDurationAtom, (songFromDb.duration * 1000) | 0);
			}
		} catch (error) {
			if (generation !== musicInfoGenerationRef.current) return;
			console.error(
				"[syncMusicInfo] An error occurred during state update:",
				error,
			);
		}
	};

	useEffect(() => {
		if (musicPlaying && firstPlay.current) {
			firstPlay.current = false;
			const mediaControlsEnabled = store.get(enableMediaControlsAtom);
			if (mediaControlsEnabled) {
				emitAudioThread("setMediaControlsEnabled", { enabled: true });
			}
		}
	}, [musicPlaying, store]);

	useEffect(() => {
		let queuedMusicId = store.get(queueCurrentSongAtom)?.id ?? null;
		const unsubscribe = store.sub(queueCurrentSongAtom, () => {
			const nextMusicId = store.get(queueCurrentSongAtom)?.id ?? null;
			if (nextMusicId === queuedMusicId) return;
			queuedMusicId = nextMusicId;
			beginRhythmGeneration(nextMusicId);
		});
		return () => {
			unsubscribe();
			beginRhythmGeneration(null);
		};
	}, [beginRhythmGeneration, store]);

	useEffect(() => {
		let rafId: number;

		const updateLoop = () => {
			const isPlaying = store.get(musicPlayingAtom);
			const now = performance.now();

			if (isPlaying) {
				const dt = (now - lastSyncRef.current.timestamp) / 1000;
				const newPos = lastSyncRef.current.position + dt;

				const duration = store.get(musicDurationAtom) / 1000;
				const clampedPos = Math.min(newPos, duration || 0);

				store.set(musicPlayingPositionAtom, (clampedPos * 1000) | 0);
			} else {
				const currentUIPosition = store.get(musicPlayingPositionAtom) / 1000;
				lastSyncRef.current.position = currentUIPosition;
				lastSyncRef.current.timestamp = now;
			}
			rafId = requestAnimationFrame(updateLoop);
		};

		rafId = requestAnimationFrame(updateLoop);
		return () => cancelAnimationFrame(rafId);
	}, [store]);

	useEffect(() => {
		initAudioThread();
		const toEmit = <T,>(onEmit: T) => ({ onEmit });

		const queueManager = new PlayQueueManager(store);
		store.set(queueManagerAtom, queueManager);
		const unsubscribeGaplessPlayback = store.sub(
			enableGaplessPlaybackAtom,
			() => queueManager.refreshGaplessCandidate(),
		);
		const unsubscribeGaplessLoudness = store.sub(
			enableLoudnessNormalizationAtom,
			() => queueManager.refreshGaplessCandidate(),
		);

		// 恢复上次的队列信息
		void queueManager
			.restore()
			.then(async ({ restored, position }) => {
				if (restored) {
					const currentSong = queueManager.getCurrentSong();
					if (currentSong) {
						// 恢复播放进度
						const started = await queueManager.playCurrentForRestore();
						if (!started) return;

						if (position > 0) {
							const requestedAt = performance.now();
							pendingSeekRef.current = {
								targetPosition: position,
								requestedAt,
							};
							lastSyncRef.current = {
								position,
								timestamp: requestedAt,
							};
							const positionMs = Math.round(position * 1_000);
							store.set(musicPlayingPositionAtom, positionMs);
							store.set(emitMusicTimelineJumpAtom, {
								positionMs,
								reason: "seek",
							});
							await emitAudioThread("seekAudio", { position });
						}
					}
				}
			})
			.catch((error) => {
				console.error("[PlayQueueManager] Failed to restore queue", error);
			});

		const onBeforeUnload = () => {
			queueManager.dispose();
		};
		window.addEventListener("beforeunload", onBeforeUnload);

		store.set(
			onClickAudioQualityTagAtom,
			toEmit(() => {
				store.set(audioQualityDialogOpenedAtom, true);
			}),
		);

		store.set(
			onPlayOrResumeAtom,
			toEmit(() => {
				queueManager.togglePlayback();
			}),
		);

		store.set(
			onRequestNextSongAtom,
			toEmit(() => {
				queueManager.advanceForUser();
			}),
		);

		store.set(
			onRequestPrevSongAtom,
			toEmit(() => {
				queueManager.retreatForUser();
			}),
		);
		store.set(
			onToggleShuffleAtom,
			toEmit(() => {
				queueManager.toggleShuffle();
			}),
		);
		store.set(
			onCycleRepeatModeAtom,
			toEmit(() => {
				queueManager.cycleRepeatMode();
			}),
		);
		store.set(
			onClickControlThumbAtom,
			toEmit(() => {
				store.set(isLyricPageOpenedAtom, false);
			}),
		);
		store.set(
			onSeekPositionAtom,
			toEmit((time: number) => {
				store.set(rhythmVisualResetAtom, (value) => value + 1);
				const targetPos = time / 1000;
				pendingSeekRef.current = {
					targetPosition: targetPos,
					requestedAt: performance.now(),
				};
				lastSyncRef.current = {
					position: targetPos,
					timestamp: performance.now(),
				};
				store.set(musicPlayingPositionAtom, time);
				store.set(emitMusicTimelineJumpAtom, {
					positionMs: time,
					reason: "seek",
				});

				emitAudioThread("seekAudio", {
					position: targetPos,
				});
			}),
		);
		store.set(
			onLyricLineClickAtom,
			toEmit((evt) => {
				store.set(rhythmVisualResetAtom, (value) => value + 1);
				const targetTimeMs = evt.line.getLine().startTime;
				const targetPos = targetTimeMs / 1000;
				pendingSeekRef.current = {
					targetPosition: targetPos,
					requestedAt: performance.now(),
				};

				lastSyncRef.current = {
					position: targetPos,
					timestamp: performance.now(),
				};
				store.set(musicPlayingPositionAtom, targetTimeMs);
				store.set(emitMusicTimelineJumpAtom, {
					positionMs: targetTimeMs,
					reason: "lyric-click",
				});

				emitAudioThread("seekAudio", {
					position: targetPos,
				});
			}),
		);
		store.set(
			onChangeVolumeAtom,
			toEmit((volume: number) => {
				emitAudioThread("setVolume", {
					volume,
				});
			}),
		);
		store.set(
			onRequestOpenMenuAtom,
			toEmit(() => {
				toast.info(
					t("amll.openMenuViaRightClick", "请右键歌词页任意位置来打开菜单哦！"),
				);
			}),
		);

		const unlistenPromise = listenAudioThreadEvent(async (evt) => {
			const evtData = evt.payload.data;
			switch (evtData?.type) {
				case "loadingAudio": {
					beginRhythmGeneration(evtData.data.musicId || null);
					break;
				}

				case "playPosition": {
					const now = performance.now();
					const pendingSeek = pendingSeekRef.current;
					if (pendingSeek) {
						const elapsed = now - pendingSeek.requestedAt;
						const expectedTarget =
							pendingSeek.targetPosition +
							(store.get(musicPlayingAtom) ? Math.max(0, elapsed) / 1000 : 0);
						if (elapsed <= 1_500) {
							if (Math.abs(evtData.data.position - expectedTarget) > 0.75) {
								break;
							}
							pendingSeekRef.current = null;
						} else {
							pendingSeekRef.current = null;
						}
					}
					const dt = (now - lastSyncRef.current.timestamp) / 1000;
					const currentExtrapolated = lastSyncRef.current.position + dt;
					const correction = evtData.data.position - currentExtrapolated;

					if (Math.abs(correction) > 0.05) {
						if (Math.abs(correction) > 0.25) {
							store.set(emitMusicTimelineJumpAtom, {
								positionMs: Math.round(evtData.data.position * 1000),
								reason: "remote-jump",
							});
						}
						lastSyncRef.current = {
							position: evtData.data.position,
							timestamp: now,
						};
						store.set(
							musicPlayingPositionAtom,
							(evtData.data.position * 1000) | 0,
						);
					}
					break;
				}

				case "loadAudio": {
					const data = evtData.data;
					const newMusicId = data.musicId || "";
					const rhythmGeneration = beginRhythmGeneration(newMusicId || null);
					pendingSeekRef.current = null;

					if (data.quality) {
						store.set(musicQualityAtom, processAudioQuality(data.quality));
					}
					if (data.musicInfo) {
						store.set(musicDurationAtom, (data.musicInfo.duration * 1000) | 0);
					}

					lastSyncRef.current = {
						position: 0,
						timestamp: performance.now(),
					};
					store.set(musicPlayingPositionAtom, 0);
					store.set(emitMusicTimelineJumpAtom, {
						positionMs: 0,
						reason: "track-change",
					});

					const currentMusicId = store.get(musicIdAtom);

					if (newMusicId && newMusicId !== currentMusicId) {
						await syncMusicInfo(data);
					}
					if (newMusicId && rhythmGeneration === rhythmGenerationRef.current) {
						void requestRhythmAnalysis(newMusicId, rhythmGeneration);
					}
					break;
				}

				case "playStatus": {
					setMusicPlaying(evtData.data.isPlaying);
					break;
				}

				case "trackEnded": {
					queueManager.advanceForAutoEnd(
						evtData.data.musicId,
						evtData.data.playbackId,
						{
							gapless: evtData.data.gapless,
							nextPlaybackId: evtData.data.nextPlaybackId,
							nextMusicId: evtData.data.nextMusicId,
						},
					);
					break;
				}

				case "hardwareMediaCommand": {
					if (evtData.data.command === "play") {
						queueManager.setExternalPlaybackState(true);
					} else if (evtData.data.command === "pause") {
						queueManager.setExternalPlaybackState(false);
					} else if (evtData.data.command === "stop") {
						queueManager.setExternalStopped();
					} else if (evtData.data.command === "next") {
						queueManager.advanceForUser();
					} else if (evtData.data.command === "prev") {
						queueManager.retreatForUser();
					} else if (evtData.data.command === "toggleShuffle") {
						queueManager.toggleShuffle();
					} else if (evtData.data.command === "toggleRepeat") {
						queueManager.cycleRepeatMode();
					}
					break;
				}

				case "loadError": {
					if (
						!queueManager.handlePlaybackLoadFailure(evtData.data.playbackId)
					) {
						break;
					}
					toast.error(
						t("amll.loadAudioError", "播放后端加载音频失败\n{error}", {
							error: evtData.data.error,
						}),
						{},
					);
					break;
				}

				case "volumeChanged": {
					store.set(musicVolumeAtom, evtData.data.volume);
					break;
				}

				case "fftData": {
					store.set(fftDataAtom, evtData.data.data);
					break;
				}
			}
		});

		return () => {
			unlistenPromise.then((unlisten) => unlisten());
			unsubscribeGaplessPlayback();
			unsubscribeGaplessLoudness();

			window.removeEventListener("beforeunload", onBeforeUnload);

			queueManager.dispose();
			musicInfoGenerationRef.current += 1;
			pendingSeekRef.current = null;
			store.set(musicCoverIsVideoAtom, false);
			store.set(queueManagerAtom, null);

			const doNothing = toEmit(() => {});
			store.set(onClickAudioQualityTagAtom, doNothing);
			store.set(onRequestNextSongAtom, doNothing);
			store.set(onRequestPrevSongAtom, doNothing);
			store.set(onPlayOrResumeAtom, doNothing);
			store.set(onClickControlThumbAtom, doNothing);
			store.set(onSeekPositionAtom, doNothing);
			store.set(onLyricLineClickAtom, doNothing);
			store.set(onChangeVolumeAtom, doNothing);
			store.set(onRequestOpenMenuAtom, doNothing);
		};
	}, [beginRhythmGeneration, requestRhythmAnalysis, store, t]);

	return (
		<>
			<LyricContext />
			<FFTToLowPassContext />
			<LocalRhythmVisualContext />
			<RhythmPrecacheProgressContext />
			<MusicQualityTagText />
		</>
	);
};

function processAudioQuality(
	quality: AudioQuality | undefined,
): MusicQualityState {
	const definiteQuality = {
		sampleRate: quality?.sampleRate ?? 0,
		bitsPerCodedSample: quality?.bitsPerCodedSample ?? 0,
		bitsPerSample: quality?.bitsPerSample ?? 0,
		channels: quality?.channels ?? 0,
		sampleFormat: quality?.sampleFormat ?? "unknown",
		codec: quality?.codec ?? "unknown",
	};

	if (definiteQuality.codec === "unknown") {
		return {
			...definiteQuality,
			type: AudioQualityType.None,
		};
	}

	const isLosslessCodec = ["flac", "alac", "ape", "wav", "aiff"].includes(
		definiteQuality.codec.toLowerCase(),
	);

	if (isLosslessCodec) {
		const sampleRate = definiteQuality.sampleRate;
		const bitsPerSample = definiteQuality.bitsPerSample;

		if (sampleRate >= 96000 && bitsPerSample >= 24) {
			return {
				...definiteQuality,
				type: AudioQualityType.HiResLossless,
			};
		}
		return {
			...definiteQuality,
			type: AudioQualityType.Lossless,
		};
	}

	return {
		...definiteQuality,
		type: AudioQualityType.None,
	};
}
