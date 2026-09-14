use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

use crossbeam_channel::{unbounded, Sender};
use crossbeam_utils::sync::{Parker, Unparker};
use ffmpeg_audio::{AudioReader, ResampleOptions};
use ringbuf::{
    traits::{Consumer, Producer, Split},
    HeapCons, HeapRb,
};
use tracing::warn;

use crate::{
    audio_quality::AudioQuality,
    player::{AudioInfo, CustomMediaSource},
    utils::{build_audio_info, can_skip_decode_error},
};

const GAPLESS_PREBUFFER_DURATION_MS: u32 = 1_000;
const AUDIO_BUFFER_DURATION_MS: u32 = 8_000;
const MAX_AUDIO_BUFFER_SAMPLES: usize = 4_000_000;
const AUDIO_BUFFER_REFILL_NUMERATOR: usize = 3;
const AUDIO_BUFFER_REFILL_DENOMINATOR: usize = 4;
const TRAILING_ENERGY_WINDOW_MS: u32 = 250;
const MINIMUM_TRAILING_LOW_ENERGY_MS: u32 = 600;
// 绝对阈值用于正常响度的母带；相对阈值保证安静母带至少保留峰值以下 30 dB
// 的动态，避免仅因整首歌本来就小声而把结尾当作可跳过区域。
const TRAILING_RMS_POWER_THRESHOLD: f64 = 0.000_031_622_776_601_683_79; // -45 dBFS
const TRAILING_PEAK_THRESHOLD: f32 = 0.015_848_932; // -36 dBFS
const TRAILING_RELATIVE_POWER_RATIO: f64 = 0.001; // -30 dB
const TRAILING_RELATIVE_AMPLITUDE_RATIO: f32 = 0.031_622_775; // -30 dB
const RECOVERED_DECODE_DURATION_TOLERANCE: Duration = Duration::from_millis(5);

#[derive(Clone, Default)]
pub struct DecoderSharedState {
    pub flush_req: Arc<AtomicBool>,
    pub flush_ack: Arc<AtomicBool>,
    pub is_eof: Arc<AtomicBool>,
    pub natural_eof: Arc<AtomicBool>,
    pub decoded_samples_at_eof: Arc<AtomicU64>,
    pub trailing_silence_samples: Arc<AtomicU64>,
    pub is_shutdown: Arc<AtomicBool>,
    pub info: AudioInfo,
    pub quality: AudioQuality,
}

pub enum DecoderCommand {
    Seek(Duration),
}

pub struct AudioSource<C> {
    consumer: C,
    unparker: Unparker,
    shared_state: DecoderSharedState,

    watermark: usize,
    ready_watermark: usize,

    samples_counter: Arc<AtomicU64>,
}

#[derive(Clone)]
pub(crate) struct TailTransitionProbe {
    flush_req: Arc<AtomicBool>,
    natural_eof: Arc<AtomicBool>,
    decoded_samples_at_eof: Arc<AtomicU64>,
    trailing_silence_samples: Arc<AtomicU64>,
    samples_counter: Arc<AtomicU64>,
}

impl<C> AudioSource<C> {
    pub fn audio_info(&self) -> AudioInfo {
        self.shared_state.info.clone()
    }

    pub fn audio_quality(&self) -> AudioQuality {
        self.shared_state.quality.clone()
    }

    pub(crate) fn tail_transition_probe(&self) -> TailTransitionProbe {
        TailTransitionProbe {
            flush_req: Arc::clone(&self.shared_state.flush_req),
            natural_eof: Arc::clone(&self.shared_state.natural_eof),
            decoded_samples_at_eof: Arc::clone(&self.shared_state.decoded_samples_at_eof),
            trailing_silence_samples: Arc::clone(&self.shared_state.trailing_silence_samples),
            samples_counter: Arc::clone(&self.samples_counter),
        }
    }
}

impl<C: Consumer<Item = f32>> AudioSource<C> {
    pub fn is_ready(&self) -> bool {
        let buffered_samples = self.consumer.occupied_len();
        buffered_samples >= self.ready_watermark
            || (buffered_samples > 0 && self.shared_state.is_eof.load(Ordering::Acquire))
    }
}

impl TailTransitionProbe {
    pub(crate) fn is_flushing(&self) -> bool {
        self.flush_req.load(Ordering::Acquire)
    }

    pub(crate) fn is_in_trimmable_tail(&self, preserved_samples: usize) -> bool {
        if self.is_flushing() || !self.natural_eof.load(Ordering::Acquire) {
            return false;
        }

        let decoded_samples = self.decoded_samples_at_eof.load(Ordering::Relaxed);
        let trailing_samples = self.trailing_silence_samples.load(Ordering::Relaxed);
        let Some(transition_sample) =
            tail_transition_sample(decoded_samples, trailing_samples, preserved_samples as u64)
        else {
            return false;
        };
        self.samples_counter.load(Ordering::Relaxed) >= transition_sample
    }
}

impl<C: Consumer<Item = f32>> Iterator for AudioSource<C> {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        if self.shared_state.flush_req.load(Ordering::Acquire) {
            self.consumer.clear();
            self.shared_state.flush_ack.store(true, Ordering::Release);
            self.unparker.unpark();
            return Some(0.0);
        }

        if let Some(sample) = self.consumer.try_pop() {
            self.samples_counter.fetch_add(1, Ordering::Relaxed);
            if self.consumer.occupied_len() < self.watermark
                && !self.shared_state.is_eof.load(Ordering::Acquire)
            {
                self.unparker.unpark();
            }
            Some(sample)
        } else {
            if self.shared_state.is_eof.load(Ordering::Acquire) {
                None
            } else {
                self.unparker.unpark();
                Some(0.0)
            }
        }
    }
}

impl<C> Drop for AudioSource<C> {
    fn drop(&mut self) {
        self.shared_state.is_shutdown.store(true, Ordering::Release);
        self.unparker.unpark();
    }
}

pub struct SpawnedDecoder {
    pub source: AudioSource<HeapCons<f32>>,
    pub fft_consumer: HeapCons<f32>,
    pub handle: FFmpegDecoder,
    pub samples_counter: Arc<AtomicU64>,
}

#[derive(Clone)]
pub struct FFmpegDecoder {
    cmd_tx: Sender<DecoderCommand>,
    unparker: Unparker,
    flush_req: Arc<AtomicBool>,
    natural_eof: Arc<AtomicBool>,
}

fn wait_for_flush_ack(shared_state: &DecoderSharedState, parker: &Parker) -> bool {
    loop {
        if shared_state.is_shutdown.load(Ordering::Acquire) {
            return false;
        }
        if shared_state.flush_ack.load(Ordering::Acquire) {
            return true;
        }
        parker.park();
    }
}

fn samples_for_duration(sample_rate: u32, channels: u16, duration_ms: u32) -> usize {
    let channels = usize::from(channels).max(1);
    ((sample_rate as usize).saturating_mul(duration_ms as usize) / 1_000).saturating_mul(channels)
}

fn tail_transition_sample(
    decoded_samples: u64,
    trailing_samples: u64,
    preserved_samples: u64,
) -> Option<u64> {
    if trailing_samples <= preserved_samples || trailing_samples > decoded_samples {
        return None;
    }

    Some(decoded_samples - trailing_samples + preserved_samples)
}

fn recovered_decode_covers_declared_duration(
    first_frame_start: Option<Duration>,
    last_frame_end: Option<Duration>,
    decoded_source_samples: u64,
    source_sample_rate: u32,
    declared_duration: Option<Duration>,
) -> bool {
    let (Some(first_frame_start), Some(last_frame_end), Some(declared_duration)) =
        (first_frame_start, last_frame_end, declared_duration)
    else {
        return false;
    };
    if source_sample_rate == 0 || first_frame_start > declared_duration {
        return false;
    }

    let covered_duration = declared_duration.saturating_sub(first_frame_start);
    let expected_samples = samples_for_timeline_duration(covered_duration, source_sample_rate);
    let tolerance_samples =
        samples_for_timeline_duration(RECOVERED_DECODE_DURATION_TOLERANCE, source_sample_rate);
    let sample_coverage_is_complete =
        decoded_source_samples.abs_diff(expected_samples) <= tolerance_samples;

    last_frame_end.saturating_add(RECOVERED_DECODE_DURATION_TOLERANCE) >= declared_duration
        && sample_coverage_is_complete
}

fn samples_for_timeline_duration(duration: Duration, sample_rate: u32) -> u64 {
    let whole_seconds = duration.as_secs().saturating_mul(u64::from(sample_rate));
    let fractional_samples = (u64::from(duration.subsec_nanos())
        .saturating_mul(u64::from(sample_rate))
        .saturating_add(500_000_000))
        / 1_000_000_000;
    whole_seconds.saturating_add(fractional_samples)
}

fn audio_buffer_layout(target_sample_rate: u32, target_channels: u16) -> (usize, usize, usize) {
    let channels = usize::from(target_channels).max(1);
    let aligned_limit = (MAX_AUDIO_BUFFER_SAMPLES / channels).max(1) * channels;
    let desired_capacity = samples_for_duration(
        target_sample_rate,
        target_channels,
        AUDIO_BUFFER_DURATION_MS,
    );
    let capacity = desired_capacity.max(channels).min(aligned_limit);
    let ready_watermark = samples_for_duration(
        target_sample_rate,
        target_channels,
        GAPLESS_PREBUFFER_DURATION_MS,
    )
    .max(channels)
    .min(capacity);
    let refill_watermark = capacity
        .saturating_mul(AUDIO_BUFFER_REFILL_NUMERATOR)
        .saturating_div(AUDIO_BUFFER_REFILL_DENOMINATOR)
        .saturating_div(channels)
        .max(1)
        .saturating_mul(channels)
        .min(capacity);
    (capacity, ready_watermark, refill_watermark)
}

fn fft_buffer_capacity_for_audio(audio_buffer_capacity: usize, target_channels: u16) -> usize {
    audio_buffer_capacity / usize::from(target_channels).max(1)
}

struct TrailingSilenceTracker {
    channels: u64,
    window_samples: u64,
    minimum_trailing_samples: u64,
    decoded_samples: u64,
    last_audible_sample_end: u64,
    window_sample_count: u64,
    window_sum_squares: f64,
    window_peak: f32,
    window_has_non_finite: bool,
    maximum_window_mean_square: f64,
    maximum_peak: f32,
    saw_audible_window: bool,
}

impl TrailingSilenceTracker {
    fn new(channels: u16, sample_rate: u32) -> Self {
        let channels_u64 = u64::from(channels).max(1);
        Self {
            channels: channels_u64,
            window_samples: samples_for_duration(sample_rate, channels, TRAILING_ENERGY_WINDOW_MS)
                .max(channels_u64 as usize) as u64,
            minimum_trailing_samples: samples_for_duration(
                sample_rate,
                channels,
                MINIMUM_TRAILING_LOW_ENERGY_MS,
            )
            .max(channels_u64 as usize) as u64,
            decoded_samples: 0,
            last_audible_sample_end: 0,
            window_sample_count: 0,
            window_sum_squares: 0.0,
            window_peak: 0.0,
            window_has_non_finite: false,
            maximum_window_mean_square: 0.0,
            maximum_peak: 0.0,
            saw_audible_window: false,
        }
    }

    fn observe(&mut self, samples: &[f32]) {
        for sample in samples {
            if sample.is_finite() {
                let magnitude = sample.abs();
                self.window_peak = self.window_peak.max(magnitude);
                self.window_sum_squares += f64::from(*sample) * f64::from(*sample);
            } else {
                // 与旧实现保持保守语义：异常样本不能帮助提前裁掉结尾。
                self.window_has_non_finite = true;
            }

            self.window_sample_count = self.window_sample_count.saturating_add(1);
            self.decoded_samples = self.decoded_samples.saturating_add(1);
            if self.window_sample_count == self.window_samples {
                self.finish_complete_window();
            }
        }
    }

    fn trailing_silence_samples(&self) -> u64 {
        let partial_window_is_audible = self.window_sample_count > 0
            && self.window_is_audible(
                self.window_sum_squares / self.window_sample_count as f64,
                self.window_peak,
                self.window_has_non_finite,
            );
        if partial_window_is_audible || !self.saw_audible_window {
            0
        } else {
            let trailing_samples = self
                .decoded_samples
                .saturating_sub(self.last_audible_sample_end)
                .saturating_div(self.channels)
                .saturating_mul(self.channels);
            if trailing_samples < self.minimum_trailing_samples {
                0
            } else {
                trailing_samples
            }
        }
    }

    fn finish_complete_window(&mut self) {
        let mean_square = self.window_sum_squares / self.window_samples as f64;
        if self.window_is_audible(mean_square, self.window_peak, self.window_has_non_finite) {
            self.last_audible_sample_end = self.decoded_samples;
            self.saw_audible_window = true;
        }
        self.maximum_window_mean_square = self.maximum_window_mean_square.max(mean_square);
        self.maximum_peak = self.maximum_peak.max(self.window_peak);
        self.window_sample_count = 0;
        self.window_sum_squares = 0.0;
        self.window_peak = 0.0;
        self.window_has_non_finite = false;
    }

    fn window_is_audible(&self, mean_square: f64, peak: f32, has_non_finite: bool) -> bool {
        if has_non_finite {
            return true;
        }

        let maximum_mean_square = self.maximum_window_mean_square.max(mean_square);
        let maximum_peak = self.maximum_peak.max(peak);
        let rms_power_threshold =
            TRAILING_RMS_POWER_THRESHOLD.min(maximum_mean_square * TRAILING_RELATIVE_POWER_RATIO);
        let peak_threshold =
            TRAILING_PEAK_THRESHOLD.min(maximum_peak * TRAILING_RELATIVE_AMPLITUDE_RATIO);
        mean_square > rms_power_threshold || peak > peak_threshold
    }

    #[cfg(test)]
    fn reset(&mut self) {
        self.reset_position();
        self.maximum_window_mean_square = 0.0;
        self.maximum_peak = 0.0;
        self.saw_audible_window = false;
    }

    fn reset_position(&mut self) {
        self.decoded_samples = 0;
        self.last_audible_sample_end = 0;
        self.window_sample_count = 0;
        self.window_sum_squares = 0.0;
        self.window_peak = 0.0;
        self.window_has_non_finite = false;
    }
}

impl FFmpegDecoder {
    pub fn seek(&self, target: Duration) -> anyhow::Result<()> {
        // 先让音频回调进入排空态并失效旧的自然结束信息，避免跳转命令尚未被
        // 解码线程处理时将旧位置的尾部误认为已经结束或仍可切换。
        self.flush_req.store(true, Ordering::Release);
        self.natural_eof.store(false, Ordering::Release);
        if let Err(error) = self.cmd_tx.send(DecoderCommand::Seek(target)) {
            self.flush_req.store(false, Ordering::Release);
            return Err(error.into());
        }
        self.unparker.unpark();
        Ok(())
    }

    pub fn spawn<T: CustomMediaSource>(
        source: T,
        target_channels: u16,
        target_sample_rate: u32,
    ) -> anyhow::Result<SpawnedDecoder> {
        let mut reader = AudioReader::new(source)?;

        let src_info = reader.source_info();
        let declared_duration = reader.duration();
        let source_sample_rate = u32::try_from(src_info.sample_rate).unwrap_or(0);

        let info = build_audio_info(&reader);
        let quality = AudioQuality::from_source_info(src_info);

        let audio_options = ResampleOptions::new()
            .sample_rate(target_sample_rate.cast_signed())
            .channels(target_channels.cast_signed().into())
            .format::<f32>();

        let fft_options = ResampleOptions::new()
            .sample_rate(target_sample_rate.cast_signed())
            .channels(1)
            .format::<f32>();

        let mut audio_resampler = reader.build_resampler(audio_options)?;
        let mut fft_resampler = reader.build_resampler(fft_options)?;

        let (buffer_capacity, ready_watermark, refill_watermark) =
            audio_buffer_layout(target_sample_rate, target_channels);
        let audio_rb = HeapRb::<f32>::new(buffer_capacity);
        let (mut audio_producer, audio_consumer) = audio_rb.split();

        // FFT 消费速度跟随实际播放帧；它必须与音频环形缓冲覆盖相同的时长，
        // 否则扩大音频预读后会丢掉尚未播放区间的频谱采样。
        let fft_buffer_capacity = fft_buffer_capacity_for_audio(buffer_capacity, target_channels);
        let fft_rb = HeapRb::<f32>::new(fft_buffer_capacity);
        let (mut fft_producer, fft_consumer) = fft_rb.split();

        let (cmd_tx, cmd_rx) = unbounded::<DecoderCommand>();
        let parker = Parker::new();
        let unparker = parker.unparker().clone();

        let shared_state = DecoderSharedState {
            info,
            quality,
            ..Default::default()
        };

        let samples_counter = Arc::new(AtomicU64::new(0));

        let source = AudioSource {
            consumer: audio_consumer,
            unparker: unparker.clone(),
            shared_state: shared_state.clone(),
            watermark: refill_watermark,
            ready_watermark,
            samples_counter: samples_counter.clone(),
        };

        let handle = FFmpegDecoder {
            cmd_tx,
            unparker: unparker.clone(),
            flush_req: Arc::clone(&shared_state.flush_req),
            natural_eof: Arc::clone(&shared_state.natural_eof),
        };

        let mut trailing_silence_tracker =
            TrailingSilenceTracker::new(target_channels, target_sample_rate);
        let mut tail_tracking_reliable = true;
        let mut recoverable_decode_errors = 0;
        let mut first_decoded_frame_start = None;
        let mut last_decoded_frame_end = None;
        let mut decoded_source_samples = 0_u64;
        thread::spawn(move || loop {
            if shared_state.is_shutdown.load(Ordering::Acquire) {
                break;
            }

            while let Ok(cmd) = cmd_rx.try_recv() {
                match cmd {
                    DecoderCommand::Seek(target) => {
                        shared_state.flush_req.store(true, Ordering::Release);
                        if !wait_for_flush_ack(&shared_state, &parker) {
                            return;
                        }

                        let seek_succeeded = match reader
                            .seek(target, ffmpeg_audio::SeekMode::Accurate)
                        {
                            Ok(()) => true,
                            Err(error) => {
                                warn!("跳转音频解码位置失败，禁用当前歌曲的尾部近静音跳过: {error:?}");
                                false
                            }
                        };
                        let audio_flush_succeeded = match audio_resampler.flush() {
                            Ok(()) => true,
                            Err(error) => {
                                warn!("跳转时重置音频重采样器失败，禁用当前歌曲的尾部近静音跳过: {error:?}");
                                false
                            }
                        };
                        if let Err(error) = fft_resampler.flush() {
                            warn!("跳转时重置 FFT 重采样器失败: {error:?}");
                        }

                        // seek 仍在同一首歌内，清空位置相关状态，但保留已经观察到的
                        // 歌曲动态参考；否则直接拖到低能量结尾会把尾音误当作安静母带。
                        trailing_silence_tracker.reset_position();
                        tail_tracking_reliable = seek_succeeded && audio_flush_succeeded;
                        recoverable_decode_errors = 0;
                        first_decoded_frame_start = None;
                        last_decoded_frame_end = None;
                        decoded_source_samples = 0;
                        shared_state
                            .decoded_samples_at_eof
                            .store(0, Ordering::Relaxed);
                        shared_state
                            .trailing_silence_samples
                            .store(0, Ordering::Relaxed);
                        shared_state.natural_eof.store(false, Ordering::Release);
                        shared_state.is_eof.store(false, Ordering::Release);
                        shared_state.flush_req.store(false, Ordering::Release);
                        shared_state.flush_ack.store(false, Ordering::Release);
                    }
                }
            }

            if shared_state.is_eof.load(Ordering::Acquire) {
                parker.park();
                continue;
            }

            match reader.receive_frame() {
                Ok(Some(frame)) => {
                    let frame_start = frame.pts();
                    if first_decoded_frame_start.is_none() {
                        first_decoded_frame_start = frame_start;
                    }
                    decoded_source_samples = decoded_source_samples
                        .saturating_add(u64::try_from(frame.samples()).unwrap_or(u64::MAX));
                    if let Some(frame_end) =
                        frame_start.and_then(|start| start.checked_add(frame.duration()))
                    {
                        last_decoded_frame_end = Some(
                            last_decoded_frame_end.map_or(frame_end, |previous: Duration| {
                                previous.max(frame_end)
                            }),
                        );
                    }

                    if let Ok(true) = fft_resampler.process::<f32>(Some(&frame)) {
                        let fft_data = fft_resampler.output_as::<f32>();
                        let _ = fft_producer.push_slice(fft_data);
                    }

                    match audio_resampler.process::<f32>(Some(&frame)) {
                        Ok(true) => {
                            let audio_data = audio_resampler.output_as::<f32>();
                            let mut written = 0;
                            while written < audio_data.len() {
                                if shared_state.is_shutdown.load(Ordering::Acquire) {
                                    return;
                                }
                                if !cmd_rx.is_empty() {
                                    break;
                                }

                                let pushed = audio_producer.push_slice(&audio_data[written..]);
                                trailing_silence_tracker
                                    .observe(&audio_data[written..written + pushed]);
                                written += pushed;

                                if pushed == 0 {
                                    parker.park();
                                }
                            }
                        }
                        Ok(false) => {}
                        Err(error) => {
                            tail_tracking_reliable = false;
                            warn!("重采样音频帧失败，禁用当前歌曲的尾部近静音跳过: {error:?}");
                        }
                    }
                }
                Ok(None) => {
                    let mut interrupted_for_command = false;
                    loop {
                        match audio_resampler.process::<f32>(None) {
                            Ok(true) => {
                                let audio_data = audio_resampler.output_as::<f32>();
                                let mut written = 0;
                                while written < audio_data.len() {
                                    if shared_state.is_shutdown.load(Ordering::Acquire) {
                                        return;
                                    }
                                    if !cmd_rx.is_empty() {
                                        interrupted_for_command = true;
                                        break;
                                    }

                                    let pushed =
                                        audio_producer.push_slice(&audio_data[written..]);
                                    trailing_silence_tracker
                                        .observe(&audio_data[written..written + pushed]);
                                    written += pushed;

                                    if pushed == 0 {
                                        parker.park();
                                    }
                                }

                                if interrupted_for_command {
                                    break;
                                }
                            }
                            Ok(false) => break,
                            Err(error) => {
                                tail_tracking_reliable = false;
                                warn!("排空音频重采样器失败: {error:?}");
                                break;
                            }
                        }
                    }

                    if interrupted_for_command {
                        continue;
                    }

                    loop {
                        match fft_resampler.process::<f32>(None) {
                            Ok(true) => {
                                let fft_data = fft_resampler.output_as::<f32>();
                                let _ = fft_producer.push_slice(fft_data);
                            }
                            Ok(false) => break,
                            Err(error) => {
                                warn!("排空 FFT 重采样器失败: {error:?}");
                                break;
                            }
                        }
                    }

                    let trailing_silence_samples = if tail_tracking_reliable {
                        trailing_silence_tracker.trailing_silence_samples()
                    } else {
                        0
                    };
                    shared_state
                        .decoded_samples_at_eof
                        .store(trailing_silence_tracker.decoded_samples, Ordering::Relaxed);
                    shared_state
                        .trailing_silence_samples
                        .store(trailing_silence_samples, Ordering::Relaxed);
                    shared_state
                        .natural_eof
                        .store(tail_tracking_reliable, Ordering::Release);
                    shared_state.is_eof.store(true, Ordering::Release);
                }
                Err(error)
                    if can_skip_decode_error(&error, recoverable_decode_errors)
                        && recovered_decode_covers_declared_duration(
                            first_decoded_frame_start,
                            last_decoded_frame_end,
                            decoded_source_samples,
                            source_sample_rate,
                            declared_duration,
                        ) =>
                {
                    recoverable_decode_errors += 1;
                    warn!(
                        error = %error,
                        skipped_errors = recoverable_decode_errors,
                        "歌曲时间线已完整，跳过末尾可恢复的损坏音频数据并继续排空解码器"
                    );
                }
                Err(e) => {
                    warn!("解码线程发生错误: {e:?}");
                    shared_state
                        .decoded_samples_at_eof
                        .store(0, Ordering::Relaxed);
                    shared_state
                        .trailing_silence_samples
                        .store(0, Ordering::Relaxed);
                    shared_state.natural_eof.store(false, Ordering::Release);
                    shared_state.is_eof.store(true, Ordering::Release);
                }
            }
        });

        Ok(SpawnedDecoder {
            source,
            fft_consumer,
            handle,
            samples_counter,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source_with_buffered_samples(
        buffered_samples: usize,
        ready_watermark: usize,
        eof: bool,
    ) -> AudioSource<HeapCons<f32>> {
        let ring = HeapRb::<f32>::new(32);
        let (mut producer, consumer) = ring.split();
        let _ = producer.push_slice(&vec![0.25; buffered_samples]);
        let parker = Parker::new();
        let shared_state = DecoderSharedState::default();
        shared_state.is_eof.store(eof, Ordering::Release);
        AudioSource {
            consumer,
            unparker: parker.unparker().clone(),
            shared_state,
            watermark: 16,
            ready_watermark,
            samples_counter: Arc::new(AtomicU64::new(0)),
        }
    }

    fn source_with_trailing_silence(
        buffered_samples: usize,
        decoded_samples: u64,
        trailing_silence_samples: u64,
        consumed_samples: u64,
        natural_eof: bool,
    ) -> AudioSource<HeapCons<f32>> {
        let source = source_with_buffered_samples(buffered_samples, 5, true);
        source
            .shared_state
            .decoded_samples_at_eof
            .store(decoded_samples, Ordering::Relaxed);
        source
            .shared_state
            .trailing_silence_samples
            .store(trailing_silence_samples, Ordering::Relaxed);
        source
            .shared_state
            .natural_eof
            .store(natural_eof, Ordering::Release);
        source
            .samples_counter
            .store(consumed_samples, Ordering::Relaxed);
        source
    }

    #[test]
    fn audio_buffer_keeps_eight_seconds_and_refills_with_six_seconds_remaining() {
        assert_eq!(audio_buffer_layout(48_000, 2), (768_000, 96_000, 576_000));
        assert_eq!(fft_buffer_capacity_for_audio(768_000, 2), 384_000);
        assert_eq!(samples_for_duration(44_101, 3, 1_500), 198_453);

        let (capacity, ready_watermark, refill_watermark) = audio_buffer_layout(192_000, 8);
        assert_eq!(capacity, MAX_AUDIO_BUFFER_SAMPLES);
        assert_eq!(ready_watermark, 1_536_000);
        assert_eq!(refill_watermark, 3_000_000);
        assert_eq!(capacity % 8, 0);
        assert_eq!(refill_watermark % 8, 0);

        let (extreme_capacity, extreme_ready, extreme_refill) =
            audio_buffer_layout(u32::MAX, u16::MAX);
        assert!((1..=MAX_AUDIO_BUFFER_SAMPLES).contains(&extreme_capacity));
        assert!(extreme_ready <= extreme_capacity);
        assert!(extreme_refill <= extreme_capacity);
        assert_eq!(extreme_capacity % u16::MAX as usize, 0);
        assert_eq!(extreme_refill % u16::MAX as usize, 0);
        assert_eq!(
            fft_buffer_capacity_for_audio(extreme_capacity, u16::MAX),
            extreme_capacity / u16::MAX as usize
        );
    }

    #[test]
    fn damaged_tail_is_recoverable_only_after_the_declared_timeline_is_complete() {
        let declared_duration = Duration::from_secs(222);
        let sample_rate = 48_000;
        let expected_samples = 222 * u64::from(sample_rate);

        assert!(recovered_decode_covers_declared_duration(
            Some(Duration::ZERO),
            Some(declared_duration),
            expected_samples,
            sample_rate,
            Some(declared_duration)
        ));
        assert!(recovered_decode_covers_declared_duration(
            Some(Duration::ZERO),
            Some(declared_duration - Duration::from_millis(4)),
            expected_samples,
            sample_rate,
            Some(declared_duration)
        ));
        assert!(!recovered_decode_covers_declared_duration(
            Some(Duration::ZERO),
            Some(declared_duration - Duration::from_millis(6)),
            expected_samples,
            sample_rate,
            Some(declared_duration)
        ));
        assert!(!recovered_decode_covers_declared_duration(
            Some(Duration::ZERO),
            Some(declared_duration),
            expected_samples - 4_096,
            sample_rate,
            Some(declared_duration)
        ));
        assert!(recovered_decode_covers_declared_duration(
            Some(Duration::from_secs(200)),
            Some(declared_duration),
            22 * u64::from(sample_rate),
            sample_rate,
            Some(declared_duration)
        ));
        assert!(!recovered_decode_covers_declared_duration(
            Some(Duration::ZERO),
            Some(declared_duration),
            expected_samples,
            sample_rate,
            None
        ));
        assert!(!recovered_decode_covers_declared_duration(
            None,
            None,
            0,
            sample_rate,
            Some(declared_duration)
        ));
    }

    #[test]
    fn trailing_low_energy_tracker_uses_window_energy_and_protects_quiet_masters() {
        let mut tracker = TrailingSilenceTracker::new(2, 1_000);
        let window_samples = tracker.window_samples as usize;

        tracker.observe(&vec![0.2; window_samples]);
        tracker.observe(&vec![0.001; window_samples * 4]);
        assert_eq!(
            tracker.trailing_silence_samples(),
            (window_samples * 4) as u64
        );
        assert_eq!(tracker.trailing_silence_samples() % 2, 0);

        // 一个孤立尖峰至多保留它所在的分析窗，不能把后续低能量尾段全部否决。
        tracker.reset();
        tracker.observe(&vec![0.2; window_samples]);
        tracker.observe(&vec![0.0; window_samples]);
        let mut isolated_peak_window = vec![0.0; window_samples];
        isolated_peak_window[17] = 1.0;
        tracker.observe(&isolated_peak_window);
        tracker.observe(&vec![0.0; window_samples * 3]);
        assert_eq!(
            tracker.trailing_silence_samples(),
            (window_samples * 3) as u64
        );

        // 相对阈值让整轨本来就很安静的内容仍被视为有效声音。
        tracker.reset();
        tracker.observe(&vec![0.001; window_samples * 4]);
        tracker.observe(&vec![0.0; window_samples * 3]);
        assert_eq!(
            tracker.trailing_silence_samples(),
            (window_samples * 3) as u64
        );

        // seek 只重置时间位置，继续使用同一首歌已经建立的动态参考。
        tracker.reset();
        tracker.observe(&vec![0.2; window_samples]);
        tracker.reset_position();
        tracker.observe(&vec![0.001; window_samples * 3]);
        assert_eq!(
            tracker.trailing_silence_samples(),
            (window_samples * 3) as u64
        );

        tracker.reset();
        tracker.observe(&vec![0.0; window_samples * 8]);
        assert_eq!(tracker.trailing_silence_samples(), 0);
    }

    #[test]
    fn trailing_low_energy_tracker_requires_a_sustained_tail_and_keeps_non_finite_samples() {
        let mut tracker = TrailingSilenceTracker::new(2, 1_000);
        let window_samples = tracker.window_samples as usize;

        tracker.observe(&vec![0.2; window_samples]);
        tracker.observe(&vec![0.001; 1_198]);
        assert_eq!(tracker.trailing_silence_samples(), 0);
        tracker.observe(&[0.001, 0.001]);
        assert_eq!(tracker.trailing_silence_samples(), 1_200);

        tracker.observe(&vec![0.2; window_samples]);
        assert_eq!(tracker.trailing_silence_samples(), 0);

        tracker.reset();
        tracker.observe(&vec![f32::NAN; window_samples]);
        tracker.observe(&vec![0.0; window_samples * 3]);
        assert_eq!(
            tracker.trailing_silence_samples(),
            (window_samples * 3) as u64
        );
        tracker.observe(&vec![f32::INFINITY; window_samples]);
        assert_eq!(tracker.trailing_silence_samples(), 0);
    }

    #[test]
    fn trailing_low_energy_tracker_is_chunk_independent_and_frame_aligned() {
        for (channels, sample_rate) in [(1, 44_100), (2, 48_000), (6, 96_000)] {
            let mut whole = TrailingSilenceTracker::new(channels, sample_rate);
            let window_samples = whole.window_samples as usize;
            let mut input = vec![0.2; window_samples];
            input.extend(vec![0.001; window_samples * 3]);
            whole.observe(&input);

            let mut chunked = TrailingSilenceTracker::new(channels, sample_rate);
            let chunk_sizes = [1, usize::from(channels) + 1, window_samples - 3, 17];
            let mut offset = 0;
            let mut chunk_index = 0;
            while offset < input.len() {
                let chunk_end = offset
                    .saturating_add(chunk_sizes[chunk_index % chunk_sizes.len()])
                    .min(input.len());
                chunked.observe(&input[offset..chunk_end]);
                offset = chunk_end;
                chunk_index += 1;
            }

            assert_eq!(chunked.decoded_samples, whole.decoded_samples);
            assert_eq!(
                chunked.trailing_silence_samples(),
                whole.trailing_silence_samples()
            );
            assert_eq!(
                chunked.trailing_silence_samples() % u64::from(channels),
                0
            );
        }
    }

    #[test]
    fn trailing_silence_tracker_counts_only_each_committed_ring_segment() {
        let ring = HeapRb::<f32>::new(4);
        let (mut producer, mut consumer) = ring.split();
        let input = [0.01, 0.0, 0.0, 0.0, 0.0, 0.0];
        let mut tracker = TrailingSilenceTracker::new(2, 4);
        let mut written = 0;

        let pushed = producer.push_slice(&input[written..]);
        tracker.observe(&input[written..written + pushed]);
        written += pushed;
        assert_eq!(pushed, 4);

        assert_eq!(consumer.try_pop(), Some(0.01));
        assert_eq!(consumer.try_pop(), Some(0.0));

        let pushed = producer.push_slice(&input[written..]);
        tracker.observe(&input[written..written + pushed]);
        written += pushed;
        assert_eq!(pushed, 2);
        assert_eq!(written, input.len());
        assert_eq!(tracker.decoded_samples, input.len() as u64);
        assert_eq!(tracker.trailing_silence_samples(), 4);
    }

    #[test]
    fn source_trims_only_a_natural_buffered_tail_after_the_preserved_window() {
        assert!(
            source_with_trailing_silence(12, 100, 40, 70, true)
                .tail_transition_probe()
                .is_in_trimmable_tail(10)
        );
        assert!(
            !source_with_trailing_silence(12, 100, 40, 69, true)
                .tail_transition_probe()
                .is_in_trimmable_tail(10)
        );
        assert!(
            !source_with_trailing_silence(12, 100, 40, 70, false)
                .tail_transition_probe()
                .is_in_trimmable_tail(10)
        );
        assert!(
            !source_with_trailing_silence(12, 100, 10, 100, true)
                .tail_transition_probe()
                .is_in_trimmable_tail(10)
        );

        let source = source_with_trailing_silence(12, 100, 40, 70, true);
        source.shared_state.flush_req.store(true, Ordering::Release);
        assert!(!source.tail_transition_probe().is_in_trimmable_tail(4));
    }

    #[test]
    fn tail_transition_rejects_inconsistent_or_unpreservable_metadata() {
        assert_eq!(tail_transition_sample(100, 40, 10), Some(70));
        assert_eq!(tail_transition_sample(100, 10, 10), None);
        assert_eq!(tail_transition_sample(100, 101, 10), None);
    }

    #[test]
    fn seek_blocks_old_eof_and_tail_before_the_decoder_handles_the_command() {
        let (cmd_tx, cmd_rx) = unbounded();
        let parker = Parker::new();
        let flush_req = Arc::new(AtomicBool::new(false));
        let natural_eof = Arc::new(AtomicBool::new(true));
        let decoder = FFmpegDecoder {
            cmd_tx,
            unparker: parker.unparker().clone(),
            flush_req: Arc::clone(&flush_req),
            natural_eof: Arc::clone(&natural_eof),
        };

        decoder.seek(Duration::from_secs(12)).unwrap();

        assert!(flush_req.load(Ordering::Acquire));
        assert!(!natural_eof.load(Ordering::Acquire));
        assert!(matches!(
            cmd_rx.try_recv(),
            Ok(DecoderCommand::Seek(target)) if target == Duration::from_secs(12)
        ));
    }

    #[test]
    fn prepared_source_waits_for_the_prebuffer_watermark() {
        assert!(!source_with_buffered_samples(4, 5, false).is_ready());
        assert!(source_with_buffered_samples(5, 5, false).is_ready());
    }

    #[test]
    fn short_finished_source_is_ready_but_empty_source_is_not() {
        assert!(source_with_buffered_samples(2, 5, true).is_ready());
        assert!(!source_with_buffered_samples(0, 5, true).is_ready());
    }

    #[test]
    fn finished_source_does_not_wake_the_parked_decoder_while_draining() {
        let ring = HeapRb::<f32>::new(8);
        let (mut producer, consumer) = ring.split();
        assert_eq!(producer.push_slice(&[0.25, 0.5, 0.75, 1.0]), 4);

        let parker = Parker::new();
        let shared_state = DecoderSharedState::default();
        shared_state.is_eof.store(true, Ordering::Release);
        let mut source = AudioSource {
            consumer,
            unparker: parker.unparker().clone(),
            shared_state,
            watermark: 8,
            ready_watermark: 1,
            samples_counter: Arc::new(AtomicU64::new(0)),
        };

        assert_eq!(source.next(), Some(0.25));
        assert_eq!(source.next(), Some(0.5));
        assert_eq!(source.next(), Some(0.75));
        assert_eq!(source.next(), Some(1.0));

        // 若 drain 期间产生过 unpark token，这里会立即返回；没有 token 时应等到超时。
        let started_at = std::time::Instant::now();
        parker.park_timeout(Duration::from_millis(50));
        assert!(started_at.elapsed() >= Duration::from_millis(25));
    }

    #[test]
    fn flush_clears_old_samples_and_wakes_the_waiting_decoder() {
        let ring = HeapRb::<f32>::new(8);
        let (mut producer, consumer) = ring.split();
        assert_eq!(producer.push_slice(&[0.25, 0.5]), 2);

        let parker = Parker::new();
        let shared_state = DecoderSharedState::default();
        shared_state.flush_req.store(true, Ordering::Release);
        let samples_counter = Arc::new(AtomicU64::new(0));
        let mut source = AudioSource {
            consumer,
            unparker: parker.unparker().clone(),
            shared_state: shared_state.clone(),
            watermark: 4,
            ready_watermark: 4,
            samples_counter: samples_counter.clone(),
        };

        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let waiter_state = shared_state.clone();
        let waiter = thread::spawn(move || {
            let _ = done_tx.send(wait_for_flush_ack(&waiter_state, &parker));
        });

        assert_eq!(source.next(), Some(0.0));
        assert!(done_rx.recv_timeout(Duration::from_secs(1)).unwrap());
        waiter.join().unwrap();
        assert_eq!(samples_counter.load(Ordering::Acquire), 0);

        shared_state.flush_req.store(false, Ordering::Release);
        shared_state.flush_ack.store(false, Ordering::Release);
        assert_eq!(producer.push_slice(&[0.75]), 1);
        assert_eq!(source.next(), Some(0.75));
    }

    #[test]
    fn dropping_source_wakes_a_parked_flush_waiter() {
        let ring = HeapRb::<f32>::new(4);
        let (_, consumer) = ring.split();
        let parker = Parker::new();
        let shared_state = DecoderSharedState::default();
        shared_state.flush_req.store(true, Ordering::Release);
        let source = AudioSource {
            consumer,
            unparker: parker.unparker().clone(),
            shared_state: shared_state.clone(),
            watermark: 2,
            ready_watermark: 2,
            samples_counter: Arc::new(AtomicU64::new(0)),
        };

        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let waiter_state = shared_state.clone();
        let waiter = thread::spawn(move || {
            let _ = done_tx.send(wait_for_flush_ack(&waiter_state, &parker));
        });

        drop(source);
        assert!(!done_rx.recv_timeout(Duration::from_secs(1)).unwrap());
        waiter.join().unwrap();
    }
}
