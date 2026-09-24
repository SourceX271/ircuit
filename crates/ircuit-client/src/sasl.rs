//! SASL authentication: the `PLAIN` and `EXTERNAL` mechanisms.
//!
//! Both are single-round: the client sends one payload and the server answers
//! with a numeric. The interesting part is not the mechanism but the framing —
//! `AUTHENTICATE` payloads are capped at 400 bytes and must be padded with a
//! final `+` when the payload length is an exact multiple of that cap.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;

use crate::config::SaslConfig;

/// Maximum bytes of base64 payload per `AUTHENTICATE` line.
pub const MAX_CHUNK_BYTES: usize = 400;

/// The `AUTHENTICATE` payload for a mechanism, base64-encoded.
///
/// Returns an empty string when the mechanism has nothing to send, which the
/// caller must express as a bare `+`.
#[must_use]
pub fn initial_payload(config: &SaslConfig) -> String {
    match config {
        // The PLAIN message is `authzid NUL authcid NUL passwd`; we leave the
        // authorisation identity empty and authenticate as the account.
        SaslConfig::Plain { account, password } => {
            BASE64.encode(format!("\0{account}\0{password}"))
        }
        // EXTERNAL sends the authorisation identity, which is usually empty
        // because the certificate already carries it.
        SaslConfig::External { authzid } => BASE64.encode(authzid.as_deref().unwrap_or_default()),
    }
}

/// Split a base64 payload into `AUTHENTICATE` chunks.
///
/// The protocol requires that a payload whose length is an exact multiple of
/// [`MAX_CHUNK_BYTES`] be followed by an empty chunk, otherwise the server keeps
/// waiting for more data.
#[must_use]
pub fn encode_chunks(payload: &str) -> Vec<String> {
    if payload.is_empty() {
        return vec!["+".to_owned()];
    }

    let mut chunks: Vec<String> = payload
        .as_bytes()
        .chunks(MAX_CHUNK_BYTES)
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .collect();

    if payload.len() % MAX_CHUNK_BYTES == 0 {
        chunks.push("+".to_owned());
    }

    chunks
}

/// Decode a challenge received from the server.
///
/// A bare `+` means "empty challenge", not invalid base64.
pub fn decode_challenge(payload: &str) -> Result<Vec<u8>, base64::DecodeError> {
    if payload == "+" || payload.is_empty() {
        return Ok(Vec::new());
    }

    BASE64.decode(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain() -> SaslConfig {
        SaslConfig::Plain {
            account: "alice".to_owned(),
            password: "hunter2".to_owned(),
        }
    }

    #[test]
    fn plain_encodes_the_nul_separated_triple() {
        let payload = initial_payload(&plain());
        let decoded = BASE64.decode(&payload).unwrap();

        assert_eq!(decoded, b"\0alice\0hunter2");
    }

    #[test]
    fn external_without_authzid_is_empty() {
        let payload = initial_payload(&SaslConfig::External { authzid: None });
        assert!(payload.is_empty());
        // An empty payload must still produce exactly one line.
        assert_eq!(encode_chunks(&payload), vec!["+"]);
    }

    #[test]
    fn external_with_authzid_encodes_it() {
        let payload = initial_payload(&SaslConfig::External {
            authzid: Some("alice".to_owned()),
        });
        assert_eq!(BASE64.decode(&payload).unwrap(), b"alice");
    }

    #[test]
    fn short_payload_is_a_single_chunk() {
        assert_eq!(encode_chunks("abc"), vec!["abc"]);
    }

    #[test]
    fn payload_exactly_at_the_cap_gets_an_empty_final_chunk() {
        let payload = "a".repeat(MAX_CHUNK_BYTES);
        let chunks = encode_chunks(&payload);

        assert_eq!(chunks.len(), 2, "a payload at the cap needs a trailing '+'");
        assert_eq!(chunks[0].len(), MAX_CHUNK_BYTES);
        assert_eq!(chunks[1], "+");
    }

    #[test]
    fn payload_one_over_the_cap_splits_without_a_trailing_chunk() {
        let payload = "a".repeat(MAX_CHUNK_BYTES + 1);
        let chunks = encode_chunks(&payload);

        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].len(), MAX_CHUNK_BYTES);
        assert_eq!(chunks[1], "a");
    }

    #[test]
    fn double_the_cap_also_gets_a_trailing_chunk() {
        let payload = "b".repeat(MAX_CHUNK_BYTES * 2);
        assert_eq!(encode_chunks(&payload).len(), 3);
    }

    #[test]
    fn chunks_reassemble_into_the_original_payload() {
        let payload = BASE64.encode(vec![0xABu8; 900]);
        let chunks = encode_chunks(&payload);

        let rejoined: String = chunks
            .iter()
            .filter(|chunk| chunk.as_str() != "+")
            .cloned()
            .collect();

        assert_eq!(rejoined, payload);
    }

    #[test]
    fn challenge_decoding_handles_the_empty_marker() {
        assert_eq!(decode_challenge("+").unwrap(), Vec::<u8>::new());
        assert_eq!(decode_challenge("").unwrap(), Vec::<u8>::new());
        assert_eq!(decode_challenge("YWJj").unwrap(), b"abc");
        assert!(decode_challenge("not base64!").is_err());
    }

    #[test]
    fn mechanism_names_match_the_wire() {
        assert_eq!(plain().mechanism(), "PLAIN");
        assert_eq!(
            SaslConfig::External { authzid: None }.mechanism(),
            "EXTERNAL"
        );
    }
}
