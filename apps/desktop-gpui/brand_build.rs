use std::path::PathBuf;

use toml::{Table, Value};

const OVERLAY: &str = "locales-fork/en.toml";
const UPSTREAM_TOKEN: &str = "%upstream%";
const RELEASES_TOKEN: &str = "%releases%";

pub fn i18n(locales: &str) {
    let manifest_dir =
        PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let out_dir = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    let locales = manifest_dir.join(locales);
    let overlay_path = manifest_dir.join(OVERLAY);
    println!("cargo:rerun-if-changed={}", locales.display());
    println!("cargo:rerun-if-changed={}", overlay_path.display());
    println!("cargo:rerun-if-env-changed={}", cap_i18n_build::STRICT_ENV);
    let strict = std::env::var(cap_i18n_build::STRICT_ENV).is_ok_and(|value| value == "1");
    let pseudo = std::env::var_os("CARGO_CFG_DEBUG_ASSERTIONS").is_some();

    let fork = std::env::var_os("CARGO_FEATURE_UX_WALK").is_some();
    let overlay = fork.then(|| {
        let text = std::fs::read_to_string(&overlay_path)
            .unwrap_or_else(|error| panic!("cannot read {}: {error}", overlay_path.display()));
        text.parse::<Table>()
            .unwrap_or_else(|error| panic!("{}: {error}", overlay_path.display()))
    });

    let catalogs: Vec<(String, String)> = cap_i18n_build::read_catalogs(&locales)
        .unwrap_or_else(|errors| fail(&errors))
        .into_iter()
        .map(|(code, text)| {
            let mut table = text
                .parse::<Table>()
                .unwrap_or_else(|error| panic!("{code}.toml: {error}"));
            if let Some(overlay) = &overlay {
                apply_overlay(&mut table, overlay, code == "en", "");
            }
            if fork {
                brand_table(&mut table, "");
                refuse_upstream_services(&table, &code, "");
            }
            let text = toml::to_string(&table)
                .unwrap_or_else(|error| panic!("{code}.toml: cannot rewrite: {error}"));
            (code, text)
        })
        .collect();
    let borrowed: Vec<(&str, &str)> = catalogs
        .iter()
        .map(|(code, text)| (code.as_str(), text.as_str()))
        .collect();
    let output = cap_i18n_build::generate_with(&borrowed, strict, pseudo)
        .unwrap_or_else(|errors| fail(&errors));
    for warning in &output.warnings {
        for line in warning.lines() {
            println!("cargo:warning={line}");
        }
    }
    let path = out_dir.join("i18n.rs");
    if let Err(error) = std::fs::write(&path, output.code) {
        panic!("cannot write {}: {error}", path.display());
    }
}

fn fail(errors: &[String]) -> ! {
    panic!(
        "{} problem(s) in the locale catalogs:\n{}",
        errors.len(),
        errors.join("\n")
    )
}

fn join(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}.{name}")
    }
}

// Fork wording replaces every locale with the same English, which is what
// the old per-call-site override did; writing it into each catalog keeps
// CAP_I18N_STRICT from reporting the keys as untranslated.
fn apply_overlay(table: &mut Table, overlay: &Table, english: bool, prefix: &str) {
    for (name, value) in overlay {
        let key = join(prefix, name);
        match value {
            Value::Table(inner) => {
                let Some(Value::Table(target)) = table.get_mut(name) else {
                    panic!("{OVERLAY}: `{key}` is not a group in the catalogs");
                };
                apply_overlay(target, inner, english, &key);
            }
            Value::String(text) => match table.get_mut(name) {
                Some(Value::Table(message)) if english && message.contains_key("text") => {
                    message.insert("text".into(), Value::String(text.clone()));
                }
                Some(Value::Table(_)) if english => {
                    panic!("{OVERLAY}: `{key}` is a plural message")
                }
                None if english => panic!("{OVERLAY}: `{key}` is not in en.toml"),
                _ => {
                    table.insert(name.clone(), Value::String(text.clone()));
                }
            },
            _ => panic!("{OVERLAY}: `{key}` must be a string"),
        }
    }
}

fn kept(key: &str) -> bool {
    fork_brand::KEEP_UPSTREAM_NAME.iter().any(|kept| {
        key.strip_prefix(kept)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('.'))
    })
}

fn refuse_upstream_services(table: &Table, code: &str, prefix: &str) {
    for (name, value) in table {
        let key = join(prefix, name);
        match value {
            Value::String(text) => {
                if let Some(host) = fork_brand::upstream_service_host(text) {
                    panic!("{code}.toml: `{key}` sends people to {host}; override it in {OVERLAY}")
                }
            }
            Value::Table(inner) => refuse_upstream_services(inner, code, &key),
            _ => {}
        }
    }
}

fn brand_table(table: &mut Table, prefix: &str) {
    for (name, value) in table.iter_mut() {
        if name == "context" {
            continue;
        }
        let key = join(prefix, name);
        match value {
            Value::String(text) => {
                if !kept(&key) {
                    *text = fork_brand::text(text);
                }
                *text = text
                    .replace(UPSTREAM_TOKEN, fork_brand::UPSTREAM_NAME)
                    .replace(RELEASES_TOKEN, fork_brand::RELEASES_URL);
            }
            Value::Table(inner) => brand_table(inner, &key),
            _ => {}
        }
    }
}
