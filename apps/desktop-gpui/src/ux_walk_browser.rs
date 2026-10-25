#[cfg(target_os = "macos")]
mod owned {
    use serde_json::{Value, json};
    use std::{
        io::{BufRead, BufReader, Write},
        path::{Path, PathBuf},
        process::{Child, ChildStdin, Command, Stdio},
        sync::{Mutex, OnceLock, mpsc},
        time::{Duration, Instant},
    };

    struct Browser {
        capture_id: String,
        window_id: Option<String>,
        journal: Option<PathBuf>,
        child: Option<Child>,
        input: Option<ChildStdin>,
        replies: mpsc::Receiver<Result<Value, String>>,
    }

    impl Drop for Browser {
        fn drop(&mut self) {
            self.input.take();
            if let Some(mut child) = self.child.take() {
                std::thread::spawn(move || {
                    for _ in 0..100 {
                        if child.try_wait().ok().flatten().is_some() {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    let _ = child.kill();
                    let _ = child.wait();
                });
            }
        }
    }

    impl Browser {
        fn command(&mut self, mut message: Value, timeout: Duration) -> Result<(), String> {
            let id = crate::store::new_uuid_v4();
            message["id"] = json!(id);
            message["captureId"] = json!(self.capture_id);
            let input = self.input.as_mut().ok_or("The walk browser closed.")?;
            let mut bytes = serde_json::to_vec(&message).map_err(|error| error.to_string())?;
            bytes.push(b'\n');
            input.write_all(&bytes).map_err(|error| error.to_string())?;
            input.flush().map_err(|error| error.to_string())?;
            let started = Instant::now();
            loop {
                let reply = self
                    .replies
                    .recv_timeout(timeout.saturating_sub(started.elapsed()))
                    .map_err(|_| "The walk browser did not acknowledge its control request.")??;
                if reply["id"].as_str() != Some(&id) {
                    continue;
                }
                return if reply["ok"] == true {
                    Ok(())
                } else {
                    Err(reply["error"]
                        .as_str()
                        .unwrap_or("The walk browser refused its control request.")
                        .to_string())
                };
            }
        }
    }

    fn browsers() -> &'static Mutex<Vec<Browser>> {
        static BROWSERS: OnceLock<Mutex<Vec<Browser>>> = OnceLock::new();
        BROWSERS.get_or_init(|| Mutex::new(Vec::new()))
    }

    fn engine() -> Result<PathBuf, String> {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        Ok(executable
            .parent()
            .and_then(Path::parent)
            .ok_or("Cap UX app bundle is unavailable.")?
            .join("Resources/ux-walk"))
    }

    fn spawn() -> Result<Browser, String> {
        let engine = engine()?;
        let capture_id = crate::store::new_uuid_v4();
        let work_dir = crate::store::app_data_dir()
            .join("walk-browser")
            .join(&capture_id);
        std::fs::create_dir_all(&work_dir).map_err(|error| error.to_string())?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&work_dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
        let mut child = Command::new(engine.join("bin/node"))
            .arg(engine.join("native-browser.mjs"))
            .arg(&capture_id)
            .arg(work_dir)
            .env(
                "CAP_UX_WALK_CONFIG_DIR",
                crate::ux_walk::config_path()
                    .parent()
                    .ok_or("Invalid walk settings folder.")?,
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Could not start the walk browser: {error}"))?;
        let input = child
            .stdin
            .take()
            .ok_or("Browser control input unavailable.")?;
        let output = child
            .stdout
            .take()
            .ok_or("Browser control output unavailable.")?;
        let (send, replies) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let response = line.map_err(|error| error.to_string()).and_then(|line| {
                    if line.len() > 65536 {
                        Err("Browser control response was too large.".into())
                    } else {
                        serde_json::from_str(&line).map_err(|error| error.to_string())
                    }
                });
                if send.send(response).is_err() {
                    return;
                }
            }
            let _ = send.send(Err("The walk browser collector closed.".into()));
        });
        let browser = Browser {
            capture_id,
            window_id: None,
            journal: None,
            child: Some(child),
            input: Some(input),
            replies,
        };
        let ready = browser
            .replies
            .recv_timeout(Duration::from_secs(25))
            .map_err(|_| "The walk browser could not start in time.")??;
        if ready["ready"] != true || ready["captureId"].as_str() != Some(&browser.capture_id) {
            return Err(ready["error"]
                .as_str()
                .unwrap_or(
                    "The walk browser could not start. Check that Google Chrome is installed.",
                )
                .to_string());
        }
        Ok(browser)
    }

    pub fn open() -> Result<crate::devices::WindowOption, String> {
        let settings = crate::ux_walk::load()?;
        let url = reqwest::Url::parse(crate::ux_walk::text(&settings, "url"))
            .map_err(|_| "Enter a valid start page in UX Walk settings.")?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err("Use an http or https start page.".into());
        }
        let before: Vec<String> = scap_targets::Window::list()
            .into_iter()
            .map(|window| window.id().to_string())
            .collect();
        let mut browser = spawn()?;
        let marker = format!("Cap UX walk {}", browser.capture_id);
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(15) {
            let matches: Vec<_> = crate::devices::list_window_targets()
                .into_iter()
                .filter(|(option, window)| {
                    window.raw_handle().bundle_identifier().as_deref() == Some("com.google.Chrome")
                        && option.label.contains(&marker)
                })
                .map(|(option, _)| option)
                .collect();
            if let Some(id) = crate::ux_walk_browser_target::new_window(
                &before,
                matches.iter().map(|window| window.id.to_string()).collect(),
            )? {
                let mut window = matches
                    .into_iter()
                    .find(|window| window.id.to_string() == id)
                    .ok_or("The new browser window disappeared.")?;
                browser.command(
                    json!({ "op": "bind", "windowId": id }),
                    Duration::from_secs(3),
                )?;
                browser.window_id = Some(id);
                browser.command(
                    json!({ "op": "navigate", "url": url.as_str() }),
                    Duration::from_secs(15),
                )?;
                window.label = format!("UX Walk · {}", url.host_str().unwrap_or("Chrome"));
                browsers()
                    .lock()
                    .map_err(|_| "Browser ownership is unavailable.")?
                    .push(browser);
                return Ok(window);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err("The browser opened, but its window could not be selected. Choose Window in the recorder and check Screen Recording permission.".into())
    }

    fn unavailable(journal: &crate::ux_walk_journal::Journal, reason: &str) {
        let file = journal.request.directory.join("browser-evidence.json");
        let mut value = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .unwrap_or_else(|| json!({ "schemaVersion": 1 }));
        value["state"] = json!(if value.get("captureId").is_some() {
            "failed"
        } else {
            "unavailable"
        });
        value["reason"] = json!(reason);
        let temporary = file.with_extension("json.tmp");
        use std::os::unix::fs::OpenOptionsExt;
        let result = (|| -> Result<(), String> {
            let mut output = std::fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .mode(0o600)
                .open(&temporary)
                .map_err(|error| error.to_string())?;
            output
                .write_all(&serde_json::to_vec_pretty(&value).map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())?;
            output.sync_all().map_err(|error| error.to_string())?;
            std::fs::rename(temporary, file).map_err(|error| error.to_string())
        })();
        if let Err(error) = result {
            tracing::warn!(%error, "could not save browser coverage status");
        }
    }

    pub fn begin(
        journal: &crate::ux_walk_journal::Journal,
        window_id: Option<String>,
    ) -> Result<(), String> {
        let mut browsers = browsers()
            .lock()
            .map_err(|_| "Browser ownership is unavailable.")?;
        let Some(browser) = browsers
            .iter_mut()
            .find(|browser| browser.window_id == window_id && window_id.is_some())
        else {
            unavailable(
                journal,
                "The selected source is not the browser window opened for this walk",
            );
            return Ok(());
        };
        match browser.command(
            json!({ "op": "start", "file": journal.file(), "windowId": window_id }),
            Duration::from_secs(3),
        ) {
            Ok(()) => {
                browser.journal = Some(journal.file());
                Ok(())
            }
            Err(error) => {
                drop(browser.input.take());
                unavailable(journal, &error);
                Err(error)
            }
        }
    }

    pub fn clock(journal: &crate::ux_walk_journal::Journal, offset_ms: u64, paused: bool) {
        let Ok(mut browsers) = browsers().lock() else {
            return;
        };
        let Some(browser) = browsers
            .iter_mut()
            .find(|browser| browser.journal.as_ref() == Some(&journal.file()))
        else {
            return;
        };
        let wall_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        if let Err(error) = browser.command(json!({ "op": "clock", "file": journal.file(), "wallMs": wall_ms, "offsetMs": offset_ms, "paused": paused }), Duration::from_secs(2)) {
            drop(browser.input.take());
            unavailable(journal, &error);
        }
    }

    pub fn finish(journal: &crate::ux_walk_journal::Journal, aborted: bool) {
        let Ok(mut browsers) = browsers().lock() else {
            return;
        };
        let Some(browser) = browsers
            .iter_mut()
            .find(|browser| browser.journal.as_ref() == Some(&journal.file()))
        else {
            return;
        };
        let operation = if aborted { "abort" } else { "stop" };
        if let Err(error) = browser.command(
            json!({ "op": operation, "file": journal.file() }),
            Duration::from_secs(10),
        ) {
            drop(browser.input.take());
            unavailable(journal, &error);
        }
        browser.journal = None;
    }

    pub fn interrupt(journal: &crate::ux_walk_journal::Journal, reason: &str) {
        finish(journal, true);
        unavailable(journal, reason);
    }

    pub fn health(journal: &crate::ux_walk_journal::Journal) -> Option<String> {
        if let Ok(mut browsers) = browsers().lock()
            && let Some(browser) = browsers
                .iter_mut()
                .find(|browser| browser.journal.as_ref() == Some(&journal.file()))
            && browser
                .child
                .as_mut()
                .is_none_or(|child| child.try_wait().ok().flatten().is_some())
        {
            unavailable(
                journal,
                "The walk browser collector exited during recording; browser evidence is partial",
            );
            browser.journal = None;
        }
        let metadata = std::fs::read(journal.request.directory.join("browser-evidence.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())?;
        (metadata["state"] == "failed").then(|| {
            metadata["reason"]
                .as_str()
                .unwrap_or("Browser evidence is partial")
                .to_string()
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn exited_collector_marks_partial_without_touching_media_or_notes() {
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let directory = std::env::temp_dir().join(format!(
                "cap-ux-browser-health-{}-{unique}",
                std::process::id()
            ));
            let mut journal = crate::ux_walk_journal::Journal::begin(
                crate::ux_walk_journal::Request {
                    directory: directory.clone(),
                    topic: "Health contract".into(),
                    url: "https://example.com".into(),
                    speakers: Vec::new(),
                },
                directory.with_extension("cap"),
                100000,
            )
            .unwrap();
            journal.add("note", "Preserve this finding", 10).unwrap();
            std::fs::create_dir(&journal.source_project).unwrap();
            let media = journal.source_project.join("source.mp4");
            std::fs::write(&media, b"synthetic media bytes").unwrap();
            let before = std::fs::read(journal.file()).unwrap();
            std::fs::write(
                directory.join("browser-evidence.json"),
                br#"{"schemaVersion":1,"captureId":"test","state":"recording"}"#,
            )
            .unwrap();
            let mut child = Command::new("/usr/bin/true").spawn().unwrap();
            child.wait().unwrap();
            let (_send, replies) = mpsc::channel();
            browsers().lock().unwrap().push(Browser {
                capture_id: "test".into(),
                window_id: Some("17".into()),
                journal: Some(journal.file()),
                child: Some(child),
                input: None,
                replies,
            });
            assert!(
                health(&journal)
                    .unwrap()
                    .contains("exited during recording")
            );
            let metadata: Value = serde_json::from_slice(
                &std::fs::read(directory.join("browser-evidence.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(metadata["state"], "failed");
            assert_eq!(std::fs::read(journal.file()).unwrap(), before);
            assert_eq!(std::fs::read(media).unwrap(), b"synthetic media bytes");
            browsers()
                .lock()
                .unwrap()
                .retain(|browser| browser.capture_id != "test");
            std::fs::remove_dir_all(directory).unwrap();
            std::fs::remove_dir_all(journal.source_project).unwrap();
        }
    }
}

#[cfg(target_os = "macos")]
pub use owned::{begin, clock, finish, health, interrupt, open};

#[cfg(not(target_os = "macos"))]
pub fn open() -> Result<crate::devices::WindowOption, String> {
    Err("Automatic browser windows are available on macOS.".into())
}

#[cfg(not(target_os = "macos"))]
pub fn begin(
    _journal: &crate::ux_walk_journal::Journal,
    _window_id: Option<String>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn clock(_journal: &crate::ux_walk_journal::Journal, _offset_ms: u64, _paused: bool) {}

#[cfg(not(target_os = "macos"))]
pub fn finish(_journal: &crate::ux_walk_journal::Journal, _aborted: bool) {}

#[cfg(not(target_os = "macos"))]
pub fn interrupt(_journal: &crate::ux_walk_journal::Journal, _reason: &str) {}

#[cfg(not(target_os = "macos"))]
pub fn health(_journal: &crate::ux_walk_journal::Journal) -> Option<String> {
    None
}
