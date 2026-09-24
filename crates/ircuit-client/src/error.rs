//! Errors surfaced by the connection layer.

use thiserror::Error;

/// Anything that can go wrong while talking to a server.
#[derive(Debug, Error)]
pub enum Error {
    #[error("could not connect to {host}:{port}: {source}")]
    Connect {
        host: String,
        port: u16,
        #[source]
        source: std::io::Error,
    },

    #[error("TLS handshake with {host} failed: {message}")]
    Tls { host: String, message: String },

    #[error(transparent)]
    Io(#[from] std::io::Error),

    /// A line without a terminator exceeded the read buffer. A server that does
    /// this is either broken or hostile, so the connection is closed rather than
    /// growing the buffer without bound.
    #[error("incoming line exceeded {limit} bytes without a terminator")]
    LineTooLong { limit: usize },

    #[error("server closed the connection")]
    Closed,

    #[error("protocol violation: {0}")]
    Protocol(String),

    #[error("SASL authentication failed: {0}")]
    Sasl(String),

    #[error("invalid configuration: {0}")]
    Config(String),
}

impl Error {
    /// Whether retrying could plausibly succeed.
    ///
    /// Configuration mistakes and protocol violations are permanent: retrying
    /// them just produces a loop of identical failures.
    #[must_use]
    pub fn is_retryable(&self) -> bool {
        match self {
            Self::Connect { .. } | Self::Closed | Self::Io(_) => true,
            Self::LineTooLong { .. } => true,
            Self::Tls { .. } | Self::Sasl(_) | Self::Config(_) | Self::Protocol(_) => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transient_failures_are_retryable() {
        assert!(Error::Closed.is_retryable());
        assert!(Error::Io(std::io::Error::other("reset")).is_retryable());
        assert!(Error::LineTooLong { limit: 1024 }.is_retryable());
    }

    #[test]
    fn permanent_failures_are_not_retryable() {
        assert!(!Error::Config("nick is empty".to_owned()).is_retryable());
        assert!(!Error::Sasl("bad password".to_owned()).is_retryable());
        assert!(!Error::Protocol("no 001".to_owned()).is_retryable());
    }
}
