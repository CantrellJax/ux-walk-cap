#[path = "../src/ux_walk_browser_target.rs"]
mod browser_target;
use browser_target::new_window;

#[test]
fn selection_uses_only_the_single_new_browser_window() {
    let before = vec!["personal-window".to_string(), "work-window".to_string()];
    assert_eq!(new_window(&before, before.clone()).unwrap(), None);
    assert_eq!(new_window(&before, vec!["personal-window".into(), "fresh-walk".into(), "work-window".into()]).unwrap(), Some("fresh-walk".into()));
    assert!(new_window(&before, vec!["fresh-walk".into(), "another-new-window".into()]).is_err());
    assert_eq!(new_window(&before, vec!["fresh-walk".into(), "fresh-walk".into()]).unwrap(), Some("fresh-walk".into()));
}
