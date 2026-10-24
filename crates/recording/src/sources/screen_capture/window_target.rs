pub fn resolve(
    requested: Option<&str>,
    available: &[u32],
    excluded: &[u32],
) -> Result<Option<u32>, &'static str> {
    let Some(requested) = requested else {
        return Ok(None);
    };
    let id = requested.parse().map_err(|_| "Invalid capture window ID")?;
    if excluded.contains(&id) {
        return Err("The selected window is excluded from capture");
    }
    if !available.contains(&id) {
        return Err("The selected capture window is no longer available");
    }
    Ok(Some(id))
}
