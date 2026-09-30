//! Turning protocol messages into something a message list can render.
//!
//! The protocol layer produces [`ircuit_proto::Message`], which is a faithful
//! record of the wire and therefore full of things a UI does not care about:
//! numerics, CTCP framing bytes, nick prefixes. This module is the single place
//! that decides what a human should see, and — just as importantly — what should
//! not be shown at all.
//!
//! It is pure and takes "now" as an argument so the tests are deterministic.

use ircuit_proto::formatting::{
    parse as parse_formatting, strip as strip_formatting, Segment, Style,
};
use ircuit_proto::{Command, Message, Prefix};

/// What kind of line this is, from the reader's point of view.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageKind {
    /// An ordinary `PRIVMSG`.
    Message,
    /// A `NOTICE`. Rendered differently because replying to one is a faux pas
    /// and most clients refuse to.
    Notice,
    /// A `PRIVMSG` carrying a CTCP `ACTION`, i.e. `/me waves`.
    Action,
    /// Server-generated: joins, parts, kills, mode changes.
    System,
}

/// A line ready to be displayed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewMessage {
    /// The display name of the sender, empty for server notices.
    pub nick: String,
    pub kind: MessageKind,
    /// The channel or user the line belongs to.
    pub target: String,
    /// The line with formatting codes removed.
    ///
    /// This is what search, notifications and log export use: markup is noise
    /// there.
    pub text: String,
    /// The same line with mIRC formatting preserved, for rendering.
    ///
    /// Colour values stay exactly as the protocol expressed them — a palette
    /// index or a 24-bit value. Deciding what those *look like* belongs to the
    /// theme, not to the protocol layer.
    pub segments: Vec<Segment>,
    /// Unix seconds, from the `server-time` tag when the server provides one.
    pub timestamp: u32,
    /// Whether this line was sent by us.
    pub is_self: bool,
}

impl ViewMessage {
    /// Whether the line should count as unread activity in its buffer.
    #[must_use]
    pub fn is_activity(&self) -> bool {
        !self.is_self && matches!(self.kind, MessageKind::Message | MessageKind::Action)
    }

    /// Which conversation this line belongs to.
    ///
    /// Not the same as [`Self::target`], and the difference is the whole point:
    /// a private message is addressed *to us* but belongs to the sender's
    /// conversation, or every PM in the client would pile into one buffer named
    /// after ourselves.
    ///
    /// This lives here rather than in the UI because history is keyed by it. Two
    /// independent implementations that disagree would not look like a bug — the
    /// client would simply show an empty conversation, because the lines were
    /// filed under a key nothing ever reads.
    ///
    /// Returns `''` for server chatter, which is the server buffer.
    #[must_use]
    pub fn buffer(&self, self_nick: &str) -> String {
        if is_channel_name(&self.target) {
            return self.target.clone();
        }

        // Joins, parts, mode changes and numerics carry no target.
        if self.target.is_empty() {
            return String::new();
        }

        let addressed_to_us = self.target.eq_ignore_ascii_case(self_nick);

        // An inbound PM belongs to the sender; our own line belongs to whoever we
        // sent it to, which is `target` in both cases once the addressee is us.
        if addressed_to_us {
            if self.is_self {
                self.target.clone()
            } else {
                self.nick.clone()
            }
        } else {
            self.target.clone()
        }
    }
}

/// Whether a target names a channel rather than a person.
///
/// Any of IRC's channel prefixes counts, not just `#`: `&`, `+` and `!` are all
/// legal and do occur on real networks.
///
/// Deliberately not driven by the server's `CHANTYPES`: a nickname may not begin
/// with any of these characters, so the answer is the same on every server.
/// `Isupport::is_channel` exists for the cases where the *server's* own idea of
/// a channel matters, which this is not.
#[must_use]
pub fn is_channel_name(target: &str) -> bool {
    matches!(
        target.chars().next(),
        Some('#') | Some('&') | Some('+') | Some('!')
    )
}

/// A single unstyled run, for lines that carry no formatting.
fn plain_segment(text: &str) -> Vec<Segment> {
    vec![Segment {
        text: text.to_owned(),
        style: Style::default(),
    }]
}

/// CTCP messages are wrapped in this byte.
const CTCP: char = '\u{0001}';

/// Convert a protocol message into a displayable line.
///
/// Returns `None` for anything the message list should not show. Dropping is a
/// deliberate choice: a client that renders every numeric reply is unusable, and
/// the raw traffic is still available through the server buffer.
///
/// `now` is used when the server does not supply a `server-time` tag.
#[must_use]
pub fn normalize(self_nick: Option<&str>, message: &Message, now: u32) -> Option<ViewMessage> {
    let timestamp = message
        .tag("time")
        .and_then(parse_server_time)
        .unwrap_or(now);

    let nick = message.nick().unwrap_or_default().to_owned();
    let is_self = self_nick.is_some_and(|own| own.eq_ignore_ascii_case(&nick));

    match &message.command {
        Command::Privmsg => {
            let target = message.param(0)?.to_owned();
            let body = message.param(1).unwrap_or_default();

            match split_ctcp(body) {
                Some(("ACTION", action)) => Some(ViewMessage {
                    nick,
                    kind: MessageKind::Action,
                    target,
                    text: strip_formatting(action),
                    segments: parse_formatting(action),
                    timestamp,
                    is_self,
                }),
                // Other CTCP queries (VERSION, PING, …) are protocol chatter;
                // answering them belongs with the rest of the CTCP work.
                Some(_) => None,
                None => Some(ViewMessage {
                    nick,
                    kind: MessageKind::Message,
                    target,
                    text: strip_formatting(body),
                    segments: parse_formatting(body),
                    timestamp,
                    is_self,
                }),
            }
        }

        Command::Notice => {
            let target = message.param(0)?.to_owned();
            let body = message.param(1).unwrap_or_default();

            // A NOTICE wrapped in CTCP is a protocol reply, not a message.
            if split_ctcp(body).is_some() {
                return None;
            }

            // A notice whose sender has no user/host is the server talking, so it
            // belongs in the server buffer rather than in a conversation named
            // after the server.
            let from_server = message.prefix.as_ref().is_some_and(Prefix::is_server);

            Some(ViewMessage {
                nick,
                kind: MessageKind::Notice,
                target: if from_server { String::new() } else { target },
                text: strip_formatting(body),
                segments: parse_formatting(body),
                timestamp,
                is_self,
            })
        }

        Command::Join => {
            let channel = message.param(0)?;
            Some(system(
                &nick,
                channel,
                format!("{nick} joined {channel}"),
                timestamp,
            ))
        }

        Command::Part => {
            let channel = message.param(0)?;
            let reason = message.param(1);
            let text = match reason {
                Some(reason) if !reason.is_empty() => {
                    format!("{nick} left {channel} ({reason})")
                }
                _ => format!("{nick} left {channel}"),
            };
            Some(system(&nick, channel, text, timestamp))
        }

        Command::Quit => {
            let reason = message.param(0).unwrap_or("Connection closed");
            // A quit has no channel parameter, so it belongs to the server
            // buffer; the caller decides which buffers to fan it out to.
            Some(system(
                &nick,
                "",
                format!("{nick} quit ({reason})"),
                timestamp,
            ))
        }

        Command::Kick => {
            let channel = message.param(0)?;
            let victim = message.param(1).unwrap_or_default();
            let reason = message.param(2).unwrap_or("no reason given");
            Some(system(
                &nick,
                channel,
                format!("{nick} kicked {victim} from {channel} ({reason})"),
                timestamp,
            ))
        }

        Command::Mode => {
            let target = message.param(0)?;
            let modes = message.params[1..].join(" ");
            Some(system(
                &nick,
                target,
                format!("{nick} set mode {modes} on {target}"),
                timestamp,
            ))
        }

        Command::Nick => {
            let new_nick = message.param(0).unwrap_or_default();
            Some(system(
                &nick,
                "",
                format!("{nick} is now known as {new_nick}"),
                timestamp,
            ))
        }

        Command::Topic => {
            let channel = message.param(0)?;
            let topic = message.param(1).unwrap_or_default();
            Some(system(
                &nick,
                channel,
                format!("{nick} changed the topic of {channel} to: {topic}"),
                timestamp,
            ))
        }

        // Numerics describe server state (MOTD, names, ISUPPORT). They are real
        // information but not conversation, and the server buffer shows them
        // raw already.
        Command::Numeric(_) => None,

        _ => None,
    }
}

fn system(nick: &str, target: &str, text: String, timestamp: u32) -> ViewMessage {
    ViewMessage {
        nick: nick.to_owned(),
        kind: MessageKind::System,
        target: target.to_owned(),
        segments: plain_segment(&text),
        text,
        timestamp,
        is_self: false,
    }
}

/// Unwrap a CTCP payload, returning `(command, argument)`.
///
/// The framing byte appears at both ends; anything else is not a CTCP.
fn split_ctcp(body: &str) -> Option<(&str, &str)> {
    let inner = body.strip_prefix(CTCP)?.strip_suffix(CTCP)?;

    match inner.split_once(' ') {
        Some((command, argument)) => Some((command, argument)),
        None => Some((inner, "")),
    }
}

/// Parse an IRCv3 `server-time` tag into Unix seconds.
///
/// The tag is always `YYYY-MM-DDThh:mm:ss.sssZ`, so this is a fixed-format parse
/// rather than a general date parser. Returns `None` for anything unexpected,
/// which makes the caller fall back to local time.
#[must_use]
pub fn parse_server_time(raw: &str) -> Option<u32> {
    let bytes = raw.as_bytes();
    // Shortest legal form is "YYYY-MM-DDThh:mm:ssZ".
    if bytes.len() < 20 {
        return None;
    }

    let year: i64 = raw.get(0..4)?.parse().ok()?;
    let month: i64 = raw.get(5..7)?.parse().ok()?;
    let day: i64 = raw.get(8..10)?.parse().ok()?;
    let hour: i64 = raw.get(11..13)?.parse().ok()?;
    let minute: i64 = raw.get(14..16)?.parse().ok()?;
    let second: i64 = raw.get(17..19)?.parse().ok()?;

    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }

    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second;

    u32::try_from(seconds).ok()
}

/// Days since 1970-01-01 for a proleptic Gregorian date.
///
/// Howard Hinnant's `days_from_civil`, which is exact for the whole range we
/// care about and avoids pulling in a date library.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;

    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(line: &str) -> Message {
        Message::parse(line).expect("test line should parse")
    }

    const NOW: u32 = 1_700_000_000;

    #[test]
    fn a_plain_privmsg_becomes_a_message() {
        let view = normalize(Some("me"), &message(":alice!a@h PRIVMSG #rust :hello"), NOW).unwrap();

        assert_eq!(view.nick, "alice");
        assert_eq!(view.kind, MessageKind::Message);
        assert_eq!(view.target, "#rust");
        assert_eq!(view.text, "hello");
        assert_eq!(view.timestamp, NOW);
        assert!(!view.is_self);
        assert!(view.is_activity());
    }

    #[test]
    fn our_own_echoed_message_is_marked_as_self() {
        let view = normalize(Some("me"), &message(":me!m@h PRIVMSG #rust :hi"), NOW).unwrap();

        assert!(view.is_self);
        assert!(!view.is_activity(), "our own line must not count as unread");
    }

    #[test]
    fn nick_matching_ignores_case() {
        let view = normalize(Some("Me"), &message(":mE!m@h PRIVMSG #rust :hi"), NOW).unwrap();
        assert!(view.is_self);
    }

    #[test]
    fn a_ctcp_action_becomes_an_action() {
        let line = ":carol!c@h PRIVMSG #rust :\u{0001}ACTION waves hello\u{0001}";
        let view = normalize(None, &message(line), NOW).unwrap();

        assert_eq!(view.kind, MessageKind::Action);
        assert_eq!(view.text, "waves hello");
    }

    #[test]
    fn other_ctcp_queries_are_not_shown() {
        let line = ":srv!s@h PRIVMSG me :\u{0001}VERSION\u{0001}";
        assert!(normalize(None, &message(line), NOW).is_none());
    }

    #[test]
    fn ctcp_notices_are_not_shown() {
        let line = ":srv!s@h NOTICE me :\u{0001}PING 12345\u{0001}";
        assert!(normalize(None, &message(line), NOW).is_none());
    }

    #[test]
    fn notices_are_distinguished_from_messages() {
        let view = normalize(
            None,
            &message(":NickServ!s@h NOTICE me :You are identified"),
            NOW,
        )
        .unwrap();

        assert_eq!(view.kind, MessageKind::Notice);
        assert_eq!(view.target, "me");
        assert!(!view.is_activity(), "a notice is not conversation activity");
    }

    #[test]
    fn a_channel_line_belongs_to_its_channel() {
        let view = normalize(None, &message(":alice!a@h PRIVMSG #rust :hi"), NOW).unwrap();
        assert_eq!(view.buffer("me"), "#rust");
    }

    #[test]
    fn an_inbound_private_message_belongs_to_the_sender() {
        let view = normalize(None, &message(":alice!a@h PRIVMSG me :hi"), NOW).unwrap();

        // The protocol says it is addressed to us; the conversation is alice's.
        // Keying history by `target` here would file every PM under our own nick.
        assert_eq!(view.target, "me");
        assert_eq!(view.buffer("me"), "alice");
    }

    #[test]
    fn our_own_private_message_belongs_to_the_recipient() {
        let view = normalize(Some("me"), &message(":me!m@h PRIVMSG bob :hi"), NOW).unwrap();
        assert!(view.is_self);
        assert_eq!(view.buffer("me"), "bob");
    }

    #[test]
    fn a_join_belongs_to_the_channel_it_joins() {
        let view = normalize(None, &message(":alice!a@h JOIN #rust"), NOW).unwrap();
        assert_eq!(view.buffer("me"), "#rust");
    }

    #[test]
    fn a_line_without_a_target_belongs_to_the_server_buffer() {
        // Not reachable through `normalize` today — every command it keeps is
        // either channel- or person-addressed — but the UI has a server buffer,
        // and something has to be able to say "this line goes there".
        let view = ViewMessage {
            nick: String::new(),
            kind: MessageKind::System,
            target: String::new(),
            text: "shutting down".to_owned(),
            segments: Vec::new(),
            timestamp: NOW,
            is_self: false,
        };

        assert_eq!(view.buffer("me"), "");
    }

    #[test]
    fn the_addressee_is_matched_without_regard_to_case() {
        let view = normalize(None, &message(":alice!a@h PRIVMSG ME :hi"), NOW).unwrap();
        assert_eq!(view.buffer("me"), "alice");
    }

    #[test]
    fn a_private_message_to_a_third_party_keeps_its_target() {
        // Not addressed to us and not from us: it belongs where it says, which is
        // what a bouncer playback or a `WHOIS`-style notice looks like.
        let view = normalize(Some("me"), &message(":alice!a@h PRIVMSG bob :hi"), NOW).unwrap();
        assert_eq!(view.buffer("me"), "bob");
    }

    #[test]
    fn every_channel_prefix_counts() {
        for name in ["#rust", "&local", "+modeless", "!12345chan"] {
            assert!(is_channel_name(name), "{name} should be a channel");
        }
        assert!(!is_channel_name("alice"));
        assert!(!is_channel_name(""));
    }

    #[test]
    fn a_notice_from_the_server_goes_to_the_server_buffer() {
        // No user/host in the prefix means the server itself is speaking, so the
        // line belongs in the server buffer — not in a conversation named after
        // the server.
        let view = normalize(
            None,
            &message(":irc.example.net NOTICE me :*** Looking up"),
            NOW,
        )
        .unwrap();

        assert_eq!(view.kind, MessageKind::Notice);
        assert_eq!(view.target, "");
    }

    #[test]
    fn join_and_part_are_system_lines() {
        let join = normalize(None, &message(":alice!a@h JOIN #rust"), NOW).unwrap();
        assert_eq!(join.kind, MessageKind::System);
        assert_eq!(join.target, "#rust");
        assert!(join.text.contains("joined"));

        let part = normalize(None, &message(":alice!a@h PART #rust :bye"), NOW).unwrap();
        assert!(part.text.contains("bye"));

        let quiet_part = normalize(None, &message(":alice!a@h PART #rust"), NOW).unwrap();
        assert!(!quiet_part.text.contains('('));
    }

    #[test]
    fn kick_names_everyone_involved() {
        let view = normalize(None, &message(":op!o@h KICK #rust bob :spamming"), NOW).unwrap();

        assert_eq!(view.target, "#rust");
        assert!(view.text.contains("bob"));
        assert!(view.text.contains("spamming"));
    }

    #[test]
    fn numerics_are_not_conversation() {
        assert!(normalize(None, &message(":srv 001 me :Welcome"), NOW).is_none());
        assert!(normalize(None, &message(":srv 353 me = #c :@me"), NOW).is_none());
        assert!(normalize(None, &message(":srv 005 me CHANTYPES=#"), NOW).is_none());
    }

    #[test]
    fn a_server_time_tag_overrides_local_time() {
        let line = "@time=2024-01-01T00:00:00.000Z :alice!a@h PRIVMSG #rust :hi";
        let view = normalize(None, &message(line), NOW).unwrap();

        // 2024-01-01T00:00:00Z
        assert_eq!(view.timestamp, 1_704_067_200);
    }

    #[test]
    fn malformed_server_time_falls_back_to_local_time() {
        for bad in [
            "",
            "not-a-time",
            "2024-13-01T00:00:00.000Z",
            "2024-01-01T25:00:00.000Z",
            "2024-01-01",
        ] {
            assert_eq!(parse_server_time(bad), None, "{bad:?} should be rejected");
        }
    }

    #[test]
    fn server_time_parses_the_epoch_and_leap_days() {
        assert_eq!(parse_server_time("1970-01-01T00:00:00.000Z"), Some(0));
        // 2000 is a leap year (divisible by 400).
        assert_eq!(
            parse_server_time("2000-02-29T00:00:00.000Z"),
            Some(951_782_400)
        );
        assert_eq!(
            parse_server_time("2024-02-29T12:00:00Z"),
            Some(1_709_208_000)
        );
        // A tag without milliseconds is still valid.
        assert_eq!(
            parse_server_time("2024-01-01T00:00:00Z"),
            Some(1_704_067_200)
        );
    }

    #[test]
    fn messages_without_a_target_are_dropped() {
        // PRIVMSG with no parameters is malformed; it must not panic.
        let malformed = Message::new(Command::Privmsg, Vec::<String>::new());
        assert!(normalize(None, &malformed, NOW).is_none());
    }

    #[test]
    fn formatting_is_preserved_in_segments_and_stripped_from_text() {
        // Bold and a colour, then plain text: three runs.
        let line = ":alice!a@h PRIVMSG #c :\u{0002}\u{0003}4bold red\u{000F} plain";
        let view = normalize(None, &message(line), NOW).unwrap();

        assert_eq!(view.text, "bold red plain");
        assert_eq!(view.segments.len(), 2);
        assert!(view.segments[0].style.bold);
        assert_eq!(
            view.segments[0].style.fg,
            Some(ircuit_proto::Color::Indexed(4))
        );
        assert_eq!(view.segments[1].text, " plain");
        assert!(view.segments[1].style.is_plain());
    }

    #[test]
    fn a_line_without_formatting_is_a_single_plain_segment() {
        let view = normalize(None, &message(":alice!a@h PRIVMSG #c :hello"), NOW).unwrap();

        assert_eq!(view.segments.len(), 1);
        assert!(view.segments[0].style.is_plain());
        assert_eq!(view.segments[0].text, "hello");
    }

    #[test]
    fn a_ctcp_action_keeps_its_formatting() {
        let line = ":alice!a@h PRIVMSG #c :\u{0001}ACTION \u{001D}waves\u{0001}";
        let view = normalize(None, &message(line), NOW).unwrap();

        assert_eq!(view.kind, MessageKind::Action);
        assert_eq!(view.text, "waves");
        assert!(view.segments[0].style.italic);
    }

    #[test]
    fn system_lines_carry_one_plain_segment() {
        let view = normalize(None, &message(":alice!a@h JOIN #rust"), NOW).unwrap();

        assert_eq!(view.segments.len(), 1);
        assert!(view.segments[0].style.is_plain());
        assert_eq!(view.segments[0].text, view.text);
    }
}
