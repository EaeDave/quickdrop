#[path = "src/config.rs"]
mod config;

fn main() {
    println!("cargo:rerun-if-env-changed=QUICKDROP_PUBLIC_BASE_URL");
    println!("cargo:rerun-if-env-changed=QUICKDROP_UPDATER_PUBLIC_KEY");
    let release = std::env::var("PROFILE").is_ok_and(|profile| profile == "release");
    let raw_base = std::env::var("QUICKDROP_PUBLIC_BASE_URL").unwrap_or_default();
    let raw_base = if raw_base.trim().is_empty() { "http://127.0.0.1:3000" } else { raw_base.trim() };
    let base = config::backend_origin(raw_base, !release).expect("Invalid QUICKDROP_PUBLIC_BASE_URL");
    let key = std::env::var("QUICKDROP_UPDATER_PUBLIC_KEY").unwrap_or_default();
    let key = key.trim();
    assert!(!key.contains(['\r', '\n']), "Updater public key must be base64-encoded on one line");
    if release { assert!(!key.is_empty(), "Release builds require the persistent QUICKDROP_UPDATER_PUBLIC_KEY"); }
    if !key.is_empty() { config::updater_public_key(key).expect("Invalid QUICKDROP_UPDATER_PUBLIC_KEY"); }
    println!("cargo:rustc-env=QUICKDROP_BUILD_BASE_URL={base}");
    println!("cargo:rustc-env=QUICKDROP_UPDATER_PUBLIC_KEY={key}");
}
