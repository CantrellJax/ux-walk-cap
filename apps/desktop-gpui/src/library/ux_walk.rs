use std::path::Path;

use gpui::App;

use super::{RecordingItem, RecordingMode, open_recording_folder, open_with_system};
use crate::ux_walk_library::WalkSummary;

pub(super) fn walk_active(item: &RecordingItem) -> bool {
    item.walk.as_ref().is_some_and(WalkSummary::is_active)
}

pub(super) fn attach_walks(
    items: impl Iterator<Item = RecordingItem>,
) -> impl Iterator<Item = RecordingItem> {
    let walks = crate::ux_walk_library::index();
    items.map(move |mut item| {
        item.walk = item
            .path
            .canonicalize()
            .ok()
            .and_then(|path| walks.get(&path))
            .cloned();
        item
    })
}

pub fn play_instant_recording(path: &Path, cx: &App) {
    let output = path.join("content/output.mp4");
    if output.is_file() {
        open_with_system(&output, cx);
    } else {
        open_recording_folder(path, RecordingMode::Instant, cx);
    }
}
