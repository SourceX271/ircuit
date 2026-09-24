//! Network manager: owns the live connections and turns their events into IPC.
//!
//! There is exactly one of these per application. It is the only place that
//! knows which networks exist, and the only place that translates the connection
//! layer's vocabulary into the UI's.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event as _;
use tokio::sync::{mpsc, Mutex};
use tracing::{debug, info, warn};

use ircuit_client::{
    command_to_lines, spawn, BackoffPolicy, ClientCommand, ConnectionConfig, NetworkEvent,
    NetworkHandle, SaslConfig, TlsMode,
};
use ircuit_state::view::{self, MessageKind as ViewMessageKind};

use crate::events::{
    ConnectionState, CoreStatus, IncomingMessage, MessageKind, NetworkBacklog, NetworkStatus,
    RawTraffic, TrafficDirection,
};

/// How often the core status heartbeat fires.
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(2);

/// What the UI sends when creating a connection.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct NetworkRequest {
    pub host: String,
    /// `0` means "the default port for the chosen transport".
    pub port: u16,
    pub tls: bool,
    pub nick: String,
    /// Defaults to the nickname when empty.
    pub realname: Option<String>,
    /// SASL account; SASL is only enabled when both account and password are set.
    pub sasl_account: Option<String>,
    pub sasl_password: Option<String>,
}

/// A network as the UI sees it.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct NetworkSummary {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub tls: bool,
    pub state: ConnectionState,
    pub nick: Option<String>,
    pub capabilities: Vec<String>,
    pub detail: Option<String>,
    pub attempt: u32,
}

struct Entry {
    handle: NetworkHandle,
    summary: NetworkSummary,
    /// Recent normalized lines, so a late subscriber can catch up.
    messages: VecDeque<IncomingMessage>,
    /// Recent raw lines, for the server buffer.
    traffic: VecDeque<RawTraffic>,
    /// Sequence counter shared by both streams of this network.
    seq: u32,
}

/// How many recent events to keep per network for replay.
///
/// Bounded on purpose: this bridges the gap for a late subscriber, it is not
/// history. M3 moves the real log into SQLite with paging and search.
const BACKLOG_MESSAGES: usize = 500;
const BACKLOG_TRAFFIC: usize = 1000;

fn push_bounded<T>(buffer: &mut VecDeque<T>, item: T, capacity: usize) {
    buffer.push_back(item);
    while buffer.len() > capacity {
        buffer.pop_front();
    }
}

impl NetworkSummary {
    /// Project onto the event the UI listens to.
    fn to_status(&self) -> NetworkStatus {
        NetworkStatus {
            network_id: self.id.clone(),
            name: self.name.clone(),
            host: self.host.clone(),
            port: self.port,
            tls: self.tls,
            state: self.state,
            nick: self.nick.clone(),
            capabilities: self.capabilities.clone(),
            detail: self.detail.clone(),
            attempt: self.attempt,
        }
    }
}

/// Owns every live connection.
#[derive(Default)]
pub struct NetworkManager {
    networks: Mutex<HashMap<String, Entry>>,
}

impl NetworkManager {
    /// Start a connection and start forwarding its events to the UI.
    ///
    /// Connecting to an endpoint that is already connected replaces the old
    /// connection, which is what a user pressing "connect" twice expects.
    pub async fn connect(
        self: &Arc<Self>,
        app: &AppHandle,
        request: NetworkRequest,
    ) -> Result<NetworkSummary, String> {
        let config = build_config(&request)?;
        let id = format!("{}:{}", config.host, config.port);

        if self.networks.lock().await.contains_key(&id) {
            debug!(%id, "replacing an existing connection");
            let _ = self.disconnect(&id).await;
        }

        let (handle, events) = spawn(config.clone(), BackoffPolicy::default());

        let summary = NetworkSummary {
            id: id.clone(),
            name: config.host.clone(),
            host: config.host.clone(),
            port: config.port,
            tls: config.tls == TlsMode::Tls,
            state: ConnectionState::Connecting,
            nick: None,
            capabilities: Vec::new(),
            detail: None,
            attempt: 0,
        };

        self.networks.lock().await.insert(
            id.clone(),
            Entry {
                handle: handle.clone(),
                summary: summary.clone(),
                messages: VecDeque::new(),
                traffic: VecDeque::new(),
                seq: 0,
            },
        );

        let manager = Arc::clone(self);
        let app_handle = app.clone();
        let start_nick = config.nick.clone();

        info!(%id, "connection started");

        tokio::spawn(async move {
            pump(app_handle, manager, id, start_nick, events).await;
        });

        let _ = summary.to_status().emit(app);

        Ok(summary)
    }

    /// Close a connection and stop retrying it.
    pub async fn disconnect(&self, network_id: &str) -> Result<(), String> {
        let entry = self.networks.lock().await.remove(network_id);

        match entry {
            Some(entry) => entry
                .handle
                .send(ClientCommand::Shutdown)
                .await
                .map_err(|error| error.to_string()),
            None => Err(format!("no such network: {network_id}")),
        }
    }

    /// Send a command, mirroring the resulting protocol lines into the server
    /// buffer so the user can see exactly what went on the wire.
    pub async fn send(
        &self,
        app: &AppHandle,
        network_id: &str,
        command: ClientCommand,
    ) -> Result<(), String> {
        let handle = {
            let networks = self.networks.lock().await;
            networks.get(network_id).map(|entry| entry.handle.clone())
        }
        .ok_or_else(|| format!("no such network: {network_id}"))?;

        for line in command_to_lines(&command) {
            let traffic = RawTraffic {
                network_id: network_id.to_owned(),
                direction: TrafficDirection::Outbound,
                line,
                timestamp: now_seconds(),
                seq: self.next_seq(network_id).await,
            };
            let _ = traffic.clone().emit(app);
            self.record_traffic(network_id, traffic).await;
        }

        handle
            .send(command)
            .await
            .map_err(|error| error.to_string())
    }

    /// Every known network, in stable id order so the UI list does not jump.
    pub async fn list(&self) -> Vec<NetworkSummary> {
        let networks = self.networks.lock().await;
        let mut summaries: Vec<NetworkSummary> = networks
            .values()
            .map(|entry| entry.summary.clone())
            .collect();
        summaries.sort_by(|left, right| left.id.cmp(&right.id));
        summaries
    }

    /// Remember a normalized line for late subscribers.
    async fn record_message(&self, network_id: &str, message: IncomingMessage) {
        let mut networks = self.networks.lock().await;
        if let Some(entry) = networks.get_mut(network_id) {
            push_bounded(&mut entry.messages, message, BACKLOG_MESSAGES);
        }
    }

    /// The next sequence number for a network's event stream.
    ///
    /// One counter covers both messages and raw traffic, so the UI only has to
    /// remember a single high-water mark per network.
    async fn next_seq(&self, network_id: &str) -> u32 {
        let mut networks = self.networks.lock().await;
        match networks.get_mut(network_id) {
            Some(entry) => {
                entry.seq = entry.seq.wrapping_add(1);
                entry.seq
            }
            None => 0,
        }
    }

    /// Remember a raw protocol line for late subscribers.
    async fn record_traffic(&self, network_id: &str, traffic: RawTraffic) {
        let mut networks = self.networks.lock().await;
        if let Some(entry) = networks.get_mut(network_id) {
            push_bounded(&mut entry.traffic, traffic, BACKLOG_TRAFFIC);
        }
    }

    /// Everything emitted for a network so far, oldest first.
    ///
    /// The UI calls this once after mounting. Without it, a connection opened at
    /// startup would have its whole registration handshake invisible: Tauri
    /// events are fire-and-forget, not a queue.
    pub async fn backlog(&self, network_id: &str) -> Option<NetworkBacklog> {
        let networks = self.networks.lock().await;
        let entry = networks.get(network_id)?;

        Some(NetworkBacklog {
            network_id: network_id.to_owned(),
            messages: entry.messages.iter().cloned().collect(),
            traffic: entry.traffic.iter().cloned().collect(),
        })
    }

    /// How many networks are registered, for the heartbeat.
    pub async fn registered_count(&self) -> u32 {
        let networks = self.networks.lock().await;
        let count = networks
            .values()
            .filter(|entry| entry.summary.state == ConnectionState::Registered)
            .count();

        u32::try_from(count).unwrap_or(u32::MAX)
    }

    /// Apply a change to one network's summary and push it to the UI.
    async fn mutate(
        &self,
        app: &AppHandle,
        network_id: &str,
        change: impl FnOnce(&mut NetworkSummary),
    ) {
        let updated = {
            let mut networks = self.networks.lock().await;
            let Some(entry) = networks.get_mut(network_id) else {
                // The user disconnected while this event was in flight.
                return;
            };
            change(&mut entry.summary);
            entry.summary.clone()
        };

        let _ = updated.to_status().emit(app);
    }
}

/// Forward one connection's events to the UI until it stops.
async fn pump(
    app: AppHandle,
    manager: Arc<NetworkManager>,
    network_id: String,
    mut self_nick: String,
    mut events: mpsc::Receiver<NetworkEvent>,
) {
    while let Some(event) = events.recv().await {
        match event {
            NetworkEvent::Connecting { attempt } => {
                manager
                    .mutate(&app, &network_id, |summary| {
                        summary.state = ConnectionState::Connecting;
                        summary.attempt = attempt;
                        summary.detail = None;
                    })
                    .await;
            }

            NetworkEvent::Connected => {
                manager
                    .mutate(&app, &network_id, |summary| {
                        summary.state = ConnectionState::Connected;
                    })
                    .await;
            }

            NetworkEvent::Registered { nick, .. } => {
                self_nick.clone_from(&nick);
                manager
                    .mutate(&app, &network_id, |summary| {
                        summary.state = ConnectionState::Registered;
                        summary.nick = Some(nick.clone());
                        summary.detail = None;
                    })
                    .await;
            }

            NetworkEvent::Capabilities { negotiated } => {
                manager
                    .mutate(&app, &network_id, |summary| {
                        summary.capabilities = negotiated.clone();
                    })
                    .await;
            }

            NetworkEvent::Disconnected { reason, retrying } => {
                manager
                    .mutate(&app, &network_id, |summary| {
                        summary.state = if retrying {
                            ConnectionState::Connecting
                        } else {
                            ConnectionState::Disconnected
                        };
                        summary.detail = Some(reason.clone());
                    })
                    .await;
            }

            NetworkEvent::Message(message) => {
                let timestamp = now_seconds();

                let traffic = RawTraffic {
                    network_id: network_id.clone(),
                    direction: TrafficDirection::Inbound,
                    line: message.to_wire(),
                    timestamp,
                    seq: manager.next_seq(&network_id).await,
                };
                let _ = traffic.clone().emit(&app);
                manager.record_traffic(&network_id, traffic).await;

                if let Some(normalized) = view::normalize(Some(&self_nick), &message, timestamp) {
                    let incoming = IncomingMessage {
                        network_id: network_id.clone(),
                        nick: normalized.nick,
                        kind: convert_kind(normalized.kind),
                        target: normalized.target,
                        text: normalized.text,
                        timestamp: normalized.timestamp,
                        is_self: normalized.is_self,
                        seq: manager.next_seq(&network_id).await,
                    };
                    let _ = incoming.clone().emit(&app);
                    manager.record_message(&network_id, incoming).await;
                }
            }
        }
    }

    // The event stream ended, so the driver is gone.
    manager
        .mutate(&app, &network_id, |summary| {
            summary.state = ConnectionState::Disconnected;
        })
        .await;

    warn!(%network_id, "connection driver stopped");
}

fn convert_kind(kind: ViewMessageKind) -> MessageKind {
    match kind {
        ViewMessageKind::Message => MessageKind::Message,
        ViewMessageKind::Notice => MessageKind::Notice,
        ViewMessageKind::Action => MessageKind::Action,
        ViewMessageKind::System => MessageKind::System,
    }
}

/// Turn a UI request into a validated connection configuration.
fn build_config(request: &NetworkRequest) -> Result<ConnectionConfig, String> {
    let tls = if request.tls {
        TlsMode::Tls
    } else {
        TlsMode::Plain
    };

    let mut config = ConnectionConfig::new(request.host.trim(), request.nick.trim());
    config.tls = tls;
    config.port = if request.port == 0 {
        tls.default_port()
    } else {
        request.port
    };

    if let Some(realname) = request
        .realname
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        config.realname = realname.to_owned();
    }

    // SASL is opt-in: an account with no password is far more likely to be a
    // half-filled form than an empty password.
    if let (Some(account), Some(password)) = (&request.sasl_account, &request.sasl_password) {
        if !account.trim().is_empty() {
            config.sasl = Some(SaslConfig::Plain {
                account: account.trim().to_owned(),
                password: password.clone(),
            });
        }
    }

    config.validate().map_err(|error| error.to_string())?;

    Ok(config)
}

/// Periodically report core status so the UI can tell the backend is alive.
pub fn spawn_status_heartbeat(app: AppHandle, manager: Arc<NetworkManager>) {
    let started = std::time::Instant::now();

    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(HEARTBEAT_INTERVAL);

        loop {
            ticker.tick().await;

            let elapsed = started.elapsed().as_secs();
            let status = CoreStatus {
                uptime_seconds: u32::try_from(elapsed).unwrap_or(u32::MAX),
                connected_networks: manager.registered_count().await,
                active_buffers: 0,
            };

            if status.emit(&app).is_err() {
                // The window is gone; nothing left to report to.
                return;
            }
        }
    });
}

fn now_seconds() -> u32 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u32::try_from(since.as_secs()).unwrap_or(u32::MAX)
        })
}

/// Development affordance: connect straight from the environment.
///
/// ```text
/// IRCUIT_AUTOCONNECT = <host>:<port>:<nick>[:plain]
/// IRCUIT_AUTOJOIN    = #channel
/// ```
///
/// Debug builds only, and deliberately so: it exists so a developer — or an
/// automated visual check — can reach a live session without filling in a form,
/// while the form stays the only way in for a release build.
#[cfg(debug_assertions)]
pub fn maybe_autoconnect(app: AppHandle, manager: Arc<NetworkManager>) {
    let Ok(spec) = std::env::var("IRCUIT_AUTOCONNECT") else {
        return;
    };

    let mut parts = spec.split(':');
    let Some(host) = parts.next().filter(|part| !part.is_empty()) else {
        warn!(%spec, "IRCUIT_AUTOCONNECT needs at least a host");
        return;
    };

    let port = parts
        .next()
        .and_then(|part| part.parse::<u16>().ok())
        .unwrap_or(TlsMode::Tls.default_port());

    let nick = parts
        .next()
        .filter(|part| !part.is_empty())
        .unwrap_or("ircuit-dev")
        .to_owned();

    let tls = !parts
        .next()
        .is_some_and(|mode| mode.eq_ignore_ascii_case("plain"));

    let request = NetworkRequest {
        host: host.to_owned(),
        port,
        tls,
        nick,
        realname: Some("Ircuit development session".to_owned()),
        sasl_account: None,
        sasl_password: None,
    };

    let channel = std::env::var("IRCUIT_AUTOJOIN")
        .ok()
        .filter(|value| !value.is_empty());

    info!(%spec, "autoconnecting from IRCUIT_AUTOCONNECT");

    tauri::async_runtime::spawn(async move {
        let network = match manager.connect(&app, request).await {
            Ok(network) => network,
            Err(error) => {
                warn!(%error, "autoconnect failed");
                return;
            }
        };

        let Some(channel) = channel else {
            return;
        };

        // A JOIN sent before registration completes is dropped by the server, so
        // wait for the state rather than guessing a delay.
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(100)).await;

            let registered = manager.list().await.iter().any(|candidate| {
                candidate.id == network.id && candidate.state == ConnectionState::Registered
            });

            if registered {
                if let Err(error) = manager
                    .send(&app, &network.id, ClientCommand::Join(channel))
                    .await
                {
                    warn!(%error, "autoconnect could not join");
                }
                return;
            }
        }

        warn!("autoconnect gave up waiting for registration");
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> NetworkRequest {
        NetworkRequest {
            host: "irc.libera.chat".to_owned(),
            port: 0,
            tls: true,
            nick: "alice".to_owned(),
            realname: None,
            sasl_account: None,
            sasl_password: None,
        }
    }

    #[test]
    fn port_zero_follows_the_transport() {
        let config = build_config(&request()).unwrap();
        assert_eq!(config.port, 6697);

        let mut plain = request();
        plain.tls = false;
        assert_eq!(build_config(&plain).unwrap().port, 6667);
    }

    #[test]
    fn an_explicit_port_is_kept() {
        let mut request = request();
        request.port = 7000;
        assert_eq!(build_config(&request).unwrap().port, 7000);
    }

    #[test]
    fn realname_defaults_to_the_nick_but_can_be_overridden() {
        assert_eq!(build_config(&request()).unwrap().realname, "alice");

        let mut with_realname = request();
        with_realname.realname = Some("Alice Liddell".to_owned());
        assert_eq!(
            build_config(&with_realname).unwrap().realname,
            "Alice Liddell"
        );
    }

    #[test]
    fn whitespace_only_values_are_ignored() {
        let mut request = request();
        request.host = "  irc.example.net  ".to_owned();
        request.realname = Some("   ".to_owned());

        let config = build_config(&request).unwrap();
        assert_eq!(config.host, "irc.example.net");
        assert_eq!(config.realname, "alice");
    }

    #[test]
    fn sasl_needs_both_account_and_password() {
        let mut account_only = request();
        account_only.sasl_account = Some("alice".to_owned());
        assert!(build_config(&account_only).unwrap().sasl.is_none());

        let mut both = request();
        both.sasl_account = Some("alice".to_owned());
        both.sasl_password = Some("hunter2".to_owned());
        let sasl = build_config(&both).unwrap().sasl.unwrap();
        assert_eq!(sasl.mechanism(), "PLAIN");
    }

    #[test]
    fn a_blank_account_does_not_enable_sasl() {
        let mut request = request();
        request.sasl_account = Some("   ".to_owned());
        request.sasl_password = Some("hunter2".to_owned());
        assert!(build_config(&request).unwrap().sasl.is_none());
    }

    #[test]
    fn a_bad_nickname_is_reported_before_connecting() {
        let mut request = request();
        request.nick = "bad nick".to_owned();
        assert!(build_config(&request).is_err());
    }

    #[test]
    fn an_empty_host_is_rejected() {
        let mut request = request();
        request.host = "   ".to_owned();
        assert!(build_config(&request).is_err());
    }

    #[test]
    fn message_kinds_map_across_the_boundary() {
        assert_eq!(convert_kind(ViewMessageKind::Message), MessageKind::Message);
        assert_eq!(convert_kind(ViewMessageKind::Notice), MessageKind::Notice);
        assert_eq!(convert_kind(ViewMessageKind::Action), MessageKind::Action);
        assert_eq!(convert_kind(ViewMessageKind::System), MessageKind::System);
    }

    #[tokio::test]
    async fn a_fresh_manager_knows_nothing() {
        let manager = NetworkManager::default();
        assert!(manager.list().await.is_empty());
        assert_eq!(manager.registered_count().await, 0);
    }

    #[tokio::test]
    async fn disconnecting_an_unknown_network_is_an_error_not_a_panic() {
        let manager = NetworkManager::default();
        assert!(manager.disconnect("nope").await.is_err());
    }
}
