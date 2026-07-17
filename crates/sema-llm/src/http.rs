use std::time::Duration;

use crate::types::LlmError;

/// Default HTTP request timeout for LLM providers (2 minutes).
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);

/// Install rustls's ring `CryptoProvider` once per process. reqwest is built with
/// `rustls-no-provider` (the default `rustls` feature pins aws-lc-rs, whose C build
/// dominates cold compiles); with no provider installed, ANY `reqwest::Client`
/// construction panics. Every crate that builds a client must call its guard first.
pub fn ensure_crypto_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // Err(_) just means another provider is already installed — that's fine.
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Create a new HTTP client with the given optional timeout.
/// Falls back to [`DEFAULT_TIMEOUT`] if `None`.
pub fn create_client(timeout: Option<Duration>) -> Result<reqwest::Client, LlmError> {
    ensure_crypto_provider();
    let mut builder = reqwest::Client::builder();
    if let Some(t) = timeout.or(Some(DEFAULT_TIMEOUT)) {
        builder = builder.timeout(t);
    }
    builder
        .build()
        .map_err(|e| LlmError::Config(format!("failed to create http client: {e}")))
}

/// Apply a per-request timeout (milliseconds) to a request builder when set. Lets a
/// per-call `:timeout` override the client default without rebuilding the client.
pub fn with_timeout(
    rb: reqwest::RequestBuilder,
    timeout_ms: Option<u64>,
) -> reqwest::RequestBuilder {
    match timeout_ms {
        Some(ms) => rb.timeout(Duration::from_millis(ms)),
        None => rb,
    }
}
