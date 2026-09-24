//! A deliberately small IRC server, used to test the connection layer.
//!
//! It is not a server implementation and does not try to be: it exists so that
//! registration, capability negotiation, SASL, keepalive and reconnection can be
//! exercised deterministically, on loopback, without reaching the network.
//!
//! # Why it parses with string matching instead of `ircuit-proto`
//!
//! A mock that shares the parser with the code under test cannot detect parser
//! bugs: both sides would be wrong in the same way. Matching on prefixes keeps
//! the server an independent witness.
//!
//! # Example
//!
//! ```no_run
//! use ircuit_testserver::{ServerConfig, TestServer};
//!
//! # async fn example() {
//! let server = TestServer::start(ServerConfig::default()).await.unwrap();
//! println!("listening on {}", server.endpoint());
//! server.shutdown().await;
//! # }
//! ```

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{watch, Mutex, Notify};

/// Capabilities the server advertises by default.
pub const DEFAULT_CAPABILITIES: &[&str] = &["message-tags", "server-time", "echo-message", "sasl"];

/// How the server should behave.
#[derive(Debug, Clone)]
pub struct ServerConfig {
    /// Capabilities to advertise in `CAP LS`.
    pub capabilities: Vec<String>,
    /// Whether a client must complete SASL before it is registered.
    pub require_sasl: bool,
    /// Credentials accepted by `AUTHENTICATE PLAIN`.
    pub credentials: Option<(String, String)>,
    /// Reject the first nickname with `433` before accepting the next one.
    pub reject_first_nick: bool,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            capabilities: DEFAULT_CAPABILITIES
                .iter()
                .map(|cap| (*cap).to_owned())
                .collect(),
            require_sasl: false,
            credentials: None,
            reject_first_nick: false,
        }
    }
}

/// Everything the test can observe about a running server.
#[derive(Debug, Default)]
struct Shared {
    /// Every line received, in arrival order.
    received: Vec<String>,
    /// Channels the client joined.
    channels: Vec<String>,
    /// The nickname the server settled on.
    nick: Option<String>,
    /// Authentication result, once SASL has run.
    authenticated: Option<bool>,
}

struct Inner {
    shared: Mutex<Shared>,
    notify: Notify,
    /// Flipped to `true` to make the server hang up on every connection.
    drop_signal: watch::Sender<bool>,
}

/// A test server listening on an ephemeral loopback port.
pub struct TestServer {
    addr: SocketAddr,
    inner: Arc<Inner>,
    shutdown: watch::Sender<bool>,
}

impl TestServer {
    /// Bind an ephemeral loopback port and start accepting connections.
    pub async fn start(config: ServerConfig) -> std::io::Result<Self> {
        Self::start_on(0, config).await
    }

    /// Bind a specific port. Useful for manual testing, where the client has to
    /// be told the address in advance.
    pub async fn start_on(port: u16, config: ServerConfig) -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", port)).await?;
        let addr = listener.local_addr()?;

        let (drop_signal, _) = watch::channel(false);
        let (shutdown, mut shutdown_rx) = watch::channel(false);

        let inner = Arc::new(Inner {
            shared: Mutex::new(Shared::default()),
            notify: Notify::new(),
            drop_signal,
        });

        let accept_inner = Arc::clone(&inner);
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    accepted = listener.accept() => match accepted {
                        Ok((stream, _peer)) => {
                            let connection_inner = Arc::clone(&accept_inner);
                            let config = config.clone();
                            tokio::spawn(async move {
                                if let Err(error) = serve(stream, config, connection_inner).await {
                                    tracing::debug!(%error, "test connection ended");
                                }
                            });
                        }
                        Err(error) => {
                            tracing::debug!(%error, "accept failed");
                            break;
                        }
                    },
                    _ = shutdown_rx.changed() => break,
                }
            }
        });

        Ok(Self {
            addr,
            inner,
            shutdown,
        })
    }

    /// The bound address.
    #[must_use]
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// `127.0.0.1:<port>`, for logging.
    #[must_use]
    pub fn endpoint(&self) -> String {
        self.addr.to_string()
    }

    #[must_use]
    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    /// Every line received so far.
    pub async fn received(&self) -> Vec<String> {
        self.inner.shared.lock().await.received.clone()
    }

    /// The channels the client joined.
    pub async fn channels(&self) -> Vec<String> {
        self.inner.shared.lock().await.channels.clone()
    }

    /// Whether SASL succeeded, if it ran at all.
    pub async fn authenticated(&self) -> Option<bool> {
        self.inner.shared.lock().await.authenticated
    }

    /// Wait until a received line satisfies `predicate`.
    ///
    /// Returns `None` on timeout, so a failing test reports a timeout rather
    /// than hanging the suite.
    pub async fn wait_for_line(
        &self,
        predicate: impl Fn(&str) -> bool,
        timeout: Duration,
    ) -> Option<String> {
        let deadline = tokio::time::Instant::now() + timeout;

        loop {
            {
                let shared = self.inner.shared.lock().await;
                if let Some(line) = shared.received.iter().find(|line| predicate(line)) {
                    return Some(line.clone());
                }
            }

            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return None;
            }

            // Either a new line arrives, or we re-check when the deadline passes.
            let _ = tokio::time::timeout(remaining, self.inner.notify.notified()).await;
        }
    }

    /// Hang up on every live connection, to exercise reconnection.
    pub fn drop_connections(&self) {
        // Toggling the value wakes every connection's watcher.
        let next = !*self.inner.drop_signal.borrow();
        let _ = self.inner.drop_signal.send(next);
    }

    /// Stop accepting and close live connections.
    pub async fn shutdown(&self) {
        let _ = self.shutdown.send(true);
        self.drop_connections();
    }
}

async fn serve(stream: TcpStream, config: ServerConfig, inner: Arc<Inner>) -> std::io::Result<()> {
    let (read_half, mut writer) = stream.into_split();
    let mut reader = BufReader::new(read_half).lines();

    let mut session = ServerSession::new(config);
    let mut drop_rx = inner.drop_signal.subscribe();

    loop {
        tokio::select! {
            line = reader.next_line() => {
                let Some(line) = line? else { return Ok(()) };
                let line = line.trim_end_matches(['\r', '\n']).to_owned();

                {
                    let mut shared = inner.shared.lock().await;
                    shared.received.push(line.clone());
                }
                inner.notify.notify_waiters();

                let replies = session.handle(&line);

                for reply in replies {
                    writer.write_all(reply.as_bytes()).await?;
                    writer.write_all(b"\r\n").await?;
                }
                writer.flush().await?;

                if let Some(nick) = &session.nick {
                    inner.shared.lock().await.nick = Some(nick.clone());
                }
                if let Some(result) = session.authenticated {
                    inner.shared.lock().await.authenticated = Some(result);
                }
                if !session.channels.is_empty() {
                    let mut shared = inner.shared.lock().await;
                    shared.channels = session.channels.clone();
                }

                if session.should_close {
                    return Ok(());
                }
            }
            changed = drop_rx.changed() => {
                // The test asked us to hang up.
                if changed.is_ok() && *drop_rx.borrow() {
                    return Ok(());
                }
            }
        }
    }
}

/// Per-connection protocol state.
struct ServerSession {
    config: ServerConfig,
    nick: Option<String>,
    user_seen: bool,
    cap_negotiating: bool,
    authenticated: Option<bool>,
    channels: Vec<String>,
    should_close: bool,
    rejected_a_nick: bool,
}

impl ServerSession {
    fn new(config: ServerConfig) -> Self {
        Self {
            config,
            nick: None,
            user_seen: false,
            cap_negotiating: false,
            authenticated: None,
            channels: Vec::new(),
            should_close: false,
            rejected_a_nick: false,
        }
    }

    fn handle(&mut self, line: &str) -> Vec<String> {
        // Tags are irrelevant to the mock; skip them.
        let line = if let Some(rest) = line.strip_prefix('@') {
            match rest.split_once(' ') {
                Some((_, rest)) => rest,
                None => return Vec::new(),
            }
        } else {
            line
        };

        let mut parts = line.splitn(2, ' ');
        let verb = parts.next().unwrap_or_default();
        let rest = parts.next().unwrap_or_default();

        match verb.to_ascii_uppercase().as_str() {
            "CAP" => self.on_cap(rest),
            "NICK" => self.on_nick(rest.trim()),
            "USER" => {
                self.user_seen = true;
                self.maybe_register()
            }
            "AUTHENTICATE" => self.on_authenticate(rest.trim()),
            "PING" => {
                let token = rest.trim().trim_start_matches(':');
                vec![format!(":{SERVER_NAME} PONG {SERVER_NAME} :{token}")]
            }
            "JOIN" => self.on_join(rest.trim()),
            "PRIVMSG" => self.on_privmsg(rest),
            "QUIT" => {
                self.should_close = true;
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn on_cap(&mut self, rest: &str) -> Vec<String> {
        // Two shapes arrive here: the client's `CAP LS 302` and `CAP REQ :...`,
        // and the server's own `CAP * LS :...` form. Distinguish by whether the
        // first field is one of the subcommands.
        let (first, remainder) = rest.split_once(' ').unwrap_or((rest, ""));
        let first_upper = first.to_ascii_uppercase();

        let (subcommand, tail) = if matches!(first_upper.as_str(), "LS" | "REQ" | "END" | "LIST") {
            (first_upper, remainder)
        } else {
            match remainder.split_once(' ') {
                Some((subcommand, tail)) => (subcommand.to_ascii_uppercase(), tail),
                None => (remainder.to_ascii_uppercase(), ""),
            }
        };

        match subcommand.as_str() {
            "LS" => {
                self.cap_negotiating = true;
                let caps = self.config.capabilities.join(" ");
                vec![format!(":{SERVER_NAME} CAP * LS :{caps}")]
            }
            "REQ" => {
                let requested = tail.trim_start_matches(':');
                vec![format!(":{SERVER_NAME} CAP * ACK :{requested}")]
            }
            "END" => {
                self.cap_negotiating = false;
                self.maybe_register()
            }
            _ => Vec::new(),
        }
    }

    fn on_nick(&mut self, nick: &str) -> Vec<String> {
        if self.config.reject_first_nick && !self.rejected_a_nick {
            self.rejected_a_nick = true;
            return vec![format!(
                ":{SERVER_NAME} 433 * {nick} :Nickname is already in use."
            )];
        }

        self.nick = Some(nick.to_owned());
        self.maybe_register()
    }

    fn on_authenticate(&mut self, payload: &str) -> Vec<String> {
        if payload.eq_ignore_ascii_case("PLAIN") {
            return vec!["AUTHENTICATE +".to_owned()];
        }

        if payload == "*" {
            self.authenticated = Some(false);
            return Vec::new();
        }

        let decoded = BASE64.decode(payload).unwrap_or_default();
        let parts: Vec<&[u8]> = decoded.split(|byte| *byte == 0).collect();

        // PLAIN is `authzid NUL authcid NUL passwd`.
        let ok = match (&self.config.credentials, parts.as_slice()) {
            (Some((account, password)), [_, authcid, passwd]) => {
                *authcid == account.as_bytes() && *passwd == password.as_bytes()
            }
            _ => false,
        };

        self.authenticated = Some(ok);

        if ok {
            let nick = self.nick.clone().unwrap_or_else(|| "*".to_owned());
            vec![
                format!(":{SERVER_NAME} 900 {nick} {nick}!user@host {nick} :You are now logged in"),
                format!(":{SERVER_NAME} 903 {nick} :SASL authentication successful"),
            ]
        } else {
            let nick = self.nick.clone().unwrap_or_else(|| "*".to_owned());
            vec![format!(
                ":{SERVER_NAME} 904 {nick} :SASL authentication failed"
            )]
        }
    }

    fn on_join(&mut self, rest: &str) -> Vec<String> {
        let channel = rest.trim().trim_start_matches(':');
        if channel.is_empty() {
            return Vec::new();
        }

        self.channels.push(channel.to_owned());
        let nick = self.nick.clone().unwrap_or_else(|| "*".to_owned());

        // The greeting is not decoration: it gives a manual tester (or a visual
        // check) something to look at without needing a second client. Between
        // them these lines cover member prefixes, message grouping, mIRC
        // formatting and link detection.
        vec![
            format!(":{nick}!user@host JOIN {channel}"),
            format!(":{SERVER_NAME} 353 {nick} = {channel} :@{nick} alice +bob carol"),
            format!(":{SERVER_NAME} 366 {nick} {channel} :End of /NAMES list."),
            format!(":alice!alice@host PRIVMSG {channel} :Welcome to {channel}, {nick}!"),
            format!(":bob!bob@host PRIVMSG {channel} :this is a mock server"),
            format!(":bob!bob@host PRIVMSG {channel} :sent twice in a row, so it should group"),
            format!(
                ":carol!carol@host PRIVMSG {channel} :\u{0002}bold\u{0002}, \
                 \u{001D}italic\u{001D}, \u{001F}underlined\u{001F}, \
                 \u{0003}04red\u{0003} and \u{0003}09green\u{0003}"
            ),
            format!(":carol!carol@host PRIVMSG {channel} :spec is at https://ircv3.net/irc/"),
            format!(
                ":alice!alice@host PRIVMSG {channel} :history: \
                 https://en.wikipedia.org/wiki/IRC_(Internet_Relay_Chat), and www.irc.org"
            ),
        ]
    }

    /// Echo the message back, which is what `echo-message` promises.
    fn on_privmsg(&mut self, rest: &str) -> Vec<String> {
        let (target, text) = match rest.split_once(' ') {
            Some((target, text)) => (target, text.trim_start_matches(':')),
            None => return Vec::new(),
        };

        let nick = self.nick.clone().unwrap_or_else(|| "*".to_owned());

        vec![format!(":{nick}!user@host PRIVMSG {target} :{text}")]
    }

    fn maybe_register(&mut self) -> Vec<String> {
        if self.cap_negotiating || self.nick.is_none() || !self.user_seen {
            return Vec::new();
        }

        if self.config.require_sasl && self.authenticated != Some(true) {
            // Nudge the client once SASL is configured but unfinished.
            return Vec::new();
        }

        let nick = self.nick.clone().unwrap_or_default();

        vec![
            format!(":{SERVER_NAME} 001 {nick} :Welcome to the test network, {nick}"),
            format!(":{SERVER_NAME} 002 {nick} :Your host is {SERVER_NAME}"),
            format!(":{SERVER_NAME} 005 {nick} CASEMAPPING=rfc1459 CHANTYPES=# :are supported"),
            format!(":{SERVER_NAME} NOTICE {nick} :You are connected to the mock server"),
        ]
    }
}

const SERVER_NAME: &str = "test.server";

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> ServerSession {
        ServerSession::new(ServerConfig::default())
    }

    #[test]
    fn cap_ls_advertises_the_configured_capabilities() {
        let replies = session().handle("CAP LS 302");
        assert_eq!(replies.len(), 1);
        assert!(replies[0].contains("message-tags"));
    }

    #[test]
    fn registration_waits_for_nick_user_and_cap_end() {
        let mut session = session();

        assert!(session.handle("CAP LS 302").len() == 1);
        assert!(
            session.handle("NICK alice").is_empty(),
            "nick alone is not enough"
        );
        assert!(
            session.handle("USER alice 0 * :Alice").is_empty(),
            "CAP must finish first"
        );

        let replies = session.handle("CAP END");
        assert!(
            replies.iter().any(|line| line.contains(" 001 ")),
            "expected a welcome numeric, got {replies:?}"
        );
    }

    #[test]
    fn nick_conflict_is_reported_once() {
        let mut session = ServerSession::new(ServerConfig {
            reject_first_nick: true,
            ..ServerConfig::default()
        });

        let replies = session.handle("NICK alice");
        assert!(replies[0].contains("433"));

        let replies = session.handle("NICK alice_");
        assert!(replies.is_empty() || !replies[0].contains("433"));
    }

    #[test]
    fn sasl_plain_is_verified() {
        let mut session = ServerSession::new(ServerConfig {
            credentials: Some(("alice".to_owned(), "hunter2".to_owned())),
            ..ServerConfig::default()
        });

        assert_eq!(session.handle("AUTHENTICATE PLAIN"), vec!["AUTHENTICATE +"]);

        let payload = BASE64.encode("\0alice\0hunter2");
        let replies = session.handle(&format!("AUTHENTICATE {payload}"));
        assert!(replies.iter().any(|line| line.contains(" 903 ")));
        assert_eq!(session.authenticated, Some(true));
    }

    #[test]
    fn sasl_rejects_a_wrong_password() {
        let mut session = ServerSession::new(ServerConfig {
            credentials: Some(("alice".to_owned(), "hunter2".to_owned())),
            ..ServerConfig::default()
        });

        let payload = BASE64.encode("\0alice\0wrong");
        let replies = session.handle(&format!("AUTHENTICATE {payload}"));

        assert!(replies.iter().any(|line| line.contains(" 904 ")));
        assert_eq!(session.authenticated, Some(false));
    }

    #[test]
    fn requiring_sasl_blocks_registration_until_it_succeeds() {
        let mut session = ServerSession::new(ServerConfig {
            require_sasl: true,
            credentials: Some(("alice".to_owned(), "hunter2".to_owned())),
            ..ServerConfig::default()
        });

        assert!(session.handle("NICK alice").is_empty());
        assert!(session.handle("USER a 0 * :A").is_empty());
        assert!(
            session.handle("CAP END").is_empty(),
            "registration must be withheld without SASL"
        );

        let payload = BASE64.encode("\0alice\0hunter2");
        session.handle(&format!("AUTHENTICATE {payload}"));

        let replies = session.handle("CAP END");
        assert!(replies.iter().any(|line| line.contains(" 001 ")));
    }

    #[test]
    fn ping_is_answered() {
        let replies = session().handle("PING :abc");
        assert_eq!(replies, vec![":test.server PONG test.server :abc"]);
    }

    #[test]
    fn cap_req_keeps_the_whole_capability_list() {
        let replies = session().handle("CAP REQ :message-tags server-time");
        assert_eq!(
            replies,
            vec![":test.server CAP * ACK :message-tags server-time"]
        );
    }

    #[test]
    fn join_returns_nick_names_and_end_of_names() {
        let mut session = session();
        session.nick = Some("alice".to_owned());

        let replies = session.handle("JOIN #rust");

        assert!(replies[0].contains("JOIN #rust"));
        assert!(replies.iter().any(|line| line.contains(" 353 ")));
        assert!(replies.iter().any(|line| line.contains(" 366 ")));
        assert_eq!(session.channels, vec!["#rust"]);
    }

    #[test]
    fn privmsg_is_echoed_with_the_sender_prefix() {
        let mut session = session();
        session.nick = Some("alice".to_owned());

        let replies = session.handle("PRIVMSG #rust :hello world");
        assert_eq!(replies, vec![":alice!user@host PRIVMSG #rust :hello world"]);
    }

    #[test]
    fn tags_are_ignored_when_matching_the_verb() {
        let mut session = session();
        session.nick = Some("alice".to_owned());

        let replies = session.handle("@label=1 PRIVMSG #rust :hi");
        assert!(replies[0].contains("PRIVMSG #rust :hi"));
    }
}
