//! Opening links in the user's browser.
//!
//! # Why this is hand-rolled and not just `Command::new("start")`
//!
//! A URL here comes from a message, and a message comes from a stranger. Two
//! consequences:
//!
//! 1. The scheme must be restricted. A `file://` link that opens the local
//!    filesystem, or a `javascript:` link, is a real attack once the URL reaches
//!    the system opener.
//! 2. Nothing may go through a shell. On Windows the obvious
//!    `cmd /C start "" <url>` re-parses its command line, so `&` or `^` inside a
//!    URL becomes a second command. `rundll32 url.dll,FileProtocolHandler`
//!    receives the URL as a plain argument instead.

use std::process::{Command, Stdio};

/// Schemes a message is allowed to open.
///
/// Deliberately short: anything not on this list is a capability we have no
/// reason to hand to untrusted text.
pub const ALLOWED_SCHEMES: &[&str] = &["http", "https", "mailto", "irc", "ircs"];

/// Longest URL accepted. Real links are far shorter; the cap just stops a
/// pathological message from being forwarded to the system opener at all.
const MAX_URL_LENGTH: usize = 2048;

/// Check that a URL is safe to hand to the system opener.
///
/// Returns the trimmed URL on success.
pub fn validate_external_url(raw: &str) -> Result<&str, String> {
    let url = raw.trim();

    if url.is_empty() {
        return Err("url is empty".to_owned());
    }

    if url.len() > MAX_URL_LENGTH {
        return Err(format!("url is longer than {MAX_URL_LENGTH} characters"));
    }

    if url.chars().any(|ch| ch.is_control() || ch.is_whitespace()) {
        return Err("url contains whitespace or control characters".to_owned());
    }

    // Defence in depth: even though nothing here goes through a shell, a quote
    // is never legitimate in a URL and is the first character any command-line
    // parser would choke on.
    if url.contains(['"', '\'', '`']) {
        return Err("url contains a quote character".to_owned());
    }

    let scheme = url
        .split_once(':')
        .map(|(scheme, _)| scheme)
        .ok_or_else(|| "url has no scheme".to_owned())?;

    if !ALLOWED_SCHEMES
        .iter()
        .any(|allowed| scheme.eq_ignore_ascii_case(allowed))
    {
        return Err(format!("scheme {scheme:?} is not allowed"));
    }

    Ok(url)
}

/// Hand a validated URL to the desktop.
///
/// The child's standard streams are `/dev/null`: the opener outlives this call,
/// and capturing its output would mean creating pipes for no reason.
pub fn launch(url: &str) -> std::io::Result<()> {
    let mut command = platform_command(url);

    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_child| ())
}

#[cfg(target_os = "windows")]
fn platform_command(url: &str) -> Command {
    let mut command = Command::new("rundll32");
    command.args(["url.dll,FileProtocolHandler", url]);
    command
}

#[cfg(target_os = "macos")]
fn platform_command(url: &str) -> Command {
    let mut command = Command::new("open");
    command.arg(url);
    command
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_command(url: &str) -> Command {
    let mut command = Command::new("xdg-open");
    command.arg(url);
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_links_are_accepted() {
        for url in [
            "https://example.com/page?q=1",
            "http://example.com",
            "irc://irc.libera.chat/rust",
            "ircs://irc.libera.chat:6697/rust",
            "mailto:someone@example.com",
        ] {
            assert_eq!(
                validate_external_url(url),
                Ok(url),
                "{url} should be allowed"
            );
        }
    }

    #[test]
    fn the_scheme_check_ignores_case() {
        assert!(validate_external_url("HTTPS://example.com").is_ok());
    }

    #[test]
    fn dangerous_schemes_are_rejected() {
        // These are the reason the allowlist exists: every one of them turns a
        // link in a message into local capability.
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "vbscript:msgbox(1)",
            "smb://server/share",
        ] {
            assert!(
                validate_external_url(url).is_err(),
                "{url} should have been rejected"
            );
        }
    }

    #[test]
    fn argument_injection_cannot_get_through() {
        // Any of these would let a URL escape its argument if something
        // downstream used a shell.
        for url in [
            "https://example.com/\" & calc",
            "https://example.com/'",
            "https://example.com/`id`",
            "https://example.com/; rm -rf /",
        ] {
            let result = validate_external_url(url);
            if url.contains(['"', '\'', '`']) {
                assert!(result.is_err(), "{url} should have been rejected");
            }
        }
    }

    #[test]
    fn whitespace_and_control_characters_are_rejected() {
        for url in [
            "https://example.com/a b",
            "https://example.com/a\nb",
            "https://example.com/a\tb",
            "  \u{0007}  ",
        ] {
            assert!(
                validate_external_url(url).is_err(),
                "{url:?} should have been rejected"
            );
        }
    }

    #[test]
    fn surrounding_whitespace_is_trimmed_rather_than_rejected() {
        assert_eq!(
            validate_external_url("  https://example.com  "),
            Ok("https://example.com")
        );
    }

    #[test]
    fn empty_and_schemeless_input_is_rejected() {
        assert!(validate_external_url("").is_err());
        assert!(validate_external_url("   ").is_err());
        assert!(validate_external_url("example.com").is_err());
        assert!(validate_external_url("//example.com").is_err());
    }

    #[test]
    fn an_over_long_url_is_rejected() {
        let url = format!("https://example.com/{}", "a".repeat(MAX_URL_LENGTH));
        assert!(validate_external_url(&url).is_err());
    }
}
