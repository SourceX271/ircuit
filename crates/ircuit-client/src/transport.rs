//! Transport: opening the socket, wrapping it in TLS, and reading lines.

use std::io;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::task::{Context, Poll};

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader, ReadBuf};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

use crate::config::{ConnectionConfig, TlsMode};
use crate::error::Error;

/// Cap on a single inbound line.
///
/// IRCv3 allows an 8 KiB tag section plus the classic 512-byte message, so this
/// leaves generous headroom while still refusing to grow the buffer without
/// bound if a peer never sends a terminator.
pub const MAX_INBOUND_LINE_BYTES: usize = 64 * 1024;

/// A byte stream to the server, plain or TLS-wrapped.
pub enum Transport {
    Plain(TcpStream),
    Tls(Box<tokio_rustls::client::TlsStream<TcpStream>>),
}

// Manual implementation: the wrapped streams carry no useful printable state,
// and deriving would only expose socket internals in logs.
impl std::fmt::Debug for Transport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Plain(_) => "Transport::Plain",
            Self::Tls(_) => "Transport::Tls",
        })
    }
}

impl AsyncRead for Transport {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_read(cx, buf),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for Transport {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_write(cx, buf),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_flush(cx),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_shutdown(cx),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_shutdown(cx),
        }
    }
}

/// The TLS client configuration, shared by every connection.
///
/// M4 replaces this with a per-network configuration so that client
/// certificates and self-signed exceptions can differ between networks.
fn tls_config() -> Result<Arc<rustls::ClientConfig>, Error> {
    static CONFIG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();

    if let Some(config) = CONFIG.get() {
        return Ok(Arc::clone(config));
    }

    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());

    // Name the provider explicitly rather than relying on the process default:
    // a provider that is never installed is discovered at runtime, which would
    // mean a panic the first time a user connects.
    let provider = Arc::new(rustls::crypto::ring::default_provider());

    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|error| Error::Tls {
            host: "<configuration>".to_owned(),
            message: error.to_string(),
        })?
        .with_root_certificates(roots)
        .with_no_client_auth();

    let config = Arc::new(config);
    // Losing the race just means another thread stored an equivalent config.
    let _ = CONFIG.set(Arc::clone(&config));

    Ok(CONFIG.get().map_or(config, Arc::clone))
}

/// Open a connection according to `config`.
pub async fn connect(config: &ConnectionConfig) -> Result<Transport, Error> {
    config.validate()?;

    let stream = TcpStream::connect((config.host.as_str(), config.port))
        .await
        .map_err(|source| Error::Connect {
            host: config.host.clone(),
            port: config.port,
            source,
        })?;

    // IRC is a latency-sensitive line protocol; batching would delay messages.
    stream.set_nodelay(true).ok();

    match config.tls {
        TlsMode::Plain => Ok(Transport::Plain(stream)),
        TlsMode::Tls => {
            let server_name = rustls::pki_types::ServerName::try_from(config.host.clone())
                .map_err(|error| Error::Tls {
                    host: config.host.clone(),
                    message: format!("invalid server name: {error}"),
                })?;

            let connector = TlsConnector::from(tls_config()?);
            let tls = connector
                .connect(server_name, stream)
                .await
                .map_err(|error| Error::Tls {
                    host: config.host.clone(),
                    message: error.to_string(),
                })?;

            Ok(Transport::Tls(Box::new(tls)))
        }
    }
}

/// Reads newline-terminated lines, decoding them as UTF-8.
///
/// IRC is byte-oriented and old networks are not UTF-8, so decoding is lossy
/// rather than fallible: a mojibake message beats a dropped connection. The real
/// encoding negotiation lands in M4.
pub struct LineReader<R> {
    reader: BufReader<R>,
    buffer: Vec<u8>,
    limit: usize,
}

impl<R: AsyncRead + Unpin> LineReader<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader: BufReader::with_capacity(8 * 1024, reader),
            buffer: Vec::with_capacity(512),
            limit: MAX_INBOUND_LINE_BYTES,
        }
    }

    /// Override the inbound line cap. Only useful in tests.
    #[must_use]
    pub fn with_limit(mut self, limit: usize) -> Self {
        self.limit = limit;
        self
    }

    /// The next line, or `None` at end of stream.
    pub async fn next_line(&mut self) -> Result<Option<String>, Error> {
        self.buffer.clear();

        loop {
            let available = self.reader.fill_buf().await?;

            if available.is_empty() {
                return if self.buffer.is_empty() {
                    Ok(None)
                } else {
                    // A final line without a terminator is still a line; the peer
                    // closed before we could see the newline.
                    Ok(Some(decode_line(&self.buffer)))
                };
            }

            match available.iter().position(|byte| *byte == b'\n') {
                Some(index) => {
                    if self.buffer.len() + index > self.limit {
                        return Err(Error::LineTooLong { limit: self.limit });
                    }

                    self.buffer.extend_from_slice(&available[..index]);
                    self.reader.consume(index + 1);

                    return Ok(Some(decode_line(&self.buffer)));
                }
                None => {
                    if self.buffer.len() + available.len() > self.limit {
                        return Err(Error::LineTooLong { limit: self.limit });
                    }

                    let taken = available.len();
                    self.buffer.extend_from_slice(available);
                    self.reader.consume(taken);
                }
            }
        }
    }
}

/// Decode a raw line, dropping one trailing CR.
fn decode_line(bytes: &[u8]) -> String {
    let without_cr = bytes.strip_suffix(b"\r").unwrap_or(bytes);
    String::from_utf8_lossy(without_cr).into_owned()
}

/// Write one protocol line, appending CRLF.
pub async fn write_line<W: AsyncWrite + Unpin>(writer: &mut W, line: &str) -> Result<(), Error> {
    writer.write_all(line.as_bytes()).await?;
    writer.write_all(b"\r\n").await?;
    writer.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reads_lines_and_strips_the_terminator() {
        let input = b"PING :1\r\nNOTICE * :hi\n".to_vec();
        let mut reader = LineReader::new(std::io::Cursor::new(input));

        assert_eq!(
            reader.next_line().await.unwrap().as_deref(),
            Some("PING :1")
        );
        assert_eq!(
            reader.next_line().await.unwrap().as_deref(),
            Some("NOTICE * :hi")
        );
        assert_eq!(reader.next_line().await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_final_line_without_a_terminator_is_still_returned() {
        let mut reader = LineReader::new(std::io::Cursor::new(b"PING :1".to_vec()));
        assert_eq!(
            reader.next_line().await.unwrap().as_deref(),
            Some("PING :1")
        );
        assert_eq!(reader.next_line().await.unwrap(), None);
    }

    #[tokio::test]
    async fn empty_lines_are_preserved() {
        let mut reader = LineReader::new(std::io::Cursor::new(b"\r\n\r\n".to_vec()));
        assert_eq!(reader.next_line().await.unwrap().as_deref(), Some(""));
        assert_eq!(reader.next_line().await.unwrap().as_deref(), Some(""));
        assert_eq!(reader.next_line().await.unwrap(), None);
    }

    #[tokio::test]
    async fn invalid_utf8_is_decoded_lossily_rather_than_failing() {
        // 0xFF is not valid UTF-8; dropping the connection over it would be worse
        // than showing a replacement character.
        let mut reader =
            LineReader::new(std::io::Cursor::new(b"PRIVMSG #c :\xFF\xFE\r\n".to_vec()));
        let line = reader.next_line().await.unwrap().unwrap();

        assert!(line.starts_with("PRIVMSG #c :"));
        assert!(line.contains('\u{FFFD}'));
    }

    #[tokio::test]
    async fn an_over_long_line_is_rejected_instead_of_buffered() {
        let input = vec![b'a'; 4096];
        let mut reader = LineReader::new(std::io::Cursor::new(input)).with_limit(1024);

        match reader.next_line().await {
            Err(Error::LineTooLong { limit }) => assert_eq!(limit, 1024),
            other => panic!("expected LineTooLong, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_line_exactly_at_the_limit_is_accepted() {
        let mut input = vec![b'a'; 1024];
        input.push(b'\n');
        let mut reader = LineReader::new(std::io::Cursor::new(input)).with_limit(1024);

        assert_eq!(reader.next_line().await.unwrap().unwrap().len(), 1024);
    }

    #[tokio::test]
    async fn write_line_appends_crlf() {
        let mut buffer: Vec<u8> = Vec::new();
        write_line(&mut buffer, "PING :1").await.unwrap();
        assert_eq!(buffer, b"PING :1\r\n");
    }

    #[tokio::test]
    async fn connect_reports_a_bad_host_as_a_config_error() {
        let mut config = ConnectionConfig::new("", "alice");
        config.port = 6667;
        // Validation runs before any socket work happens.
        assert!(matches!(connect(&config).await, Err(Error::Config(_))));
    }

    #[tokio::test]
    async fn connect_failure_names_the_endpoint() {
        // Port 1 on the loopback interface has nothing listening.
        let mut config = ConnectionConfig::new("127.0.0.1", "alice");
        config.tls = TlsMode::Plain;
        config.port = 1;

        match connect(&config).await {
            Err(Error::Connect { host, port, .. }) => {
                assert_eq!(host, "127.0.0.1");
                assert_eq!(port, 1);
            }
            other => panic!("expected a Connect error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn tls_config_is_built_once_and_reused() {
        let first = tls_config().unwrap();
        let second = tls_config().unwrap();
        assert!(Arc::ptr_eq(&first, &second));
    }
}
