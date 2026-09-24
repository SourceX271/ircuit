//! The connection driver: registration, keepalive, message plumbing and retry.
//!
//! One [`spawn`] call owns one network. The driver runs as a background task and
//! talks to the rest of the application through two channels: [`ClientCommand`]
//! in, [`NetworkEvent`] out. Nothing else in the process touches the socket, so
//! there is exactly one place where connection state lives.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::io::AsyncWrite;
use tokio::sync::mpsc;
use tokio::time::MissedTickBehavior;
use tracing::{debug, info, warn};

use ircuit_proto::{Command, Message, Prefix};

use crate::cap::{CapNegotiator, SaslOutcome};
use crate::config::ConnectionConfig;
use crate::error::Error;
use crate::reconnect::BackoffPolicy;
use crate::transport::{self, LineReader};

/// How often to send our own `PING`.
const PING_INTERVAL: Duration = Duration::from_secs(60);

/// How long the connection may stay completely silent before it is considered
/// dead. Three missed ping intervals, which tolerates a slow but healthy server
/// while still catching a half-open socket that TCP will never report.
const IDLE_TIMEOUT: Duration = Duration::from_secs(180);

/// How many times to append an underscore when a nickname is already taken.
const MAX_NICK_ATTEMPTS: u32 = 5;

/// Something the application asks a connection to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientCommand {
    Privmsg {
        target: String,
        text: String,
    },
    Notice {
        target: String,
        text: String,
    },
    Join(String),
    Part {
        channel: String,
        reason: Option<String>,
    },
    Nick(String),
    /// Set channel modes, e.g. `MODE #rust +o alice`.
    Mode {
        target: String,
        modes: String,
        args: Vec<String>,
    },
    /// Remove someone from a channel.
    Kick {
        channel: String,
        nick: String,
        reason: Option<String>,
    },
    /// Ask the server about someone.
    Whois(String),
    /// Read, set or clear a channel topic.
    ///
    /// `None` asks the server for the current topic, `Some("")` clears it. Those
    /// are different requests on the wire (`TOPIC #c` versus `TOPIC #c :`), so
    /// the distinction has to survive this far.
    Topic {
        channel: String,
        topic: Option<String>,
    },
    /// Set an away message, or clear it with `None`.
    Away {
        message: Option<String>,
    },
    /// Invite someone to a channel.
    Invite {
        nick: String,
        channel: String,
    },
    /// Send a raw protocol line. Intended for the command console.
    Raw(String),
    /// Close the connection and do not reconnect.
    Shutdown,
}

/// Something a connection wants the application to know about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetworkEvent {
    /// A connection attempt is starting. `attempt` counts from 1.
    Connecting { attempt: u32 },
    /// The socket is open, before registration.
    Connected,
    /// The server accepted us.
    Registered { nick: String, welcome: String },
    /// Every inbound protocol message, in order.
    Message(Box<Message>),
    /// A conversation line we sent ourselves, echoed locally.
    ///
    /// Only produced when the server did **not** grant `echo-message`, in which
    /// case nothing would otherwise come back and the user's own words would
    /// never appear. Exactly one of the two paths is ever active, which is why
    /// there is no de-duplication to do.
    LocalEcho(Box<Message>),
    /// Capabilities the server granted.
    Capabilities { negotiated: Vec<String> },
    /// The connection ended. `retrying` says whether another attempt follows.
    Disconnected { reason: String, retrying: bool },
}

/// Handle used by the application to talk to a running connection.
#[derive(Debug, Clone)]
pub struct NetworkHandle {
    commands: mpsc::Sender<ClientCommand>,
}

impl NetworkHandle {
    /// Queue a command for the connection.
    ///
    /// Fails only when the driver has stopped.
    pub async fn send(&self, command: ClientCommand) -> Result<(), Error> {
        self.commands
            .send(command)
            .await
            .map_err(|_| Error::Protocol("connection is closed".to_owned()))
    }

    /// Whether the driver is still running.
    #[must_use]
    pub fn is_running(&self) -> bool {
        !self.commands.is_closed()
    }
}

/// Start a connection.
///
/// Returns a handle plus the event stream. Dropping the event receiver stops the
/// driver, so callers must keep it alive for as long as they want the connection.
pub fn spawn(
    config: ConnectionConfig,
    policy: BackoffPolicy,
) -> (NetworkHandle, mpsc::Receiver<NetworkEvent>) {
    let (command_tx, command_rx) = mpsc::channel(64);
    let (event_tx, event_rx) = mpsc::channel(256);

    spawn_driver(run(config, policy, command_rx, event_tx));

    (
        NetworkHandle {
            commands: command_tx,
        },
        event_rx,
    )
}

fn spawn_driver<F>(future: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    tokio::spawn(future);
}

/// Why a single session ended.
enum SessionEnd {
    /// The user asked to stop, or the event stream was dropped.
    Stopped,
    Failed(Error),
}

async fn run(
    config: ConnectionConfig,
    policy: BackoffPolicy,
    mut commands: mpsc::Receiver<ClientCommand>,
    events: mpsc::Sender<NetworkEvent>,
) {
    let mut attempt: u32 = 0;

    loop {
        attempt += 1;

        if events
            .send(NetworkEvent::Connecting { attempt })
            .await
            .is_err()
        {
            return;
        }

        match run_session(&config, &mut commands, &events).await {
            SessionEnd::Stopped => {
                debug!("session stopped");
                return;
            }
            SessionEnd::Failed(error) => {
                let retrying = config.auto_reconnect && error.is_retryable();

                warn!(%error, retrying, "session ended");

                if events
                    .send(NetworkEvent::Disconnected {
                        reason: error.to_string(),
                        retrying,
                    })
                    .await
                    .is_err()
                {
                    return;
                }

                if !retrying {
                    return;
                }

                let delay = policy.delay(attempt, clock_seed());
                debug!(?delay, attempt, "waiting before reconnecting");

                // A user asking to quit during the wait must not be ignored.
                tokio::select! {
                    () = tokio::time::sleep(delay) => {}
                    command = commands.recv() => match command {
                        Some(ClientCommand::Shutdown) | None => return,
                        // Anything else queued while offline has no connection to
                        // travel over; dropping it is kinder than replaying a
                        // stale join into a future session.
                        Some(other) => debug!(?other, "dropping command queued while offline"),
                    },
                }
            }
        }
    }
}

async fn run_session(
    config: &ConnectionConfig,
    commands: &mut mpsc::Receiver<ClientCommand>,
    events: &mpsc::Sender<NetworkEvent>,
) -> SessionEnd {
    let transport = match transport::connect(config).await {
        Ok(transport) => transport,
        Err(error) => return SessionEnd::Failed(error),
    };

    if events.send(NetworkEvent::Connected).await.is_err() {
        return SessionEnd::Stopped;
    }

    let (read_half, mut writer) = tokio::io::split(transport);
    let mut reader = LineReader::new(read_half);

    let mut cap = CapNegotiator::new(config.sasl.clone());

    if let Err(error) = send_preamble(&mut writer, config, &cap).await {
        return SessionEnd::Failed(error);
    }

    let mut state = SessionState {
        nick: config.nick.clone(),
        nick_attempts: 0,
        registered: false,
    };

    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
    // The first tick completes immediately; skip it so the first PING is a
    // minute away rather than instantaneous.
    ping.tick().await;

    let mut last_inbound = Instant::now();

    loop {
        tokio::select! {
            line = reader.next_line() => match line {
                Ok(Some(text)) => {
                    last_inbound = Instant::now();

                    let message = match Message::parse(&text) {
                        Ok(message) => message,
                        // A line we cannot parse must not kill the connection.
                        Err(error) => {
                            debug!(%error, %text, "ignoring unparsable line");
                            continue;
                        }
                    };

                    let outcome = handle_inbound(
                        config,
                        &mut cap,
                        &mut state,
                        &message,
                        events,
                        &mut writer,
                    )
                    .await;

                    if let Some(end) = outcome {
                        return end;
                    }
                }
                Ok(None) => return SessionEnd::Failed(Error::Closed),
                Err(error) => return SessionEnd::Failed(error),
            },

            command = commands.recv() => match command {
                Some(ClientCommand::Shutdown) | None => {
                    // Best effort: the server may already be gone.
                    let _ = transport::write_line(&mut writer, "QUIT :Leaving").await;
                    return SessionEnd::Stopped;
                }
                Some(command) => {
                    let lines = command_to_lines(&command);

                    for line in &lines {
                        if let Err(error) = transport::write_line(&mut writer, line).await {
                            return SessionEnd::Failed(error);
                        }
                    }

                    // Without `echo-message` the server sends nothing back for our
                    // own PRIVMSG, so the message the user just typed would simply
                    // never appear. When the capability *is* granted the server's
                    // echo is authoritative, and echoing locally as well would
                    // duplicate every line.
                    if !cap.has("echo-message") {
                        for message in local_echoes(&lines, &state.nick) {
                            let _ = events.send(NetworkEvent::LocalEcho(Box::new(message))).await;
                        }
                    }
                }
            },

            _ = ping.tick() => {
                if last_inbound.elapsed() > IDLE_TIMEOUT {
                    return SessionEnd::Failed(Error::Protocol(format!(
                        "no data from the server for {}s",
                        IDLE_TIMEOUT.as_secs()
                    )));
                }

                let token = format!("ircuit{}", clock_seed());
                if let Err(error) =
                    transport::write_line(&mut writer, &format!("PING :{token}")).await
                {
                    return SessionEnd::Failed(error);
                }
            }
        }
    }
}

/// Mutable state that lives for one session.
struct SessionState {
    nick: String,
    nick_attempts: u32,
    registered: bool,
}

async fn send_preamble<W: AsyncWrite + Unpin>(
    writer: &mut W,
    config: &ConnectionConfig,
    cap: &CapNegotiator,
) -> Result<(), Error> {
    // PASS, if any, must precede registration.
    if let Some(password) = &config.server_password {
        transport::write_line(writer, &format!("PASS {password}")).await?;
    }

    for line in cap.opening_lines() {
        transport::write_line(writer, &line).await?;
    }

    transport::write_line(writer, &format!("NICK {}", config.nick)).await?;
    transport::write_line(
        writer,
        &Message::new(
            Command::User,
            [
                config.user.clone(),
                "0".to_owned(),
                "*".to_owned(),
                config.realname.clone(),
            ],
        )
        .to_wire(),
    )
    .await?;

    Ok(())
}

/// Handle one inbound message. `Some(end)` means the session is over.
async fn handle_inbound<W: AsyncWrite + Unpin>(
    config: &ConnectionConfig,
    cap: &mut CapNegotiator,
    state: &mut SessionState,
    message: &Message,
    events: &mpsc::Sender<NetworkEvent>,
    writer: &mut W,
) -> Option<SessionEnd> {
    // Capability negotiation first: it owns several message types.
    let was_finished = cap.is_finished();
    for line in cap.on_message(message) {
        if let Err(error) = transport::write_line(writer, &line).await {
            return Some(SessionEnd::Failed(error));
        }
    }

    if !was_finished && cap.is_finished() {
        if let SaslOutcome::Failed(reason) = cap.sasl_outcome() {
            warn!(%reason, "SASL authentication failed");
        }

        if !cap.negotiated().is_empty() {
            let _ = events
                .send(NetworkEvent::Capabilities {
                    negotiated: cap.negotiated().to_vec(),
                })
                .await;
        }
    }

    match &message.command {
        Command::Ping => {
            let token = message.param(0).unwrap_or_default();
            let line = Message::new(Command::Pong, [token.to_owned()]).to_wire();
            if let Err(error) = transport::write_line(writer, &line).await {
                return Some(SessionEnd::Failed(error));
            }
        }

        Command::Error => {
            let reason = message
                .params
                .last()
                .cloned()
                .unwrap_or_else(|| "server sent ERROR".to_owned());
            return Some(SessionEnd::Failed(Error::Protocol(reason)));
        }

        Command::Numeric(1) => {
            if !state.registered {
                state.registered = true;
                if let Some(nick) = message.param(0) {
                    state.nick = nick.to_owned();
                }

                let welcome = message.param(1).unwrap_or_default().to_owned();
                info!(nick = %state.nick, "registered");

                let _ = events
                    .send(NetworkEvent::Registered {
                        nick: state.nick.clone(),
                        welcome,
                    })
                    .await;
            }
        }

        // 433 ERR_NICKNAMEINUSE: pick another nick rather than giving up.
        Command::Numeric(433) if !state.registered => {
            state.nick_attempts += 1;

            if state.nick_attempts > MAX_NICK_ATTEMPTS {
                return Some(SessionEnd::Failed(Error::Protocol(
                    "every nickname we tried was already in use".to_owned(),
                )));
            }

            let fallback = format!("{}_{}", config.nick, state.nick_attempts);
            info!(%fallback, "nickname taken, trying another");

            if let Err(error) = transport::write_line(writer, &format!("NICK {fallback}")).await {
                return Some(SessionEnd::Failed(error));
            }
        }

        _ => {}
    }

    if events
        .send(NetworkEvent::Message(Box::new(message.clone())))
        .await
        .is_err()
    {
        return Some(SessionEnd::Stopped);
    }

    None
}

/// Turn an application command into protocol lines.
///
/// Public because the caller needs the exact text that goes on the wire: the app
/// layer mirrors outbound traffic into the server buffer, and reimplementing the
/// splitting and framing rules would let the two drift apart.
#[must_use]
pub fn command_to_lines(command: &ClientCommand) -> Vec<String> {
    match command {
        ClientCommand::Privmsg { target, text } => {
            split_to_messages(Command::Privmsg, target, text)
        }
        ClientCommand::Notice { target, text } => split_to_messages(Command::Notice, target, text),
        ClientCommand::Join(channel) => {
            vec![Message::new(Command::Join, [channel.clone()]).to_wire()]
        }
        ClientCommand::Part { channel, reason } => match reason {
            Some(reason) => {
                vec![Message::new(Command::Part, [channel.clone(), reason.clone()]).to_wire()]
            }
            None => vec![Message::new(Command::Part, [channel.clone()]).to_wire()],
        },
        ClientCommand::Nick(nick) => vec![Message::new(Command::Nick, [nick.clone()]).to_wire()],
        ClientCommand::Mode {
            target,
            modes,
            args,
        } => {
            let params = std::iter::once(target.clone())
                .chain(std::iter::once(modes.clone()))
                .chain(args.iter().cloned())
                .collect::<Vec<_>>();

            vec![Message::new(Command::Mode, params).to_wire()]
        }
        ClientCommand::Kick {
            channel,
            nick,
            reason,
        } => {
            let params = match reason {
                Some(reason) => vec![channel.clone(), nick.clone(), reason.clone()],
                None => vec![channel.clone(), nick.clone()],
            };

            vec![Message::new(Command::Kick, params).to_wire()]
        }
        ClientCommand::Whois(nick) => vec![Message::new(Command::Whois, [nick.clone()]).to_wire()],
        ClientCommand::Topic { channel, topic } => {
            let params = match topic {
                Some(topic) => vec![channel.clone(), topic.clone()],
                None => vec![channel.clone()],
            };

            vec![Message::new(Command::Topic, params).to_wire()]
        }
        ClientCommand::Away { message } => {
            let params: Vec<String> = message.iter().cloned().collect();
            vec![Message::new(Command::Away, params).to_wire()]
        }
        ClientCommand::Invite { nick, channel } => {
            vec![Message::new(Command::Invite, [nick.clone(), channel.clone()]).to_wire()]
        }
        ClientCommand::Raw(line) => {
            // Strip framing characters so a raw line cannot become two commands.
            let cleaned: String = line.chars().filter(|c| *c != '\r' && *c != '\n').collect();
            if cleaned.trim().is_empty() {
                Vec::new()
            } else {
                vec![cleaned]
            }
        }
        ClientCommand::Shutdown => Vec::new(),
    }
}

/// Build the local echo for the lines we are about to send.
///
/// The echoes are derived by parsing the very lines that go on the wire rather
/// than by rebuilding them from the command. That matters for two reasons: a
/// long message is split into several `PRIVMSG`s and each one has to appear, and
/// `/me` is a CTCP-framed `PRIVMSG` whose framing is what makes the UI render it
/// as an action. Rebuilding from the command would have to reproduce both rules,
/// and would drift the first time either changed.
///
/// Only conversation lines are echoed. A `MODE`, a `JOIN` or a `WHOIS` produces
/// its own visible result, and inventing a chat line for one would be noise.
fn local_echoes(lines: &[String], nick: &str) -> Vec<Message> {
    lines
        .iter()
        .filter_map(|line| {
            let mut message = Message::parse(line).ok()?;
            if !matches!(message.command, Command::Privmsg | Command::Notice) {
                return None;
            }

            // Attributed to us, so the normalizer marks it as our own line.
            message.prefix = Some(Prefix {
                nick: Some(nick.to_owned()),
                user: None,
                host: None,
            });

            Some(message)
        })
        .collect()
}

fn split_to_messages(command: Command, target: &str, text: &str) -> Vec<String> {
    match ircuit_proto::split_privmsg(target, text, ircuit_proto::MAX_LINE_BYTES) {
        Ok(chunks) => chunks
            .into_iter()
            .map(|chunk| Message::new(command.clone(), [target.to_owned(), chunk]).to_wire())
            .collect(),
        Err(error) => {
            // The target alone blew the budget; sending a truncated line is
            // better than silently dropping what the user typed.
            warn!(%error, "could not split message");
            vec![Message::new(command, [target.to_owned(), text.to_owned()]).to_wire()]
        }
    }
}

/// A changing seed for backoff jitter and ping tokens.
fn clock_seed() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn privmsg_becomes_a_protocol_line() {
        let lines = command_to_lines(&ClientCommand::Privmsg {
            target: "#rust".to_owned(),
            text: "hello world".to_owned(),
        });

        assert_eq!(lines, vec!["PRIVMSG #rust :hello world"]);
    }

    #[test]
    fn long_messages_are_split_into_several_lines() {
        let lines = command_to_lines(&ClientCommand::Privmsg {
            target: "#rust".to_owned(),
            text: "word ".repeat(400),
        });

        assert!(lines.len() > 1);
        for line in &lines {
            assert!(line.len() <= ircuit_proto::MAX_LINE_BYTES);
            assert!(line.starts_with("PRIVMSG #rust :"));
        }
    }

    #[test]
    fn part_includes_the_reason_only_when_given() {
        assert_eq!(
            command_to_lines(&ClientCommand::Part {
                channel: "#rust".to_owned(),
                reason: None,
            }),
            vec!["PART #rust"]
        );

        let with_reason = command_to_lines(&ClientCommand::Part {
            channel: "#rust".to_owned(),
            reason: Some("bye now".to_owned()),
        });
        assert_eq!(with_reason, vec!["PART #rust :bye now"]);
    }

    #[test]
    fn mode_changes_keep_their_arguments_in_order() {
        let lines = command_to_lines(&ClientCommand::Mode {
            target: "#rust".to_owned(),
            modes: "+ov".to_owned(),
            args: vec!["alice".to_owned(), "bob".to_owned()],
        });

        assert_eq!(lines, vec!["MODE #rust +ov alice bob"]);
    }

    #[test]
    fn a_mode_without_arguments_has_no_trailing_colon() {
        let lines = command_to_lines(&ClientCommand::Mode {
            target: "#rust".to_owned(),
            modes: "+m".to_owned(),
            args: Vec::new(),
        });

        assert_eq!(lines, vec!["MODE #rust +m"]);
    }

    #[test]
    fn kick_includes_the_reason_only_when_given() {
        let without = command_to_lines(&ClientCommand::Kick {
            channel: "#rust".to_owned(),
            nick: "alice".to_owned(),
            reason: None,
        });
        assert_eq!(without, vec!["KICK #rust alice"]);

        // A single-word reason needs no colon sigil; the wire form stays minimal.
        let single = command_to_lines(&ClientCommand::Kick {
            channel: "#rust".to_owned(),
            nick: "alice".to_owned(),
            reason: Some("spamming".to_owned()),
        });
        assert_eq!(single, vec!["KICK #rust alice spamming"]);

        // A reason with spaces does need it.
        let with = command_to_lines(&ClientCommand::Kick {
            channel: "#rust".to_owned(),
            nick: "alice".to_owned(),
            reason: Some("please stop".to_owned()),
        });
        assert_eq!(with, vec!["KICK #rust alice :please stop"]);
    }

    #[test]
    fn whois_names_its_target() {
        assert_eq!(
            command_to_lines(&ClientCommand::Whois("alice".to_owned())),
            vec!["WHOIS alice"]
        );
    }

    #[test]
    fn topic_query_set_and_clear_are_three_different_lines() {
        let query = command_to_lines(&ClientCommand::Topic {
            channel: "#rust".to_owned(),
            topic: None,
        });
        assert_eq!(query, vec!["TOPIC #rust"]);

        let set = command_to_lines(&ClientCommand::Topic {
            channel: "#rust".to_owned(),
            topic: Some("hello world".to_owned()),
        });
        assert_eq!(set, vec!["TOPIC #rust :hello world"]);

        // Clearing sends an empty trailing parameter, which is *not* the same
        // request as asking for the current topic.
        let clear = command_to_lines(&ClientCommand::Topic {
            channel: "#rust".to_owned(),
            topic: Some(String::new()),
        });
        assert_eq!(clear, vec!["TOPIC #rust :"]);
    }

    #[test]
    fn a_topic_cannot_inject_a_command() {
        let lines = command_to_lines(&ClientCommand::Topic {
            channel: "#rust".to_owned(),
            topic: Some("hi\r\nJOIN #evil".to_owned()),
        });

        assert_eq!(lines.len(), 1);
        assert!(!lines[0].contains('\r'));
        assert!(!lines[0].contains('\n'));
    }

    #[test]
    fn away_sets_and_clears() {
        // A one-word message needs no colon sigil, exactly like KICK's reason;
        // the wire form stays minimal and servers treat the two as equivalent.
        assert_eq!(
            command_to_lines(&ClientCommand::Away {
                message: Some("lunch".to_owned()),
            }),
            vec!["AWAY lunch"]
        );

        // A message with spaces does need it, or it would look like two params.
        assert_eq!(
            command_to_lines(&ClientCommand::Away {
                message: Some("out to lunch".to_owned()),
            }),
            vec!["AWAY :out to lunch"]
        );

        // Clearing sends the bare command.
        assert_eq!(
            command_to_lines(&ClientCommand::Away { message: None }),
            vec!["AWAY"]
        );
    }

    #[test]
    fn invite_names_both_parties() {
        assert_eq!(
            command_to_lines(&ClientCommand::Invite {
                nick: "alice".to_owned(),
                channel: "#rust".to_owned(),
            }),
            vec!["INVITE alice #rust"]
        );
    }

    #[test]
    fn a_malicious_nick_cannot_inject_a_command() {
        // Nicknames reach these commands from a channel's member list, which
        // means they come from the server, which means they come from whoever
        // registered them.
        let lines = command_to_lines(&ClientCommand::Whois("alice\r\nJOIN #evil".to_owned()));

        assert_eq!(lines.len(), 1);
        assert!(!lines[0].contains('\r'));
        assert!(!lines[0].contains('\n'));
    }

    #[test]
    fn raw_lines_cannot_smuggle_a_second_command() {
        let lines = command_to_lines(&ClientCommand::Raw(
            "PRIVMSG #a :hi\r\nQUIT :bye".to_owned(),
        ));

        assert_eq!(lines.len(), 1);
        assert!(!lines[0].contains('\r'));
        assert!(!lines[0].contains('\n'));
    }

    #[test]
    fn blank_raw_lines_are_dropped() {
        assert!(command_to_lines(&ClientCommand::Raw("   ".to_owned())).is_empty());
    }

    #[test]
    fn shutdown_produces_no_lines() {
        assert!(command_to_lines(&ClientCommand::Shutdown).is_empty());
    }

    #[test]
    fn pong_mirrors_the_ping_token() {
        let ping = Message::parse("PING :abc123").unwrap();
        let token = ping.param(0).unwrap_or_default();
        assert_eq!(
            Message::new(Command::Pong, [token.to_owned()]).to_wire(),
            "PONG abc123"
        );
    }

    #[test]
    fn clock_seed_changes_between_calls() {
        let first = clock_seed();
        std::thread::sleep(Duration::from_millis(2));
        assert_ne!(first, clock_seed());
    }

    #[test]
    fn a_sent_message_is_echoed_under_our_own_nickname() {
        let lines = command_to_lines(&ClientCommand::Privmsg {
            target: "#rust".to_owned(),
            text: "hello".to_owned(),
        });

        let echoes = local_echoes(&lines, "alice");

        assert_eq!(echoes.len(), 1);
        assert_eq!(echoes[0].command, Command::Privmsg);
        assert_eq!(echoes[0].param(0), Some("#rust"));
        assert_eq!(echoes[0].param(1), Some("hello"));
        // Attributed to us, which is what makes the normalizer mark it as our
        // own line rather than someone else's.
        assert_eq!(echoes[0].nick(), Some("alice"));
    }

    #[test]
    fn a_notice_is_echoed_too() {
        let lines = command_to_lines(&ClientCommand::Notice {
            target: "bob".to_owned(),
            text: "psst".to_owned(),
        });

        let echoes = local_echoes(&lines, "alice");

        assert_eq!(echoes.len(), 1);
        assert_eq!(echoes[0].command, Command::Notice);
    }

    #[test]
    fn a_long_message_produces_one_echo_per_line() {
        let lines = command_to_lines(&ClientCommand::Privmsg {
            target: "#rust".to_owned(),
            text: "x".repeat(ircuit_proto::MAX_LINE_BYTES * 2),
        });
        assert!(lines.len() > 1, "the fixture should have split the message");

        let echoes = local_echoes(&lines, "alice");

        // Rebuilding the echo from the command would have produced one line for
        // a message the user sees as several.
        assert_eq!(echoes.len(), lines.len());
    }

    #[test]
    fn an_action_keeps_its_ctcp_framing() {
        let lines = command_to_lines(&ClientCommand::Privmsg {
            target: "#rust".to_owned(),
            text: "\u{0001}ACTION waves\u{0001}".to_owned(),
        });

        let echoes = local_echoes(&lines, "alice");

        // The framing is what tells the UI to render this as an action rather
        // than as a plain message.
        assert_eq!(echoes.len(), 1);
        assert_eq!(echoes[0].param(1), Some("\u{0001}ACTION waves\u{0001}"));
    }

    #[test]
    fn commands_with_their_own_visible_result_are_not_echoed() {
        for command in [
            ClientCommand::Join("#rust".to_owned()),
            ClientCommand::Nick("bob".to_owned()),
            ClientCommand::Whois("alice".to_owned()),
            ClientCommand::Mode {
                target: "#rust".to_owned(),
                modes: "+m".to_owned(),
                args: Vec::new(),
            },
            ClientCommand::Topic {
                channel: "#rust".to_owned(),
                topic: Some("hi".to_owned()),
            },
            ClientCommand::Raw("PING :x".to_owned()),
        ] {
            let lines = command_to_lines(&command);
            assert!(
                local_echoes(&lines, "alice").is_empty(),
                "{command:?} should not invent a chat line"
            );
        }
    }
}
