use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::PublicKey;
use url::{Host, Url};

pub fn require_secure_transport(url: &Url, allow_local: bool) -> Result<(), String> {
    let loopback = match url.host() {
        Some(Host::Domain("localhost")) => true,
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        _ => false,
    };
    if url.scheme() == "https" || (allow_local && url.scheme() == "http" && loopback) {
        Ok(())
    } else {
        Err(if allow_local {
            "Use HTTPS for remote backends; HTTP is allowed only on localhost or loopback addresses."
        } else {
            "Release backends require HTTPS, including localhost."
        }.into())
    }
}

pub fn backend_origin(raw: &str, allow_local: bool) -> Result<String, String> {
    let url = Url::parse(raw.trim()).map_err(|_| "The backend must be an absolute HTTP(S) origin.".to_string())?;
    require_secure_transport(&url, allow_local)?;
    if url.host().is_none() || !url.username().is_empty() || url.password().is_some()
        || url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err("The backend origin must not contain credentials, a path, query, or fragment.".into());
    }
    Ok(url.origin().ascii_serialization())
}

pub fn decode_signing_text(value: &str) -> Result<String, String> {
    String::from_utf8(STANDARD.decode(value.trim()).map_err(|error| format!("Invalid signing data: {error}"))?)
        .map_err(|error| format!("Invalid signing data: {error}"))
}

pub fn updater_public_key(value: &str) -> Result<PublicKey, String> {
    PublicKey::decode(&decode_signing_text(value)?).map_err(|error| format!("Invalid updater public key: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_valid_origins_and_rejects_credentials_or_extra_url_parts() {
        assert_eq!(backend_origin(" https://Drop.Example:443/ ", false).unwrap(), "https://drop.example");
        for invalid in ["https://", "https://user:secret@drop.example", "https://drop.example/api", "https://drop.example/?q=1", "https://drop.example/#room"] {
            assert!(backend_origin(invalid, false).is_err(), "{invalid}");
        }
    }

    #[test]
    fn permits_plaintext_only_for_explicit_local_development() {
        for local in ["http://localhost:3000", "http://127.0.0.1:3000", "http://127.0.0.2:3000", "http://[::1]:3000"] {
            assert!(backend_origin(local, true).is_ok(), "{local}");
            assert!(backend_origin(local, false).is_err(), "{local}");
        }
        for remote in ["http://example.com", "http://192.168.1.2", "http://localhost.example.com"] {
            assert!(backend_origin(remote, true).is_err(), "{remote}");
        }
    }

    #[test]
    fn rejects_malformed_public_keys_before_they_can_ship() {
        let public = STANDARD.encode("untrusted comment: test\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3");
        assert!(updater_public_key(&public).is_ok());
        for invalid in ["", "not base64", "aW52YWxpZCBtaW5pc2lnIGtleQ=="] {
            assert!(updater_public_key(invalid).is_err());
        }
    }
}
