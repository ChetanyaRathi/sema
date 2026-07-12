//! End-to-end tests for the `:mcp` auth-resolution step using the REAL resolver
//! (`sema::workflow_mcp`, over `sema-mcp`) against a local mock MCP HTTP server —
//! no fake resolver, no FakeProvider. The mock server + subprocess harness mirror
//! the `sema-mcp` OAuth test patterns (`crates/sema-mcp/tests/mcp_oauth_connect_test.rs`
//! and `mcp_connect_from_config_test.rs`): a Python `http.server` script printing
//! its bound port on stdout, killed via a `Drop` guard.
//!
//! Env-var discipline: `SEMA_WORKFLOW_*`/`SEMA_MCP_AUTH_KEY` are process-global, so
//! every test funnels through [`run_workflow`], which holds a process-wide mutex
//! for its whole set/run/clear window — no parallel test IN THIS BINARY can
//! interleave. A concurrently-running *different* test binary is a separate
//! process and so can't race on env either.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use sema::InterpreterBuilder;
use sema_mcp::oauth::scoped::ScopedFileStore;
use sema_mcp::oauth::store::{ClientInfo, StoredCredentials, TokenSet, TokenStore};

static SERIAL: Mutex<()> = Mutex::new(());

/// A fixed 32-byte key, as 64 hex chars (`"22" x 32`), for `ScopedFileStore` —
/// this is a TEST key, never used for anything real; each test's run dir is
/// thrown away afterward. Built via `.repeat` rather than a hand-counted
/// literal, so its length can't silently drift from the required 64.
fn auth_key_hex() -> String {
    "22".repeat(32)
}

/// A minimal MCP-over-HTTP server: any `/mcp` POST without a recognized
/// `Authorization: Bearer <token>` gets a `401` + `WWW-Authenticate` challenge (so
/// an empty-store run would see a real challenge if it ever probed); a
/// recognized bearer gets the normal JSON-RPC `initialize`/`tools/list`/
/// `tools/call` triad, exposing one tool (`ping`) that echoes back `"pong"`.
/// Also serves RFC 9728/8414 discovery documents and a `/token` refresh-grant
/// endpoint, so a resolver-side token refresh (expired access token + stored
/// refresh token) can run end-to-end against it, mirroring
/// `crates/sema-mcp/tests/mcp_oauth_refresh_test.rs`.
const SERVER: &str = r#"
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

PORT = None
RECOGNIZED = {"valid-token-abc", "refreshed-token-xyz"}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def base(self):
        return "http://127.0.0.1:%d" % PORT

    def _json(self, obj, code=200, headers=None):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        p = urlparse(self.path)
        if p.path == "/.well-known/oauth-protected-resource":
            return self._json({"resource": self.base() + "/mcp",
                               "authorization_servers": [self.base()],
                               "scopes_supported": ["mcp:tools"]})
        if p.path == "/.well-known/oauth-authorization-server":
            return self._json({"issuer": self.base(),
                               "authorization_endpoint": self.base() + "/authorize",
                               "token_endpoint": self.base() + "/token",
                               "code_challenge_methods_supported": ["S256"]})
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        p = urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        if p.path == "/token":
            body = parse_qs(raw.decode())
            if body.get("grant_type", [""])[0] == "refresh_token":
                if body.get("refresh_token", [""])[0] != "refresh-xyz":
                    return self._json({"error": "invalid_grant"}, code=400)
                return self._json({"access_token": "refreshed-token-xyz",
                                   "refresh_token": "refresh-2", "token_type": "Bearer",
                                   "expires_in": 3600, "scope": "mcp:tools"})
            return self._json({"error": "unsupported_grant_type"}, code=400)
        if p.path != "/mcp":
            self.send_response(404)
            self.end_headers()
            return
        auth = self.headers.get("Authorization", "")
        token = auth[len("Bearer "):] if auth.startswith("Bearer ") else ""
        if token not in RECOGNIZED:
            self.send_response(401)
            self.send_header(
                "WWW-Authenticate",
                'Bearer resource_metadata="%s/.well-known/oauth-protected-resource"' % self.base(),
            )
            self.end_headers()
            return
        msg = json.loads(raw) if raw else {}
        method = msg.get("method")
        rid = msg.get("id")
        if rid is None:
            self.send_response(202)
            self.end_headers()
            return
        if method == "initialize":
            return self._json(
                {"jsonrpc": "2.0", "id": rid, "result": {
                    "protocolVersion": "2025-11-25", "capabilities": {},
                    "serverInfo": {"name": "e2e-server", "version": "1.0"}}},
                headers={"Mcp-Session-Id": "sess-e2e"},
            )
        if method == "tools/list":
            return self._json({"jsonrpc": "2.0", "id": rid, "result": {"tools": [
                {"name": "ping", "description": "Ping",
                 "inputSchema": {"type": "object", "properties": {}}}]}})
        if method == "tools/call":
            params = msg.get("params", {})
            if params.get("name") == "ping":
                return self._json({"jsonrpc": "2.0", "id": rid, "result": {
                    "content": [{"type": "text", "text": "pong"}]}})
            return self._json({"jsonrpc": "2.0", "id": rid,
                               "error": {"code": -32601, "message": "unknown tool"}})
        return self._json({"jsonrpc": "2.0", "id": rid,
                           "error": {"code": -32601, "message": "Method not found"}})

srv = HTTPServer(("127.0.0.1", 0), H)
PORT = srv.server_address[1]
print(PORT, flush=True)
srv.serve_forever()
"#;

struct ServerGuard {
    child: Child,
    _stdout: BufReader<ChildStdout>,
}

impl Drop for ServerGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn start_server() -> (ServerGuard, u16) {
    let mut child = Command::new("python3")
        .args(["-c", SERVER])
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn python3 mock MCP server");
    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader.read_line(&mut line).expect("read port");
    let port: u16 = line.trim().parse().expect("port");
    (
        ServerGuard {
            child,
            _stdout: reader,
        },
        port,
    )
}

fn temp_run_dir(tag: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("sema-mcp-e2e-{}-{}-{tag}", std::process::id(), n));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

struct RunOutput {
    events: Vec<serde_json::Value>,
    result: serde_json::Value,
}

fn events_of<'a>(events: &'a [serde_json::Value], name: &str) -> Vec<&'a serde_json::Value> {
    events.iter().filter(|e| e["event"] == name).collect()
}

/// Run `src` as a workflow against the REAL resolver, under the fixed-ts seam,
/// into `run_dir/<run_id>/`. Serialized via `SERIAL` (env is process-global).
fn run_workflow(src: &str, run_dir: &Path, run_id: &str) -> RunOutput {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());

    std::env::set_var("SEMA_WORKFLOW_FIXED_TS", "0");
    std::env::set_var("SEMA_WORKFLOW_RUN_ID", run_id);
    std::env::set_var("SEMA_WORKFLOW_RUN_DIR", run_dir);
    std::env::set_var("SEMA_WORKFLOW_CODE_VERSION", "");
    std::env::set_var("SEMA_WORKFLOW_ARGS_JSON", "{}");
    std::env::remove_var("SEMA_WORKFLOW_RESUME");
    std::env::set_var("SEMA_MCP_AUTH_KEY", auth_key_hex());

    let interp = InterpreterBuilder::new().build();
    sema::workflow_mcp::register_real_resolver();
    let _ = interp.eval_str(src);

    for v in [
        "SEMA_WORKFLOW_FIXED_TS",
        "SEMA_WORKFLOW_RUN_ID",
        "SEMA_WORKFLOW_RUN_DIR",
        "SEMA_WORKFLOW_CODE_VERSION",
        "SEMA_WORKFLOW_ARGS_JSON",
        "SEMA_MCP_AUTH_KEY",
    ] {
        std::env::remove_var(v);
    }

    let run = run_dir.join(run_id);
    let events = std::fs::read_to_string(run.join("events.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).expect("valid event json"))
        .collect();
    let result = std::fs::read_to_string(run.join("result.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null);
    RunOutput { events, result }
}

/// Seed a `:persist :run`-scoped credential for `url` into `<run_dir>/<run_id>/auth/`
/// — the same directory `store_for(McpPersist::Run, ...)` resolves to. Using
/// `:run` (not `:workflow`) keeps this test fully self-contained under its own
/// temp run dir (`:workflow`'s `.sema/auth/<name>/` has no env override to
/// relocate it away from the real repo tree).
fn seed_run_scoped_credential(
    run_dir: &Path,
    run_id: &str,
    url: &str,
    access_token: &str,
    refresh_token: Option<&str>,
    expires_in: Option<u64>,
) {
    let key = {
        let hex = auth_key_hex();
        let mut k = [0u8; 32];
        for (i, byte) in k.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap();
        }
        k
    };
    let dir = run_dir.join(run_id).join("auth");
    let store = ScopedFileStore::new(dir, key);
    store
        .save(&StoredCredentials {
            server_url: url.to_string(),
            tokens: TokenSet::from_response(
                access_token.to_string(),
                refresh_token.map(str::to_string),
                expires_in,
                Some("mcp:tools".to_string()),
                sema_mcp::oauth::store::now_unix(),
            ),
            client_info: Some(ClientInfo {
                client_id: "test-client".to_string(),
                client_secret: None,
            }),
        })
        .expect("seed credential");
}

// ── (1) empty store, 401-challenging server → needs-auth, no network probe ────

#[test]
fn empty_store_against_gated_server_yields_needs_auth() {
    let (_server, port) = start_server();
    let url = format!("http://127.0.0.1:{port}/mcp");
    let run_dir = temp_run_dir("empty-store");

    let src = format!(
        r#"
        (defworkflow triage
          "test"
          {{:budget {{:usd 1.0}}
            :mcp {{gated {{:url "{url}" :auth {{:scopes ["mcp:tools"]}} :persist :run}}}}}}
          (phase "Use")
          (checkpoint :ran #t)
          {{:status :success}})
        "#
    );

    let out = run_workflow(&src, &run_dir, "e2e-empty-store");

    let required = events_of(&out.events, "auth.required");
    assert_eq!(required.len(), 1);
    assert_eq!(required[0]["server"], "gated");
    assert_eq!(required[0]["scopes"][0], "mcp:tools");
    assert_eq!(required[0]["persist"], "run");

    assert!(
        events_of(&out.events, "phase.started").is_empty(),
        "body must not run on a needs-auth gate"
    );
    assert_eq!(out.result["status"], "needs-auth");
    assert_eq!(out.result["servers"], serde_json::json!(["gated"]));

    let ended = events_of(&out.events, "run.ended");
    assert_eq!(ended[0]["status"], "needs-auth");

    let _ = std::fs::remove_dir_all(&run_dir);
}

// ── (2) pre-seeded scoped store, valid token → cached connect, leaf mcp/call ──

#[test]
fn preseeded_store_connects_silently_and_leaf_call_succeeds() {
    let (_server, port) = start_server();
    let url = format!("http://127.0.0.1:{port}/mcp");
    let run_dir = temp_run_dir("preseeded");
    let run_id = "e2e-preseeded";

    seed_run_scoped_credential(
        &run_dir,
        run_id,
        &url,
        "valid-token-abc",
        Some("refresh-xyz"),
        Some(3600),
    );

    let src = format!(
        r#"
        (defworkflow triage
          "test"
          {{:budget {{:usd 1.0}}
            :mcp {{srv {{:url "{url}" :auth {{:scopes ["mcp:tools"]}} :persist :run}}}}}}
          (phase "Use")
          (checkpoint :out (mcp/call srv "ping" {{}}))
          {{:status :success :out (checkpoint :out)}})
        "#
    );

    let out = run_workflow(&src, &run_dir, run_id);

    let granted = events_of(&out.events, "auth.granted");
    assert_eq!(granted.len(), 1);
    assert_eq!(granted[0]["server"], "srv");
    assert_eq!(granted[0]["source"], "cached");

    assert!(events_of(&out.events, "auth.required").is_empty());
    assert!(events_of(&out.events, "auth.failed").is_empty());
    assert!(!events_of(&out.events, "phase.started").is_empty());

    assert_eq!(out.result["status"], "success");
    assert_eq!(out.result["out"], "pong");

    let _ = std::fs::remove_dir_all(&run_dir);
}

// ── (3) allowed-tools: an undeclared tool call fails with the manifest hint ────

#[test]
fn undeclared_tool_call_fails_with_manifest_hint() {
    let (_server, port) = start_server();
    let url = format!("http://127.0.0.1:{port}/mcp");
    let run_dir = temp_run_dir("allowed-tools");
    let run_id = "e2e-allowed-tools";

    seed_run_scoped_credential(
        &run_dir,
        run_id,
        &url,
        "valid-token-abc",
        Some("refresh-xyz"),
        Some(3600),
    );

    // Declares :tools ["ping"], but the leaf calls "not_declared".
    let src = format!(
        r#"
        (defworkflow triage
          "test"
          {{:budget {{:usd 1.0}}
            :mcp {{srv {{:url "{url}" :auth {{:scopes ["mcp:tools"]}}
                        :tools ["ping"] :persist :run}}}}}}
          (phase "Use")
          (mcp/call srv "not_declared" {{}}))
        "#
    );

    let out = run_workflow(&src, &run_dir, run_id);

    // The server still connects fine (auth.granted) — the manifest is enforced
    // client-side by mcp/call, not by refusing the connection.
    let granted = events_of(&out.events, "auth.granted");
    assert_eq!(granted.len(), 1);

    assert_eq!(out.result["status"], "failed");
    let msg = out.result["error"].as_str().unwrap();
    assert!(msg.contains("not_declared"), "{msg}");
    assert!(
        msg.contains(":tools manifest") || msg.contains("declared"),
        "expected the manifest hint, got: {msg}"
    );

    let _ = std::fs::remove_dir_all(&run_dir);
}

// ── (4) expired token + refresh token → silent refresh, source:"refreshed" ────

#[test]
fn expired_token_with_refresh_token_refreshes_silently() {
    let (_server, port) = start_server();
    let url = format!("http://127.0.0.1:{port}/mcp");
    let run_dir = temp_run_dir("refresh");
    let run_id = "e2e-refresh";

    // An access token that is NOT in the server's RECOGNIZED set (so if refresh
    // did NOT run, the connect would fail with a fresh 401 instead of silently
    // "working" for the wrong reason) plus a refresh token the mock /token
    // endpoint accepts.
    seed_run_scoped_credential(
        &run_dir,
        run_id,
        &url,
        "stale-expired-token",
        Some("refresh-xyz"),
        Some(0), // immediately expired under the 60s skew
    );

    let src = format!(
        r#"
        (defworkflow triage
          "test"
          {{:budget {{:usd 1.0}}
            :mcp {{srv {{:url "{url}" :auth {{:scopes ["mcp:tools"]}} :persist :run}}}}}}
          (phase "Use")
          (checkpoint :out (mcp/call srv "ping" {{}}))
          {{:status :success :out (checkpoint :out)}})
        "#
    );

    let out = run_workflow(&src, &run_dir, run_id);

    let granted = events_of(&out.events, "auth.granted");
    assert_eq!(granted.len(), 1);
    assert_eq!(granted[0]["server"], "srv");
    assert_eq!(granted[0]["source"], "refreshed");

    assert!(events_of(&out.events, "auth.required").is_empty());
    assert!(events_of(&out.events, "auth.failed").is_empty());

    assert_eq!(out.result["status"], "success");
    assert_eq!(out.result["out"], "pong");

    // The rotated access/refresh tokens must have been persisted back to the
    // SAME scoped store (so a later resolution in this run scope reuses them).
    let key = {
        let hex = auth_key_hex();
        let mut k = [0u8; 32];
        for (i, byte) in k.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap();
        }
        k
    };
    let store = ScopedFileStore::new(run_dir.join(run_id).join("auth"), key);
    let saved = store.load(&url).expect("refreshed credential persisted");
    assert_eq!(saved.tokens.access_token, "refreshed-token-xyz");
    assert_eq!(saved.tokens.refresh_token.as_deref(), Some("refresh-2"));

    let _ = std::fs::remove_dir_all(&run_dir);
}

// ── (5) expired token, refresh REJECTED → re-gate (plan §10 Q3) ───────────────

#[test]
fn expired_token_with_rejected_refresh_regates_to_needs_auth() {
    let (_server, port) = start_server();
    let url = format!("http://127.0.0.1:{port}/mcp");
    let run_dir = temp_run_dir("refresh-rejected");
    let run_id = "e2e-refresh-rejected";

    // A refresh token the mock /token endpoint does NOT recognize -> invalid_grant.
    seed_run_scoped_credential(
        &run_dir,
        run_id,
        &url,
        "stale-expired-token",
        Some("wrong-refresh-token"),
        Some(0),
    );

    let src = format!(
        r#"
        (defworkflow triage
          "test"
          {{:budget {{:usd 1.0}}
            :mcp {{srv {{:url "{url}" :auth {{:scopes ["mcp:tools"]}} :persist :run}}}}}}
          (phase "Use")
          (checkpoint :ran #t)
          {{:status :success}})
        "#
    );

    let out = run_workflow(&src, &run_dir, run_id);

    assert!(events_of(&out.events, "auth.granted").is_empty());
    let required = events_of(&out.events, "auth.required");
    assert_eq!(required.len(), 1);
    assert_eq!(required[0]["server"], "srv");

    assert!(
        events_of(&out.events, "phase.started").is_empty(),
        "body must not run when refresh fails"
    );
    assert_eq!(out.result["status"], "needs-auth");

    let _ = std::fs::remove_dir_all(&run_dir);
}
