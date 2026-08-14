fn main() {
    println!("cargo:rerun-if-env-changed=QUICKDROP_PUBLIC_BASE_URL");
    if let Ok(value) = std::env::var("QUICKDROP_PUBLIC_BASE_URL") {
        let normalized = value.trim().trim_end_matches('/');
        let normalized = if normalized.is_empty() {
            "http://127.0.0.1:3000"
        } else {
            normalized
        };
        println!("cargo:rustc-env=QUICKDROP_PUBLIC_BASE_URL={normalized}");
    }
}
