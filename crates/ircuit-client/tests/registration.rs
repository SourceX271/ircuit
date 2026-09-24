//! End-to-end tests for the connection layer against an in-process server.
//!
//! These cover the parts that unit tests cannot: that the socket is actually
//! opened, that negotiation and registration happen in the right order, and that
//! a dropped connection recovers. Everything runs on loopback, so the suite is
//! deterministic and works without network access.

use std::time::Duration;

use tokio::sync::mpsc;

use ircuit_client::{
    spawn, BackoffPolicy, ClientCommand, ConnectionConfig, NetworkEvent, SaslConfig, TlsMode,
};
use ircuit_proto::Command;
use ircuit_testserver::{ServerConfig, TestServer};

/// Generous enough for a loaded CI machine, short enough that a hang fails
/// rather than stalls the suite.
const TIMEOUT: Duration = Duration::from_secs(15);

fn local(server: &TestServer, nick: &str) -> ConnectionConfig {
    let mut config = ConnectionConfig::new("127.0.0.1", nick);
    config.tls = TlsMode::Plain;
    config.port = server.port();
    config
}

/// Pull events until one satisfies `predicate`, or the deadline passes.
async fn wait_for(
    events: &mut mpsc::Receiver<NetworkEvent>,
    predicate: impl Fn(&NetworkEvent) -> bool,
) -> Option<NetworkEvent> {
    let deadline = tokio::time::Instant::now() + TIMEOUT;

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return None;
        }

        match tokio::time::timeout(remaining, events.recv()).await {
            Ok(Some(event)) => {
                if predicate(&event) {
                    return Some(event);
                }
            }
            // Channel closed or deadline passed.
            Ok(None) | Err(_) => return None,
        }
    }
}

async fn wait_for_registration(events: &mut mpsc::Receiver<NetworkEvent>) -> Option<String> {
    match wait_for(events, |event| {
        matches!(event, NetworkEvent::Registered { .. })
    })
    .await
    {
        Some(NetworkEvent::Registered { nick, .. }) => Some(nick),
        _ => None,
    }
}

#[tokio::test]
async fn registers_and_reports_the_negotiated_capabilities() {
    let server = TestServer::start(ServerConfig::default()).await.unwrap();
    let (handle, mut events) = spawn(local(&server, "alice"), BackoffPolicy::immediate());

    assert!(
        wait_for(&mut events, |event| matches!(
            event,
            NetworkEvent::Connected
        ))
        .await
        .is_some(),
        "the socket never came up"
    );

    match wait_for(&mut events, |event| {
        matches!(event, NetworkEvent::Capabilities { .. })
    })
    .await
    {
        Some(NetworkEvent::Capabilities { negotiated }) => {
            assert!(
                negotiated.iter().any(|cap| cap == "message-tags"),
                "expected message-tags, got {negotiated:?}"
            );
        }
        other => panic!("expected a Capabilities event, got {other:?}"),
    }

    assert_eq!(
        wait_for_registration(&mut events).await.as_deref(),
        Some("alice")
    );

    // The client must have announced itself before registration.
    let received = server.received().await;
    assert!(received.iter().any(|line| line == "CAP LS 302"));
    assert!(received.iter().any(|line| line == "NICK alice"));
    assert!(received.iter().any(|line| line.starts_with("USER alice")));
    assert!(received.iter().any(|line| line == "CAP END"));

    let _ = handle.send(ClientCommand::Shutdown).await;
    server.shutdown().await;
}

#[tokio::test]
async fn joining_a_channel_reaches_the_server() {
    let server = TestServer::start(ServerConfig::default()).await.unwrap();
    let (handle, mut events) = spawn(local(&server, "alice"), BackoffPolicy::immediate());
    assert!(wait_for_registration(&mut events).await.is_some());

    handle
        .send(ClientCommand::Join("#rust".to_owned()))
        .await
        .unwrap();

    assert!(server
        .wait_for_line(|line| line == "JOIN #rust", TIMEOUT)
        .await
        .is_some());
    assert_eq!(server.channels().await, vec!["#rust"]);

    // The server answers a JOIN with a NAMES burst, which must come through.
    let names = wait_for(&mut events, |event| {
        matches!(event, NetworkEvent::Message(message) if message.command == Command::Numeric(353))
    })
    .await;
    assert!(names.is_some(), "no 353 RPL_NAMREPLY arrived");

    let _ = handle.send(ClientCommand::Shutdown).await;
    server.shutdown().await;
}

#[tokio::test]
async fn a_topic_round_trips_through_the_server() {
    let server = TestServer::start(ServerConfig::default()).await.unwrap();
    let (handle, mut events) = spawn(local(&server, "alice"), BackoffPolicy::immediate());
    assert!(wait_for_registration(&mut events).await.is_some());

    handle
        .send(ClientCommand::Join("#rust".to_owned()))
        .await
        .unwrap();
    assert!(server
        .wait_for_line(|line| line == "JOIN #rust", TIMEOUT)
        .await
        .is_some());

    // Query first: the server has no topic yet, so 331 comes back.
    handle
        .send(ClientCommand::Topic {
            channel: "#rust".to_owned(),
            topic: None,
        })
        .await
        .unwrap();
    assert!(
        wait_for(&mut events, |event| {
            matches!(event, NetworkEvent::Message(message) if message.command == Command::Numeric(331))
        })
        .await
        .is_some(),
        "a bare TOPIC should ask the server for the current topic"
    );

    // Set one. The wire form needs the colon sigil because the text has a space.
    handle
        .send(ClientCommand::Topic {
            channel: "#rust".to_owned(),
            topic: Some("hello world".to_owned()),
        })
        .await
        .unwrap();
    assert!(server
        .wait_for_line(|line| line == "TOPIC #rust :hello world", TIMEOUT)
        .await
        .is_some());
    assert_eq!(server.topic("#rust").await.as_deref(), Some("hello world"));

    // The echo proves the change is visible to the client, not just accepted.
    assert!(
        wait_for(&mut events, |event| {
            matches!(event, NetworkEvent::Message(message) if message.command == Command::Topic)
        })
        .await
        .is_some(),
        "the topic change never came back"
    );

    // Clearing sends an empty trailing parameter, which is a different request
    // from asking what the topic is.
    handle
        .send(ClientCommand::Topic {
            channel: "#rust".to_owned(),
            topic: Some(String::new()),
        })
        .await
        .unwrap();
    assert!(server
        .wait_for_line(|line| line == "TOPIC #rust :", TIMEOUT)
        .await
        .is_some());
    assert_eq!(server.topic("#rust").await, None);

    let _ = handle.send(ClientCommand::Shutdown).await;
    server.shutdown().await;
}

#[tokio::test]
async fn notice_away_invite_and_mode_reach_the_server() {
    let server = TestServer::start(ServerConfig::default()).await.unwrap();
    let (handle, mut events) = spawn(local(&server, "alice"), BackoffPolicy::immediate());
    assert!(wait_for_registration(&mut events).await.is_some());

    handle
        .send(ClientCommand::Notice {
            target: "bob".to_owned(),
            text: "psst there".to_owned(),
        })
        .await
        .unwrap();
    assert!(server
        .wait_for_line(|line| line == "NOTICE bob :psst there", TIMEOUT)
        .await
        .is_some());

    handle
        .send(ClientCommand::Away {
            message: Some("out to lunch".to_owned()),
        })
        .await
        .unwrap();
    assert!(server
        .wait_for_line(|line| line == "AWAY :out to lunch", TIMEOUT)
        .await
        .is_some());
    assert_eq!(server.away().await.as_deref(), Some("out to lunch"));

    // The 306 acknowledgement is what the user sees, so it has to come back.
    assert!(
        wait_for(&mut events, |event| {
            matches!(event, NetworkEvent::Message(message) if message.command == Command::Numeric(306))
        })
        .await
        .is_some(),
        "no 306 RPL_NOWAWAY arrived"
    );

    handle
        .send(ClientCommand::Away { message: None })
        .await
        .unwrap();
    assert!(server
        .wait_for_line(|line| line == "AWAY", TIMEOUT)
        .await
        .is_some());
    assert_eq!(server.away().await, None);

    handle
        .send(ClientCommand::Invite {
            nick: "bob".to_owned(),
            channel: "#rust".to_owned(),
        })
        .await
        .unwrap();
    assert!(server
        .wait_for_line(|line| line == "INVITE bob #rust", TIMEOUT)
        .await
        .is_some());

    // A privilege change is just a MODE with an argument, which is why the
    // client keeps one general path for all of them.
    handle
        .send(ClientCommand::Mode {
            target: "#rust".to_owned(),
            modes: "+o".to_owned(),
            args: vec!["bob".to_owned()],
        })
        .await
        .unwrap();
    assert!(server
        .wait_for_line(|line| line == "MODE #rust +o bob", TIMEOUT)
        .await
        .is_some());

    let _ = handle.send(ClientCommand::Shutdown).await;
    server.shutdown().await;
}

#[tokio::test]
async fn leaving_a_channel_reaches_the_server() {
    let server = TestServer::start(ServerConfig::default()).await.unwrap();
    let (handle, mut events) = spawn(local(&server, "alice"), BackoffPolicy::immediate());
    assert!(wait_for_registration(&mut events).await.is_some());

    handle
        .send(ClientCommand::Join("#rust".to_owned()))
        .await
        .unwrap();
    assert!(server
        .wait_for_line(|line| line == "JOIN #rust", TIMEOUT)
        .await
        .is_some());

    handle
        .send(ClientCommand::Part {
            channel: "#rust".to_owned(),
            reason: Some("done here".to_owned()),
        })
        .await
        .unwrap();
    assert!(server
        .wait_for_line(|line| line == "PART #rust :done here", TIMEOUT)
        .await
        .is_some());
    assert!(server.channels().await.is_empty());

    let _ = handle.send(ClientCommand::Shutdown).await;
    server.shutdown().await;
}

#[tokio::test]
async fn a_sent_message_is_echoed_back() {
    let server = TestServer::start(ServerConfig::default()).await.unwrap();
    let (handle, mut events) = spawn(local(&server, "alice"), BackoffPolicy::immediate());
    assert!(wait_for_registration(&mut events).await.is_some());

    handle
        .send(ClientCommand::Privmsg {
            target: "#rust".to_owned(),
            text: "hello world".to_owned(),
        })
        .await
        .unwrap();

    let echoed = wait_for(&mut events, |event| {
        matches!(
            event,
            NetworkEvent::Message(message)
                if message.command == Command::Privmsg
                    && message.param(1) == Some("hello world")
        )
    })
    .await;

    assert!(echoed.is_some(), "the message never came back");
    assert!(server
        .wait_for_line(|line| line == "PRIVMSG #rust :hello world", TIMEOUT)
        .await
        .is_some());

    let _ = handle.send(ClientCommand::Shutdown).await;
    server.shutdown().await;
}

#[tokio::test]
async fn a_taken_nickname_is_retried_automatically() {
    let server = TestServer::start(ServerConfig {
        reject_first_nick: true,
        ..ServerConfig::default()
    })
    .await
    .unwrap();

    let (handle, mut events) = spawn(local(&server, "alice"), BackoffPolicy::immediate());

    // The server rejects "alice" with a 433; the client must try a variant
    // rather than sitting there unregistered.
    assert_eq!(
        wait_for_registration(&mut events).await.as_deref(),
        Some("alice_1"),
        "the nickname conflict was not recovered from"
    );

    let _ = handle.send(ClientCommand::Shutdown).await;
    server.shutdown().await;
}

#[tokio::test]
async fn sasl_plain_authenticates_before_registration() {
    let server = TestServer::start(ServerConfig {
        require_sasl: true,
        credentials: Some(("alice".to_owned(), "hunter2".to_owned())),
        ..ServerConfig::default()
    })
    .await
    .unwrap();

    let mut config = local(&server, "alice");
    config.sasl = Some(SaslConfig::Plain {
        account: "alice".to_owned(),
        password: "hunter2".to_owned(),
    });

    let (handle, mut events) = spawn(config, BackoffPolicy::immediate());

    assert_eq!(
        wait_for_registration(&mut events).await.as_deref(),
        Some("alice")
    );
    assert_eq!(server.authenticated().await, Some(true));

    let received = server.received().await;
    assert!(received.iter().any(|line| line == "AUTHENTICATE PLAIN"));

    let _ = handle.send(ClientCommand::Shutdown).await;
    server.shutdown().await;
}

#[tokio::test]
async fn a_rejected_password_does_not_break_the_connection() {
    let server = TestServer::start(ServerConfig {
        require_sasl: false,
        credentials: Some(("alice".to_owned(), "hunter2".to_owned())),
        ..ServerConfig::default()
    })
    .await
    .unwrap();

    let mut config = local(&server, "alice");
    config.sasl = Some(SaslConfig::Plain {
        account: "alice".to_owned(),
        password: "definitely-wrong".to_owned(),
    });

    let (handle, mut events) = spawn(config, BackoffPolicy::immediate());

    // Registration still completes; the failure is reported, not fatal.
    assert!(wait_for_registration(&mut events).await.is_some());
    assert_eq!(server.authenticated().await, Some(false));

    let _ = handle.send(ClientCommand::Shutdown).await;
    server.shutdown().await;
}

#[tokio::test]
async fn the_client_reconnects_after_the_server_hangs_up() {
    let server = TestServer::start(ServerConfig::default()).await.unwrap();
    let (handle, mut events) = spawn(local(&server, "alice"), BackoffPolicy::immediate());
    assert!(wait_for_registration(&mut events).await.is_some());

    server.drop_connections();

    match wait_for(&mut events, |event| {
        matches!(event, NetworkEvent::Disconnected { .. })
    })
    .await
    {
        Some(NetworkEvent::Disconnected { retrying, .. }) => {
            assert!(retrying, "a dropped socket should be retried");
        }
        other => panic!("expected a Disconnected event, got {other:?}"),
    }

    let reconnecting = wait_for(
        &mut events,
        |event| matches!(event, NetworkEvent::Connecting { attempt } if *attempt >= 2),
    )
    .await;
    assert!(reconnecting.is_some(), "no second connection attempt");

    assert!(
        wait_for_registration(&mut events).await.is_some(),
        "did not register again after reconnecting"
    );

    let _ = handle.send(ClientCommand::Shutdown).await;
    server.shutdown().await;
}

#[tokio::test]
async fn shutdown_says_goodbye_and_stops_the_driver() {
    let server = TestServer::start(ServerConfig::default()).await.unwrap();
    let (handle, mut events) = spawn(local(&server, "alice"), BackoffPolicy::immediate());
    assert!(wait_for_registration(&mut events).await.is_some());

    handle.send(ClientCommand::Shutdown).await.unwrap();

    // Draining returns `None` once the driver drops the event sender.
    assert!(wait_for(&mut events, |_| false).await.is_none());
    assert!(!handle.is_running());

    assert!(server
        .wait_for_line(|line| line.starts_with("QUIT"), TIMEOUT)
        .await
        .is_some());

    // Sending after shutdown must fail rather than silently queue forever.
    assert!(handle.send(ClientCommand::Shutdown).await.is_err());

    server.shutdown().await;
}

/// Manual check against a real network.
///
/// Ignored by default because it needs outbound internet access, which CI and
/// sandboxes do not have. Run it explicitly:
///
/// ```text
/// cargo test -p ircuit-client --test registration -- --ignored --nocapture
/// ```
///
/// It defaults to OFTC, which accepts unauthenticated connections, and prints
/// every lifecycle event so a failure is diagnosable from the log alone.
///
/// Override with environment variables:
///
/// - `IRCUIT_TEST_SERVER` — defaults to `irc.oftc.net`
/// - `IRCUIT_TEST_NICK` — defaults to a process-unique name
/// - `IRCUIT_TEST_SASL_ACCOUNT` / `IRCUIT_TEST_SASL_PASSWORD` — needed by
///   networks such as Libera.Chat, which refuses registration from many hosting
///   ranges unless the client authenticates.
#[tokio::test]
#[ignore = "requires outbound internet access"]
async fn registers_with_a_real_network_over_tls() {
    let server = std::env::var("IRCUIT_TEST_SERVER").unwrap_or_else(|_| "irc.oftc.net".to_owned());
    let nick = std::env::var("IRCUIT_TEST_NICK")
        .unwrap_or_else(|_| format!("ircuit{}", std::process::id() % 100_000));

    let mut config = ConnectionConfig::new(&server, &nick);
    config.realname = "Ircuit integration test".to_owned();

    if let (Ok(account), Ok(password)) = (
        std::env::var("IRCUIT_TEST_SASL_ACCOUNT"),
        std::env::var("IRCUIT_TEST_SASL_PASSWORD"),
    ) {
        config.sasl = Some(ircuit_client::SaslConfig::Plain { account, password });
    }

    println!("connecting to {server} as {nick}");
    let (handle, mut events) = spawn(config, BackoffPolicy::immediate());

    let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
    let mut registered = None;
    let mut capabilities = Vec::new();
    let mut failures = Vec::new();

    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(5), events.recv()).await {
            Ok(Some(NetworkEvent::Registered { nick, welcome })) => {
                println!("registered as {nick}: {welcome}");
                registered = Some(nick);
            }
            Ok(Some(NetworkEvent::Capabilities { negotiated })) => {
                println!("capabilities: {negotiated:?}");
                capabilities = negotiated;
            }
            Ok(Some(NetworkEvent::Disconnected { reason, retrying })) => {
                println!("disconnected (retrying={retrying}): {reason}");
                failures.push(reason);
            }
            // Raw messages are far too noisy to print in full.
            Ok(Some(NetworkEvent::Message(_))) => {}
            Ok(Some(event)) => println!("{event:?}"),
            Ok(None) => {
                println!("event stream closed");
                break;
            }
            Err(_) => println!("(no event for 5s)"),
        }

        if registered.is_some() && !capabilities.is_empty() {
            break;
        }
    }

    println!("negotiated capabilities: {capabilities:?}");

    assert!(
        registered.is_some(),
        "never registered with {server}; failures: {failures:?}"
    );

    // Which capabilities a network offers varies wildly — OFTC advertises only
    // `multi-prefix`, Libera advertises a dozen — so assert that negotiation
    // happened at all rather than pinning a specific capability.
    assert!(
        !capabilities.is_empty(),
        "capability negotiation produced nothing; failures: {failures:?}"
    );

    let _ = handle.send(ClientCommand::Shutdown).await;
}
