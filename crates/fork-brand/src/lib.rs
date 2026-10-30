use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, PoisonError};

pub const APP_NAME: &str = env!("FORK_BRAND_APP_NAME");
pub const UPSTREAM_NAME: &str = env!("FORK_BRAND_UPSTREAM_NAME");
pub const SLUG: &str = env!("FORK_BRAND_SLUG");
pub const BUNDLE_ID: &str = env!("FORK_BRAND_BUNDLE_ID");
pub const CLI_KEYRING_SERVICE: &str = concat!(env!("FORK_BRAND_BUNDLE_ID"), ".cli");
pub const DEV_BUNDLE_ID: &str = concat!(env!("FORK_BRAND_BUNDLE_ID"), ".dev");
pub const URL_SCHEME: &str = env!("FORK_BRAND_URL_SCHEME");
pub const REPO_URL: &str = env!("FORK_BRAND_REPO_URL");
pub const RELEASES_URL: &str = env!("FORK_BRAND_RELEASES_URL");
pub const ISSUES_URL: &str = env!("FORK_BRAND_ISSUES_URL");
pub const CHANGES_URL: &str = env!("FORK_BRAND_CHANGES_URL");
pub const DEFAULT_SERVER_URL: &str = env!("FORK_BRAND_DEFAULT_SERVER_URL");
pub const LONG_DESCRIPTION: &str = env!("FORK_BRAND_LONG_DESCRIPTION");

/// Catalog keys whose "Cap" names upstream's product, service or `.cap`
/// file format rather than this app, so the build-time catalog pass leaves
/// them alone.
pub const KEEP_UPSTREAM_NAME: &[&str] = &[
    "editor.clips.cap_filter",
    "editor.clips.error.not_a_project",
    "editor.clips.error.source_empty",
    "editor.clips.error.source_failed",
    "editor.clips.error.source_recording",
    "editor.clips.error.source_unimportable",
    "editor.export.done.uploaded",
    "editor.panel.text_preset.sample.title",
    "settings.license.description",
];

/// Swaps each standalone [`UPSTREAM_NAME`] for [`APP_NAME`]. Words that only
/// start with it ("Caps", "Capture"), domains ("Cap.so") and text that
/// already carries [`APP_NAME`] are left as they are.
pub fn text(text: &str) -> String {
    if APP_NAME == UPSTREAM_NAME || UPSTREAM_NAME.is_empty() {
        return text.to_string();
    }
    let suffix = APP_NAME
        .strip_prefix(UPSTREAM_NAME)
        .filter(|s| !s.is_empty());
    let mut out = String::with_capacity(text.len() + APP_NAME.len());
    let mut rest = text;
    while let Some(index) = rest.find(UPSTREAM_NAME) {
        let (head, tail) = rest.split_at(index);
        let after = &tail[UPSTREAM_NAME.len()..];
        let mut next = after.chars();
        let joined_before = head
            .chars()
            .next_back()
            .is_some_and(|c| c.is_ascii_alphanumeric());
        let joined_after = match next.next() {
            Some(c) if c.is_ascii_alphanumeric() => true,
            Some('.') => next.next().is_some_and(|c| c.is_ascii_alphanumeric()),
            _ => false,
        };
        let branded = suffix.is_some_and(|suffix| after.starts_with(suffix));
        out.push_str(head);
        out.push_str(if joined_before || joined_after || branded {
            UPSTREAM_NAME
        } else {
            APP_NAME
        });
        rest = after;
    }
    out.push_str(rest);
    out
}

/// [`text`] for `&'static str`; each distinct input is rebranded once and
/// kept for the life of the process.
pub fn text_static(source: &'static str) -> &'static str {
    static CACHE: LazyLock<Mutex<HashMap<&'static str, &'static str>>> =
        LazyLock::new(Default::default);
    if !source.contains(UPSTREAM_NAME) {
        return source;
    }
    let mut cache = CACHE.lock().unwrap_or_else(PoisonError::into_inner);
    cache
        .entry(source)
        .or_insert_with(|| Box::leak(text(source).into_boxed_str()))
}

pub fn update_refusal() -> String {
    format!(
        "This {APP_NAME} build uses releases from {RELEASES_URL}; official {UPSTREAM_NAME} updates would replace it."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn brand(source: &str) -> String {
        source.replace("{app}", APP_NAME)
    }

    #[test]
    fn standalone_names_are_branded() {
        assert_eq!(text("About Cap"), brand("About {app}"));
        assert_eq!(text("Cap v0.1.0"), brand("{app} v0.1.0"));
        assert_eq!(text("Cap's cloud"), brand("{app}'s cloud"));
        assert_eq!(text("Quit Cap."), brand("Quit {app}."));
        assert_eq!(text("CapはCaps"), brand("{app}はCaps"));
    }

    #[test]
    fn words_domains_and_branded_text_are_kept() {
        for kept in ["Caps", "Capture", "MyCap", "Cap.so/download", "recap"] {
            assert_eq!(text(kept), kept);
        }
        assert_eq!(text(APP_NAME), APP_NAME);
        assert_eq!(text(&text("Hide Cap")), text("Hide Cap"));
    }

    #[test]
    fn static_text_is_cached() {
        let first = text_static("Quit Cap");
        assert_eq!(first, text("Quit Cap"));
        assert!(std::ptr::eq(first, text_static("Quit Cap")));
        assert!(std::ptr::eq(text_static("Settings"), "Settings"));
    }

    #[test]
    fn update_refusal_points_at_fork_releases() {
        assert!(update_refusal().contains(RELEASES_URL));
        assert!(update_refusal().contains(APP_NAME));
    }

    #[test]
    fn derived_ids_follow_the_bundle_id() {
        assert_eq!(CLI_KEYRING_SERVICE, format!("{BUNDLE_ID}.cli"));
        assert_eq!(DEV_BUNDLE_ID, format!("{BUNDLE_ID}.dev"));
    }
}
