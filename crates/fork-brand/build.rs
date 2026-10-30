use serde_json::Value;

const STRINGS: [(&str, &str); 16] = [
    ("display_name", "FORK_BRAND_APP_NAME"),
    ("upstream_name", "FORK_BRAND_UPSTREAM_NAME"),
    ("slug", "FORK_BRAND_SLUG"),
    ("bundle_id", "FORK_BRAND_BUNDLE_ID"),
    ("url_scheme", "FORK_BRAND_URL_SCHEME"),
    ("repo_url", "FORK_BRAND_REPO_URL"),
    ("releases_url", "FORK_BRAND_RELEASES_URL"),
    ("issues_url", "FORK_BRAND_ISSUES_URL"),
    ("changes_url", "FORK_BRAND_CHANGES_URL"),
    ("help_url", "FORK_BRAND_HELP_URL"),
    ("docs_url", "FORK_BRAND_DOCS_URL"),
    ("feedback_url", "FORK_BRAND_FEEDBACK_URL"),
    ("status_url", "FORK_BRAND_STATUS_URL"),
    ("community_url", "FORK_BRAND_COMMUNITY_URL"),
    ("default_server_url", "FORK_BRAND_DEFAULT_SERVER_URL"),
    ("long_description", "FORK_BRAND_LONG_DESCRIPTION"),
];

fn main() {
    println!("cargo:rerun-if-changed=brand.json");
    let text = std::fs::read_to_string("brand.json").expect("fork-brand: cannot read brand.json");
    let brand: Value = serde_json::from_str(&text).expect("fork-brand: brand.json is not JSON");
    for (field, env) in STRINGS {
        let value = brand
            .get(field)
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("fork-brand: brand.json needs a string `{field}`"));
        assert!(
            !value.contains(['\n', '\r']),
            "fork-brand: `{field}` must be one line"
        );
        println!("cargo:rustc-env={env}={value}");
    }
}
