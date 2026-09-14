use std::{
    collections::VecDeque,
    f32::consts::PI,
    fs::File,
    io::{Read, Seek},
    path::Path,
};

use anyhow::Context;
use bs1770::{ChannelLoudnessMeter, gated_mean, reduce_stereo};
use ffmpeg_audio::{AudioReader, ResampleOptions};
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::utils::can_skip_decode_error;

pub const RHYTHM_ANALYZER_VERSION: u32 = 5;
pub const LOUDNESS_ANALYZER_VERSION: u32 = 1;

const TARGET_SAMPLE_RATE: u32 = 22_050;
const LOUDNESS_SAMPLE_RATE: u32 = 48_000;
const FFT_SIZE: usize = 1_024;
const HOP_SIZE: usize = 256;
const BAND_COUNT: usize = 5;
const BAND_EDGES_HZ: [f32; BAND_COUNT + 1] = [30.0, 150.0, 400.0, 1_200.0, 3_500.0, 11_025.0];
const MIN_TEMPO_BPM: f32 = 55.0;
const MAX_TEMPO_BPM: f32 = 210.0;
const TEMPO_SEGMENT_DOWNSAMPLE: usize = 2;
/// Calibrates `sqrt(sum of squared Hann-windowed bin magnitudes)` back to an
/// approximate PCM RMS scale so `band_levels` is comparable with `energy_scale`.
/// Spectral leakage and fixed band edges make it a visual estimate rather than
/// an exact per-band loudness measurement.
const BAND_LEVEL_SCALE: f32 = 2.828_427;
/// A tempo segment only gets its own beat-grid period when it is long and
/// confident enough, and clearly deviates from the global tempo. Everything
/// else keeps the global grid so constant-tempo tracks behave exactly as
/// before.
const SEGMENT_GRID_MIN_CONFIDENCE: f32 = 0.35;
const SEGMENT_GRID_MIN_DURATION_MS: u64 = 12_000;
const SEGMENT_GRID_MIN_BPM_DEVIATION: f32 = 0.06;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RhythmBeatPoint {
    pub time_ms: u64,
    pub strength: f32,
    pub confidence: f32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RhythmOnsetPoint {
    pub time_ms: u64,
    pub strength: f32,
    pub bands: [f32; BAND_COUNT],
    /// Absolute per-band linear level (approximate PCM RMS units) around the
    /// onset. `bands` is per-band normalized novelty and deliberately loudness
    /// invariant, so it cannot tell a loud kick from a quiet shaker; this field
    /// restores that cross-band loudness ranking for visual amplitude mapping.
    #[serde(default)]
    pub band_levels: [f32; BAND_COUNT],
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RhythmTempoSegment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub bpm: f32,
    pub confidence: f32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RhythmTimedValue {
    pub time_ms: u64,
    pub value: f32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackLoudnessAnalysis {
    pub analyzer_version: u32,
    pub integrated_loudness_lufs: Option<f32>,
    /// Maximum absolute sample value after the 48 kHz stereo analysis resample.
    pub sample_peak: f32,
}

impl TrackLoudnessAnalysis {
    pub fn is_current(&self) -> bool {
        self.analyzer_version == LOUDNESS_ANALYZER_VERSION
            && self
                .integrated_loudness_lufs
                .is_none_or(|loudness| loudness.is_finite())
            && self.sample_peak.is_finite()
            && self.sample_peak >= 0.0
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RhythmAnalysis {
    pub analyzer_version: u32,
    pub duration_ms: u64,
    pub global_bpm: Option<f32>,
    pub confidence: f32,
    pub beats: Vec<RhythmBeatPoint>,
    pub onsets: Vec<RhythmOnsetPoint>,
    pub tempo_segments: Vec<RhythmTempoSegment>,
    pub energy_envelope: Vec<RhythmTimedValue>,
    /// Absolute P95 frame RMS before `energy_envelope` is normalized. Keeping
    /// this scalar makes the relative envelope comparable across tracks without
    /// duplicating another full-length time series in the cache.
    #[serde(default)]
    pub energy_scale: f32,
    /// Per-track perceived loudness. This has its own version so adding it does
    /// not invalidate otherwise compatible rhythm caches or the legacy schema.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loudness: Option<TrackLoudnessAnalysis>,
}

impl RhythmAnalysis {
    fn empty(duration_ms: u64) -> Self {
        Self {
            analyzer_version: RHYTHM_ANALYZER_VERSION,
            duration_ms,
            global_bpm: None,
            confidence: 0.0,
            beats: Vec::new(),
            onsets: Vec::new(),
            tempo_segments: Vec::new(),
            energy_envelope: Vec::new(),
            energy_scale: 0.0,
            loudness: Some(TrackLoudnessAnalysis {
                analyzer_version: LOUDNESS_ANALYZER_VERSION,
                integrated_loudness_lufs: None,
                sample_peak: 0.0,
            }),
        }
    }

    pub fn has_current_loudness_analysis(&self) -> bool {
        self.loudness
            .as_ref()
            .is_some_and(TrackLoudnessAnalysis::is_current)
    }
}

struct TrackLoudnessMeter {
    left: ChannelLoudnessMeter,
    right: ChannelLoudnessMeter,
    sample_peak: f32,
}

impl TrackLoudnessMeter {
    fn new(sample_rate: u32) -> Self {
        Self {
            left: ChannelLoudnessMeter::new(sample_rate),
            right: ChannelLoudnessMeter::new(sample_rate),
            sample_peak: 0.0,
        }
    }

    fn clean_sample(sample: f32) -> f32 {
        if sample.is_finite() { sample } else { 0.0 }
    }

    fn push_interleaved_stereo(&mut self, samples: &[f32]) {
        self.left.push(
            samples
                .chunks_exact(2)
                .map(|frame| Self::clean_sample(frame[0])),
        );
        self.right.push(
            samples
                .chunks_exact(2)
                .map(|frame| Self::clean_sample(frame[1])),
        );
        for &sample in samples {
            self.sample_peak = self.sample_peak.max(Self::clean_sample(sample).abs());
        }
    }

    fn push_dual_mono(&mut self, samples: &[f32]) {
        self.left
            .push(samples.iter().copied().map(Self::clean_sample));
        self.right
            .push(samples.iter().copied().map(Self::clean_sample));
        for &sample in samples {
            self.sample_peak = self.sample_peak.max(Self::clean_sample(sample).abs());
        }
    }

    fn finish(self) -> TrackLoudnessAnalysis {
        let left = self.left.into_100ms_windows();
        let right = self.right.into_100ms_windows();
        let stereo = reduce_stereo(left.as_ref(), right.as_ref());
        let integrated_loudness_lufs = if stereo.len() >= 4 {
            let loudness = gated_mean(stereo.as_ref()).loudness_lkfs();
            loudness.is_finite().then_some(loudness)
        } else {
            None
        };

        TrackLoudnessAnalysis {
            analyzer_version: LOUDNESS_ANALYZER_VERSION,
            integrated_loudness_lufs,
            sample_peak: self.sample_peak,
        }
    }
}

/// Decode a local audio file independently from the playback decoder and analyze
/// the complete track. The playback ring buffer is deliberately not involved.
pub fn analyze_rhythm_file(path: impl AsRef<Path>) -> anyhow::Result<RhythmAnalysis> {
    let path = path.as_ref();
    let file = File::open(path)
        .with_context(|| format!("failed to open audio file {}", path.display()))?;
    analyze_rhythm_source(file)
        .with_context(|| format!("failed to analyze audio file {}", path.display()))
}

/// Decode any seekable media source and stream the 22.05 kHz mono PCM through
/// the spectral accumulator chunk by chunk. Whole-track PCM is never buffered,
/// so multi-hour files no longer create hundreds of megabytes of transient
/// allocations during analysis.
pub fn analyze_rhythm_source<T>(source: T) -> anyhow::Result<RhythmAnalysis>
where
    T: Read + Seek + Send + 'static,
{
    let mut reader = AudioReader::new(source).context("failed to initialize audio decoder")?;
    let options = ResampleOptions::new()
        .sample_rate(TARGET_SAMPLE_RATE as i32)
        .channels(1)
        .format::<f32>();
    let mut resampler = reader
        .build_resampler(options)
        .context("failed to initialize rhythm analysis resampler")?;
    let loudness_options = ResampleOptions::new()
        .sample_rate(LOUDNESS_SAMPLE_RATE as i32)
        .channels(2)
        .format::<f32>();
    let mut loudness_resampler = reader
        .build_resampler(loudness_options)
        .context("failed to initialize loudness analysis resampler")?;
    let mut loudness_meter = TrackLoudnessMeter::new(LOUDNESS_SAMPLE_RATE);
    let mut accumulator = SpectralAccumulator::new(TARGET_SAMPLE_RATE);

    let mut recoverable_decode_errors = 0;
    loop {
        let frame = match reader.receive_frame() {
            Ok(Some(frame)) => frame,
            Ok(None) => break,
            Err(error) if can_skip_decode_error(&error, recoverable_decode_errors) => {
                recoverable_decode_errors += 1;
                warn!(
                    error = %error,
                    skipped_errors = recoverable_decode_errors,
                    "skipping recoverable damaged audio data during rhythm analysis"
                );
                continue;
            }
            Err(error) => {
                return Err(error).context("failed while decoding audio for rhythm analysis");
            }
        };
        if resampler
            .process::<f32>(Some(&frame))
            .context("failed to resample audio for rhythm analysis")?
        {
            accumulator.push(resampler.output_as::<f32>());
        }
        if loudness_resampler
            .process::<f32>(Some(&frame))
            .context("failed to resample audio for loudness analysis")?
        {
            loudness_meter.push_interleaved_stereo(loudness_resampler.output_as::<f32>());
        }
    }

    while resampler
        .process::<f32>(None)
        .context("failed to flush rhythm analysis resampler")?
    {
        accumulator.push(resampler.output_as::<f32>());
    }

    while loudness_resampler
        .process::<f32>(None)
        .context("failed to flush loudness analysis resampler")?
    {
        loudness_meter.push_interleaved_stereo(loudness_resampler.output_as::<f32>());
    }

    finish_analysis(accumulator, TARGET_SAMPLE_RATE, Some(loudness_meter.finish()))
}

/// Analyze a complete mono PCM signal. This pure boundary is intentionally free
/// from FFmpeg, CPAL, Tauri, SQLite, and wall-clock state so it can be tested with
/// deterministic synthetic signals.
pub fn analyze_mono_pcm(samples: &[f32], sample_rate: u32) -> anyhow::Result<RhythmAnalysis> {
    anyhow::ensure!(sample_rate > 0, "sample rate must be greater than zero");

    let mut loudness_meter = TrackLoudnessMeter::new(sample_rate);
    loudness_meter.push_dual_mono(samples);
    analyze_mono_pcm_with_loudness(samples, sample_rate, Some(loudness_meter.finish()))
}

/// Incrementally turns arbitrarily sized PCM chunks into per-frame spectral
/// features. Only up to one FFT window of PCM is buffered at any moment, so a
/// complete track never has to exist in memory at once; the per-frame feature
/// rows grow at roughly 7 MB per hour of audio instead of ~320 MB of buffered
/// PCM. Feeding the same samples in any chunking produces bit-identical
/// results to a single-slice pass.
struct SpectralAccumulator {
    bin_bands: Vec<Option<usize>>,
    window: Vec<f32>,
    pending: VecDeque<f32>,
    total_samples: u64,
    frame_index: usize,
    previous_spectrum: Vec<f32>,
    current_spectrum: Vec<f32>,
    real: Vec<f32>,
    imaginary: Vec<f32>,
    raw_flux: Vec<[f32; BAND_COUNT]>,
    band_linear: Vec<[f32; BAND_COUNT]>,
    rms: Vec<f32>,
}

struct SpectralFeatures {
    raw_flux: Vec<[f32; BAND_COUNT]>,
    band_linear: Vec<[f32; BAND_COUNT]>,
    rms: Vec<f32>,
    total_samples: u64,
}

impl SpectralAccumulator {
    fn new(sample_rate: u32) -> Self {
        Self {
            bin_bands: frequency_bin_bands(sample_rate),
            window: hann_window(),
            pending: VecDeque::with_capacity(FFT_SIZE * 4),
            total_samples: 0,
            frame_index: 0,
            previous_spectrum: vec![0.0_f32; FFT_SIZE / 2 + 1],
            current_spectrum: vec![0.0_f32; FFT_SIZE / 2 + 1],
            real: vec![0.0_f32; FFT_SIZE],
            imaginary: vec![0.0_f32; FFT_SIZE],
            raw_flux: Vec::new(),
            band_linear: Vec::new(),
            rms: Vec::new(),
        }
    }

    fn push(&mut self, samples: &[f32]) {
        self.total_samples += samples.len() as u64;
        let mut remaining = samples;
        while !remaining.is_empty() {
            let needed = FFT_SIZE - self.pending.len();
            let take = needed.min(remaining.len());
            self.pending.extend(remaining[..take].iter().copied());
            remaining = &remaining[take..];
            // 每次只补满一个分析窗后立即消费，避免解码器给出大块 PCM 时
            // pending 临时扩容到整块大小。
            if self.pending.len() == FFT_SIZE {
                self.process_frame();
            }
        }
    }

    fn process_frame(&mut self) {
        let mut square_sum = 0.0_f32;
        for index in 0..FFT_SIZE {
            let sample = self
                .pending
                .get(index)
                .copied()
                .filter(|value| value.is_finite())
                .unwrap_or(0.0);
            square_sum += sample * sample;
            self.real[index] = sample * self.window[index];
            self.imaginary[index] = 0.0;
        }
        self.rms.push((square_sum / FFT_SIZE as f32).sqrt());

        fft_in_place(&mut self.real, &mut self.imaginary);
        let mut band_bin_counts = [0_usize; BAND_COUNT];
        let mut band_energy = [0.0_f32; BAND_COUNT];
        let mut flux_row = [0.0_f32; BAND_COUNT];
        let mut band_linear_row = [0.0_f32; BAND_COUNT];
        for bin in 1..=FFT_SIZE / 2 {
            let magnitude = (self.real[bin] * self.real[bin]
                + self.imaginary[bin] * self.imaginary[bin])
                .sqrt()
                / FFT_SIZE as f32;
            self.current_spectrum[bin] = (1.0 + magnitude * 64.0).ln();
            if let Some(band) = self.bin_bands[bin] {
                band_energy[band] += magnitude * magnitude;
            }
        }
        for band in 0..BAND_COUNT {
            band_linear_row[band] = band_energy[band].sqrt() * BAND_LEVEL_SCALE;
        }
        self.band_linear.push(band_linear_row);
        for bin in 1..=FFT_SIZE / 2 {
            if let Some(band) = self.bin_bands[bin] {
                // The first frame has no predecessor; comparing against the
                // all-zero seed would fabricate a full-scale novelty burst that
                // masks real onsets near t=0 and poisons the adaptive baseline.
                if self.frame_index > 0 {
                    // SuperFlux-style comparison against a small frequency-neighbourhood
                    // in the preceding frame reduces vibrato-created false positives.
                    let previous_local_max = self.previous_spectrum[bin.saturating_sub(1)]
                        .max(self.previous_spectrum[bin])
                        .max(self.previous_spectrum[(bin + 1).min(FFT_SIZE / 2)]);
                    flux_row[band] += (self.current_spectrum[bin] - previous_local_max).max(0.0);
                }
                band_bin_counts[band] += 1;
            }
        }
        std::mem::swap(&mut self.previous_spectrum, &mut self.current_spectrum);
        for band in 0..BAND_COUNT {
            if band_bin_counts[band] > 0 {
                flux_row[band] /= band_bin_counts[band] as f32;
            }
        }
        self.raw_flux.push(flux_row);
        self.frame_index += 1;
        let consumed = HOP_SIZE.min(self.pending.len());
        self.pending.drain(..consumed);
    }

    fn finish(mut self) -> SpectralFeatures {
        // 尾部不足一窗的样本按原实现补零成帧,帧数保持 ceil(len / HOP)。
        while !self.pending.is_empty() {
            self.process_frame();
        }
        SpectralFeatures {
            raw_flux: self.raw_flux,
            band_linear: self.band_linear,
            rms: self.rms,
            total_samples: self.total_samples,
        }
    }
}

fn analyze_mono_pcm_with_loudness(
    samples: &[f32],
    sample_rate: u32,
    loudness: Option<TrackLoudnessAnalysis>,
) -> anyhow::Result<RhythmAnalysis> {
    let mut accumulator = SpectralAccumulator::new(sample_rate);
    accumulator.push(samples);
    finish_analysis(accumulator, sample_rate, loudness)
}

fn finish_analysis(
    accumulator: SpectralAccumulator,
    sample_rate: u32,
    loudness: Option<TrackLoudnessAnalysis>,
) -> anyhow::Result<RhythmAnalysis> {
    let features = accumulator.finish();
    let duration_ms = samples_to_ms(features.total_samples as f64, sample_rate);
    if features.total_samples == 0 {
        let mut analysis = RhythmAnalysis::empty(duration_ms);
        analysis.loudness = loudness;
        return Ok(analysis);
    }
    let raw_flux = features.raw_flux;
    let band_linear = features.band_linear;
    let rms = features.rms;

    let normalized_bands = normalize_band_flux(&raw_flux);
    let novelty = combine_band_novelty(&normalized_bands);
    let onset_frames = pick_onset_frames(&novelty);
    let onsets = onset_frames
        .iter()
        .map(|&frame| RhythmOnsetPoint {
            time_ms: frame_to_ms(frame as f64, sample_rate).min(duration_ms),
            strength: unit(novelty[frame]),
            bands: normalized_bands[frame].map(unit),
            band_levels: onset_band_levels(&band_linear, frame),
        })
        .collect::<Vec<_>>();
    let (energy_envelope, energy_scale) = make_energy_envelope(&rms, sample_rate, duration_ms);

    let tempo_envelope = smooth_tempo_envelope(&novelty, &onset_frames);
    let frames_per_second = sample_rate as f32 / HOP_SIZE as f32;
    let global_tempo = estimate_tempo(&tempo_envelope, frames_per_second);
    let (global_bpm, confidence, beats, tempo_segments) = match global_tempo {
        Some(tempo) => {
            let segments =
                estimate_tempo_segments(&tempo_envelope, sample_rate, duration_ms, tempo);
            let beats =
                build_beat_grid(&tempo_envelope, tempo, &segments, sample_rate, duration_ms);
            let coverage = beat_coverage(&beats);
            let confidence = unit(tempo.confidence * (0.75 + 0.25 * coverage));
            (Some(tempo.bpm), confidence, beats, segments)
        }
        None => (None, 0.0, Vec::new(), Vec::new()),
    };

    Ok(RhythmAnalysis {
        analyzer_version: RHYTHM_ANALYZER_VERSION,
        duration_ms,
        global_bpm,
        confidence,
        beats,
        onsets,
        tempo_segments,
        energy_envelope,
        energy_scale,
        loudness,
    })
}

fn samples_to_ms(samples: f64, sample_rate: u32) -> u64 {
    ((samples * 1_000.0 / sample_rate as f64).max(0.0)).round() as u64
}

fn frame_to_ms(frame: f64, sample_rate: u32) -> u64 {
    samples_to_ms(frame * HOP_SIZE as f64 + FFT_SIZE as f64 * 0.5, sample_rate)
}

fn frame_boundary_to_ms(frame: usize, sample_rate: u32) -> u64 {
    samples_to_ms(frame as f64 * HOP_SIZE as f64, sample_rate)
}

fn unit(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn hann_window() -> Vec<f32> {
    (0..FFT_SIZE)
        .map(|index| 0.5 - 0.5 * (2.0 * PI * index as f32 / (FFT_SIZE - 1) as f32).cos())
        .collect()
}

fn frequency_bin_bands(sample_rate: u32) -> Vec<Option<usize>> {
    let nyquist = sample_rate as f32 / 2.0;
    (0..=FFT_SIZE / 2)
        .map(|bin| {
            let frequency = bin as f32 * sample_rate as f32 / FFT_SIZE as f32;
            (0..BAND_COUNT).find(|&band| {
                let lower = BAND_EDGES_HZ[band];
                let upper = BAND_EDGES_HZ[band + 1].min(nyquist);
                frequency >= lower
                    && if band + 1 == BAND_COUNT {
                        frequency <= upper
                    } else {
                        frequency < upper
                    }
            })
        })
        .collect()
}

fn fft_in_place(real: &mut [f32], imaginary: &mut [f32]) {
    debug_assert_eq!(real.len(), imaginary.len());
    debug_assert!(real.len().is_power_of_two());
    let size = real.len();

    let mut reversed = 0_usize;
    for index in 1..size {
        let mut bit = size >> 1;
        while reversed & bit != 0 {
            reversed ^= bit;
            bit >>= 1;
        }
        reversed ^= bit;
        if index < reversed {
            real.swap(index, reversed);
            imaginary.swap(index, reversed);
        }
    }

    let mut length = 2;
    while length <= size {
        let angle = -2.0 * PI / length as f32;
        let step_real = angle.cos();
        let step_imaginary = angle.sin();
        for block_start in (0..size).step_by(length) {
            let mut twiddle_real = 1.0_f32;
            let mut twiddle_imaginary = 0.0_f32;
            for offset in 0..length / 2 {
                let even = block_start + offset;
                let odd = even + length / 2;
                let odd_real = real[odd] * twiddle_real - imaginary[odd] * twiddle_imaginary;
                let odd_imaginary = real[odd] * twiddle_imaginary + imaginary[odd] * twiddle_real;
                let even_real = real[even];
                let even_imaginary = imaginary[even];
                real[even] = even_real + odd_real;
                imaginary[even] = even_imaginary + odd_imaginary;
                real[odd] = even_real - odd_real;
                imaginary[odd] = even_imaginary - odd_imaginary;

                let next_real = twiddle_real * step_real - twiddle_imaginary * step_imaginary;
                twiddle_imaginary = twiddle_real * step_imaginary + twiddle_imaginary * step_real;
                twiddle_real = next_real;
            }
        }
        length <<= 1;
    }
}

fn percentile(values: impl IntoIterator<Item = f32>, fraction: f32) -> f32 {
    let mut values = values
        .into_iter()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    if values.is_empty() {
        return 0.0;
    }
    values.sort_unstable_by(f32::total_cmp);
    let index = ((values.len() - 1) as f32 * fraction.clamp(0.0, 1.0)).round() as usize;
    values[index]
}

fn normalize_band_flux(raw_flux: &[[f32; BAND_COUNT]]) -> Vec<[f32; BAND_COUNT]> {
    let mut scales = [0.0_f32; BAND_COUNT];
    for band in 0..BAND_COUNT {
        scales[band] = percentile(raw_flux.iter().map(|frame| frame[band]), 0.9).max(1.0e-7);
    }

    let mut mean = [0.0_f32; BAND_COUNT];
    let mut deviation = [0.02_f32; BAND_COUNT];
    let mut result = vec![[0.0_f32; BAND_COUNT]; raw_flux.len()];
    for (frame_index, flux) in raw_flux.iter().enumerate() {
        for band in 0..BAND_COUNT {
            let scaled = (flux[band] / scales[band]).min(12.0);
            let excess = scaled - mean[band] - deviation[band] * 0.35;
            let normalized = 1.0 - (-excess.max(0.0) / (deviation[band] * 2.5 + 0.08)).exp();
            result[frame_index][band] = unit(normalized);

            // Update after measuring the current frame so a transient is not used
            // to raise its own threshold. Slow release follows section loudness.
            let delta = scaled - mean[band];
            mean[band] += delta * 0.018;
            deviation[band] += (delta.abs() - deviation[band]) * 0.018;
        }
    }
    result
}

fn combine_band_novelty(bands: &[[f32; BAND_COUNT]]) -> Vec<f32> {
    bands
        .iter()
        .map(|values| {
            let mut sorted = *values;
            sorted.sort_unstable_by(|left, right| right.total_cmp(left));
            let strongest = (sorted[0] + sorted[1]) * 0.5;
            let average = values.iter().sum::<f32>() / BAND_COUNT as f32;
            unit(strongest * 0.68 + average * 0.32)
        })
        .collect()
}

/// Peak linear band level inside the same ±3 frame neighbourhood used for
/// onset peak picking, so the reported level still captures the transient when
/// the spectral-flux peak leads or trails the energy peak by a frame or two.
fn onset_band_levels(band_linear: &[[f32; BAND_COUNT]], frame: usize) -> [f32; BAND_COUNT] {
    if band_linear.is_empty() {
        return [0.0; BAND_COUNT];
    }
    let start = frame.saturating_sub(3);
    let end = (frame + 3).min(band_linear.len() - 1);
    let mut levels = [0.0_f32; BAND_COUNT];
    for frame_levels in &band_linear[start..=end] {
        for band in 0..BAND_COUNT {
            levels[band] = levels[band].max(frame_levels[band]);
        }
    }
    levels.map(|value| if value.is_finite() { value.max(0.0) } else { 0.0 })
}

fn pick_onset_frames(novelty: &[f32]) -> Vec<usize> {
    if novelty.len() < 3 {
        return Vec::new();
    }
    let mut candidates = Vec::new();
    for frame in 1..novelty.len() - 1 {
        let start = frame.saturating_sub(3);
        let end = (frame + 3).min(novelty.len() - 1);
        let is_peak = (start..=end).all(|nearby| {
            nearby == frame
                || novelty[frame] > novelty[nearby]
                || (nearby > frame && novelty[frame] == novelty[nearby])
        });
        if is_peak && novelty[frame] >= 0.14 {
            if let Some(previous) = candidates.last_mut()
                && frame - *previous < 4
            {
                if novelty[frame] > novelty[*previous] {
                    *previous = frame;
                }
                continue;
            }
            candidates.push(frame);
        }
    }
    candidates
}

fn make_energy_envelope(
    rms: &[f32],
    sample_rate: u32,
    duration_ms: u64,
) -> (Vec<RhythmTimedValue>, f32) {
    let scale = percentile(rms.iter().copied(), 0.95);
    if scale <= 1.0e-8 {
        return (Vec::new(), 0.0);
    }
    const FRAMES_PER_POINT: usize = 4;
    let mut points = Vec::with_capacity(rms.len().div_ceil(FRAMES_PER_POINT));
    for start in (0..rms.len()).step_by(FRAMES_PER_POINT) {
        let block = &rms[start..(start + FRAMES_PER_POINT).min(rms.len())];
        let mean = block.iter().sum::<f32>() / block.len() as f32;
        points.push(RhythmTimedValue {
            time_ms: frame_to_ms(start as f64, sample_rate).min(duration_ms),
            value: unit(mean / scale),
        });
    }
    (points, scale)
}

fn smooth_tempo_envelope(novelty: &[f32], onset_frames: &[usize]) -> Vec<f32> {
    let mut peaks = vec![0.0_f32; novelty.len()];
    for &frame in onset_frames {
        peaks[frame] = novelty[frame];
    }
    let mut smoothed = vec![0.0_f32; novelty.len()];
    const KERNEL: [f32; 5] = [0.12, 0.24, 0.28, 0.24, 0.12];
    for (frame, value) in smoothed.iter_mut().enumerate() {
        for (kernel_index, weight) in KERNEL.iter().enumerate() {
            let source = frame as isize + kernel_index as isize - 2;
            if source >= 0 && (source as usize) < peaks.len() {
                *value += peaks[source as usize] * weight;
            }
        }
    }
    smoothed
}

#[derive(Clone, Copy, Debug)]
struct TempoEstimate {
    bpm: f32,
    confidence: f32,
    period_frames: f32,
}

fn estimate_tempo(envelope: &[f32], frames_per_second: f32) -> Option<TempoEstimate> {
    let min_lag = ((frames_per_second * 60.0 / MAX_TEMPO_BPM).floor() as usize).max(1);
    let max_lag = (frames_per_second * 60.0 / MIN_TEMPO_BPM).floor() as usize;
    if max_lag < min_lag
        || envelope.len() < max_lag.max((frames_per_second * 4.0) as usize)
        || envelope.iter().sum::<f32>() < 0.8
    {
        return None;
    }

    // Keep tempo candidates inside the configured range, but retain one real
    // score on either side so a boundary winner can still be interpolated
    // against three distinct samples. Reusing the boundary score itself makes
    // the parabola produce a fixed +/-0.5-frame offset.
    let score_min_lag = min_lag.saturating_sub(1).max(1);
    let score_max_lag = max_lag.checked_add(1)?;
    let correlation_len = score_max_lag.checked_mul(2)?.checked_add(1)?;
    let mut correlation = vec![0.0_f32; correlation_len];
    // Correlations outside the candidate range feed the interpolation guards;
    // faster ones also reject half/third-tempo interpretations near the upper
    // boundary.
    for lag in (min_lag / 3).max(1)..correlation.len() {
        if lag >= envelope.len() {
            break;
        }
        let mut product = 0.0_f32;
        let mut left_power = 0.0_f32;
        let mut right_power = 0.0_f32;
        for index in lag..envelope.len() {
            let left = envelope[index];
            let right = envelope[index - lag];
            product += left * right;
            left_power += left * left;
            right_power += right * right;
        }
        correlation[lag] = product / (left_power * right_power).sqrt().max(1.0e-8);
    }

    let mut scores = vec![0.0_f32; score_max_lag.checked_add(1)?];
    for lag in score_min_lag..=score_max_lag {
        let double = correlation.get(lag * 2).copied().unwrap_or(0.0);
        let half = correlation.get(lag / 2).copied().unwrap_or(0.0);
        let third_lag = (lag as f32 / 3.0).round() as usize;
        let third = correlation.get(third_lag).copied().unwrap_or(0.0);
        // A candidate whose half-lag is already strongly periodic is usually
        // the half-tempo interpretation. Penalizing that ambiguity keeps a
        // 120 BPM click train at 120 instead of systematically choosing 60.
        let harmonic_score = correlation[lag] + double * 0.35 - half * 0.25 - third * 0.20;
        let bpm = frames_per_second * 60.0 / lag as f32;
        let tempo_prior = (-0.5 * ((bpm / 120.0).log2() / 1.25).powi(2)).exp();
        scores[lag] = (harmonic_score.max(0.0) / 1.35) * (0.95 + tempo_prior * 0.05);
    }
    let (best_lag, &best_score) = (min_lag..=max_lag)
        .map(|lag| (lag, &scores[lag]))
        .max_by(|left, right| left.1.total_cmp(right.1))?;
    if best_score < 0.08 {
        return None;
    }

    let baseline = percentile(scores[min_lag..=max_lag].iter().copied(), 0.5);
    let contrast = unit((best_score - baseline) / (1.0 - baseline).max(1.0e-6));
    let offset = if best_lag > score_min_lag && best_lag < score_max_lag {
        let left = scores[best_lag - 1];
        let right = scores[best_lag + 1];
        let denominator = left - 2.0 * best_score + right;
        if denominator.abs() > 1.0e-6 {
            (0.5 * (left - right) / denominator).clamp(-0.5, 0.5)
        } else {
            0.0
        }
    } else {
        0.0
    };
    let refined_period_frames = best_lag as f32 + offset;
    let raw_bpm = frames_per_second * 60.0 / refined_period_frames;
    if !raw_bpm.is_finite() {
        return None;
    }
    let bpm = raw_bpm.clamp(MIN_TEMPO_BPM, MAX_TEMPO_BPM);
    let period_frames = frames_per_second * 60.0 / bpm;
    let event_count = envelope.iter().filter(|value| **value >= 0.08).count() as f32;
    let expected_beats = envelope.len() as f32 / period_frames;
    let density = unit(event_count / (expected_beats * 3.0).max(1.0));
    let confidence = unit(best_score * 0.58 + contrast * 0.32 + density * 0.10);
    if confidence < 0.12 {
        None
    } else {
        Some(TempoEstimate {
            bpm,
            confidence,
            period_frames,
        })
    }
}

struct GridSpan {
    start_frame: f32,
    end_frame: f32,
    period_frames: f32,
    confidence: f32,
}

fn ms_to_frame(time_ms: u64, sample_rate: u32) -> f32 {
    time_ms as f32 * (sample_rate as f32 / HOP_SIZE as f32) / 1_000.0
}

fn tempo_periods_match(left: f32, right: f32) -> bool {
    (left - right).abs() <= left.abs().max(right.abs()) * 1.0e-6
}

/// tempo segments 是局部估计;只有足够长、足够可信、且明显偏离全局速度的
/// 分段才获得自己的拍格周期。其余区间沿用全局周期,因此恒速曲目的拍格与
/// 分段化之前完全一致。
fn build_grid_spans(
    envelope_len: usize,
    segments: &[RhythmTempoSegment],
    global: TempoEstimate,
    sample_rate: u32,
) -> Vec<GridSpan> {
    let frames_per_second = sample_rate as f32 / HOP_SIZE as f32;
    let mut spans: Vec<GridSpan> = Vec::new();
    for segment in segments {
        let duration = segment.end_ms.saturating_sub(segment.start_ms);
        let deviation = (segment.bpm - global.bpm).abs() / global.bpm.max(1.0);
        let qualified = segment.bpm > 0.0
            && segment.confidence >= SEGMENT_GRID_MIN_CONFIDENCE
            && duration >= SEGMENT_GRID_MIN_DURATION_MS
            && deviation >= SEGMENT_GRID_MIN_BPM_DEVIATION;
        let period_frames = if qualified {
            frames_per_second * 60.0 / segment.bpm
        } else {
            global.period_frames
        };
        let confidence = if qualified {
            segment.confidence
        } else {
            global.confidence
        };
        let end_frame = ms_to_frame(segment.end_ms, sample_rate).min(envelope_len as f32);
        if let Some(last) = spans.last_mut()
            && tempo_periods_match(last.period_frames, period_frames)
        {
            last.end_frame = last.end_frame.max(end_frame);
            last.confidence = last.confidence.max(confidence);
            continue;
        }
        spans.push(GridSpan {
            start_frame: ms_to_frame(segment.start_ms, sample_rate),
            end_frame,
            period_frames,
            confidence,
        });
    }
    match spans.first_mut() {
        Some(first) => first.start_frame = 0.0,
        None => spans.push(GridSpan {
            start_frame: 0.0,
            end_frame: envelope_len as f32,
            period_frames: global.period_frames,
            confidence: global.confidence,
        }),
    }
    if let Some(last) = spans.last_mut() {
        last.end_frame = last.end_frame.max(envelope_len as f32);
    }
    spans.retain(|span| span.end_frame > span.start_frame && span.period_frames >= 1.0);
    spans
}

fn best_grid_phase(envelope: &[f32], span: &GridSpan) -> f32 {
    let phase_steps = (span.period_frames * 4.0).ceil() as usize;
    let mut best_phase = span.start_frame;
    let mut best_phase_score = f32::NEG_INFINITY;
    for step in 0..phase_steps {
        let phase = span.start_frame + step as f32 / 4.0;
        let mut position = phase;
        let mut score = 0.0_f32;
        let mut count = 0_usize;
        while position < span.end_frame {
            let center = position.round() as usize;
            let start = center.saturating_sub(2);
            let end = (center + 2).min(envelope.len() - 1);
            score += envelope[start..=end]
                .iter()
                .copied()
                .fold(0.0_f32, f32::max);
            count += 1;
            position += span.period_frames;
        }
        if count == 0 {
            continue;
        }
        let normalized = score / count as f32;
        if normalized > best_phase_score {
            best_phase_score = normalized;
            best_phase = phase;
        }
    }
    best_phase
}

fn build_beat_grid(
    envelope: &[f32],
    tempo: TempoEstimate,
    segments: &[RhythmTempoSegment],
    sample_rate: u32,
    duration_ms: u64,
) -> Vec<RhythmBeatPoint> {
    if envelope.is_empty() || tempo.period_frames < 1.0 {
        return Vec::new();
    }
    let frame_duration_ms = HOP_SIZE as f32 * 1_000.0 / sample_rate as f32;
    let spans = build_grid_spans(envelope.len(), segments, tempo, sample_rate);
    let mut beats: Vec<RhythmBeatPoint> = Vec::new();
    for span in &spans {
        let search_radius = (span.period_frames * 0.16).round().clamp(2.0, 8.0) as usize;
        // 跨段衔接:新段首拍与上一段末拍至少间隔 0.45 个周期,
        // 避免相位重搜在边界处挤出双拍。
        let min_gap_ms = (span.period_frames * 0.45 * frame_duration_ms) as u64;
        let mut expected = best_grid_phase(envelope, span);
        while expected < span.end_frame {
            let center = expected.round() as usize;
            let start = center.saturating_sub(search_radius);
            let end = (center + search_radius).min(envelope.len() - 1);
            let mut selected = center.min(envelope.len() - 1);
            let mut selected_score = 0.0_f32;
            for candidate in start..=end {
                let timing_penalty =
                    (candidate as f32 - expected).abs() / search_radius as f32 * 0.18;
                let score = envelope[candidate] - timing_penalty;
                if score > selected_score {
                    selected = candidate;
                    selected_score = score;
                }
            }
            let local_strength = unit(envelope[selected] * 2.2);
            let selected_frame = if local_strength >= 0.06 {
                selected as f64
            } else {
                expected as f64
            };
            let time_ms = frame_to_ms(selected_frame, sample_rate).min(duration_ms);
            if beats.last().is_none_or(|previous: &RhythmBeatPoint| {
                previous.time_ms < time_ms && time_ms - previous.time_ms >= min_gap_ms
            }) {
                beats.push(RhythmBeatPoint {
                    time_ms,
                    strength: local_strength,
                    confidence: unit(span.confidence * (0.32 + local_strength * 0.68)),
                });
            }
            expected += span.period_frames;
        }
    }
    beats
}

fn beat_coverage(beats: &[RhythmBeatPoint]) -> f32 {
    if beats.is_empty() {
        return 0.0;
    }
    unit(beats.iter().filter(|beat| beat.strength >= 0.12).count() as f32 / beats.len() as f32)
}

fn estimate_tempo_segments(
    envelope: &[f32],
    sample_rate: u32,
    duration_ms: u64,
    global: TempoEstimate,
) -> Vec<RhythmTempoSegment> {
    let frames_per_second = sample_rate as f32 / HOP_SIZE as f32;
    let window_frames = (frames_per_second * 18.0).round() as usize;
    if envelope.len() < window_frames + window_frames / 3 {
        return vec![RhythmTempoSegment {
            start_ms: 0,
            end_ms: duration_ms,
            bpm: global.bpm,
            confidence: global.confidence,
        }];
    }

    // Downsample envelope by 2× for sliding-window tempo estimation.
    // The 18-second windows don't need 11ms resolution; reducing the input
    // and lag ranges by half cuts autocorrelation cost to roughly one quarter.
    // Sum pooling preserves the absolute energy used by estimate_tempo's
    // sparse-window guard.
    let downsampled = envelope
        .chunks(TEMPO_SEGMENT_DOWNSAMPLE)
        .map(|chunk| chunk.iter().sum::<f32>())
        .collect::<Vec<_>>();
    let downsampled_window_frames = window_frames.div_ceil(TEMPO_SEGMENT_DOWNSAMPLE);

    let mut raw_segments = Vec::new();
    for start in (0..downsampled.len()).step_by(downsampled_window_frames) {
        let end = (start + downsampled_window_frames).min(downsampled.len());
        let estimate = estimate_tempo(
            &downsampled[start..end],
            frames_per_second / TEMPO_SEGMENT_DOWNSAMPLE as f32,
        )
        .unwrap_or(global);
        // Map downsampled frame indices back to original timeline
        let original_start = start * TEMPO_SEGMENT_DOWNSAMPLE;
        let original_end = (end * TEMPO_SEGMENT_DOWNSAMPLE).min(envelope.len());
        let start_ms = frame_boundary_to_ms(original_start, sample_rate).min(duration_ms);
        let end_ms = frame_boundary_to_ms(original_end, sample_rate).min(duration_ms);
        if start_ms >= end_ms {
            continue;
        }
        raw_segments.push(RhythmTempoSegment {
            start_ms,
            end_ms,
            bpm: estimate.bpm,
            confidence: estimate.confidence,
        });
    }

    let mut merged: Vec<RhythmTempoSegment> = Vec::new();
    for segment in raw_segments {
        if let Some(previous) = merged.last_mut()
            && (previous.bpm - segment.bpm).abs() <= previous.bpm * 0.025
        {
            let previous_duration = previous.end_ms.saturating_sub(previous.start_ms) as f32;
            let segment_duration = segment.end_ms.saturating_sub(segment.start_ms) as f32;
            let total_duration = (previous_duration + segment_duration).max(1.0);
            previous.bpm = (previous.bpm * previous_duration + segment.bpm * segment_duration)
                / total_duration;
            previous.confidence = unit(
                (previous.confidence * previous_duration + segment.confidence * segment_duration)
                    / total_duration,
            );
            previous.end_ms = segment.end_ms;
            continue;
        }
        merged.push(segment);
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::MAX_RECOVERABLE_DECODE_ERRORS;
    use ffmpeg_audio::AudioError;

    fn high_frequency_click_track(bpm: f32, seconds: f32) -> Vec<f32> {
        let mut pcm = vec![0.0_f32; (TARGET_SAMPLE_RATE as f32 * seconds) as usize];
        let beat_period = TARGET_SAMPLE_RATE as f32 * 60.0 / bpm;
        let mut beat = TARGET_SAMPLE_RATE as f32 * 0.25;
        while beat < pcm.len() as f32 {
            let start = beat.round() as usize;
            let burst_length = (TARGET_SAMPLE_RATE as f32 * 0.012) as usize;
            for offset in 0..burst_length.min(pcm.len() - start) {
                let decay = 1.0 - offset as f32 / burst_length as f32;
                pcm[start + offset] +=
                    (2.0 * PI * 6_500.0 * offset as f32 / TARGET_SAMPLE_RATE as f32).sin()
                        * decay
                        * 0.8;
            }
            beat += beat_period;
        }
        pcm
    }

    #[test]
    fn ffmpeg_invalid_data_errors_are_recoverable_only_within_budget() {
        let damaged_frame = AudioError::FFmpeg(
            ffmpeg_audio::sys::AVERROR_INVALIDDATA,
            "invalid data".to_owned(),
        );
        let unrelated_ffmpeg_error = AudioError::FFmpeg(-1, "unrelated".to_owned());

        assert!(can_skip_decode_error(&damaged_frame, 0));
        assert!(can_skip_decode_error(
            &damaged_frame,
            MAX_RECOVERABLE_DECODE_ERRORS - 1
        ));
        assert!(!can_skip_decode_error(
            &damaged_frame,
            MAX_RECOVERABLE_DECODE_ERRORS
        ));
        assert!(!can_skip_decode_error(&unrelated_ffmpeg_error, 0));
        assert!(!can_skip_decode_error(&AudioError::Eof, 0));
    }

    #[test]
    fn chunked_streaming_matches_single_slice_analysis() {
        let mut pcm = high_frequency_click_track(120.0, 8.0);
        // 掺入非法样本,验证与整段路径一致的清洗行为。
        pcm[1_000] = f32::NAN;
        let whole = analyze_mono_pcm(&pcm, TARGET_SAMPLE_RATE).unwrap();

        let mut accumulator = SpectralAccumulator::new(TARGET_SAMPLE_RATE);
        // 777 与 hop/窗口都不对齐,专门制造跨块的帧边界。
        for chunk in pcm.chunks(777) {
            accumulator.push(chunk);
        }
        let mut loudness_meter = TrackLoudnessMeter::new(TARGET_SAMPLE_RATE);
        loudness_meter.push_dual_mono(&pcm);
        let streamed = finish_analysis(
            accumulator,
            TARGET_SAMPLE_RATE,
            Some(loudness_meter.finish()),
        )
        .unwrap();
        assert_eq!(whole, streamed);
    }

    #[test]
    fn large_pcm_slice_does_not_expand_pending_to_track_size() {
        let mut accumulator = SpectralAccumulator::new(TARGET_SAMPLE_RATE);
        let pcm = vec![0.0_f32; FFT_SIZE * 64 + 123];
        accumulator.push(&pcm);

        assert!(accumulator.pending.len() < FFT_SIZE);
        assert!(
            accumulator.pending.capacity() <= FFT_SIZE * 4,
            "pending capacity grew to {} samples",
            accumulator.pending.capacity()
        );
    }

    #[test]
    fn silence_has_no_false_rhythm() {
        let pcm = vec![0.0_f32; TARGET_SAMPLE_RATE as usize * 6];
        let analysis = analyze_mono_pcm(&pcm, TARGET_SAMPLE_RATE).unwrap();
        assert_eq!(analysis.global_bpm, None);
        assert_eq!(analysis.confidence, 0.0);
        assert!(analysis.beats.is_empty());
        assert!(analysis.onsets.is_empty());
        assert!(analysis.energy_envelope.is_empty());
        assert_eq!(analysis.energy_scale, 0.0);
        let loudness = analysis
            .loudness
            .expect("silence should be marked as analyzed");
        assert!(loudness.is_current());
        assert_eq!(loudness.integrated_loudness_lufs, None);
        assert_eq!(loudness.sample_peak, 0.0);
    }

    #[test]
    fn integrated_loudness_tracks_perceived_amplitude() {
        let pcm = (0..TARGET_SAMPLE_RATE as usize * 3)
            .map(|sample| {
                (2.0 * PI * 1_000.0 * sample as f32 / TARGET_SAMPLE_RATE as f32).sin() * 0.4
            })
            .collect::<Vec<_>>();
        let quieter_pcm = pcm.iter().map(|sample| sample * 0.5).collect::<Vec<_>>();
        let loud = analyze_mono_pcm(&pcm, TARGET_SAMPLE_RATE).unwrap();
        let quiet = analyze_mono_pcm(&quieter_pcm, TARGET_SAMPLE_RATE).unwrap();
        let loudness = loud.loudness.unwrap();
        let quiet_loudness = quiet.loudness.unwrap();
        let difference = loudness.integrated_loudness_lufs.unwrap()
            - quiet_loudness.integrated_loudness_lufs.unwrap();

        assert!(
            (difference - 6.0206).abs() < 0.05,
            "difference was {difference}"
        );
        assert!((loudness.sample_peak - 0.4).abs() < 1.0e-4);
        assert!((quiet_loudness.sample_peak - 0.2).abs() < 1.0e-4);
    }

    #[test]
    fn energy_scale_preserves_absolute_pcm_level() {
        let pcm = (0..TARGET_SAMPLE_RATE as usize * 2)
            .map(|sample| {
                (2.0 * PI * 440.0 * sample as f32 / TARGET_SAMPLE_RATE as f32).sin() * 0.6
            })
            .collect::<Vec<_>>();
        let quieter_pcm = pcm.iter().map(|sample| sample * 0.25).collect::<Vec<_>>();
        let loud = analyze_mono_pcm(&pcm, TARGET_SAMPLE_RATE).unwrap();
        let quiet = analyze_mono_pcm(&quieter_pcm, TARGET_SAMPLE_RATE).unwrap();

        assert!(loud.energy_scale > 0.0);
        assert!((loud.energy_scale / quiet.energy_scale - 4.0).abs() < 1.0e-4);
        assert_eq!(loud.energy_envelope.len(), quiet.energy_envelope.len());
        for (loud_point, quiet_point) in loud
            .energy_envelope
            .iter()
            .zip(quiet.energy_envelope.iter())
        {
            assert!((loud_point.value - quiet_point.value).abs() < 1.0e-5);
        }
    }

    #[test]
    fn high_frequency_clicks_are_detected_without_bass() {
        let pcm = high_frequency_click_track(120.0, 12.0);
        let analysis = analyze_mono_pcm(&pcm, TARGET_SAMPLE_RATE).unwrap();
        let bpm = analysis.global_bpm.expect("expected a tempo estimate");
        assert!((115.0..=125.0).contains(&bpm), "unexpected BPM: {bpm}");
        assert!(
            analysis.confidence > 0.2,
            "low confidence: {}",
            analysis.confidence
        );
        assert!(
            analysis.onsets.len() >= 18,
            "too few onsets: {}",
            analysis.onsets.len()
        );
        assert!(
            analysis.beats.len() >= 18,
            "too few beats: {}",
            analysis.beats.len()
        );
        assert!(analysis.onsets.iter().any(|onset| onset.bands[4] > 0.4));
    }

    #[test]
    fn fast_high_frequency_rhythm_does_not_collapse_to_half_or_third_tempo() {
        for expected_bpm in [174.0_f32, 205.0, 210.0] {
            let pcm = high_frequency_click_track(expected_bpm, 16.0);
            let analysis = analyze_mono_pcm(&pcm, TARGET_SAMPLE_RATE).unwrap();
            let bpm = analysis.global_bpm.expect("expected a fast tempo estimate");
            assert!(
                (bpm - expected_bpm).abs() <= 6.0,
                "expected about {expected_bpm} BPM, detected {bpm} BPM"
            );
        }
    }

    /// 模拟弦乐/弱奏钢琴:120ms 线性起音的双音摆动,无任何打击性瞬态。
    fn soft_attack_track(bpm: f32, seconds: f32) -> Vec<f32> {
        let mut pcm = vec![0.0_f32; (TARGET_SAMPLE_RATE as f32 * seconds) as usize];
        let period = TARGET_SAMPLE_RATE as f32 * 60.0 / bpm;
        let attack_samples = (TARGET_SAMPLE_RATE as f32 * 0.12) as usize;
        let note_samples = (TARGET_SAMPLE_RATE as f32 * 0.32) as usize;
        let mut start = TARGET_SAMPLE_RATE as f32 * 0.25;
        let mut note_index = 0_usize;
        while (start as usize) < pcm.len() {
            let base = start as usize;
            // 相邻音符换音高,让频谱确实发生变化而不是纯响度摆动。
            let frequency = if note_index % 2 == 0 { 294.0 } else { 392.0 };
            for offset in 0..note_samples.min(pcm.len() - base) {
                let envelope = if offset < attack_samples {
                    offset as f32 / attack_samples as f32
                } else {
                    1.0 - (offset - attack_samples) as f32
                        / (note_samples - attack_samples) as f32
                };
                let phase = 2.0 * PI * offset as f32 / TARGET_SAMPLE_RATE as f32;
                pcm[base + offset] += (phase * frequency).sin() * envelope * 0.28
                    + (phase * frequency * 2.0).sin() * envelope * 0.12;
            }
            start += period;
            note_index += 1;
        }
        pcm
    }

    #[test]
    fn soft_attacks_still_produce_onsets_and_a_beat_grid() {
        let pcm = soft_attack_track(70.0, 16.0);
        let analysis = analyze_mono_pcm(&pcm, TARGET_SAMPLE_RATE).unwrap();
        // 16s × 70BPM ≈ 18 个音符起音。
        assert!(
            analysis.onsets.len() >= 12,
            "soft attacks lost: only {} onsets",
            analysis.onsets.len()
        );
        let bpm = analysis
            .global_bpm
            .expect("soft attack track should still yield a tempo");
        let normalized = if bpm > 100.0 { bpm / 2.0 } else { bpm };
        assert!(
            (normalized - 70.0).abs() <= 5.0,
            "unexpected BPM for soft attack track: {bpm}"
        );
        assert!(
            analysis.beats.iter().filter(|beat| beat.strength >= 0.06).count() >= 10,
            "beat grid failed to lock onto soft attacks"
        );
    }

    #[test]
    fn leading_edge_artifact_does_not_mask_a_real_early_hit() {
        // 背景音从第 0 采样点就存在(歌曲被剪辑到直接开唱是常态),
        // 真实的宽频敲击落在 ~30ms。旧实现里第 0 帧与全零 previous_spectrum
        // 比较会产生虚假满幅 novelty,峰值窗口内真实敲击永远赢不了它。
        let mut pcm = (0..TARGET_SAMPLE_RATE as usize * 4)
            .map(|sample| {
                (2.0 * PI * 440.0 * sample as f32 / TARGET_SAMPLE_RATE as f32).sin() * 0.18
            })
            .collect::<Vec<_>>();
        let click_start = (TARGET_SAMPLE_RATE as f32 * 0.03) as usize;
        let click_length = (TARGET_SAMPLE_RATE as f32 * 0.012) as usize;
        for offset in 0..click_length {
            let decay = 1.0 - offset as f32 / click_length as f32;
            pcm[click_start + offset] +=
                (2.0 * PI * 6_500.0 * offset as f32 / TARGET_SAMPLE_RATE as f32).sin()
                    * decay
                    * 0.8;
        }
        let analysis = analyze_mono_pcm(&pcm, TARGET_SAMPLE_RATE).unwrap();
        let first = analysis
            .onsets
            .first()
            .expect("the early hit should be detected");
        assert!(
            first.time_ms <= 90,
            "early hit was masked by the leading-edge artifact: first onset at {}ms",
            first.time_ms
        );
        assert!(
            first.strength >= 0.4,
            "early hit strength too weak: {}",
            first.strength
        );
    }

    fn dual_band_track(seconds: f32) -> Vec<f32> {
        let mut pcm = vec![0.0_f32; (TARGET_SAMPLE_RATE as f32 * seconds) as usize];
        let mut write_burst = |start_s: f32, freq: f32, amp: f32, length_s: f32| {
            let start = (TARGET_SAMPLE_RATE as f32 * start_s) as usize;
            let burst_length = (TARGET_SAMPLE_RATE as f32 * length_s) as usize;
            for offset in 0..burst_length.min(pcm.len().saturating_sub(start)) {
                let decay = 1.0 - offset as f32 / burst_length as f32;
                pcm[start + offset] +=
                    (2.0 * PI * freq * offset as f32 / TARGET_SAMPLE_RATE as f32).sin()
                        * decay
                        * amp;
            }
        };
        let mut cursor = 0.25_f32;
        while cursor + 0.5 < seconds {
            // 响亮的低频鼓与安静的高频 tick 交替出现。
            write_burst(cursor, 80.0, 0.7, 0.04);
            write_burst(cursor + 0.25, 6_500.0, 0.06, 0.012);
            cursor += 0.5;
        }
        pcm
    }

    #[test]
    fn band_levels_capture_absolute_band_loudness() {
        let pcm = dual_band_track(12.0);
        let analysis = analyze_mono_pcm(&pcm, TARGET_SAMPLE_RATE).unwrap();

        let mut kick_low_levels = Vec::new();
        let mut tick_high_levels = Vec::new();
        for onset in &analysis.onsets {
            // kick 落在 mod 500 ≈ 250 处,tick 落在 mod 500 ≈ 0 处;
            // frame_to_ms 的窗中心偏移约 +23ms,±40ms 容差足够覆盖。
            let phase_ms = onset.time_ms % 500;
            let near_kick = phase_ms.abs_diff(250) <= 40;
            let near_tick =
                onset.time_ms >= 400 && phase_ms.min(500 - phase_ms) <= 40;
            if near_kick {
                kick_low_levels.push(onset.band_levels[0]);
            } else if near_tick {
                tick_high_levels.push(onset.band_levels[4]);
            }
        }

        assert!(
            kick_low_levels.len() >= 8,
            "too few kick onsets: {}",
            kick_low_levels.len()
        );
        assert!(
            tick_high_levels.len() >= 8,
            "too few tick onsets: {}",
            tick_high_levels.len()
        );
        let kick_low = percentile(kick_low_levels.iter().copied(), 0.5);
        let tick_high = percentile(tick_high_levels.iter().copied(), 0.5);
        assert!(kick_low >= 0.05, "kick band level too small: {kick_low}");
        assert!(tick_high > 0.0, "tick band level missing: {tick_high}");
        assert!(
            kick_low >= tick_high * 4.0,
            "absolute band loudness ranking lost: kick={kick_low} tick={tick_high}"
        );

        let value = serde_json::to_value(&analysis).unwrap();
        let first_onset = value["onsets"][0]
            .as_object()
            .expect("onset should serialize as object");
        assert!(first_onset.contains_key("bandLevels"));
        assert!(first_onset.get("band_levels").is_none());

        let mut legacy_value = serde_json::to_value(&analysis).unwrap();
        for onset in legacy_value["onsets"].as_array_mut().unwrap() {
            onset.as_object_mut().unwrap().remove("bandLevels");
        }
        let restored: RhythmAnalysis = serde_json::from_value(legacy_value).unwrap();
        assert!(
            restored
                .onsets
                .iter()
                .all(|onset| onset.band_levels == [0.0; BAND_COUNT])
        );
    }

    fn add_click(pcm: &mut [f32], time_s: f32, amp: f32) {
        let start = (TARGET_SAMPLE_RATE as f32 * time_s) as usize;
        let length = (TARGET_SAMPLE_RATE as f32 * 0.012) as usize;
        for offset in 0..length.min(pcm.len().saturating_sub(start)) {
            let decay = 1.0 - offset as f32 / length as f32;
            pcm[start + offset] +=
                (2.0 * PI * 3_000.0 * offset as f32 / TARGET_SAMPLE_RATE as f32).sin()
                    * decay
                    * amp;
        }
    }

    fn misaligned_clicks(
        clicks: &[f32],
        beats: &[RhythmBeatPoint],
        tolerance_ms: f32,
    ) -> usize {
        clicks
            .iter()
            .filter(|&&click| {
                let click_ms = click * 1_000.0 + 23.2;
                !beats.iter().any(|beat| {
                    beat.strength >= 0.06
                        && (beat.time_ms as f32 - click_ms).abs() <= tolerance_ms
                })
            })
            .count()
    }

    fn synthetic_tempo_envelope(
        len: usize,
        start_frame: f32,
        interval_frames: f32,
        strength: f32,
    ) -> Vec<f32> {
        let mut novelty = vec![0.0_f32; len];
        let mut onset_frames = Vec::new();
        let mut position = start_frame;
        while position < len as f32 {
            let frame = position.round() as usize;
            if frame >= len {
                break;
            }
            novelty[frame] = strength;
            onset_frames.push(frame);
            position += interval_frames;
        }
        smooth_tempo_envelope(&novelty, &onset_frames)
    }

    fn dominant_tempo_segment(segments: &[RhythmTempoSegment]) -> &RhythmTempoSegment {
        segments
            .iter()
            .max_by_key(|segment| segment.end_ms.saturating_sub(segment.start_ms))
            .expect("expected at least one tempo segment")
    }

    #[test]
    fn sparse_local_tempo_survives_energy_preserving_downsample() {
        let frames_per_second = TARGET_SAMPLE_RATE as f32 / HOP_SIZE as f32;
        let window_frames = (frames_per_second * 18.0).round() as usize;
        let envelope = synthetic_tempo_envelope(window_frames * 2, 20.0, 148.0, 0.14);
        let global = TempoEstimate {
            bpm: 120.0,
            confidence: 0.9,
            period_frames: frames_per_second * 60.0 / 120.0,
        };
        let duration_ms = frame_boundary_to_ms(envelope.len(), TARGET_SAMPLE_RATE);

        let segments = estimate_tempo_segments(&envelope, TARGET_SAMPLE_RATE, duration_ms, global);
        let dominant = dominant_tempo_segment(&segments);
        let expected_bpm = frames_per_second * 60.0 / 74.0;

        assert!(
            (dominant.bpm - expected_bpm).abs() <= 2.0,
            "sparse local tempo fell back to global: expected {expected_bpm}, got {}",
            dominant.bpm
        );
    }

    #[test]
    fn local_tempo_downsample_preserves_maximum_bpm() {
        let frames_per_second = TARGET_SAMPLE_RATE as f32 / HOP_SIZE as f32;
        let window_frames = (frames_per_second * 18.0).round() as usize;
        let interval = frames_per_second * 60.0 / MAX_TEMPO_BPM;
        let envelope = synthetic_tempo_envelope(window_frames * 2, 20.0, interval, 1.0);
        let global = TempoEstimate {
            bpm: 120.0,
            confidence: 0.9,
            period_frames: frames_per_second * 60.0 / 120.0,
        };
        let duration_ms = frame_boundary_to_ms(envelope.len(), TARGET_SAMPLE_RATE);

        let segments = estimate_tempo_segments(&envelope, TARGET_SAMPLE_RATE, duration_ms, global);
        let dominant = dominant_tempo_segment(&segments);

        assert!(
            (dominant.bpm - MAX_TEMPO_BPM).abs() <= 6.0,
            "210 BPM local segment collapsed to {} BPM",
            dominant.bpm
        );
    }

    #[test]
    fn full_and_local_tempo_windows_distinguish_upper_boundary_tempos() {
        let full_frames_per_second = TARGET_SAMPLE_RATE as f32 / HOP_SIZE as f32;
        for frames_per_second in [
            full_frames_per_second,
            full_frames_per_second / TEMPO_SEGMENT_DOWNSAMPLE as f32,
        ] {
            let window_frames = (frames_per_second * 18.0).round() as usize;
            let mut detected_bpms = Vec::new();

            for expected_bpm in [207.0_f32, 208.0, 209.0, 210.0] {
                let interval = frames_per_second * 60.0 / expected_bpm;
                let envelope = synthetic_tempo_envelope(window_frames * 4, 3.25, interval, 1.0);
                let mut window_bpms = Vec::new();
                for (window_index, window) in envelope.chunks(window_frames).enumerate() {
                    let estimate = estimate_tempo(window, frames_per_second)
                        .expect("expected a boundary tempo estimate");
                    assert!(
                        (estimate.bpm - expected_bpm).abs() <= 0.9,
                        "window {window_index} at {frames_per_second} FPS of {expected_bpm} BPM \
                         was estimated as {} BPM",
                        estimate.bpm
                    );
                    window_bpms.push(estimate.bpm);
                }
                detected_bpms.push(window_bpms.iter().sum::<f32>() / window_bpms.len() as f32);
            }

            for pair in detected_bpms.windows(2) {
                assert!(
                    pair[1] - pair[0] >= 0.25,
                    "upper-boundary tempos still stick together at {frames_per_second} FPS: \
                     {detected_bpms:?}"
                );
            }
        }
    }

    #[test]
    fn lower_boundary_interpolation_also_uses_a_real_guard_score() {
        let frames_per_second =
            TARGET_SAMPLE_RATE as f32 / HOP_SIZE as f32 / TEMPO_SEGMENT_DOWNSAMPLE as f32;
        let window_frames = (frames_per_second * 18.0).round() as usize;

        for expected_bpm in [55.5_f32, 56.0, 56.5] {
            let envelope = synthetic_tempo_envelope(
                window_frames,
                3.25,
                frames_per_second * 60.0 / expected_bpm,
                1.0,
            );
            let estimate = estimate_tempo(&envelope, frames_per_second)
                .expect("expected a lower-boundary tempo estimate");
            assert!(
                (estimate.bpm - expected_bpm).abs() <= 0.2,
                "{expected_bpm} BPM was estimated as {} BPM",
                estimate.bpm
            );
        }
    }

    #[test]
    fn long_fast_beat_grid_keeps_phase_and_interval() {
        let frames_per_second = TARGET_SAMPLE_RATE as f32 / HOP_SIZE as f32;
        let expected_bpm = 207.0_f32;
        let interval = frames_per_second * 60.0 / expected_bpm;
        let duration_seconds = 96.0_f32;
        let envelope_len = (frames_per_second * duration_seconds).round() as usize;
        let start_frame = 7.25_f32;
        let envelope = synthetic_tempo_envelope(envelope_len, start_frame, interval, 1.0);
        let local_frames_per_second = frames_per_second / TEMPO_SEGMENT_DOWNSAMPLE as f32;
        let local_window_frames = (local_frames_per_second * 18.0).round() as usize;
        let local_envelope = synthetic_tempo_envelope(
            local_window_frames,
            start_frame / TEMPO_SEGMENT_DOWNSAMPLE as f32,
            local_frames_per_second * 60.0 / expected_bpm,
            1.0,
        );
        let local = estimate_tempo(&local_envelope, local_frames_per_second)
            .expect("expected a local tempo estimate");
        let tempo = TempoEstimate {
            bpm: local.bpm,
            confidence: local.confidence,
            period_frames: local.period_frames * TEMPO_SEGMENT_DOWNSAMPLE as f32,
        };
        let duration_ms = frame_boundary_to_ms(envelope_len, TARGET_SAMPLE_RATE);
        let beats = build_beat_grid(&envelope, tempo, &[], TARGET_SAMPLE_RATE, duration_ms);
        let strong_beats = beats
            .iter()
            .filter(|beat| beat.strength >= 0.06)
            .collect::<Vec<_>>();

        let expected_count = ((envelope_len as f32 - start_frame) / interval).floor() as usize + 1;
        assert!(
            strong_beats.len().abs_diff(expected_count) <= 2,
            "long-grid strong beat count was {}/{} at {} BPM",
            strong_beats.len(),
            expected_count,
            local.bpm
        );

        let expected_interval_ms = 60_000.0 / expected_bpm;
        let phase_tolerance_ms = HOP_SIZE as f32 * 2.0 * 1_000.0 / TARGET_SAMPLE_RATE as f32;
        for expected_index in [0, expected_count / 2, expected_count - 1] {
            let expected_frame = (start_frame + expected_index as f32 * interval).round();
            let expected_time_ms = frame_to_ms(expected_frame as f64, TARGET_SAMPLE_RATE);
            let phase_error_ms = strong_beats
                .iter()
                .map(|beat| (beat.time_ms as f32 - expected_time_ms as f32).abs())
                .fold(f32::INFINITY, f32::min);
            assert!(
                phase_error_ms <= phase_tolerance_ms,
                "beat {expected_index} drifted {phase_error_ms} ms from the long-grid phase"
            );
        }
        for pair in strong_beats.windows(2) {
            let interval_ms = pair[1].time_ms.saturating_sub(pair[0].time_ms) as f32;
            assert!(
                (interval_ms - expected_interval_ms).abs() <= 18.0,
                "long-grid interval drifted to {interval_ms} ms at {} BPM",
                local.bpm
            );
        }
        let average_interval_ms = strong_beats
            .last()
            .expect("expected a final strong beat")
            .time_ms
            .saturating_sub(
                strong_beats
                    .first()
                    .expect("expected an initial strong beat")
                    .time_ms,
            ) as f32
            / (strong_beats.len() - 1) as f32;
        assert!(
            (average_interval_ms - expected_interval_ms).abs() <= 0.5,
            "long-grid average interval drifted to {average_interval_ms} ms"
        );
    }

    #[test]
    fn nearly_equal_local_periods_merge_into_one_grid_span() {
        let frames_per_second = TARGET_SAMPLE_RATE as f32 / HOP_SIZE as f32;
        let global = TempoEstimate {
            bpm: 120.0,
            confidence: 0.9,
            period_frames: frames_per_second * 60.0 / 120.0,
        };
        let segments = [
            RhythmTempoSegment {
                start_ms: 0,
                end_ms: 13_000,
                bpm: 100.0,
                confidence: 0.9,
            },
            RhythmTempoSegment {
                start_ms: 13_000,
                end_ms: 26_000,
                bpm: 100.000_05,
                confidence: 0.9,
            },
        ];
        let envelope_len = ms_to_frame(26_000, TARGET_SAMPLE_RATE).ceil() as usize;

        let spans = build_grid_spans(envelope_len, &segments, global, TARGET_SAMPLE_RATE);

        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].start_frame, 0.0);
        assert!(spans[0].end_frame >= envelope_len as f32);
    }

    #[test]
    fn beat_grid_follows_local_tempo_segments() {
        // 前 22 秒 80 BPM,后 22 秒 132 BPM。旧实现用全局单一 BPM 铺满
        // 全曲,慢速半段最多有过半点击对不上拍。
        let seconds = 44.0_f32;
        let mut pcm = vec![0.0_f32; (TARGET_SAMPLE_RATE as f32 * seconds) as usize];
        let mut slow_clicks = Vec::new();
        let mut fast_clicks = Vec::new();
        let mut cursor = 0.25_f32;
        while cursor < 22.0 {
            slow_clicks.push(cursor);
            add_click(&mut pcm, cursor, 0.7);
            cursor += 60.0 / 80.0;
        }
        let mut cursor = 22.0 + 60.0 / 132.0;
        while cursor < seconds - 0.05 {
            fast_clicks.push(cursor);
            add_click(&mut pcm, cursor, 0.7);
            cursor += 60.0 / 132.0;
        }

        let analysis = analyze_mono_pcm(&pcm, TARGET_SAMPLE_RATE).unwrap();
        // 18 秒窗口的分段边界有 ±4 秒的不确定性;只考察远离边界的点击。
        let stable_slow: Vec<f32> = slow_clicks
            .iter()
            .copied()
            .filter(|&click| click < 17.0)
            .collect();
        let stable_fast: Vec<f32> = fast_clicks
            .iter()
            .copied()
            .filter(|&click| click > 23.0)
            .collect();
        assert!(stable_slow.len() >= 20 && stable_fast.len() >= 40);
        let slow_misses = misaligned_clicks(&stable_slow, &analysis.beats, 70.0);
        let fast_misses = misaligned_clicks(&stable_fast, &analysis.beats, 70.0);
        assert_eq!(
            slow_misses, 0,
            "slow half still misaligned: {slow_misses}/{} clicks",
            stable_slow.len()
        );
        assert_eq!(
            fast_misses, 0,
            "fast half still misaligned: {fast_misses}/{} clicks",
            stable_fast.len()
        );

        // 慢速半段的真实拍距应该贴住 750ms,而不是全局 454ms 网格。
        let slow_beats: Vec<u64> = analysis
            .beats
            .iter()
            .filter(|beat| beat.strength >= 0.06 && beat.time_ms < 17_000)
            .map(|beat| beat.time_ms)
            .collect();
        let mut gaps: Vec<f32> = slow_beats
            .windows(2)
            .map(|pair| (pair[1] - pair[0]) as f32)
            .collect();
        gaps.sort_by(f32::total_cmp);
        let median_gap = gaps.get(gaps.len() / 2).copied().unwrap_or(0.0);
        assert!(
            (median_gap - 750.0).abs() <= 40.0,
            "slow half median beat gap {median_gap}ms"
        );
    }

    #[test]
    fn beat_grid_absorbs_mild_rubato() {
        // ±2.5% 的正弦速度摆动(8 秒一个来回)模拟轻音乐的弹性节拍。
        let seconds = 40.0_f32;
        let mut clicks = Vec::new();
        let mut cursor = 0.25_f32;
        while cursor < seconds - 0.05 {
            clicks.push(cursor);
            let inst_bpm = 72.0 * (1.0 + 0.025 * (2.0 * PI * cursor / 8.0).sin());
            cursor += 60.0 / inst_bpm;
        }
        let mut pcm = vec![0.0_f32; (TARGET_SAMPLE_RATE as f32 * seconds) as usize];
        for &click in &clicks {
            add_click(&mut pcm, click, 0.7);
        }
        let analysis = analyze_mono_pcm(&pcm, TARGET_SAMPLE_RATE).unwrap();
        let misses = misaligned_clicks(&clicks, &analysis.beats, 70.0);
        assert_eq!(misses, 0, "rubato clicks lost: {misses}/{}", clicks.len());
    }

    #[test]
    fn json_contract_is_camel_case_and_round_trips() {
        let analysis = RhythmAnalysis::empty(1_234);
        let value = serde_json::to_value(&analysis).unwrap();
        assert_eq!(value["analyzerVersion"], RHYTHM_ANALYZER_VERSION);
        assert_eq!(value["durationMs"], 1_234);
        assert!(value["globalBpm"].is_null());
        assert_eq!(value["energyScale"], 0.0);
        assert_eq!(
            value["loudness"]["analyzerVersion"],
            LOUDNESS_ANALYZER_VERSION
        );
        assert!(value["loudness"]["integratedLoudnessLufs"].is_null());
        assert!(value.get("analyzer_version").is_none());
        let restored: RhythmAnalysis = serde_json::from_value(value).unwrap();
        assert_eq!(analysis, restored);

        let mut legacy_value = serde_json::to_value(&analysis).unwrap();
        legacy_value.as_object_mut().unwrap().remove("energyScale");
        legacy_value.as_object_mut().unwrap().remove("loudness");
        let restored_legacy: RhythmAnalysis = serde_json::from_value(legacy_value).unwrap();
        assert_eq!(restored_legacy.energy_scale, 0.0);
        assert_eq!(restored_legacy.loudness, None);
        assert!(!restored_legacy.has_current_loudness_analysis());
    }
}
