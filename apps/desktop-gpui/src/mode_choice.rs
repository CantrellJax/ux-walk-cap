use crate::{app_windows, main_window::Mode, settings_window::Page};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModeChoice {
    Capture(Mode),
    UxWalk,
}

impl ModeChoice {
    pub const ALL: &'static [Self] = &[
        Self::Capture(Mode::Instant),
        Self::Capture(Mode::Studio),
        Self::Capture(Mode::Screenshot),
        #[cfg(target_os = "macos")]
        Self::UxWalk,
    ];

    pub fn capture_mode(self) -> Option<Mode> {
        match self {
            Self::Capture(mode) => Some(mode),
            Self::UxWalk => None,
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Self::Capture(mode) => mode.panel_title(),
            Self::UxWalk => "UX Walk",
        }
    }

    pub fn icon(self) -> &'static str {
        match self {
            Self::Capture(mode) => mode.icon(),
            Self::UxWalk => "icons/ux-walk.svg",
        }
    }

    pub fn icon_size(self) -> f32 {
        match self {
            Self::Capture(mode) => mode.icon_size(),
            Self::UxWalk => 16.,
        }
    }

    pub fn index(self) -> usize {
        Self::ALL
            .iter()
            .position(|choice| *choice == self)
            .unwrap_or(0)
    }

    pub fn panel_description(self) -> &'static str {
        match self {
            Self::Capture(mode) => mode.panel_description(),
            Self::UxWalk => {
                "Record a product walkthrough with notes, chapters and transcripts. Keep evidence ready for your agent."
            }
        }
    }

    pub fn card_description(self) -> &'static str {
        match self {
            Self::Capture(Mode::Instant) => "Share instantly with a link. Uploads as you record.",
            Self::Capture(Mode::Studio) => "Highest quality local recording for editing later.",
            Self::Capture(Mode::Screenshot) => "Capture and annotate screenshots instantly.",
            Self::UxWalk => "Record a walkthrough with notes, chapters and findings.",
        }
    }

    pub fn hover_description(self) -> &'static str {
        match self {
            Self::Capture(Mode::Instant) => {
                "No rendering required — uploads on the fly so you can share the link the moment you stop."
            }
            Self::Capture(Mode::Studio) => {
                "Saves to your computer and opens the editor when you stop. Choose recording quality in settings."
            }
            Self::Capture(Mode::Screenshot) => "Capture and annotate stills.",
            Self::UxWalk => {
                "Record with Cap UX capture controls, then review notes, chapters and transcripts."
            }
        }
    }

    pub fn activate(self, cx: &mut gpui::App) {
        match self {
            Self::Capture(mode) => app_windows::set_recording_mode(mode, cx),
            Self::UxWalk => crate::ux_walk::start(cx),
        }
    }

    pub fn open_settings(self, cx: &mut gpui::App) {
        match self {
            Self::Capture(mode) => app_windows::open_quality_settings(mode, cx),
            Self::UxWalk => app_windows::open_settings(Page::General, cx),
        }
    }
}
