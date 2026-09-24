//! IRCv3 capability negotiation.
//!
//! Before registration the client asks which extensions the server supports and
//! requests the ones it wants. This is a small state machine with a few sharp
//! edges — multi-line `LS` replies, SASL nested inside the exchange, and servers
//! that answer `NAK` — so it lives on its own and is driven by feeding it parsed
//! messages.
//!
//! The negotiation must finish before registration completes, which is why
//! `NICK`/`USER` are sent up front and `CAP END` is what actually lets the server
//! register the client.

use ircuit_proto::{Command, Message};

use crate::config::SaslConfig;
use crate::sasl::{encode_chunks, initial_payload};

/// Capabilities requested when the server offers them.
///
/// Deliberately conservative: every capability here is one this client actually
/// acts on. Requesting `batch` or `draft/chathistory` before implementing them
/// would change the shape of inbound traffic for no benefit.
pub const DEFAULT_CAPABILITIES: &[&str] = &[
    "message-tags",
    "server-time",
    "echo-message",
    "multi-prefix",
    "away-notify",
    "account-tag",
    "extended-join",
    "chghost",
    "cap-notify",
    "labeled-response",
    "standard-replies",
];

/// The `CAP LS` version we advertise, which enables the 302 extensions.
pub const CAP_VERSION: &str = "302";

/// How the SASL exchange ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaslOutcome {
    /// No SASL was configured for this network.
    NotConfigured,
    /// SASL was configured but the server never offered it.
    Unsupported,
    /// The exchange is in flight.
    Pending,
    Succeeded,
    Failed(String),
}

impl SaslOutcome {
    /// Whether authentication definitely did not succeed.
    #[must_use]
    pub fn is_failure(&self) -> bool {
        matches!(self, Self::Unsupported | Self::Failed(_))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// Waiting for the (possibly multi-line) `LS` reply.
    Listing,
    /// `REQ` sent, waiting for `ACK` or `NAK`.
    Requesting,
    /// `AUTHENTICATE` sent, waiting for the challenge and result.
    Authenticating,
    /// `CAP END` sent.
    Finished,
}

/// Drives capability negotiation for one connection.
#[derive(Debug)]
pub struct CapNegotiator {
    desired: Vec<String>,
    available: Vec<String>,
    negotiated: Vec<String>,
    sasl: Option<SaslConfig>,
    sasl_outcome: SaslOutcome,
    state: State,
    /// Set while a `LS` reply may still be followed by more lines.
    listing_continues: bool,
}

impl CapNegotiator {
    /// Build a negotiator for the given SASL configuration.
    #[must_use]
    pub fn new(sasl: Option<SaslConfig>) -> Self {
        let mut desired: Vec<String> = DEFAULT_CAPABILITIES
            .iter()
            .map(|cap| (*cap).to_owned())
            .collect();

        let sasl_outcome = match &sasl {
            Some(_) => {
                desired.push("sasl".to_owned());
                SaslOutcome::Pending
            }
            None => SaslOutcome::NotConfigured,
        };

        Self {
            desired,
            available: Vec::new(),
            negotiated: Vec::new(),
            sasl,
            sasl_outcome,
            state: State::Listing,
            listing_continues: false,
        }
    }

    /// The lines to send immediately after the socket opens.
    #[must_use]
    pub fn opening_lines(&self) -> Vec<String> {
        vec![format!("CAP LS {CAP_VERSION}")]
    }

    /// Whether `CAP END` has been sent, i.e. registration may complete.
    #[must_use]
    pub fn is_finished(&self) -> bool {
        self.state == State::Finished
    }

    /// Capabilities the server actually enabled.
    #[must_use]
    pub fn negotiated(&self) -> &[String] {
        &self.negotiated
    }

    /// Capabilities the server advertised.
    #[must_use]
    pub fn available(&self) -> &[String] {
        &self.available
    }

    /// How the SASL exchange ended.
    #[must_use]
    pub fn sasl_outcome(&self) -> &SaslOutcome {
        &self.sasl_outcome
    }

    /// Whether a capability was negotiated.
    #[must_use]
    pub fn has(&self, capability: &str) -> bool {
        self.negotiated.iter().any(|cap| cap == capability)
    }

    /// Feed one inbound message and get the lines to send in response.
    pub fn on_message(&mut self, message: &Message) -> Vec<String> {
        if self.state == State::Finished {
            // `cap-notify` keeps sending NEW/DEL after registration; track them
            // but never reopen negotiation.
            if message.command == Command::Cap {
                self.track_cap_change(message);
            }
            return Vec::new();
        }

        match message.command {
            Command::Cap => self.on_cap(message),
            Command::Authenticate => self.on_authenticate(message),
            Command::Numeric(code) => self.on_numeric(code, message),
            _ => Vec::new(),
        }
    }

    /// Pull `(subcommand, continues, capabilities)` out of a `CAP` message.
    fn parse_cap_params(message: &Message) -> Option<(&str, bool, &str)> {
        // CAP <target> <subcommand> [*] :<capabilities>
        let subcommand = message.param(1)?;
        let second = message.param(2)?;

        // The continuation marker only appears on `LS`.
        if second == "*" {
            let caps = message.param(3).unwrap_or("");
            Some((subcommand, true, caps))
        } else {
            Some((subcommand, false, second))
        }
    }

    fn on_cap(&mut self, message: &Message) -> Vec<String> {
        let Some((raw_subcommand, continues, caps)) = Self::parse_cap_params(message) else {
            return Vec::new();
        };

        let subcommand = raw_subcommand.to_ascii_uppercase();
        let caps = split_caps(caps);

        match subcommand.as_str() {
            "LS" => {
                self.available.extend(caps);
                self.listing_continues = continues;

                if continues {
                    return Vec::new();
                }

                self.available.sort_unstable();
                self.available.dedup();
                self.request_desired()
            }
            "ACK" => {
                for cap in caps {
                    if !self.negotiated.contains(&cap) {
                        self.negotiated.push(cap);
                    }
                }
                self.after_acknowledgement()
            }
            "NAK" => {
                // The server refused the batch. Drop those wishes and move on
                // rather than retrying them forever.
                let refused = caps;
                self.desired.retain(|cap| !refused.contains(cap));

                if refused.iter().any(|cap| cap == "sasl") {
                    self.sasl = None;
                    self.sasl_outcome = SaslOutcome::Unsupported;
                }

                vec!["CAP END".to_owned()]
            }
            "NEW" => {
                self.available.extend(caps);
                self.available.sort_unstable();
                self.available.dedup();
                Vec::new()
            }
            "DEL" => {
                self.available.retain(|cap| !caps.contains(cap));
                self.negotiated.retain(|cap| !caps.contains(cap));
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    /// Track NEW/DEL once negotiation is over.
    fn track_cap_change(&mut self, message: &Message) {
        let Some((raw_subcommand, _continues, caps)) = Self::parse_cap_params(message) else {
            return;
        };

        let caps = split_caps(caps);
        match raw_subcommand.to_ascii_uppercase().as_str() {
            "NEW" => {
                self.available.extend(caps);
                self.available.sort_unstable();
                self.available.dedup();
            }
            "DEL" => {
                self.available.retain(|cap| !caps.contains(cap));
                self.negotiated.retain(|cap| !caps.contains(cap));
            }
            _ => {}
        }
    }

    /// Request the intersection of what we want and what is on offer.
    fn request_desired(&mut self) -> Vec<String> {
        let wanted: Vec<String> = self
            .desired
            .iter()
            .filter(|cap| self.available.iter().any(|avail| avail == *cap))
            .cloned()
            .collect();

        if self.desired.iter().any(|cap| cap == "sasl") && !wanted.iter().any(|cap| cap == "sasl") {
            self.sasl_outcome = SaslOutcome::Unsupported;
        }

        if wanted.is_empty() {
            self.state = State::Finished;
            return vec!["CAP END".to_owned()];
        }

        self.state = State::Requesting;
        vec![format!("CAP REQ :{}", wanted.join(" "))]
    }

    /// `ACK` may cover SASL, in which case the exchange starts here.
    fn after_acknowledgement(&mut self) -> Vec<String> {
        let sasl_acked = self.has("sasl");

        match (&self.sasl, sasl_acked) {
            (Some(config), true) => {
                self.state = State::Authenticating;
                vec![format!("AUTHENTICATE {}", config.mechanism())]
            }
            _ => {
                if self.sasl.is_some() {
                    self.sasl_outcome = SaslOutcome::Unsupported;
                }
                self.state = State::Finished;
                vec!["CAP END".to_owned()]
            }
        }
    }

    fn on_authenticate(&mut self, message: &Message) -> Vec<String> {
        if self.state != State::Authenticating {
            return Vec::new();
        }

        let challenge = message.param(0).unwrap_or("");

        match challenge {
            // The server is ready for our payload.
            "+" => {
                let Some(config) = &self.sasl else {
                    return self.abort_sasl("no SASL configuration");
                };

                encode_chunks(&initial_payload(config))
                    .into_iter()
                    .map(|chunk| format!("AUTHENTICATE {chunk}"))
                    .collect()
            }
            // PLAIN and EXTERNAL are single-round; a real challenge means the
            // server is running a mechanism we did not ask for.
            "*" => self.abort_sasl("server aborted the exchange"),
            other => self.abort_sasl(&format!("unexpected challenge {other:?}")),
        }
    }

    fn on_numeric(&mut self, code: u16, message: &Message) -> Vec<String> {
        match code {
            // 900 RPL_LOGGEDIN, 903 RPL_SASLSUCCESS
            903 => {
                self.sasl_outcome = SaslOutcome::Succeeded;
                self.state = State::Finished;
                vec!["CAP END".to_owned()]
            }
            // 904 ERR_SASLFAIL, 905 ERR_SASLTOOLONG, 906 ERR_SASLABORTED,
            // 907 ERR_SASLALREADY
            904..=907 => {
                let reason = message
                    .params
                    .last()
                    .cloned()
                    .unwrap_or_else(|| format!("server replied {code}"));

                self.sasl_outcome = SaslOutcome::Failed(reason);
                self.state = State::Finished;
                vec!["CAP END".to_owned()]
            }
            _ => Vec::new(),
        }
    }

    /// Abort a SASL exchange that cannot be completed.
    fn abort_sasl(&mut self, reason: &str) -> Vec<String> {
        self.sasl_outcome = SaslOutcome::Failed(reason.to_owned());
        self.state = State::Finished;
        vec!["AUTHENTICATE *".to_owned(), "CAP END".to_owned()]
    }
}

/// Split a capability list, ignoring the value suffix some servers append.
///
/// A few networks still send legacy `cap=value` pairs; the value is dropped here
/// because none of the capabilities we request take one.
fn split_caps(raw: &str) -> Vec<String> {
    raw.split_whitespace()
        .map(|cap| cap.split('=').next().unwrap_or(cap).to_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(line: &str) -> Message {
        Message::parse(line).expect("test line should parse")
    }

    fn negotiate_to_end(sasl: Option<SaslConfig>, ls: &str) -> CapNegotiator {
        let mut negotiator = CapNegotiator::new(sasl);
        assert_eq!(negotiator.opening_lines(), vec!["CAP LS 302"]);

        let lines = negotiator.on_message(&message(ls));
        assert!(
            lines.iter().any(|line| line.starts_with("CAP REQ")),
            "{lines:?}"
        );

        let acks = lines
            .iter()
            .find(|line| line.starts_with("CAP REQ"))
            .map(|line| line.trim_start_matches("CAP REQ :").to_owned())
            .unwrap();

        let _ = negotiator.on_message(&message(&format!(":s CAP * ACK :{acks}")));
        negotiator
    }

    #[test]
    fn requests_only_the_intersection_of_wanted_and_offered() {
        let mut negotiator = CapNegotiator::new(None);
        let lines = negotiator.on_message(&message(
            ":s CAP * LS :message-tags server-time something-we-do-not-want",
        ));

        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0], "CAP REQ :message-tags server-time");
        assert!(!negotiator.is_finished());
    }

    #[test]
    fn finishes_immediately_when_nothing_is_on_offer() {
        let mut negotiator = CapNegotiator::new(None);
        let lines = negotiator.on_message(&message(":s CAP * LS :unknown-cap"));

        assert_eq!(lines, vec!["CAP END"]);
        assert!(negotiator.is_finished());
    }

    #[test]
    fn multi_line_ls_replies_are_accumulated() {
        let mut negotiator = CapNegotiator::new(None);

        assert!(negotiator
            .on_message(&message(":s CAP * LS * :message-tags"))
            .is_empty());
        assert!(negotiator
            .on_message(&message(":s CAP * LS * :server-time"))
            .is_empty());

        let lines = negotiator.on_message(&message(":s CAP * LS :echo-message"));

        assert_eq!(
            lines,
            vec!["CAP REQ :message-tags server-time echo-message"]
        );
        assert_eq!(
            negotiator.available(),
            ["echo-message", "message-tags", "server-time"]
        );
    }

    #[test]
    fn legacy_valued_capabilities_are_accepted() {
        let mut negotiator = CapNegotiator::new(None);
        let lines = negotiator.on_message(&message(":s CAP * LS :message-tags=1 server-time"));

        assert_eq!(lines, vec!["CAP REQ :message-tags server-time"]);
    }

    #[test]
    fn sasl_is_requested_only_when_configured() {
        let without = CapNegotiator::new(None);
        assert!(!without.desired.iter().any(|cap| cap == "sasl"));

        let with = CapNegotiator::new(Some(SaslConfig::Plain {
            account: "alice".to_owned(),
            password: "hunter2".to_owned(),
        }));
        assert!(with.desired.iter().any(|cap| cap == "sasl"));
    }

    #[test]
    fn ack_that_covers_sasl_starts_the_exchange() {
        let mut negotiator = CapNegotiator::new(Some(SaslConfig::Plain {
            account: "alice".to_owned(),
            password: "hunter2".to_owned(),
        }));

        negotiator.on_message(&message(":s CAP * LS :sasl message-tags"));
        let lines = negotiator.on_message(&message(":s CAP * ACK :sasl message-tags"));

        assert_eq!(lines, vec!["AUTHENTICATE PLAIN"]);
        assert_eq!(negotiator.sasl_outcome(), &SaslOutcome::Pending);
        assert!(negotiator.has("sasl"));
        assert!(negotiator.has("message-tags"));
    }

    #[test]
    fn the_full_sasl_plain_exchange_reaches_success() {
        let mut negotiator = CapNegotiator::new(Some(SaslConfig::Plain {
            account: "alice".to_owned(),
            password: "hunter2".to_owned(),
        }));

        negotiator.on_message(&message(":s CAP * LS :sasl"));
        negotiator.on_message(&message(":s CAP * ACK :sasl"));
        let payload_lines = negotiator.on_message(&message("AUTHENTICATE +"));

        assert_eq!(payload_lines.len(), 1);
        let decoded =
            crate::sasl::decode_challenge(payload_lines[0].trim_start_matches("AUTHENTICATE "))
                .unwrap();
        assert_eq!(decoded, b"\0alice\0hunter2");

        let lines = negotiator.on_message(&message(":s 903 alice :SASL authentication successful"));

        assert_eq!(lines, vec!["CAP END"]);
        assert_eq!(negotiator.sasl_outcome(), &SaslOutcome::Succeeded);
        assert!(negotiator.is_finished());
    }

    #[test]
    fn a_sasl_failure_is_reported_and_negotiation_still_ends() {
        let mut negotiator = CapNegotiator::new(Some(SaslConfig::Plain {
            account: "alice".to_owned(),
            password: "wrong".to_owned(),
        }));

        negotiator.on_message(&message(":s CAP * LS :sasl"));
        negotiator.on_message(&message(":s CAP * ACK :sasl"));
        negotiator.on_message(&message("AUTHENTICATE +"));
        let lines = negotiator.on_message(&message(":s 904 alice :SASL authentication failed"));

        assert_eq!(lines, vec!["CAP END"]);
        assert!(negotiator.is_finished());
        match negotiator.sasl_outcome() {
            SaslOutcome::Failed(reason) => assert!(reason.contains("SASL authentication failed")),
            other => panic!("expected a failure, got {other:?}"),
        }
    }

    #[test]
    fn sasl_configured_but_not_offered_is_reported_as_unsupported() {
        let mut negotiator = CapNegotiator::new(Some(SaslConfig::Plain {
            account: "alice".to_owned(),
            password: "hunter2".to_owned(),
        }));

        let lines = negotiator.on_message(&message(":s CAP * LS :message-tags"));

        assert_eq!(lines, vec!["CAP REQ :message-tags"]);
        assert_eq!(negotiator.sasl_outcome(), &SaslOutcome::Unsupported);
        assert!(negotiator.sasl_outcome().is_failure());
    }

    #[test]
    fn sasl_configured_but_refused_is_reported_as_unsupported() {
        let mut negotiator = CapNegotiator::new(Some(SaslConfig::Plain {
            account: "alice".to_owned(),
            password: "hunter2".to_owned(),
        }));

        negotiator.on_message(&message(":s CAP * LS :sasl message-tags"));
        let lines = negotiator.on_message(&message(":s CAP * NAK :sasl"));

        assert_eq!(lines, vec!["CAP END"]);
        assert_eq!(negotiator.sasl_outcome(), &SaslOutcome::Unsupported);
    }

    #[test]
    fn an_unexpected_challenge_aborts_the_exchange() {
        let mut negotiator = CapNegotiator::new(Some(SaslConfig::External { authzid: None }));

        negotiator.on_message(&message(":s CAP * LS :sasl"));
        negotiator.on_message(&message(":s CAP * ACK :sasl"));
        let lines = negotiator.on_message(&message("AUTHENTICATE dGVjaGFsbGVuZ2U="));

        assert_eq!(lines, vec!["AUTHENTICATE *", "CAP END"]);
        assert!(negotiator.sasl_outcome().is_failure());
        assert!(negotiator.is_finished());
    }

    #[test]
    fn external_sends_the_empty_marker_when_there_is_no_authzid() {
        let mut negotiator = CapNegotiator::new(Some(SaslConfig::External { authzid: None }));
        negotiator.on_message(&message(":s CAP * LS :sasl"));
        negotiator.on_message(&message(":s CAP * ACK :sasl"));

        assert_eq!(
            negotiator.on_message(&message("AUTHENTICATE +")),
            vec!["AUTHENTICATE +"]
        );
    }

    #[test]
    fn negotiation_without_sasl_ends_on_ack() {
        let negotiator = negotiate_to_end(None, ":s CAP * LS :message-tags server-time");
        // `negotiate_to_end` feeds the ACK, which must have produced CAP END.
        assert!(negotiator.is_finished());
        assert_eq!(negotiator.sasl_outcome(), &SaslOutcome::NotConfigured);
    }

    #[test]
    fn cap_notify_changes_are_tracked_after_negotiation() {
        let mut negotiator = negotiate_to_end(None, ":s CAP * LS :message-tags");

        negotiator.on_message(&message(":s CAP * NEW :draft/reactions"));
        assert!(negotiator
            .available()
            .iter()
            .any(|cap| cap == "draft/reactions"));

        negotiator.on_message(&message(":s CAP * DEL :message-tags"));
        assert!(!negotiator
            .available()
            .iter()
            .any(|cap| cap == "message-tags"));
        assert!(!negotiator.has("message-tags"));
    }

    #[test]
    fn nothing_is_sent_after_negotiation_finishes() {
        let mut negotiator = negotiate_to_end(None, ":s CAP * LS :message-tags");

        assert!(negotiator
            .on_message(&message(":s CAP * ACK :message-tags"))
            .is_empty());
        assert!(negotiator.on_message(&message("PING :1")).is_empty());
        assert!(negotiator
            .on_message(&message(":s 903 alice :ok"))
            .is_empty());
    }
}
