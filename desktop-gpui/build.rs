fn main() {
    println!("cargo:rerun-if-env-changed=QUICKDROP_PUBLIC_BASE_URL");
    println!("cargo:rerun-if-env-changed=QUICKDROP_UPDATER_PUBLIC_KEY");
    let release = std::env::var("PROFILE").is_ok_and(|profile| profile == "release");
    let base = std::env::var("QUICKDROP_PUBLIC_BASE_URL").unwrap_or_else(|_| "http://127.0.0.1:3000".into());
    let key = std::env::var("QUICKDROP_UPDATER_PUBLIC_KEY").unwrap_or_default();
    if release {
        assert!(base.starts_with("https://"), "Release builds require QUICKDROP_PUBLIC_BASE_URL using HTTPS");
        assert!(!key.trim().is_empty(), "Release builds require the persistent QUICKDROP_UPDATER_PUBLIC_KEY");
    }
    assert!(!base.contains(['\r', '\n']), "Invalid build origin");
    assert!(!key.contains(['\r', '\n']), "Updater public key must be base64-encoded on one line");
    println!("cargo:rustc-env=QUICKDROP_BUILD_BASE_URL={}", base.trim().trim_end_matches('/'));
    println!("cargo:rustc-env=QUICKDROP_UPDATER_PUBLIC_KEY={}", key.trim());
}
