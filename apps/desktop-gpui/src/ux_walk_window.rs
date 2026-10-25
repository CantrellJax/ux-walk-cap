use crate::{
    session::{Phase, RecordingSession},
    theme::Theme,
    ui,
};
use gpui::{
    App, AppContext as _, Bounds, Context, Entity, FontWeight, Global, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, StatefulInteractiveElement as _, Styled, Window,
    WindowBounds, WindowHandle, WindowOptions, div, prelude::FluentBuilder as _, px, size,
};

#[derive(Default)]
struct WalkWindows(Option<WindowHandle<WalkWindow>>);
impl Global for WalkWindows {}

pub fn prepare(cx: &mut App) -> Result<isize, String> {
    let number = ensure(false, cx)?;
    reset_live(cx);
    Ok(number)
}
pub fn open(cx: &mut App) {
    if let Err(error) = ensure(true, cx) {
        tracing::error!(%error, "opening native walk notes");
    } else {
        reset_live(cx);
    }
}

fn reset_live(cx: &mut App) {
    if let Some(handle) = cx.global::<WalkWindows>().0 {
        handle
            .update(cx, |view, _, cx| {
                view.selection.choose(None);
                view.saved = None;
                view.summary = None;
                view.error = None;
                view.notice = None;
                view.poll = None;
                cx.notify();
            })
            .ok();
    }
}

pub fn open_saved(file: std::path::PathBuf, cx: &mut App) {
    if let Err(error) = ensure(true, cx) {
        tracing::error!(%error, "opening saved walk notes");
        return;
    }
    if let Some(handle) = cx.global::<WalkWindows>().0 {
        handle
            .update(cx, |view, window, cx| {
                view.selection.choose(Some(file.clone()));
                view.saved = None;
                view.summary = None;
                view.error = None;
                view.notice = None;
                view.poll = None;
                view.load_saved(file, window, cx);
            })
            .ok();
    }
}

fn ensure(show: bool, cx: &mut App) -> Result<isize, String> {
    if !cx.has_global::<WalkWindows>() {
        cx.set_global(WalkWindows::default());
    }
    let handle = match cx.global::<WalkWindows>().0 {
        Some(handle) => handle,
        None => {
            let bounds = Bounds::centered(None, size(px(520.), px(550.)), cx);
            let handle = cx
                .open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(bounds)),
                        titlebar: Some(gpui::TitlebarOptions {
                            title: Some("Cap UX · Walk notes".into()),
                            ..Default::default()
                        }),
                        focus: show,
                        show,
                        is_resizable: true,
                        window_min_size: Some(size(px(440.), px(360.))),
                        ..Default::default()
                    },
                    |window, cx| cx.new(|cx| WalkWindow::new(window, cx)),
                )
                .map_err(|e| e.to_string())?;
            cx.global_mut::<WalkWindows>().0 = Some(handle);
            handle
        }
    };
    let (number, native) = handle
        .update(cx, |_, window, _| {
            let native = crate::platform::native_window(window);
            if let Some(native) = &native {
                crate::platform::set_window_capture_hidden(native, true);
            }
            (crate::platform::window_number(window), native)
        })
        .map_err(|e| e.to_string())?;
    let number = number
        .filter(|number| *number > 0)
        .ok_or_else(|| "Could not exclude the walk notes window from capture.".to_string())?;
    if show {
        // Native ordering re-enters GPUI; reveal outside the window borrow, like the editor.
        cx.spawn(async move |cx| {
            if let Some(native) = &native {
                crate::platform::show_native(native);
            }
            cx.update(|cx| {
                cx.activate(true);
                handle
                    .update(cx, |_, window, cx| {
                        window.activate_window();
                        crate::platform::kick_display_link(window);
                        cx.notify();
                        window.refresh();
                    })
                    .ok();
                crate::menus::schedule_dock_sync(cx);
            });
        })
        .detach();
    }
    Ok(number)
}

struct WalkWindow {
    theme: Theme,
    session: Entity<RecordingSession>,
    input: Entity<ui::TextInputState>,
    selection: crate::ux_walk_library::WalkSelection,
    saved: Option<crate::ux_walk_journal::Journal>,
    summary: Option<crate::ux_walk_library::WalkSummary>,
    poll: Option<gpui::Task<()>>,
    action_revision: u64,
    reprocessing: std::collections::BTreeSet<std::path::PathBuf>,
    notice: Option<String>,
    error: Option<String>,
}

impl WalkWindow {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        crate::theme::bind_window(window, cx);
        window.on_window_should_close(cx, |window, _| {
            if let Some(native) = crate::platform::native_window(window) {
                crate::platform::hide_native(&native);
            }
            false
        });
        let session = RecordingSession::global(cx);
        cx.observe_in(&session, window, |_, _, window, cx| {
            cx.notify();
            window.refresh();
        })
        .detach();
        let input = cx.new(|cx| {
            let mut input = ui::TextInputState::single_line(window, cx);
            input.set_placeholder("Add an observation or a chapter title");
            input
        });
        cx.subscribe(&input, |this, _, event, cx| {
            if matches!(event, ui::TextInputEvent::Confirmed) {
                this.add("note", cx);
            }
        })
        .detach();
        Self {
            theme: Theme::for_window(window, cx, false),
            session,
            input,
            selection: Default::default(),
            saved: None,
            summary: None,
            poll: None,
            action_revision: 0,
            reprocessing: Default::default(),
            notice: None,
            error: None,
        }
    }

    fn load_saved(
        &mut self,
        file: std::path::PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let revision = self.selection.choose(Some(file.clone()));
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let requested = file.clone();
            let result = cx
                .background_executor()
                .spawn(async move { crate::ux_walk_library::read_walk(&file) })
                .await;
            this.update_in(cx, |this, window, cx| {
                if !this.selection.accepts(&requested, revision) {
                    return;
                }
                match result {
                    Ok((summary, journal)) => {
                        this.summary = Some(summary);
                        this.saved = Some(journal);
                        this.error = None;
                        if this
                            .summary
                            .as_ref()
                            .is_some_and(crate::ux_walk_library::WalkSummary::is_active)
                            || this.reprocessing.contains(&requested)
                        {
                            let file = requested.clone();
                            this.poll = Some(cx.spawn_in(window, async move |this, cx| {
                                cx.background_executor()
                                    .timer(std::time::Duration::from_secs(2))
                                    .await;
                                this.update_in(cx, |this, window, cx| {
                                    if this.selection.accepts(&file, revision) {
                                        this.load_saved(file, window, cx);
                                    }
                                })
                                .ok();
                            }));
                        } else {
                            this.poll = None;
                        }
                    }
                    Err(error) => {
                        this.error = Some(error);
                        this.notice = Some("Saved notes could not be opened.".into());
                        this.poll = None;
                    }
                }
                cx.notify();
                window.refresh();
            })
            .ok();
        })
        .detach();
    }

    fn add(&mut self, kind: &str, cx: &mut Context<Self>) {
        if self.selection.file.is_some() {
            return;
        }
        let text = self.input.read(cx).text().to_string();
        match self
            .session
            .update(cx, |session, cx| session.add_walk_event(kind, &text, cx))
        {
            Ok(()) => {
                self.error = None;
                self.input.update(cx, |input, cx| input.set_text("", cx));
            }
            Err(error) => self.error = Some(error),
        }
        cx.notify();
    }

    fn reprocess_saved(
        &mut self,
        file: std::path::PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.selection.file.as_ref() != Some(&file)
            || self.session.read(cx).phase != Phase::Idle
            || self.reprocessing.contains(&file)
        {
            return;
        }
        if let Err(error) = crate::ux_walk_library::reprocess_allowed(&file) {
            self.error = Some(error);
            cx.notify();
            return;
        }
        self.reprocessing.insert(file.clone());
        self.error = None;
        self.notice = Some(
            "Preparing chapters, screenshots and transcript… Your notes remain available.".into(),
        );
        self.load_saved(file.clone(), window, cx);
        cx.spawn_in(window, async move |this, cx| {
            let selected = file.clone();
            let result = cx
                .background_executor()
                .spawn(async move {
                    crate::ux_walk_library::reprocess_allowed(&file)?;
                    crate::ux_walk::run_engine("process", &file)
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                this.reprocessing.remove(&selected);
                if this.selection.file.as_ref() != Some(&selected) {
                    return;
                }
                this.notice = Some(match result {
                    Ok(_) => "Walk ready. Open the report or copy its agent prompt.".into(),
                    Err(error) => format!(
                        "Recording and notes are saved. Could not reprocess this walk: {error}"
                    ),
                });
                this.load_saved(selected, window, cx);
                cx.notify();
                window.refresh();
            })
            .ok();
        })
        .detach();
    }

    fn action(&mut self, command: &'static str, file: std::path::PathBuf, cx: &mut Context<Self>) {
        self.action_revision = self.action_revision.wrapping_add(1);
        let revision = self.action_revision;
        let selection = self.selection.file.clone();
        self.notice = Some(
            if command == "prompt" {
                "Preparing agent prompt…"
            } else {
                "Opening Claude in cmux…"
            }
            .into(),
        );
        cx.notify();
        cx.spawn(async move |this, cx| {
            let selected = file.clone();
            let result = cx
                .background_executor()
                .spawn(async move { crate::ux_walk::run_engine(command, &file) })
                .await;
            this.update(cx, |this, cx| {
                if this.action_revision != revision || this.selection.file != selection {
                    return;
                }
                if selection.is_none()
                    && this
                        .session
                        .read(cx)
                        .walk
                        .as_ref()
                        .is_none_or(|walk| walk.file() != selected)
                {
                    return;
                }
                this.notice = Some(match result {
                    Ok(output) if command == "prompt" => {
                        cx.write_to_clipboard(gpui::ClipboardItem::new_string(output));
                        "Agent prompt copied".into()
                    }
                    Ok(_) => "Opened Claude in cmux with this walk’s prompt.".into(),
                    Err(error) => format!("Could not complete the action: {error}"),
                });
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

impl Render for WalkWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.theme.refresh(window, cx, false);
        let theme = self.theme;
        let saved_view = self.selection.file.is_some();
        let session = self.session.read(cx);
        let walk = if saved_view {
            self.saved.clone()
        } else {
            session.walk.clone()
        };
        let live = !saved_view
            && walk.as_ref().is_some_and(|walk| walk.state == "recording")
            && matches!(session.phase, Phase::Recording { .. });
        let capture_active = session.phase != Phase::Idle;
        let processing = if saved_view {
            self.summary
                .as_ref()
                .is_some_and(|walk| walk.status == crate::ux_walk_library::WalkStatus::Processing)
        } else {
            session.walk_processing || session.phase == Phase::Stopping
        };
        let notice = self.notice.clone().unwrap_or_else(|| {
            if saved_view {
                self.summary
                    .as_ref()
                    .map(|summary| summary.status.notice())
                    .unwrap_or_else(|| "Loading saved notes…".into())
            } else if session.walk_notice.is_empty() {
                "Start a UX Walk from the recorder. Use its existing capture and audio controls."
                    .into()
            } else {
                session.walk_notice.clone()
            }
        });
        div().size_full().flex().flex_col().gap(px(14.)).p(px(24.)).bg(theme.gray_1).text_color(theme.text_primary).font_family(crate::theme::UI_FONT)
            .child(div().text_size(px(22.)).font_weight(FontWeight::SEMIBOLD).child(walk.as_ref().map(|walk| walk.request.topic.clone()).unwrap_or_else(|| "UX Walk".into())))
            .child(div().text_size(px(12.)).line_height(px(18.)).text_color(theme.gray_10).child(notice))
            .when(live, |this| this.child(ui::TextInput::settings(&theme, "walk-note-input", &self.input)).child(
                div().flex().gap(px(8.))
                    .child(ui::Button::plain(&theme, "walk-add-note", ui::ButtonVariant::Blue, ui::ButtonSize::Sm).label("Add note").on_click(cx.listener(|this, _, _, cx| this.add("note", cx))))
                    .child(ui::Button::plain(&theme, "walk-add-chapter", ui::ButtonVariant::Gray, ui::ButtonSize::Sm).label("New chapter").on_click(cx.listener(|this, _, _, cx| this.add("chapter", cx))))
            ))
            .when_some(self.error.clone(), |this, error| this.child(div().text_size(px(12.)).text_color(theme.red_9).child(error)))
            .child(div().id("walk-events").flex().flex_col().gap(px(10.)).flex_1().min_h_0().overflow_y_scroll().children(walk.as_ref().map(|walk| &walk.events).into_iter().flatten().map(|event| {
                div().flex().flex_col().gap(px(3.))
                    .child(div().text_size(px(11.)).text_color(theme.gray_10).child(format!("{}:{:02} · {}", event.offset_ms / 60_000, (event.offset_ms / 1000) % 60, if event.kind == "chapter" { "Chapter" } else { "Note" })))
                    .child(div().text_size(px(13.)).child(event.text.clone()))
            })))
            .when_some(walk, |this, walk| {
                let file = walk.file();
                let folder = walk.request.directory.clone();
                let report = folder.join("report.html");
                let ready = if saved_view { self.summary.as_ref().is_some_and(crate::ux_walk_library::WalkSummary::report_ready) }
                    else { !processing && crate::ux_walk_library::processing_status(&walk.request.directory) == crate::ux_walk_library::WalkStatus::Ready };
                let saved_retry = file.clone();
                let retry_disabled = capture_active || processing || self.reprocessing.contains(&file)
                    || self.summary.as_ref().is_some_and(|summary| matches!(summary.status, crate::ux_walk_library::WalkStatus::OwnerUnknown(_)));
                let prompt_file = file.clone();
                let handoff_file = file.clone();
                let cmux = crate::ux_walk::load().is_ok_and(|settings| crate::ux_walk::text(&settings, "agent") == "cmux");
                let evidence = if processing { "The agent prompt describes the browser evidence available while processing continues.".into() } else { crate::ux_walk_library::evidence_notice(&walk.request.directory) };
                this.child(div().text_size(px(11.)).text_color(theme.gray_10).child(evidence))
                    .child(div().flex().flex_wrap().gap(px(8.))
                        .child(ui::Button::plain(&theme, "walk-open-folder", ui::ButtonVariant::Gray, ui::ButtonSize::Sm).label("Show files").on_click(move |_, _, _| crate::library::reveal_in_folder(&folder)))
                        .child(ui::Button::plain(&theme, "walk-open-report", ui::ButtonVariant::Blue, ui::ButtonSize::Sm).label("Open report").disabled(!ready).on_click(move |_, _, cx| { if let Ok(url) = reqwest::Url::from_file_path(&report) { cx.open_url(url.as_str()); } }))
                        .child(ui::Button::plain(&theme, "walk-copy-prompt", ui::ButtonVariant::Gray, ui::ButtonSize::Sm).label("Copy agent prompt").on_click(cx.listener(move |this, _, _, cx| this.action("prompt", prompt_file.clone(), cx))))
                        .when(cmux, |this| this.child(ui::Button::plain(&theme, "walk-open-claude", ui::ButtonVariant::Gray, ui::ButtonSize::Sm).label("Open Claude in cmux").disabled(!ready).on_click(cx.listener(move |this, _, _, cx| this.action("handoff", handoff_file.clone(), cx)))))
                        .when(saved_view && walk.state == "complete", |this| this.child(ui::Button::plain(&theme, "walk-reprocess-saved", ui::ButtonVariant::Gray, ui::ButtonSize::Sm).label("Reprocess").disabled(retry_disabled).on_click(cx.listener(move |this, _, window, cx| this.reprocess_saved(saved_retry.clone(), window, cx)))))
                        .when(!saved_view && walk.state == "complete" && !processing, |this| this.child(ui::Button::plain(&theme, "walk-edit-copy", ui::ButtonVariant::Gray, ui::ButtonSize::Sm).label("Edit a copy").on_click(cx.listener(|this, _, _, cx| { this.session.update(cx, |session, cx| session.edit_walk(cx)); }))))
                        .when(!saved_view && walk.state == "complete" && !processing, |this| this.child(ui::Button::plain(&theme, "walk-retry", ui::ButtonVariant::Gray, ui::ButtonSize::Sm).label("Reprocess").disabled(capture_active).on_click(cx.listener(|this, _, _, cx| { this.session.update(cx, |session, cx| session.process_walk(cx)); }))))
                    )
            })
    }
}
