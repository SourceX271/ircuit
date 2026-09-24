//! Run the mock IRC server on its own, for manual and visual testing.
//!
//! ```text
//! cargo run -p ircuit-testserver --bin ircuit-testserver
//! # then point a client at 127.0.0.1:6667 without TLS
//! ```
//!
//! Port comes from `IRCUIT_TESTSERVER_PORT` and defaults to 6667. This is a test
//! fixture, not a server: it implements just enough of the protocol to exercise
//! the client, and it will happily accept any nickname or password configured
//! through the environment.

use std::time::Duration;

use ircuit_testserver::{ServerConfig, TestServer};
use tracing::info;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("IRCUIT_LOG")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let port: u16 = std::env::var("IRCUIT_TESTSERVER_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(6667);

    let credentials = match (
        std::env::var("IRCUIT_TESTSERVER_ACCOUNT"),
        std::env::var("IRCUIT_TESTSERVER_PASSWORD"),
    ) {
        (Ok(account), Ok(password)) => Some((account, password)),
        _ => None,
    };

    let mut capabilities: Vec<String> = ircuit_testserver::DEFAULT_CAPABILITIES
        .iter()
        .map(|cap| (*cap).to_owned())
        .collect();

    // Withholding `echo-message` is how the client's local-echo path gets
    // exercised by hand: without it the server sends nothing back for our own
    // PRIVMSG, so the only thing on screen is what the client echoed itself.
    if std::env::var("IRCUIT_TESTSERVER_NO_ECHO").is_ok() {
        capabilities.retain(|cap| cap != "echo-message");
    }

    let config = ServerConfig {
        capabilities,
        require_sasl: std::env::var("IRCUIT_TESTSERVER_REQUIRE_SASL").is_ok(),
        credentials,
        flood: std::env::var("IRCUIT_TESTSERVER_FLOOD")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(0),
        ..ServerConfig::default()
    };

    let server = TestServer::start_on(port, config).await?;
    info!("mock IRC server listening on {}", server.endpoint());
    info!("capabilities: {}", server.capabilities().join(" "));

    // Run until interrupted.
    loop {
        tokio::time::sleep(Duration::from_secs(3600)).await;
    }
}
