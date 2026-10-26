use super::*;
use crate::{
    ChannelAudioSourceConfig,
    output_pipeline::{AudioFrame, ChannelAudioSource},
};

pub struct SystemAudioSourceConfig {
    inner: ChannelAudioSourceConfig,
    capturer: Capturer,
    error_rx: broadcast::Receiver<arc::R<ns::Error>>,
    params: Arc<AudioCaptureParams>,
    health_rx: tokio::sync::mpsc::Receiver<output_pipeline::PipelineHealthEvent>,
}

struct AudioCaptureParams {
    audio_tx: mpsc::Sender<AudioFrame>,
    error_tx: broadcast::Sender<arc::R<ns::Error>>,
    health_tx: output_pipeline::HealthSender,
    frames: AtomicU64,
    drops: AtomicU64,
}

impl SystemAudioSourceConfig {
    pub(super) fn new(content: &sc::ShareableContent, info: AudioInfo) -> anyhow::Result<Self> {
        let (audio_tx, audio_rx) = mpsc::channel(128);
        let (error_tx, error_rx) = broadcast::channel(8);
        let (health_tx, health_rx) = tokio::sync::mpsc::channel(32);
        let params = Arc::new(AudioCaptureParams {
            audio_tx,
            error_tx,
            health_tx,
            frames: AtomicU64::new(0),
            drops: AtomicU64::new(0),
        });
        let capturer = build_audio_capturer(content, &params)
            .context("Could not prepare computer audio capture")?;
        Ok(Self {
            inner: ChannelAudioSourceConfig::new(info, audio_rx),
            capturer,
            error_rx,
            params,
            health_rx,
        })
    }
}

fn build_audio_capturer(
    content: &sc::ShareableContent,
    params: &Arc<AudioCaptureParams>,
) -> anyhow::Result<Capturer> {
    if !scap_screencapturekit::is_system_audio_supported() {
        return Err(anyhow!("Computer audio capture requires macOS 13 or later"));
    }
    let displays = content.displays();
    let display = displays
        .first()
        .ok_or_else(|| anyhow!("No display is available for computer audio capture"))?;
    // Audio from a window filter is limited to its owning app. This independent
    // stream follows v0's global audio fallback; its tiny screen frames are discarded.
    let filter = sc::ContentFilter::with_display_excluding_windows(display, &ns::Array::new());
    let mut settings = scap_screencapturekit::StreamCfgBuilder::default()
        .with_width(2)
        .with_height(2)
        .with_fps(1.0)
        .with_shows_cursor(false)
        .with_captures_audio(true)
        .build();
    unsafe {
        settings.set_sample_rate(48_000);
        settings.set_channel_count(2);
        settings.set_excludes_current_process_audio(true);
    }
    let mut audio_tx = params.audio_tx.clone();
    let output_params = params.clone();
    let error_tx = params.error_tx.clone();
    let native = scap_screencapturekit::Capturer::builder(filter, settings)
        .with_output_sample_buf_cb(move |frame| {
            let scap_screencapturekit::Frame::Audio(audio) = frame else {
                return;
            };
            cap_fail::fail_ret!("screen_capture audio frame skip");
            let sample = audio.sample_buf();
            let timestamp = Timestamp::MachAbsoluteTime(cap_timestamp::MachAbsoluteTimestamp::new(
                cm::Clock::convert_host_time_to_sys_units(sample.pts()),
            ));
            let Ok(buffers) = sample.audio_buf_list::<2>() else {
                warn!("Could not extract computer audio sample");
                return;
            };
            let Ok(bytes) = buffers.block().as_slice() else {
                return;
            };
            let mut frame = ffmpeg::frame::Audio::new(
                ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
                sample.num_samples() as usize,
                ffmpeg::ChannelLayout::STEREO,
            );
            frame.set_rate(48_000);
            let plane_bytes = buffers.list().buffers[0].data_bytes_size as usize;
            for plane in 0..frame.planes() {
                let Some(source) = bytes.get(plane * plane_bytes..(plane + 1) * plane_bytes) else {
                    return;
                };
                let Some(destination) = frame.data_mut(plane).get_mut(..source.len()) else {
                    return;
                };
                destination.copy_from_slice(source);
            }
            match output_pipeline::send_with_stall_budget_futures(
                &mut audio_tx,
                AudioFrame::new(frame, timestamp),
                "screen-system-audio",
                &output_params.health_tx,
            ) {
                output_pipeline::StallSendOutcome::Sent => {
                    output_params.frames.fetch_add(1, atomic::Ordering::Relaxed);
                }
                output_pipeline::StallSendOutcome::StalledAndDropped { .. }
                | output_pipeline::StallSendOutcome::Disconnected => {
                    output_params.drops.fetch_add(1, atomic::Ordering::Relaxed);
                }
            }
        })
        .with_stop_with_err_cb(move |_, error| {
            let _ = error_tx.send(error.retained());
        })
        .build()?;
    Ok(Capturer::new(Arc::new(native)))
}

pub struct SystemAudioSource {
    inner: ChannelAudioSource,
    capturer: Arc<tokio::sync::Mutex<Capturer>>,
    cancel_token: CancellationToken,
    _drop_guard: DropGuard,
}

impl output_pipeline::AudioSource for SystemAudioSource {
    type Config = SystemAudioSourceConfig;

    fn setup(
        config: Self::Config,
        tx: mpsc::Sender<AudioFrame>,
        ctx: &mut SetupCtx,
    ) -> impl Future<Output = anyhow::Result<Self>> + 'static {
        let SystemAudioSourceConfig {
            inner,
            capturer,
            mut error_rx,
            params,
            mut health_rx,
        } = config;
        let cancel_token = CancellationToken::new();
        let capturer = Arc::new(tokio::sync::Mutex::new(capturer));
        let pipeline_cancel = ctx.stop_token();
        let stop_signal = ctx.stop_signal();
        let health_tx = ctx.health_tx().clone();
        ctx.tasks().spawn("system-audio", {
            let cancel = cancel_token.clone();
            let capturer = capturer.clone();
            async move {
                let mut restarts = 0;
                let mut stats = tokio::time::interval(Duration::from_secs(5));
                loop {
                    select! {
                        biased;
                        _ = cancel.cancelled() => break,
                        Some(event) = health_rx.recv() => { output_pipeline::emit_health(&health_tx, event); }
                        _ = stats.tick() => {
                            debug!(captured = params.frames.load(atomic::Ordering::Relaxed),
                                dropped = params.drops.load(atomic::Ordering::Relaxed), "Independent computer audio stats");
                        }
                        result = error_rx.recv() => {
                            let error = match result {
                                Ok(error) => error,
                                Err(broadcast::error::RecvError::Closed) => break,
                                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            };
                            capturer.lock().await.mark_stopped();
                            if is_user_stop_error(error.as_ref()) {
                                stop_signal.mark_user_stopped();
                                pipeline_cancel.cancel();
                                return Err(anyhow!("Computer audio sharing was stopped from macOS sharing controls"));
                            }
                            if !is_system_stop_error(error.as_ref()) || restarts >= MAX_CAPTURE_RESTARTS {
                                return Err(anyhow!("Computer audio capture stopped: {error}"));
                            }
                            restarts += 1;
                            output_pipeline::emit_health(&health_tx, output_pipeline::PipelineHealthEvent::SourceRestarting);
                            select! {
                                _ = cancel.cancelled() => break,
                                _ = tokio::time::sleep(RESTART_DELAY) => {}
                            }
                            let content = sc::ShareableContent::current().await
                                .context("Could not refresh computer audio capture")?;
                            let replacement = build_audio_capturer(&content, &params)?;
                            let mut active = capturer.lock().await;
                            if cancel.is_cancelled() { break; }
                            *active = replacement;
                            active.start().await.context("Could not restart computer audio capture")?;
                            output_pipeline::emit_health(&health_tx, output_pipeline::PipelineHealthEvent::SourceRestarted);
                        }
                    }
                }
                Ok(())
            }
        });
        let drop_guard = cancel_token.clone().drop_guard();
        ChannelAudioSource::setup(inner, tx, ctx).map(move |result| {
            result.map(|inner| Self {
                inner,
                capturer,
                cancel_token,
                _drop_guard: drop_guard,
            })
        })
    }

    async fn start(&mut self) -> anyhow::Result<()> {
        self.capturer
            .lock()
            .await
            .start()
            .await
            .context("Could not start computer audio capture")
    }

    async fn stop(&mut self) -> anyhow::Result<()> {
        self.cancel_token.cancel();
        tokio::time::timeout(Duration::from_secs(5), async {
            self.capturer.lock().await.stop().await
        })
        .await
        .context("Computer audio capture did not stop within five seconds")?
    }

    fn audio_info(&self) -> AudioInfo {
        self.inner.audio_info()
    }
}
