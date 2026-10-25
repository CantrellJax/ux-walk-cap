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
    ensure(false, cx)
}
pub fn open(cx: &mut App) {
    if let Err(error) = ensure(true, cx) {
        tracing::error!(%error, "opening native walk notes");
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
            error: None,
        }
    }

    fn add(&mut self, kind: &str, cx: &mut Context<Self>) {
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
}

impl Render for WalkWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.theme.refresh(window, cx, false);
        let theme = self.theme;
        let session = self.session.read(cx);
        let walk = session.walk.clone();
        let live = walk.as_ref().is_some_and(|walk| walk.state == "recording")
            && matches!(session.phase, Phase::Recording { .. });
        let processing = session.walk_processing || session.phase == Phase::Stopping;
        let notice = session.walk_notice.clone();
        div().size_full().flex().flex_col().gap(px(14.)).p(px(24.)).bg(theme.gray_1).text_color(theme.text_primary).font_family(crate::theme::UI_FONT)
            .child(div().text_size(px(22.)).font_weight(FontWeight::SEMIBOLD).child(walk.as_ref().map(|walk| walk.request.topic.clone()).unwrap_or_else(|| "UX Walk".into())))
            .child(div().text_size(px(12.)).line_height(px(18.)).text_color(theme.gray_10).child(if notice.is_empty() { "Start a UX Walk from the recorder. Use its existing capture and audio controls.".into() } else { notice }))
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
                let directory = walk.request.directory;
                let folder = directory.clone();
                let report = directory.join("report.html");
                let ready = report.is_file();
                let prompt = format!("Review this UX Walk: {}. Read report.html and the chapter timelines, inspect the referenced screenshots and transcript, and propose concrete fixes. Evidence is a native screen recording with manual notes; DOM, network and console were not captured.", directory.display());
                this.child(div().text_size(px(11.)).text_color(theme.gray_10).child("Notes use Cap UX’s elapsed clock. DOM, network and console events are not captured."))
                    .child(div().flex().flex_wrap().gap(px(8.))
                        .child(ui::Button::plain(&theme, "walk-open-folder", ui::ButtonVariant::Gray, ui::ButtonSize::Sm).label("Show files").on_click(move |_, _, _| crate::library::reveal_in_folder(&folder)))
                        .child(ui::Button::plain(&theme, "walk-open-report", ui::ButtonVariant::Blue, ui::ButtonSize::Sm).label("Open report").disabled(!ready).on_click(move |_, _, cx| { if let Ok(url) = reqwest::Url::from_file_path(&report) { cx.open_url(url.as_str()); } }))
                        .child(ui::Button::plain(&theme, "walk-copy-prompt", ui::ButtonVariant::Gray, ui::ButtonSize::Sm).label(if crate::ux_walk::load().is_ok_and(|settings| crate::ux_walk::text(&settings, "agent") == "cmux") { "Open Claude in cmux" } else { "Copy agent prompt" }).disabled(!ready).on_click(move |_, _, cx| { cx.write_to_clipboard(gpui::ClipboardItem::new_string(prompt.clone()));
                            if crate::ux_walk::load().is_ok_and(|settings| crate::ux_walk::text(&settings, "agent") == "cmux") { RecordingSession::global(cx).update(cx, |session, cx| session.handoff_walk(cx)); }
                        }))
                        .when(walk.state == "complete" && !processing, |this| this.child(ui::Button::plain(&theme, "walk-edit-copy", ui::ButtonVariant::Gray, ui::ButtonSize::Sm).label("Edit a copy").on_click(cx.listener(|this, _, _, cx| { this.session.update(cx, |session, cx| session.edit_walk(cx)); }))))
                        .when(walk.state == "complete" && !processing, |this| this.child(ui::Button::plain(&theme, "walk-retry", ui::ButtonVariant::Gray, ui::ButtonSize::Sm).label("Reprocess").on_click(cx.listener(|this, _, _, cx| { this.session.update(cx, |session, cx| session.process_walk(cx)); }))))
                    )
            })
    }
}
