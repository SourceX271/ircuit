//! Everything needed to open one network connection.

use crate::error::Error;

/// Whether to wrap the connection in TLS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TlsMode {
    /// Plain TCP. Only reasonable for a local test server.
    Plain,
    /// TLS from the first byte.
    Tls,
}

impl TlsMode {
    /// The port to use when the user has not specified one.
    #[must_use]
    pub fn default_port(self) -> u16 {
        match self {
            Self::Plain => 6667,
            Self::Tls => 6697,
        }
    }
}

/// How to authenticate with SASL.
///
/// SCRAM-SHA-256 is deliberately absent for now: it needs HMAC/PBKDF2 and a
/// multi-round exchange, and it is scheduled alongside client certificates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaslConfig {
    /// `AUTHENTICATE PLAIN`, sending account and password.
    Plain { account: String, password: String },
    /// `AUTHENTICATE EXTERNAL`, proving identity with a TLS client certificate.
    External { authzid: Option<String> },
}

impl SaslConfig {
    /// The mechanism name as sent to the server.
    #[must_use]
    pub fn mechanism(&self) -> &'static str {
        match self {
            Self::Plain { .. } => "PLAIN",
            Self::External { .. } => "EXTERNAL",
        }
    }

    /// The first `AUTHENTICATE` payload, already base64-encoded.
    ///
    /// An empty string means the mechanism has nothing to send up front; the
    /// caller must transmit `+` instead.
    #[must_use]
    pub fn initial_payload(&self) -> String {
        crate::sasl::initial_payload(self)
    }
}

/// Configuration for a single network connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionConfig {
    pub host: String,
    pub port: u16,
    pub tls: TlsMode,
    /// The nickname to request.
    pub nick: String,
    /// The ident/username reported to the server.
    pub user: String,
    /// The real name reported to the server.
    pub realname: String,
    /// `PASS` sent before registration, for servers that require one.
    pub server_password: Option<String>,
    pub sasl: Option<SaslConfig>,
    /// Whether to reconnect automatically after the connection drops.
    pub auto_reconnect: bool,
}

impl ConnectionConfig {
    /// A configuration with sensible defaults for a public network.
    #[must_use]
    pub fn new(host: impl Into<String>, nick: impl Into<String>) -> Self {
        let host = host.into();
        let nick = nick.into();

        Self {
            port: TlsMode::Tls.default_port(),
            tls: TlsMode::Tls,
            user: nick.clone(),
            realname: nick.clone(),
            host,
            nick,
            server_password: None,
            sasl: None,
            auto_reconnect: true,
        }
    }

    /// Check the configuration before tearing down an existing connection.
    ///
    /// Returning a [`Error::Config`] here is what stops a typo from turning into
    /// an infinite reconnect loop.
    pub fn validate(&self) -> Result<(), Error> {
        if self.host.trim().is_empty() {
            return Err(Error::Config("server host is empty".to_owned()));
        }
        if self.port == 0 {
            return Err(Error::Config("port must be between 1 and 65535".to_owned()));
        }
        if self.nick.trim().is_empty() {
            return Err(Error::Config("nickname is empty".to_owned()));
        }
        if self
            .nick
            .contains([' ', ',', '*', '?', '!', '@', '\r', '\n'])
        {
            return Err(Error::Config(format!(
                "nickname {:?} contains a character IRC does not allow",
                self.nick
            )));
        }
        if self.user.contains([' ', '\r', '\n']) {
            return Err(Error::Config("username must not contain spaces".to_owned()));
        }
        if let Some(SaslConfig::Plain { account, .. }) = &self.sasl {
            if account.trim().is_empty() {
                return Err(Error::Config("SASL account is empty".to_owned()));
            }
        }

        Ok(())
    }

    /// The `host:port` pair, for logs.
    #[must_use]
    pub fn endpoint(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_defaults_to_tls_on_the_tls_port() {
        let config = ConnectionConfig::new("irc.libera.chat", "alice");
        assert_eq!(config.tls, TlsMode::Tls);
        assert_eq!(config.port, 6697);
        assert_eq!(config.user, "alice");
        assert_eq!(config.realname, "alice");
        assert!(config.auto_reconnect);
    }

    #[test]
    fn plain_defaults_to_the_classic_port() {
        assert_eq!(TlsMode::Plain.default_port(), 6667);
        assert_eq!(TlsMode::Tls.default_port(), 6697);
    }

    #[test]
    fn a_sane_config_validates() {
        assert!(ConnectionConfig::new("irc.libera.chat", "alice")
            .validate()
            .is_ok());
    }

    #[test]
    fn empty_host_and_nick_are_rejected() {
        assert!(ConnectionConfig::new("", "alice").validate().is_err());
        assert!(ConnectionConfig::new("host", "").validate().is_err());
        assert!(ConnectionConfig::new("host", "   ").validate().is_err());
    }

    #[test]
    fn nick_characters_that_break_the_protocol_are_rejected() {
        for bad in ["a b", "a,b", "a*b", "a?b", "a!b", "a@b", "a\nb"] {
            let config = ConnectionConfig::new("host", bad);
            assert!(config.validate().is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn zero_port_is_rejected() {
        let mut config = ConnectionConfig::new("host", "alice");
        config.port = 0;
        assert!(config.validate().is_err());
    }

    #[test]
    fn sasl_plain_requires_an_account() {
        let mut config = ConnectionConfig::new("host", "alice");
        config.sasl = Some(SaslConfig::Plain {
            account: "  ".to_owned(),
            password: "secret".to_owned(),
        });
        assert!(config.validate().is_err());
    }

    #[test]
    fn sasl_external_needs_no_account() {
        let mut config = ConnectionConfig::new("host", "alice");
        config.sasl = Some(SaslConfig::External { authzid: None });
        assert!(config.validate().is_ok());
        assert_eq!(config.sasl.unwrap().mechanism(), "EXTERNAL");
    }
}
