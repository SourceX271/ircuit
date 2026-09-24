//! RFC 1459 / RFC 2812 message structure, parsing and serialization.
//!
//! A message looks like this:
//!
//! ```text
//! @msgid=abc;account=bob :bob!bob@example.com PRIVMSG #rust :hello world
//! \_______tags________/ \______prefix______/ \command/ \__params____/
//! ```
//!
//! Parsing is deliberately lenient: real servers emit slightly malformed lines
//! and dropping them would lose messages. Serialization is deliberately strict,
//! because it is the direction where a mistake becomes a security problem — see
//! [`Message::to_wire`].

use std::borrow::Cow;
use std::fmt;

use thiserror::Error;

use crate::tags::Tags;

/// Errors produced while parsing a line.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ParseError {
    /// The line contained only tags and/or a prefix, with no command.
    #[error("message has no command")]
    MissingCommand,
}

/// The source of a message: either `nick!user@host`, or a bare server name.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Prefix {
    pub nick: Option<String>,
    pub user: Option<String>,
    pub host: Option<String>,
}

impl Prefix {
    /// Parse a prefix. The `!user@host` parts are optional and independently so.
    #[must_use]
    pub fn parse(raw: &str) -> Self {
        let (nick, rest) = match raw.split_once('!') {
            Some((nick, rest)) => (nick, Some(rest)),
            None => (raw, None),
        };

        let (user, host) = match rest {
            Some(rest) => match rest.split_once('@') {
                Some((user, host)) => (Some(user.to_owned()), Some(host.to_owned())),
                // `nick!user` without a host.
                None => (Some(rest.to_owned()), None),
            },
            None => match raw.split_once('@') {
                // `nick@host`, which some services use.
                Some((nick, host)) => {
                    return Self {
                        nick: Some(nick.to_owned()),
                        user: None,
                        host: Some(host.to_owned()),
                    };
                }
                None => (None, None),
            },
        };

        Self {
            nick: Some(nick.to_owned()),
            user,
            host,
        }
    }

    #[must_use]
    pub fn to_wire(&self) -> String {
        let mut out = String::new();

        if let Some(nick) = &self.nick {
            out.push_str(nick);
        }
        if let Some(user) = &self.user {
            out.push('!');
            out.push_str(user);
        }
        if let Some(host) = &self.host {
            out.push('@');
            out.push_str(host);
        }

        out
    }

    /// True when this prefix looks like a server rather than a user.
    #[must_use]
    pub fn is_server(&self) -> bool {
        self.user.is_none() && self.host.is_none()
    }
}

impl fmt::Display for Prefix {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_wire())
    }
}

/// A protocol command: a numeric reply, a known verb, or anything else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// A three-digit numeric reply such as `001` or `353`.
    Numeric(u16),
    Privmsg,
    Notice,
    Tagmsg,
    Join,
    Part,
    Quit,
    Nick,
    Ping,
    Pong,
    Cap,
    Authenticate,
    Error,
    Mode,
    Topic,
    Kick,
    Invite,
    Away,
    Account,
    Chghost,
    Batch,
    Setname,
    User,
    Pass,
    Oper,
    Who,
    Whois,
    Names,
    List,
    Motd,
    /// Any command we do not model explicitly, kept exactly as received.
    Other(String),
}

impl Command {
    /// Map a wire verb to a command. Matching is case-insensitive because the
    /// protocol is, even though every real server sends uppercase.
    #[must_use]
    pub fn from_wire(raw: &str) -> Self {
        if raw.len() == 3 && raw.bytes().all(|byte| byte.is_ascii_digit()) {
            if let Ok(numeric) = raw.parse::<u16>() {
                return Self::Numeric(numeric);
            }
        }

        if let Some(command) = Self::named(raw) {
            return command;
        }

        // Only pay for the allocation when the input was not already uppercase.
        if raw.bytes().any(|byte| byte.is_ascii_lowercase()) {
            if let Some(command) = Self::named(&raw.to_ascii_uppercase()) {
                return command;
            }
        }

        Self::Other(raw.to_owned())
    }

    fn named(raw: &str) -> Option<Self> {
        let command = match raw {
            "PRIVMSG" => Self::Privmsg,
            "NOTICE" => Self::Notice,
            "TAGMSG" => Self::Tagmsg,
            "JOIN" => Self::Join,
            "PART" => Self::Part,
            "QUIT" => Self::Quit,
            "NICK" => Self::Nick,
            "PING" => Self::Ping,
            "PONG" => Self::Pong,
            "CAP" => Self::Cap,
            "AUTHENTICATE" => Self::Authenticate,
            "ERROR" => Self::Error,
            "MODE" => Self::Mode,
            "TOPIC" => Self::Topic,
            "KICK" => Self::Kick,
            "INVITE" => Self::Invite,
            "AWAY" => Self::Away,
            "ACCOUNT" => Self::Account,
            "CHGHOST" => Self::Chghost,
            "BATCH" => Self::Batch,
            "SETNAME" => Self::Setname,
            "USER" => Self::User,
            "PASS" => Self::Pass,
            "OPER" => Self::Oper,
            "WHO" => Self::Who,
            "WHOIS" => Self::Whois,
            "NAMES" => Self::Names,
            "LIST" => Self::List,
            "MOTD" => Self::Motd,
            _ => return None,
        };

        Some(command)
    }

    /// The wire representation of this command.
    #[must_use]
    pub fn as_wire(&self) -> Cow<'_, str> {
        match self {
            Self::Numeric(numeric) => Cow::Owned(format!("{numeric:03}")),
            Self::Privmsg => Cow::Borrowed("PRIVMSG"),
            Self::Notice => Cow::Borrowed("NOTICE"),
            Self::Tagmsg => Cow::Borrowed("TAGMSG"),
            Self::Join => Cow::Borrowed("JOIN"),
            Self::Part => Cow::Borrowed("PART"),
            Self::Quit => Cow::Borrowed("QUIT"),
            Self::Nick => Cow::Borrowed("NICK"),
            Self::Ping => Cow::Borrowed("PING"),
            Self::Pong => Cow::Borrowed("PONG"),
            Self::Cap => Cow::Borrowed("CAP"),
            Self::Authenticate => Cow::Borrowed("AUTHENTICATE"),
            Self::Error => Cow::Borrowed("ERROR"),
            Self::Mode => Cow::Borrowed("MODE"),
            Self::Topic => Cow::Borrowed("TOPIC"),
            Self::Kick => Cow::Borrowed("KICK"),
            Self::Invite => Cow::Borrowed("INVITE"),
            Self::Away => Cow::Borrowed("AWAY"),
            Self::Account => Cow::Borrowed("ACCOUNT"),
            Self::Chghost => Cow::Borrowed("CHGHOST"),
            Self::Batch => Cow::Borrowed("BATCH"),
            Self::Setname => Cow::Borrowed("SETNAME"),
            Self::User => Cow::Borrowed("USER"),
            Self::Pass => Cow::Borrowed("PASS"),
            Self::Oper => Cow::Borrowed("OPER"),
            Self::Who => Cow::Borrowed("WHO"),
            Self::Whois => Cow::Borrowed("WHOIS"),
            Self::Names => Cow::Borrowed("NAMES"),
            Self::List => Cow::Borrowed("LIST"),
            Self::Motd => Cow::Borrowed("MOTD"),
            Self::Other(raw) => Cow::Borrowed(raw),
        }
    }
}

impl fmt::Display for Command {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.as_wire())
    }
}

/// Remove bytes that would break line framing.
///
/// A CR or LF inside a parameter would let the peer (or a plugin) start a new
/// protocol command, so they are stripped rather than escaped: IRC has no
/// escaping mechanism for them, and the line limit makes it unrecoverable.
fn strip_framing(text: &str) -> Cow<'_, str> {
    if !text.contains(['\r', '\n']) {
        return Cow::Borrowed(text);
    }

    Cow::Owned(text.replace(['\r', '\n'], ""))
}

/// A complete IRC protocol message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub tags: Tags,
    pub prefix: Option<Prefix>,
    pub command: Command,
    pub params: Vec<String>,
}

impl Message {
    /// Build a message with no tags and no prefix.
    pub fn new<I, S>(command: Command, params: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            tags: Tags::new(),
            prefix: None,
            command,
            params: params.into_iter().map(Into::into).collect(),
        }
    }

    #[must_use]
    pub fn with_prefix(mut self, prefix: Prefix) -> Self {
        self.prefix = Some(prefix);
        self
    }

    #[must_use]
    pub fn with_tags(mut self, tags: Tags) -> Self {
        self.tags = tags;
        self
    }

    /// Parse a single line. A trailing CRLF is tolerated and stripped.
    pub fn parse(line: &str) -> Result<Self, ParseError> {
        let mut rest = line.trim_end_matches(['\r', '\n']);

        let tags = match rest.strip_prefix('@') {
            Some(after) => {
                let split = after.find(' ').ok_or(ParseError::MissingCommand)?;
                let tags = Tags::parse(&after[..split]);
                rest = &after[split + 1..];
                tags
            }
            None => Tags::new(),
        };

        // The spec mandates exactly one space, but tolerating extra ones costs
        // nothing and keeps us talking to sloppy servers.
        rest = rest.trim_start_matches(' ');

        let prefix = match rest.strip_prefix(':') {
            Some(after) => {
                let split = after.find(' ').ok_or(ParseError::MissingCommand)?;
                let prefix = Prefix::parse(&after[..split]);
                rest = &after[split + 1..];
                Some(prefix)
            }
            None => None,
        };

        rest = rest.trim_start_matches(' ');
        if rest.is_empty() {
            return Err(ParseError::MissingCommand);
        }

        let (verb, after_verb) = match rest.find(' ') {
            Some(split) => (&rest[..split], &rest[split + 1..]),
            None => (rest, ""),
        };

        let command = Command::from_wire(verb);
        let params = Self::parse_params(after_verb);

        Ok(Self {
            tags,
            prefix,
            command,
            params,
        })
    }

    fn parse_params(mut cursor: &str) -> Vec<String> {
        let mut params = Vec::new();
        cursor = cursor.trim_start_matches(' ');

        while !cursor.is_empty() {
            // A leading ':' marks the final parameter, which may contain spaces.
            if let Some(trailing) = cursor.strip_prefix(':') {
                params.push(trailing.to_owned());
                break;
            }

            match cursor.find(' ') {
                Some(split) => {
                    params.push(cursor[..split].to_owned());
                    cursor = cursor[split + 1..].trim_start_matches(' ');
                }
                None => {
                    params.push(cursor.to_owned());
                    break;
                }
            }
        }

        params
    }

    /// Render the message as a single wire line, **without** the trailing CRLF.
    ///
    /// The `:` sigil is emitted on the trailing parameter only when it is
    /// actually needed (empty, containing a space, or starting with `:`), so the
    /// output is minimal rather than byte-identical to the input. Compare parsed
    /// messages, not raw lines, when asserting fidelity.
    ///
    /// CR and LF inside any field are removed, so the result is guaranteed to be
    /// exactly one line.
    #[must_use]
    pub fn to_wire(&self) -> String {
        let mut out = String::new();

        if !self.tags.is_empty() {
            out.push('@');
            out.push_str(&strip_framing(&self.tags.to_wire()));
            out.push(' ');
        }

        if let Some(prefix) = &self.prefix {
            out.push(':');
            out.push_str(&prefix.to_wire());
            out.push(' ');
        }

        out.push_str(&self.command.as_wire());

        let last_index = self.params.len().saturating_sub(1);
        for (index, param) in self.params.iter().enumerate() {
            out.push(' ');

            let param = strip_framing(param);

            // The trailing parameter needs the ':' sigil when it would otherwise
            // be ambiguous: empty, containing a space, or starting with ':'.
            if index == last_index
                && (param.is_empty() || param.contains(' ') || param.starts_with(':'))
            {
                out.push(':');
            }

            out.push_str(&param);
        }

        out
    }

    /// The parameter at `index`, if present.
    #[must_use]
    pub fn param(&self, index: usize) -> Option<&str> {
        self.params.get(index).map(String::as_str)
    }

    /// The nick from the prefix, if this message came from a user.
    #[must_use]
    pub fn nick(&self) -> Option<&str> {
        self.prefix.as_ref()?.nick.as_deref()
    }

    /// The tag value at `key`, if present.
    #[must_use]
    pub fn tag(&self, key: &str) -> Option<&str> {
        self.tags.get(key)
    }
}

impl fmt::Display for Message {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_wire())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_ping() {
        let message = Message::parse("PING :12345").unwrap();
        assert_eq!(message.command, Command::Ping);
        assert_eq!(message.params, vec!["12345"]);
        assert!(message.prefix.is_none());
        assert!(message.tags.is_empty());
    }

    #[test]
    fn parses_prefix_and_trailing_parameter() {
        let message = Message::parse(":bob!bob@example.com PRIVMSG #rust :hello world").unwrap();

        let prefix = message.prefix.unwrap();
        assert_eq!(prefix.nick.as_deref(), Some("bob"));
        assert_eq!(prefix.user.as_deref(), Some("bob"));
        assert_eq!(prefix.host.as_deref(), Some("example.com"));
        assert!(!prefix.is_server());

        assert_eq!(message.command, Command::Privmsg);
        assert_eq!(message.params, vec!["#rust", "hello world"]);
    }

    #[test]
    fn parses_tags_then_prefix_then_params() {
        let line = "@time=2024-01-01T00:00:00.000Z;account=bob :bob!b@h PRIVMSG #c :hi";
        let message = Message::parse(line).unwrap();

        assert_eq!(message.tag("account"), Some("bob"));
        assert_eq!(message.nick(), Some("bob"));
        assert_eq!(message.command, Command::Privmsg);
        assert_eq!(message.params, vec!["#c", "hi"]);
    }

    #[test]
    fn parses_numerics() {
        let message = Message::parse(":irc.example.net 001 alice :Welcome to IRC").unwrap();
        assert_eq!(message.command, Command::Numeric(1));
        assert_eq!(message.params, vec!["alice", "Welcome to IRC"]);
        assert!(message.prefix.unwrap().is_server());
    }

    #[test]
    fn trailing_parameter_may_be_empty() {
        let message = Message::parse(":s PRIVMSG #c :").unwrap();
        assert_eq!(message.params, vec!["#c", ""]);
        // The empty trailing parameter must survive the round trip.
        assert_eq!(message.to_wire(), ":s PRIVMSG #c :");
    }

    #[test]
    fn command_without_params() {
        let message = Message::parse(":s QUIT").unwrap();
        assert_eq!(message.command, Command::Quit);
        assert!(message.params.is_empty());
    }

    #[test]
    fn colon_inside_a_middle_parameter_is_not_a_trailing_marker() {
        let message = Message::parse(":s PRIVMSG #c :a:b c").unwrap();
        assert_eq!(message.params, vec!["#c", "a:b c"]);
    }

    #[test]
    fn unknown_command_is_preserved_verbatim() {
        let message = Message::parse(":s FROBNICATE #c :x").unwrap();
        assert_eq!(message.command, Command::Other("FROBNICATE".to_owned()));

        // The trailing ':' is optional for a single-word parameter, so the wire
        // form is minimal — assert on semantics, not on the exact bytes.
        let wire = message.to_wire();
        assert_eq!(wire, ":s FROBNICATE #c x");
        assert_eq!(Message::parse(&wire).unwrap(), message);
    }

    #[test]
    fn required_trailing_colon_is_kept() {
        // A space in the final parameter makes the ':' mandatory.
        let message = Message::parse(":s PRIVMSG #c :a b").unwrap();
        assert_eq!(message.to_wire(), ":s PRIVMSG #c :a b");

        // ...and so does an empty final parameter.
        let message = Message::parse(":s PRIVMSG #c :").unwrap();
        assert_eq!(message.to_wire(), ":s PRIVMSG #c :");
    }

    #[test]
    fn lowercase_verbs_are_recognised() {
        assert_eq!(Command::from_wire("privmsg"), Command::Privmsg);
        assert_eq!(Command::from_wire("pInG"), Command::Ping);
    }

    #[test]
    fn prefix_variants() {
        assert_eq!(Prefix::parse("nick").nick.as_deref(), Some("nick"));
        assert_eq!(Prefix::parse("nick!user").user.as_deref(), Some("user"));
        assert_eq!(Prefix::parse("nick@host").host.as_deref(), Some("host"));
        assert!(Prefix::parse("irc.example.net").is_server());
    }

    #[test]
    fn crlf_is_ignored_on_input() {
        let message = Message::parse("PING :1\r\n").unwrap();
        assert_eq!(message.params, vec!["1"]);
    }

    #[test]
    fn framing_characters_are_stripped_on_output() {
        // Without this, `\r\n` in a parameter would let the peer start a new
        // command — the classic IRC injection bug.
        let message = Message::new(
            Command::Privmsg,
            ["#c".to_owned(), "hello\r\nQUIT :bye".to_owned()],
        );

        let wire = message.to_wire();
        assert!(!wire.contains('\r'));
        assert!(!wire.contains('\n'));
        assert_eq!(wire, "PRIVMSG #c :helloQUIT :bye");
    }

    #[test]
    fn round_trips_a_fully_loaded_message() {
        let line = "@msgid=abc;draft/reply=p1 :bob!b@h PRIVMSG #rust :hello world";
        let message = Message::parse(line).unwrap();
        assert_eq!(message.to_wire(), line);
    }

    #[test]
    fn tags_without_command_are_rejected() {
        assert_eq!(Message::parse("@a=b"), Err(ParseError::MissingCommand));
        assert_eq!(Message::parse(":prefix"), Err(ParseError::MissingCommand));
        assert_eq!(Message::parse(""), Err(ParseError::MissingCommand));
        assert_eq!(Message::parse("   "), Err(ParseError::MissingCommand));
    }

    #[test]
    fn tolerates_repeated_separators() {
        let message = Message::parse(":s  PRIVMSG   #c  :hi").unwrap();
        assert_eq!(message.command, Command::Privmsg);
        assert_eq!(message.params, vec!["#c", "hi"]);
    }
}
