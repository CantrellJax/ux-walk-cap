use gpui::App;

use super::{Entry, mode_submenu};
#[cfg(target_os = "macos")]
use super::{TrayItem, mode_icon};
use crate::{i18n::tr, main_window::Mode};

#[cfg(target_os = "macos")]
const UX_WALK_ICON: &[u8] = include_bytes!("../../assets/tray/tray-default-icon-ux-walk.png");

fn editor_open(cx: &App) -> bool {
    crate::session::RecordingSession::global(cx)
        .read(cx)
        .editor_recording_target()
        .is_some()
}

#[cfg(target_os = "macos")]
pub(super) fn current_mode_icon(mode: Mode, cx: &App) -> &'static [u8] {
    if editor_open(cx) {
        mode_icon(Mode::Studio)
    } else if crate::store::ux_walk_selected() {
        UX_WALK_ICON
    } else {
        mode_icon(mode)
    }
}

#[cfg(target_os = "macos")]
pub(super) fn icon_name(png: &[u8]) -> Option<&'static str> {
    (png == UX_WALK_ICON).then_some("ux-walk")
}

pub(super) fn menu_mode(mode: Mode, cx: &App) -> Mode {
    if editor_open(cx) { Mode::Studio } else { mode }
}

pub(super) fn decorate_mode_submenu(entries: &mut [Entry], mode: Mode, cx: &App) {
    let walk = crate::store::ux_walk_selected() && !editor_open(cx);
    for entry in entries {
        if matches!(entry, Entry::ModePicker { .. })
            || matches!(entry, Entry::Submenu { title, .. } if title == tr::tray::select_mode())
        {
            *entry = walk_submenu(mode, walk);
        }
    }
}

fn walk_submenu(mode: Mode, walk: bool) -> Entry {
    let mut submenu = mode_submenu(mode);
    let Entry::Submenu { items, .. } = &mut submenu else {
        return submenu;
    };
    if walk {
        for item in items.iter_mut() {
            if let Entry::Item { title, .. } = item
                && let Some(text) = title.strip_prefix("\u{2713} ")
            {
                *title = format!("   {text}");
            }
        }
    }
    #[cfg(target_os = "macos")]
    items.push(Entry::item(
        if walk { "✓ UX Walk" } else { "   UX Walk" },
        TrayItem::StartWalkthrough,
    ));
    submenu
}

#[cfg(test)]
mod tests {
    use super::*;

    fn titles(entries: &[Entry]) -> Vec<String> {
        entries
            .iter()
            .filter_map(|entry| match entry {
                Entry::Item { title, .. } => Some(title.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn walk_submenu_adds_the_walk_choice_after_the_upstream_modes() {
        let Entry::Submenu { items, .. } = walk_submenu(Mode::Studio, false) else {
            panic!("the mode picker is a submenu");
        };
        let Entry::Submenu {
            items: upstream, ..
        } = mode_submenu(Mode::Studio)
        else {
            panic!("the mode picker is a submenu");
        };
        assert_eq!(titles(&items[..3]), titles(&upstream));
        #[cfg(target_os = "macos")]
        {
            assert_eq!(titles(&items[3..]), vec!["   UX Walk"]);
            assert!(matches!(
                items[3],
                Entry::Item {
                    item: Some(TrayItem::StartWalkthrough),
                    enabled: true,
                    ..
                }
            ));
        }
        #[cfg(not(target_os = "macos"))]
        assert_eq!(items.len(), 3);
    }

    #[test]
    fn a_selected_walk_moves_the_check_mark_off_the_recording_mode() {
        let Entry::Submenu { items, .. } = walk_submenu(Mode::Studio, true) else {
            panic!("the mode picker is a submenu");
        };
        let titles = titles(&items);
        assert!(titles[..3].iter().all(|title| title.starts_with("   ")));
        #[cfg(target_os = "macos")]
        assert_eq!(titles[3], "✓ UX Walk");
    }
}
