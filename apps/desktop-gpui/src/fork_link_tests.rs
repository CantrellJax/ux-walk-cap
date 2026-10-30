use std::path::{Path, PathBuf};

use fork_brand::upstream_service_host;

const WRAPPED: &str = "fork_policy::link(";

// Upstream links left in place because a fork hook keeps them from being
// reached; each names the hook that has to stay for that to hold.
const UNREACHABLE: &[(&str, &str, (&str, &str))] = &[
    (
        "menus.rs",
        "https://cap.so/dashboard",
        ("menus.rs", "fork::register_help_links(cx);"),
    ),
    (
        "menus.rs",
        "https://cap.so/docs",
        ("menus.rs", "fork::register_help_links(cx);"),
    ),
    (
        "menus.rs",
        "https://cap.so/faq",
        ("menus.rs", "fork::register_help_links(cx);"),
    ),
    (
        "menus.rs",
        "https://cap.so/self-hosting",
        ("menus.rs", "fork::register_help_links(cx);"),
    ),
    (
        "menus.rs",
        "https://help.cap.so/",
        ("menus.rs", "fork::register_help_links(cx);"),
    ),
    (
        "menus.rs",
        "https://cap.openstatus.dev/",
        ("menus.rs", "fork::register_help_links(cx);"),
    ),
    (
        "menus.rs",
        "https://cap.link/discord",
        ("menus.rs", "fork::register_help_links(cx);"),
    ),
    (
        "settings_pages.rs",
        "https://cap.link/discord",
        ("settings_pages.rs", "return self.render_fork_feedback();"),
    ),
    (
        "settings_pages.rs",
        "https://cap.so/docs/s3-config",
        (
            "settings_pages.rs",
            "return self.render_owned_integrations(cx);",
        ),
    ),
    (
        "settings_pages.rs",
        "https://l.cap.so/api",
        (
            "entitlement.rs",
            "assert!(!Page::ALL.contains(&Page::License));",
        ),
    ),
    (
        "settings_window/fork.rs",
        "https://cap.so/download/versions",
        ("settings_window/fork.rs", "fork_brand::RELEASES_URL"),
    ),
    (
        "store.rs",
        "\"https://cap.so\"",
        ("store.rs", "fork_brand::DEFAULT_SERVER_URL"),
    ),
];

fn src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("read src") {
        let path = entry.expect("src entry").path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs")
            && !path.to_string_lossy().ends_with("_tests.rs")
        {
            out.push(path);
        }
    }
}

fn shipped(source: &str) -> Vec<(usize, &str)> {
    let lines: Vec<&str> = source.lines().collect();
    let end = lines
        .windows(2)
        .position(|pair| {
            let attribute = pair[0].trim_start();
            (attribute.starts_with("#[cfg(test)]") || attribute.starts_with("#[cfg(all(test"))
                && pair[1].trim_start().starts_with("mod ")
        })
        .unwrap_or(lines.len());
    lines[..end]
        .iter()
        .enumerate()
        .filter(|(_, line)| !line.trim_start().starts_with("//"))
        .map(|(index, line)| (index + 1, *line))
        .collect()
}

fn read(relative: &str) -> String {
    std::fs::read_to_string(src().join(relative)).unwrap_or_else(|_| panic!("read {relative}"))
}

#[test]
fn no_upstream_service_link_is_reachable_in_a_fork_build() {
    let mut files = Vec::new();
    sources(&src(), &mut files);
    let mut unexplained = Vec::new();
    let mut used = vec![false; UNREACHABLE.len()];
    for path in files {
        let relative = path
            .strip_prefix(src())
            .expect("under src")
            .to_string_lossy()
            .replace('\\', "/");
        let source = std::fs::read_to_string(&path).expect("read source");
        let lines = shipped(&source);
        for (position, (number, line)) in lines.iter().enumerate() {
            let Some(host) = upstream_service_host(line) else {
                continue;
            };
            let wrapped = lines[position.saturating_sub(2)..=position]
                .iter()
                .any(|(_, line)| line.contains(WRAPPED));
            let listed = UNREACHABLE
                .iter()
                .position(|(file, url, _)| *file == relative && line.contains(url));
            match (wrapped, listed) {
                (true, _) => {}
                (false, Some(index)) => used[index] = true,
                (false, None) => unexplained.push(format!("{relative}:{number}: {host}")),
            }
        }
    }
    assert!(
        unexplained.is_empty(),
        "upstream service links reachable in a fork build; route them through fork_brand:\n{}",
        unexplained.join("\n")
    );
    for ((file, url, _), used) in UNREACHABLE.iter().zip(used) {
        assert!(used, "{file} no longer has {url}; drop it from UNREACHABLE");
    }
}

#[test]
fn hooks_that_hide_upstream_links_are_still_in_place() {
    for (file, url, (guard_file, guard)) in UNREACHABLE {
        assert!(
            read(guard_file).contains(guard),
            "{file} reaches {url} unless {guard_file} keeps `{guard}`"
        );
    }
}

#[test]
fn compiled_catalogs_name_no_upstream_service() {
    let catalogs = include_str!(concat!(env!("OUT_DIR"), "/i18n.rs"));
    let leaks: Vec<&str> = catalogs
        .lines()
        .filter(|line| upstream_service_host(line).is_some())
        .collect();
    assert!(leaks.is_empty(), "{}", leaks.join("\n"));
}

#[test]
fn rewired_links_resolve_to_fork_destinations() {
    for url in [crate::auth::PRICING_URL, fork_brand::FEEDBACK_URL] {
        assert_eq!(upstream_service_host(url), None, "{url}");
    }
}
