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
    let editor_open = editor_open(cx);
    #[cfg(target_os = "macos")]
    WALK_PILL_SHOWN.set(!editor_open && crate::store::ux_walk_selected());
    if editor_open { Mode::Studio } else { mode }
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

#[cfg(target_os = "macos")]
thread_local! {
    static WALK_PILL_SHOWN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Pill {
    Mode(Mode),
    UxWalk,
}

#[cfg(target_os = "macos")]
impl PartialEq<Mode> for Pill {
    fn eq(&self, mode: &Mode) -> bool {
        *self == Pill::Mode(*mode)
    }
}

#[cfg(target_os = "macos")]
impl From<Pill> for Mode {
    fn from(pill: Pill) -> Self {
        match pill {
            Pill::Mode(mode) => mode,
            Pill::UxWalk => Mode::Studio,
        }
    }
}

#[cfg(target_os = "macos")]
pub(super) fn picker_pills(modes: &[(Mode, TrayItem)]) -> Vec<(Pill, TrayItem)> {
    modes
        .iter()
        .map(|(mode, item)| (Pill::Mode(*mode), item.clone()))
        .chain([(Pill::UxWalk, TrayItem::StartWalkthrough)])
        .collect()
}

#[cfg(target_os = "macos")]
pub(super) fn shown_pill(mode: Mode) -> Pill {
    if WALK_PILL_SHOWN.get() {
        Pill::UxWalk
    } else {
        Pill::Mode(mode)
    }
}

#[cfg(target_os = "macos")]
pub(super) fn mode_name(pill: Pill) -> &'static str {
    match pill {
        Pill::Mode(mode) => super::mode_name(mode),
        Pill::UxWalk => crate::mode_choice::ModeChoice::UxWalk.display_name(),
    }
}

#[cfg(target_os = "macos")]
pub(super) fn mode_heading(pill: Pill) -> &'static str {
    match pill {
        Pill::Mode(mode) => super::mode_heading(mode),
        Pill::UxWalk => "UX Walk Mode",
    }
}

#[cfg(target_os = "macos")]
pub(super) fn mode_picker_icon(pill: Pill) -> Option<Vec<u8>> {
    match pill {
        Pill::Mode(mode) => super::mode_picker_icon(mode),
        Pill::UxWalk => super::svg_icon_png(
            include_bytes!("../../assets/icons/ux-walk.svg"),
            super::PICKER_ICON_SIZE,
        ),
    }
}

#[cfg(target_os = "macos")]
pub(super) fn set_status_mode(pill: Pill) {
    if let Pill::Mode(mode) = pill {
        super::mac::set_status_mode(mode);
    }
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

#[cfg(all(test, target_os = "macos"))]
mod pill_tests {
    use super::*;

    const UPSTREAM_PILLS: [(Mode, TrayItem); 3] = [
        (Mode::Instant, TrayItem::ModeInstant),
        (Mode::Studio, TrayItem::ModeStudio),
        (Mode::Screenshot, TrayItem::ModeScreenshot),
    ];

    #[test]
    fn the_walk_pill_follows_the_upstream_mode_pills() {
        let pills = picker_pills(&UPSTREAM_PILLS);
        assert_eq!(
            pills,
            vec![
                (Pill::Mode(Mode::Instant), TrayItem::ModeInstant),
                (Pill::Mode(Mode::Studio), TrayItem::ModeStudio),
                (Pill::Mode(Mode::Screenshot), TrayItem::ModeScreenshot),
                (Pill::UxWalk, TrayItem::StartWalkthrough),
            ]
        );
    }

    #[test]
    fn the_walk_pill_is_labelled_and_drawn() {
        assert_eq!(mode_name(Pill::UxWalk), "UX Walk");
        assert_eq!(mode_heading(Pill::UxWalk), "UX Walk Mode");
        assert!(mode_picker_icon(Pill::UxWalk).is_some());
        for mode in [Mode::Instant, Mode::Studio, Mode::Screenshot] {
            assert_eq!(mode_name(Pill::Mode(mode)), super::super::mode_name(mode));
            assert_eq!(
                mode_heading(Pill::Mode(mode)),
                super::super::mode_heading(mode)
            );
        }
    }

    #[test]
    fn the_walk_pill_records_in_studio_and_is_not_studio() {
        assert_eq!(Mode::from(Pill::UxWalk), Mode::Studio);
        assert!(Pill::UxWalk != Mode::Studio);
        assert!(Pill::Mode(Mode::Studio) == Mode::Studio);
    }

    #[test]
    fn a_selected_walk_selects_the_walk_pill() {
        WALK_PILL_SHOWN.set(true);
        assert_eq!(shown_pill(Mode::Studio), Pill::UxWalk);
        WALK_PILL_SHOWN.set(false);
        assert_eq!(shown_pill(Mode::Studio), Pill::Mode(Mode::Studio));
        assert_eq!(shown_pill(Mode::Instant), Pill::Mode(Mode::Instant));
    }
}
