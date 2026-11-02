use std::{path::Path, sync::Arc};

use anyhow::{Context as _, anyhow};
use cap_project::InstantRecordingMeta;
use cap_recording::{instant_recording, upload_resume::UploadLock};

use super::{StartConfig, persist_instant_meta, save_instant_metadata};

pub(super) fn reserve(
    project_dir: &Path,
    config: &StartConfig,
) -> anyhow::Result<Option<Arc<UploadLock>>> {
    if !cfg!(feature = "ux-walk") {
        return Ok(None);
    }
    std::fs::create_dir(project_dir).context("reserving local instant recording")?;
    std::fs::create_dir(project_dir.join("content")).context("creating instant content folder")?;
    if config.microphone.is_some() || config.system_audio {
        std::fs::create_dir(project_dir.join("content/audio"))
            .context("preserving required audio intent")?;
    }
    let ownership = Arc::new(
        UploadLock::acquire(project_dir)
            .map_err(|error| anyhow!("reserving instant recording: {error}"))?,
    );
    persist_local_instant_meta(
        project_dir,
        InstantRecordingMeta::InProgress { recording: true },
    )?;
    Ok(Some(ownership))
}

pub(super) fn build_failed(project_dir: &Path, error: &anyhow::Error) {
    if !cfg!(feature = "ux-walk") {
        return;
    }
    if let Err(metadata_error) = persist_local_instant_meta(
        project_dir,
        InstantRecordingMeta::Failed {
            error: error.to_string(),
        },
    ) {
        tracing::error!(%metadata_error, "Could not save the failed local recording status");
    }
}

pub(super) fn drain_segments(handle: &instant_recording::ActorHandle) {
    if let Some(events) = handle.take_segment_rx() {
        drop(tokio::task::spawn_blocking(move || {
            events.into_iter().for_each(drop)
        }));
    }
}

pub(super) fn persist(
    completed: &instant_recording::CompletedRecording,
    upload: Option<&crate::upload::InstantUpload>,
) -> anyhow::Result<()> {
    if let Some(upload) = upload {
        return persist_instant_meta(completed, upload.video(), upload.metadata_lock());
    }
    let meta = match &completed.meta {
        InstantRecordingMeta::InProgress { .. } => InstantRecordingMeta::Failed {
            error: "Recording stopped before finalization completed.".into(),
        },
        other => other.clone(),
    };
    persist_local_instant_meta(&completed.project_path, meta)
}

pub(super) fn persist_local_instant_meta(
    project_path: &std::path::Path,
    inner: cap_project::InstantRecordingMeta,
) -> anyhow::Result<()> {
    let pretty_name = project_path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or(fork_brand::text_static("Cap recording"))
        .to_string();
    let meta = cap_project::RecordingMeta {
        platform: Some(cap_project::Platform::default()),
        project_path: project_path.to_path_buf(),
        pretty_name,
        sharing: None,
        inner: cap_project::RecordingMetaInner::Instant(inner),
        upload: None,
    };
    save_instant_metadata(&meta)?;
    cap_project::ProjectConfiguration::default()
        .write(project_path)
        .map_err(|error| anyhow!("saving instant project config: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod owned_sharing_tests {
    use super::*;

    #[test]
    fn local_instant_metadata_needs_no_remote_identity_or_upload() {
        let directory = tempfile::tempdir().unwrap();
        persist_local_instant_meta(
            directory.path(),
            cap_project::InstantRecordingMeta::InProgress { recording: true },
        )
        .unwrap();
        let meta = cap_project::RecordingMeta::load_for_project(directory.path()).unwrap();
        assert!(meta.sharing.is_none());
        assert!(meta.upload.is_none());
        assert!(matches!(
            meta.inner,
            cap_project::RecordingMetaInner::Instant(
                cap_project::InstantRecordingMeta::InProgress { recording: true }
            )
        ));
        persist_local_instant_meta(
            directory.path(),
            cap_project::InstantRecordingMeta::Complete {
                fps: 60,
                sample_rate: Some(48000),
            },
        )
        .unwrap();
        let meta = cap_project::RecordingMeta::load_for_project(directory.path()).unwrap();
        assert!(matches!(
            meta.inner,
            cap_project::RecordingMetaInner::Instant(cap_project::InstantRecordingMeta::Complete {
                fps: 60,
                sample_rate: Some(48000)
            })
        ));
        assert!(meta.upload.is_none());
        assert!(meta.sharing.is_none());
    }
}
