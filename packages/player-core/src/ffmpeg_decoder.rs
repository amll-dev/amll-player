use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::Duration,
};

use crossbeam_channel::{Sender, unbounded};
use crossbeam_utils::sync::{Parker, Unparker};
use ffmpeg_audio::{AudioReader, ResampleOptions};
use ringbuf::{
    HeapRb,
    traits::{Consumer, Producer, Split},
};
use tracing::warn;

use crate::{
    audio_quality::AudioQuality,
    player::{AudioInfo, CustomMediaSource},
    utils::build_audio_info,
};

#[derive(Clone, Default)]
pub struct DecoderSharedState {
    pub flush_req: Arc<AtomicBool>,
    pub flush_ack: Arc<AtomicBool>,
    pub is_eof: Arc<AtomicBool>,
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

    samples_counter: Arc<AtomicU64>,
}

impl<C> AudioSource<C> {
    pub fn audio_info(&self) -> AudioInfo {
        self.shared_state.info.clone()
    }

    pub fn audio_quality(&self) -> AudioQuality {
        self.shared_state.quality.clone()
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
            if self.consumer.occupied_len() < self.watermark {
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

pub struct SpawnedDecoder<C, FC> {
    pub source: AudioSource<C>,
    pub fft_consumer: FC,
    pub handle: FFmpegDecoder,
    pub samples_counter: Arc<AtomicU64>,
}

#[derive(Clone)]
pub struct FFmpegDecoder {
    cmd_tx: Sender<DecoderCommand>,
    unparker: Unparker,
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

impl FFmpegDecoder {
    pub fn seek(&self, target: Duration) -> anyhow::Result<()> {
        self.cmd_tx.send(DecoderCommand::Seek(target))?;
        self.unparker.unpark();
        Ok(())
    }

    pub fn spawn<T: CustomMediaSource>(
        source: T,
        target_channels: u16,
        target_sample_rate: u32,
    ) -> anyhow::Result<
        SpawnedDecoder<
            impl Consumer<Item = f32> + Send + 'static,
            impl Consumer<Item = f32> + Send + 'static,
        >,
    > {
        let mut reader = AudioReader::new(source)?;

        let src_info = reader.source_info();

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

        let buffer_capacity = (target_sample_rate * target_channels as u32 * 3 / 2) as usize;
        let audio_rb = HeapRb::<f32>::new(buffer_capacity);
        let (mut audio_producer, audio_consumer) = audio_rb.split();

        let fft_buffer_capacity = (target_sample_rate * 3 / 2) as usize;
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
            watermark: buffer_capacity / 2,
            samples_counter: samples_counter.clone(),
        };

        let handle = FFmpegDecoder {
            cmd_tx,
            unparker: unparker.clone(),
        };

        thread::spawn(move || {
            loop {
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

                            let _ = reader.seek(target, ffmpeg_audio::SeekMode::Accurate);
                            let _ = audio_resampler.flush();
                            let _ = fft_resampler.flush();

                            shared_state.flush_req.store(false, Ordering::Release);
                            shared_state.flush_ack.store(false, Ordering::Release);
                            shared_state.is_eof.store(false, Ordering::Release);
                        }
                    }
                }

                if shared_state.is_eof.load(Ordering::Acquire) {
                    parker.park();
                    continue;
                }

                match reader.receive_frame() {
                    Ok(Some(frame)) => {
                        if let Ok(true) = fft_resampler.process::<f32>(Some(&frame)) {
                            let fft_data = fft_resampler.output_as::<f32>();
                            let _ = fft_producer.push_slice(fft_data);
                        }

                        if let Ok(true) = audio_resampler.process::<f32>(Some(&frame)) {
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
                                written += pushed;

                                if pushed == 0 {
                                    parker.park();
                                }
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

                        shared_state.is_eof.store(true, Ordering::Release);
                    }
                    Err(e) => {
                        warn!("解码线程发生错误: {e:?}");
                        shared_state.is_eof.store(true, Ordering::Release);
                    }
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
    use std::{io::Cursor, time::Instant};

    fn sine_wav(sample_rate: u32) -> Vec<u8> {
        // A short PCM fixture fits in both rings before the consumer starts.
        let samples = sample_rate / 10;
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + samples * 2).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&(sample_rate * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(samples * 2).to_le_bytes());
        for index in 0..samples {
            let phase = index as f32 * 440.0 * std::f32::consts::TAU / sample_rate as f32;
            wav.extend_from_slice(&((phase.sin() * 16000.0) as i16).to_le_bytes());
        }
        wav
    }

    fn reference_samples(wav: &[u8], sample_rate: u32, channels: i32) -> Vec<f32> {
        let mut reader = AudioReader::new(Cursor::new(wav.to_vec()))
            .unwrap()
            .into_resampled(
                ResampleOptions::new()
                    .sample_rate(sample_rate as i32)
                    .channels(channels)
                    .format::<f32>(),
            )
            .unwrap();
        let mut samples = Vec::new();
        while let Some(frame) = reader.receive_frame_as::<f32>().unwrap() {
            samples.extend_from_slice(frame);
        }
        samples
    }

    #[test]
    fn eof_includes_audio_and_fft_resampler_tails() {
        for (input_rate, output_rate) in [(44100, 48000), (48000, 44100)] {
            let wav = sine_wav(input_rate);
            let expected_audio = reference_samples(&wav, output_rate, 2);
            let expected_fft = reference_samples(&wav, output_rate, 1);
            let mut decoder = FFmpegDecoder::spawn(Cursor::new(wav), 2, output_rate).unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while !decoder.source.shared_state.is_eof.load(Ordering::Acquire) {
                assert!(Instant::now() < deadline, "decoder did not reach EOF");
                thread::sleep(Duration::from_millis(1));
            }
            let actual_audio: Vec<_> = decoder.source.by_ref().collect();
            let actual_fft: Vec<_> = decoder.fft_consumer.pop_iter().collect();
            assert_eq!(actual_audio.len() % 2, 0);
            assert!(!actual_audio.is_empty());
            assert_eq!(actual_audio, expected_audio, "audio {input_rate} -> {output_rate}");
            assert_eq!(actual_fft, expected_fft, "FFT {input_rate} -> {output_rate}");
        }
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
