#[path = "../src/sources/screen_capture/window_target.rs"]
mod window_target;

#[test]
fn a_window_selection_never_falls_back_to_display_capture() {
    assert_eq!(
        window_target::resolve(Some("42"), &[17, 42, 99], &[]),
        Ok(Some(42))
    );
    assert!(window_target::resolve(Some("42"), &[17, 99], &[]).is_err());
    assert!(window_target::resolve(Some("invalid"), &[17, 99], &[]).is_err());
    assert!(window_target::resolve(Some("42"), &[42], &[42]).is_err());
    assert_eq!(window_target::resolve(None, &[17, 42], &[42]), Ok(None));
}
