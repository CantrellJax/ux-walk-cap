use std::path::Path;

use serde_json::{Map, Value};

fn update_file(_path: &Path, _key: &str, _value: Value) -> Result<Map<String, Value>, String> {
    Err("UX Walk preferences cannot be saved yet".into())
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf, sync::atomic::{AtomicU64, Ordering}};

    use super::*;
    use serde_json::json;

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("cap-ux-preferences-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir_all(&path).unwrap();
            Self(path.join("config.json"))
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(self.0.parent().unwrap()).unwrap();
        }
    }

    #[test]
    fn native_provider_choice_preserves_companion_preferences() {
        let fixture = Fixture::new();
        fs::write(&fixture.0, r##"{"transcriber":"elevenlabs","sourceRoot":"/work/app","contextSelectors":{"org":"#org"},"assemblyaiKeychainItem":"custom-item"}"##).unwrap();
        update_file(&fixture.0, "transcriber", json!("assemblyai")).unwrap();
        let saved: Value = serde_json::from_slice(&fs::read(&fixture.0).unwrap()).unwrap();
        assert_eq!(saved["transcriber"], "assemblyai");
        assert_eq!(saved["sourceRoot"], "/work/app");
        assert_eq!(saved["contextSelectors"], json!({"org":"#org"}));
        assert_eq!(saved["assemblyaiKeychainItem"], "custom-item");
    }

    #[test]
    fn malformed_existing_preferences_are_never_overwritten() {
        let fixture = Fixture::new();
        for original in ["{broken", "[]", "null"] {
            fs::write(&fixture.0, original).unwrap();
            assert!(update_file(&fixture.0, "me", json!("Alex")).is_err());
            assert_eq!(fs::read_to_string(&fixture.0).unwrap(), original);
        }
    }

    #[test]
    fn credentials_and_invalid_choices_are_refused_by_json_writer() {
        let fixture = Fixture::new();
        for (key, value) in [("apiKey", json!("example-secret")), ("transcriber", json!("unknown")), ("askSpeakers", json!("yes")), ("agent", json!("shell-command"))] {
            assert!(update_file(&fixture.0, key, value).is_err());
            assert!(!fixture.0.exists());
        }
    }
}
