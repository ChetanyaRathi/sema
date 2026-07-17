//! CLI entry points for MCP client authentication (`sema mcp login/logout`),
//! plus [`login_interactive`] — the same browser-loopback flow, returned to
//! the caller instead of persisted, for embedders that own their own
//! credential placement (the workflow run-start interactive auth path in the
//! `sema` binary crate; see `crates/sema/src/workflow_mcp.rs`).
//!
//! `mcp_login` runs the OAuth flow eagerly (before any `mcp/connect`) so a
//! token is cached and later connects are silent; `logout` clears the stored
//! credentials for a server. Both use the default credential store (keychain
//! or `0600` file).

use std::time::Duration;

use crate::oauth;
use crate::oauth::loopback::BrowserOpener;
use crate::oauth::store::StoredCredentials;

const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

fn runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("failed to create runtime: {e}"))
}

/// Authenticate to a remote MCP server and cache the resulting token. Uses the
/// browser loopback flow by default; `use_device` selects the RFC 8628 device
/// flow for headless boxes.
pub fn mcp_login(url: &str, use_device: bool, client_id: Option<&str>) -> Result<(), String> {
    let store = oauth::store::default_store();

    let creds = if use_device {
        let rt = runtime()?;
        rt.block_on(async {
            crate::ensure_crypto_provider();
            let http = reqwest::Client::new();
            let config = oauth::login::LoginConfig {
                mcp_url: url,
                resource_metadata_url: None,
                requested_scope: None,
                preconfigured_client_id: client_id,
            };
            let existing = store.load(url).and_then(|c| c.client_info);
            oauth::device::device_login(&http, &config, existing, &|device| {
                eprintln!(
                    "\nTo authorize, visit:\n  {}\nand enter the code: {}\n",
                    device.verification_uri, device.user_code
                );
                if let Some(complete) = &device.verification_uri_complete {
                    eprintln!("(or open directly: {complete})\n");
                }
                eprintln!("Waiting for approval…");
            })
            .await
        })?
    } else {
        eprintln!("Opening your browser to authorize {url} …");
        // Shares the whole flow with `login_interactive` — this differs only
        // in what happens to the result (persisted here to the default store;
        // `login_interactive`'s caller decides).
        login_interactive(url, client_id, None)?
    };

    store.save(&creds)?;
    eprintln!("Authenticated to {url}. Token cached.");
    Ok(())
}

/// Authenticate to a remote MCP server via the browser-loopback flow and
/// RETURN the resulting credentials — never persisted here. `mcp_login`'s
/// non-device branch is exactly this call, followed by a save to the default
/// store: one flow implementation (this function), two persistence choices.
///
/// The interactive run-start auth path (`sema workflow run` on a TTY; see
/// `crates/sema/src/workflow_mcp.rs`) is the other caller — it wants a
/// declared server's own SCOPED store (`:keyring`/`:workflow`/`:run`/`:none`),
/// never the default one, so it must own the persistence step itself.
///
/// `opener` is injectable so tests can drive the redirect programmatically
/// (see `crates/sema-mcp/tests/mcp_oauth_test.rs`) without a real browser;
/// `None` opens the system browser via [`oauth::loopback::open_browser`] —
/// callers that must respect a sandbox gate (`Caps::PROCESS`) have to pass a
/// pre-gated opener themselves (e.g. `crate::builtins::gated_browser_opener`),
/// this function never gates on its own.
///
/// Runs its own fresh current-thread runtime (see `runtime()`) and blocks on
/// it — like `mcp_login`, callers must not invoke this from inside another
/// `block_on` already active on the same thread.
pub fn login_interactive(
    url: &str,
    client_id: Option<&str>,
    opener: Option<BrowserOpener>,
) -> Result<StoredCredentials, String> {
    let rt = runtime()?;
    rt.block_on(async {
        crate::ensure_crypto_provider();
        let http = reqwest::Client::new();
        let existing = oauth::store::default_store()
            .load(url)
            .and_then(|c| c.client_info);
        let driver = match opener {
            Some(opener) => oauth::loopback::LoopbackDriver::with_opener(LOGIN_TIMEOUT, opener)?,
            None => oauth::loopback::LoopbackDriver::new(LOGIN_TIMEOUT)?,
        };
        let config = oauth::login::LoginConfig {
            mcp_url: url,
            resource_metadata_url: None,
            requested_scope: None,
            preconfigured_client_id: client_id,
        };
        oauth::login::login(&http, &config, existing, &driver).await
    })
}

/// Store a pre-issued access token directly, skipping discovery/DCR/OAuth
/// entirely — the headless/CI escape hatch (plan §5: "accepts a … pre-issued
/// token"). `expires_in` (seconds, relative to now) becomes an absolute
/// `expires_at`; `None` stores a non-expiring token. Never echoes `token`.
pub fn mcp_login_token(url: &str, token: &str, expires_in: Option<u64>) -> Result<(), String> {
    let creds = oauth::store::StoredCredentials {
        server_url: url.to_string(),
        tokens: oauth::store::TokenSet::from_response(
            token.to_string(),
            None,
            expires_in,
            None,
            oauth::store::now_unix(),
        ),
        client_info: None,
    };
    oauth::store::default_store().save(&creds)?;
    eprintln!("Authenticated to {url}. Token cached.");
    Ok(())
}

/// Remove any cached credentials for a remote MCP server.
pub fn mcp_logout(url: &str) -> Result<(), String> {
    oauth::store::default_store().delete(url)?;
    eprintln!("Cleared cached credentials for {url}.");
    Ok(())
}
