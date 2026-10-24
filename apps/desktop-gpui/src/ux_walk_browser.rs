#[cfg(target_os = "macos")]
pub fn open() -> Result<crate::devices::WindowOption, String> {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    let settings = crate::ux_walk::load()?;
    let url = reqwest::Url::parse(crate::ux_walk::text(&settings, "url"))
        .map_err(|_| "Enter a valid start page in UX Walk settings.")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Use an http or https start page.".into());
    }
    let binary = [
        std::path::PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        dirs::home_dir()
            .unwrap_or_default()
            .join("Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ]
    .into_iter()
    .find(|path| path.is_file())
    .ok_or("Install Google Chrome to open a walk window, or choose a capture source manually.")?;
    let before: Vec<String> = scap_targets::Window::list()
        .into_iter()
        .map(|window| window.id().to_string())
        .collect();
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let address = listener.local_addr().map_err(|e| e.to_string())?;
    let nonce = crate::store::new_uuid_v4();
    let marker = format!("Cap UX walk {nonce}");
    // The temporary title identifies the new window before navigation, so a
    // concurrently opened personal Chrome window can never be auto-selected.
    let html = format!(
        r#"<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="1;url=/ready/{nonce}"><title>{marker}</title><body style="font:18px system-ui;padding:48px;color:#20242c;background:#fafaf9">Opening your UX Walk…"#
    );
    let mut child = Command::new(binary)
        .arg("--new-window")
        .arg(format!("http://{address}/walk/{nonce}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not open Chrome: {e}"))?;
    let _ = std::thread::spawn(move || {
        let _ = child.wait();
    });
    let started = Instant::now();
    let mut selected = None;
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
            selected = matches
                .into_iter()
                .find(|window| window.id.to_string() == id);
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream
                    .set_read_timeout(Some(Duration::from_millis(100)))
                    .map_err(|e| e.to_string())?;
                stream
                    .set_write_timeout(Some(Duration::from_millis(100)))
                    .map_err(|e| e.to_string())?;
                let mut bytes = [0; 2048];
                let count = stream.read(&mut bytes).unwrap_or(0);
                let request = String::from_utf8_lossy(&bytes[..count]);
                let is_ready = request.starts_with(&format!("GET /ready/{nonce} "));
                let is_page = request.starts_with(&format!("GET /walk/{nonce} "));
                let redirect = is_ready && selected.is_some();
                let body = if redirect {
                    String::new()
                } else if is_page || is_ready {
                    html.clone()
                } else {
                    "Not found".into()
                };
                let status = if redirect {
                    "302 Found"
                } else if is_page || is_ready {
                    "200 OK"
                } else {
                    "404 Not Found"
                };
                let location = if redirect {
                    format!("Location: {}\r\n", url.as_str())
                } else {
                    String::new()
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\n{location}Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                );
                if stream.write_all(response.as_bytes()).is_ok()
                    && is_ready
                    && let Some(mut window) = selected.take()
                {
                    window.label = format!("UX Walk · {}", url.host_str().unwrap_or("Chrome"));
                    return Ok(window);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(50))
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("The browser opened, but its window could not be selected. Choose Window in the recorder and check Screen Recording permission.".into())
}

#[cfg(not(target_os = "macos"))]
pub fn open() -> Result<crate::devices::WindowOption, String> {
    Err("Automatic browser windows are available on macOS.".into())
}
