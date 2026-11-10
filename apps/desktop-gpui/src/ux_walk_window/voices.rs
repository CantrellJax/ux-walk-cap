//! The notes window's "Who's talking?" card: after a walk stops, Node writes `voices.json` in the walk
//! folder with one entry per voice it heard. The card names them through the `name-voices` bridge command.

use super::WalkWindow;
use crate::ui;
use gpui::{
    AnyElement, AppContext as _, Context, Entity, FontWeight, IntoElement, ParentElement as _,
    SharedString, Styled, Window, div, prelude::FluentBuilder as _, px,
};
use serde::Deserialize;
use std::path::{Component, Path, PathBuf};

const QUOTE_CHARS: usize = 90;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Voice {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub quote: String,
    #[serde(default)]
    pub clip: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VoicesFile {
    schema_version: u32,
    #[serde(default)]
    pub matched: bool,
    #[serde(default)]
    pub asked: bool,
    #[serde(default)]
    pub pending: bool,
    #[serde(default)]
    pub voices: Vec<Voice>,
    #[serde(default)]
    pub suggestions: Vec<String>,
}

impl VoicesFile {
    pub(super) fn parse(bytes: &[u8]) -> Option<Self> {
        serde_json::from_slice::<Self>(bytes)
            .ok()
            .filter(|file| file.schema_version == 1)
    }

    fn read(directory: &Path) -> Option<Self> {
        std::fs::read(directory.join("voices.json"))
            .ok()
            .and_then(|bytes| Self::parse(&bytes))
    }

    fn ids(&self) -> Vec<String> {
        self.voices.iter().map(|voice| voice.id.clone()).collect()
    }

    pub(super) fn summary_line(&self) -> String {
        let names: Vec<&str> = self
            .voices
            .iter()
            .map(|voice| {
                voice
                    .name
                    .as_deref()
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .unwrap_or(&voice.label)
            })
            .collect();
        format!("Voices: {}", names.join(", "))
    }
}

pub(super) fn pending_names(
    file: &VoicesFile,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    (file.asked && file.pending).then(|| {
        file.voices
            .iter()
            .map(|voice| {
                (
                    voice.id.clone(),
                    serde_json::Value::String(voice.name.clone().unwrap_or_default()),
                )
            })
            .collect()
    })
}

pub(super) fn short_quote(quote: &str) -> String {
    let quote = quote.trim();
    if quote.chars().count() <= QUOTE_CHARS {
        return format!("“{quote}”");
    }
    let cut: String = quote.chars().take(QUOTE_CHARS).collect();
    format!("“{}…”", cut.trim_end())
}

pub(super) fn clip_path(directory: &Path, clip: &str) -> Option<PathBuf> {
    let relative = Path::new(clip);
    let safe = relative
        .components()
        .all(|component| matches!(component, Component::Normal(_)));
    let wav = relative
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("wav"));
    (safe && wav && !clip.is_empty()).then(|| directory.join(relative))
}

fn play(path: PathBuf) {
    std::thread::spawn(move || {
        if let Ok(mut child) = std::process::Command::new("/usr/bin/afplay")
            .arg(&path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            let _ = child.wait();
        }
    });
}

#[derive(Default)]
pub(super) struct VoicesState {
    directory: Option<PathBuf>,
    journal: Option<PathBuf>,
    file: Option<VoicesFile>,
    inputs: Vec<(String, Entity<ui::TextInputState>)>,
    editing: bool,
    busy: bool,
    error: Option<String>,
    last_blurred: Option<usize>,
    was_ready: Option<bool>,
    revision: u64,
}

impl WalkWindow {
    fn voices_target(&self, cx: &Context<Self>) -> Option<(PathBuf, PathBuf)> {
        let walk = if self.selection.file.is_some() {
            self.saved.as_ref()
        } else {
            self.session.read(cx).walk.journal.as_ref()
        }?;
        Some((walk.request.directory.clone(), walk.file()))
    }

    pub(super) fn start_voices_poll(window: &mut Window, cx: &mut Context<Self>) {
        cx.spawn_in(window, async move |this, cx| {
            loop {
                let Ok(target) = this.update(cx, |this, cx| this.voices_target(cx)) else {
                    break;
                };
                let directory = target.as_ref().map(|(directory, _)| directory.clone());
                let (file, ready) = cx
                    .background_executor()
                    .spawn(async move {
                        let Some(directory) = directory else {
                            return (None, false);
                        };
                        let ready = crate::ux_walk_library::processing_status(&directory)
                            == crate::ux_walk_library::WalkStatus::Ready;
                        (VoicesFile::read(&directory), ready)
                    })
                    .await;
                if this
                    .update_in(cx, |this, window, cx| {
                        this.voices_loaded(target, file, ready, window, cx)
                    })
                    .is_err()
                {
                    break;
                }
                cx.background_executor()
                    .timer(std::time::Duration::from_secs(2))
                    .await;
            }
        })
        .detach();
    }

    fn voices_loaded(
        &mut self,
        target: Option<(PathBuf, PathBuf)>,
        file: Option<VoicesFile>,
        ready: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (directory, journal) = match target {
            Some((directory, journal)) => (Some(directory), Some(journal)),
            None => (None, None),
        };
        if self.voices.directory != directory {
            self.voices = VoicesState {
                directory,
                journal,
                revision: self.voices.revision.wrapping_add(1),
                ..VoicesState::default()
            };
            cx.notify();
        }
        let became_ready = ready && self.voices.was_ready != Some(true);
        self.voices.was_ready = Some(ready);
        if became_ready && let Some(names) = file.as_ref().and_then(pending_names) {
            self.send_voice_names(names, false, window, cx);
        }
        if self.voices.file == file {
            return;
        }
        let ids_changed = file.as_ref().map(VoicesFile::ids)
            != Some(
                self.voices
                    .inputs
                    .iter()
                    .map(|(id, _)| id.clone())
                    .collect(),
            );
        let summary = file.as_ref().is_some_and(|file| file.asked) && !self.voices.editing;
        if ids_changed || summary {
            self.reset_voice_inputs(file.as_ref(), window, cx);
        }
        self.voices.file = file;
        cx.notify();
    }

    fn reset_voice_inputs(
        &mut self,
        file: Option<&VoicesFile>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let voices = file.map(|file| file.voices.clone()).unwrap_or_default();
        let same_ids = voices.len() == self.voices.inputs.len()
            && voices
                .iter()
                .zip(&self.voices.inputs)
                .all(|(voice, (id, _))| &voice.id == id);
        if !same_ids {
            self.voices.last_blurred = None;
            self.voices.inputs = voices
                .iter()
                .enumerate()
                .map(|(index, voice)| {
                    let input = cx.new(|cx| {
                        let mut input = ui::TextInputState::single_line(window, cx);
                        input.set_placeholder("Name");
                        input
                    });
                    cx.subscribe(&input, move |this: &mut WalkWindow, _, event, _| {
                        if matches!(event, ui::TextInputEvent::Blurred) {
                            this.voices.last_blurred = Some(index);
                        }
                    })
                    .detach();
                    (voice.id.clone(), input)
                })
                .collect();
        }
        for (voice, (_, input)) in voices.iter().zip(&self.voices.inputs) {
            let name = voice.name.clone().unwrap_or_default();
            input.update(cx, |input, cx| input.set_text(name, cx));
        }
    }

    fn suggest_voice_name(&mut self, name: String, window: &mut Window, cx: &mut Context<Self>) {
        let last_blurred = self.voices.last_blurred.take();
        let inputs = &self.voices.inputs;
        let target = inputs
            .iter()
            .position(|(_, input)| input.read(cx).is_focused(window))
            .or(last_blurred)
            .or_else(|| {
                inputs
                    .iter()
                    .position(|(_, input)| input.read(cx).text().trim().is_empty())
            });
        if let Some((_, input)) = target.and_then(|index| inputs.get(index)) {
            input.update(cx, |input, cx| input.set_text(name, cx));
        }
        cx.notify();
    }

    fn save_voice_names(&mut self, skipped: bool, window: &mut Window, cx: &mut Context<Self>) {
        let names = if skipped {
            serde_json::Map::new()
        } else {
            self.voices
                .inputs
                .iter()
                .map(|(id, input)| {
                    (
                        id.clone(),
                        serde_json::Value::String(input.read(cx).text().trim().to_string()),
                    )
                })
                .collect()
        };
        self.send_voice_names(names, skipped, window, cx);
    }

    fn send_voice_names(
        &mut self,
        names: serde_json::Map<String, serde_json::Value>,
        skipped: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Some(directory), Some(journal)) =
            (self.voices.directory.clone(), self.voices.journal.clone())
        else {
            return;
        };
        if self.voices.busy {
            return;
        }
        self.voices.busy = true;
        self.voices.error = None;
        let revision = self.voices.revision;
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let body =
                serde_json::json!({ "journal": journal, "names": names, "skipped": skipped });
            let result = cx
                .background_executor()
                .spawn(async move {
                    let output = super::filing::run_request("name-voices", body)?;
                    serde_json::from_str::<serde_json::Value>(&output)
                        .map_err(|error| format!("Unexpected reply: {error}"))?;
                    Ok::<_, String>(VoicesFile::read(&directory))
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                if this.voices.revision != revision {
                    return;
                }
                this.voices.busy = false;
                match result {
                    Ok(file) => {
                        this.voices.editing = false;
                        this.reset_voice_inputs(file.as_ref(), window, cx);
                        this.voices.file = file;
                    }
                    Err(error) => {
                        this.voices.error = Some(format!("Could not save the names: {error}"))
                    }
                }
                cx.notify();
                window.refresh();
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn render_voices(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = self.theme;
        let file = self
            .voices
            .file
            .as_ref()
            .filter(|file| file.voices.len() >= 2)?;
        let muted = |text: String| {
            div()
                .text_size(px(11.))
                .line_height(px(16.))
                .text_color(theme.gray_10)
                .child(text)
        };
        let card = div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .p(px(10.))
            .rounded(px(8.))
            .bg(theme.gray_2)
            .border_1()
            .border_color(theme.gray_4);
        let busy = self.voices.busy;
        if file.asked && !self.voices.editing {
            return Some(
                card.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .text_size(px(13.))
                                .child(file.summary_line()),
                        )
                        .child(
                            ui::Button::plain(
                                &theme,
                                "walk-voices-rename",
                                ui::ButtonVariant::Gray,
                                ui::ButtonSize::Xs,
                            )
                            .label("Rename")
                            .disabled(busy)
                            .on_click(cx.listener(
                                |this, _, window, cx| {
                                    this.voices.editing = true;
                                    let file = this.voices.file.clone();
                                    this.reset_voice_inputs(file.as_ref(), window, cx);
                                    cx.notify();
                                },
                            )),
                        ),
                )
                .when(file.pending, |this| {
                    this.child(muted(
                        "The names apply to the transcript and notes when processing finishes."
                            .into(),
                    ))
                })
                .when_some(self.voices.error.clone(), |this, error| {
                    this.child(
                        div()
                            .text_size(px(12.))
                            .text_color(theme.red_9)
                            .child(error),
                    )
                })
                .into_any_element(),
            );
        }
        let directory = self.voices.directory.clone()?;
        let rows = file.voices.iter().zip(&self.voices.inputs).enumerate().map(
            |(index, (voice, (_, input)))| {
                let clip = voice
                    .clip
                    .as_deref()
                    .and_then(|clip| clip_path(&directory, clip));
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .child(
                                div()
                                    .w(px(80.))
                                    .flex_none()
                                    .text_size(px(12.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(voice.label.clone()),
                            )
                            .child(div().flex_1().min_w_0().child(ui::TextInput::settings(
                                &theme,
                                SharedString::from(format!("walk-voice-name-{index}")),
                                input,
                            )))
                            .when_some(clip, |this, clip| {
                                this.child(
                                    ui::Button::plain(
                                        &theme,
                                        SharedString::from(format!("walk-voice-play-{index}")),
                                        ui::ButtonVariant::Gray,
                                        ui::ButtonSize::Xs,
                                    )
                                    .label("Play")
                                    .on_click(move |_, _, _| play(clip.clone())),
                                )
                            }),
                    )
                    .when(!voice.quote.trim().is_empty(), |this| {
                        this.child(muted(short_quote(&voice.quote)))
                    })
            },
        );
        Some(
            card.child(
                div()
                    .text_size(px(13.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("Who's talking?"),
            )
            .child(muted(
                "Name each voice so the transcript and notes say who said what. Skip keeps Speaker 1, Speaker 2."
                    .into(),
            ))
            .when(!file.matched, |this| {
                this.child(muted(
                    "These voices could not be matched across the whole recording, so one person may appear more than once."
                        .into(),
                ))
            })
            .children(rows)
            .when(!file.suggestions.is_empty(), |this| {
                this.child(
                    div().flex().flex_wrap().gap(px(6.)).children(
                        file.suggestions.iter().enumerate().map(|(index, name)| {
                            let name = name.clone();
                            ui::Button::plain(
                                &theme,
                                SharedString::from(format!("walk-voice-suggest-{index}")),
                                ui::ButtonVariant::Gray,
                                ui::ButtonSize::Xs,
                            )
                            .label(name.clone())
                            .disabled(busy)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.suggest_voice_name(name.clone(), window, cx)
                            }))
                        }),
                    ),
                )
            })
            .when_some(self.voices.error.clone(), |this, error| {
                this.child(div().text_size(px(12.)).text_color(theme.red_9).child(error))
            })
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .child(
                        ui::Button::plain(
                            &theme,
                            "walk-voices-save",
                            ui::ButtonVariant::Blue,
                            ui::ButtonSize::Sm,
                        )
                        .label(if busy { "Saving…" } else { "Save names" })
                        .disabled(busy)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.save_voice_names(false, window, cx)
                        })),
                    )
                    .child(
                        ui::Button::plain(
                            &theme,
                            "walk-voices-skip",
                            ui::ButtonVariant::Gray,
                            ui::ButtonSize::Sm,
                        )
                        .label(if file.asked { "Cancel" } else { "Skip" })
                        .disabled(busy)
                        .on_click(cx.listener(|this, _, window, cx| {
                            if this.voices.file.as_ref().is_some_and(|file| file.asked) {
                                this.voices.editing = false;
                                let file = this.voices.file.clone();
                                this.reset_voice_inputs(file.as_ref(), window, cx);
                                cx.notify();
                            } else {
                                this.save_voice_names(true, window, cx);
                            }
                        })),
                    ),
            )
            .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_voices_and_rejects_other_versions() {
        let file = VoicesFile::parse(
            br#"{"schemaVersion":1,"matched":true,"asked":false,"pending":false,
            "voices":[{"id":"voice-1","label":"Speaker 1","name":"Jackson","words":12,"quote":"hi","clip":"voices/voice-1.wav"},
            {"id":"voice-2","label":"Speaker 2","name":null,"words":3,"quote":"yo","clip":null}],
            "suggestions":["Clay"]}"#,
        )
        .unwrap();
        assert_eq!(file.voices.len(), 2);
        assert_eq!(file.summary_line(), "Voices: Jackson, Speaker 2");
        assert!(pending_names(&file).is_none());
        let pending = VoicesFile::parse(
            br#"{"schemaVersion":1,"asked":true,"pending":true,"inputHash":"x","all":[],
            "voices":[{"id":"voice-1","label":"Speaker 1","name":"Jackson"},{"id":"voice-2","label":"Speaker 2"}]}"#,
        )
        .unwrap();
        let names = pending_names(&pending).unwrap();
        assert_eq!(names["voice-1"], "Jackson");
        assert_eq!(names["voice-2"], "");
        assert!(VoicesFile::parse(br#"{"schemaVersion":2,"voices":[]}"#).is_none());
        assert!(VoicesFile::parse(b"not json").is_none());
    }

    #[test]
    fn clip_paths_stay_inside_the_walk_folder() {
        let walk = Path::new("/walk");
        assert_eq!(
            clip_path(walk, "voices/voice-1.wav"),
            Some(PathBuf::from("/walk/voices/voice-1.wav"))
        );
        assert_eq!(clip_path(walk, "../secret.wav"), None);
        assert_eq!(clip_path(walk, "/etc/voice.wav"), None);
        assert_eq!(clip_path(walk, "voices/voice-1.mp3"), None);
    }

    #[test]
    fn long_quotes_are_shortened() {
        assert_eq!(short_quote(" hello "), "“hello”");
        let long = "word ".repeat(40);
        let short = short_quote(&long);
        assert!(short.ends_with("…”"));
        assert!(short.chars().count() <= QUOTE_CHARS + 3);
    }
}
