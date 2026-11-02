#![cfg(feature = "ux-walk")]

#[test]
fn fork_refuses_official_installer() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_cap"))
        .args(["update", "--json"])
        .output()
        .expect("run cap update");
    assert!(!output.status.success());
    let printed = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(printed.contains(fork_brand::RELEASES_URL), "{printed}");
}
