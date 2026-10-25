use std::collections::BTreeSet;

pub fn new_window(before: &[String], after: Vec<String>) -> Result<Option<String>, String> {
    let new: BTreeSet<_> = after
        .into_iter()
        .filter(|id| !before.contains(id))
        .collect();
    match new.len() {
        0 => Ok(None),
        1 => Ok(new.into_iter().next()),
        _ => Err("More than one walk window appeared. Choose the window in the recorder.".into()),
    }
}
