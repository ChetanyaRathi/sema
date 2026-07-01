//! Legacy HTTP+SSE mid-session auth challenge capture + reconnect. The scripted
//! server (per-session queues so a reconnect doesn't cross-talk) answers a
//! `tools/call` for the tool `boom` with `401 insufficient_scope`, and serves
//! everything else. This proves the legacy transport surfaces the challenge
//! (`http_last_status`/`http_challenge`/`http_url`, at parity with Streamable
//! HTTP) and that `reauthorize_bearer` re-opens the stream so calls work again.

use std::io::{BufRead, BufReader};
use std::process::{Child, ChildStdout, Command, Stdio};

use sema_mcp::{McpClient, McpHttpConfig};
use serde_json::json;

const SERVER: &str = r#"
import json, queue, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = None
sessions = {}
counter = {"n": 0}
lock = threading.Lock()

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        p = urlparse(self.path)
        if p.path == "/sse":
            with lock:
                counter["n"] += 1
                sid = "s%d" % counter["n"]
                q = queue.Queue()
                sessions[sid] = q
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(("event: endpoint\ndata: /messages?sessionId=%s\n\n" % sid).encode())
            self.wfile.flush()
            while True:
                msg = q.get()
                if msg is None:
                    break
                self.wfile.write(("event: message\ndata: " + json.dumps(msg) + "\n\n").encode())
                self.wfile.flush()
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        p = urlparse(self.path)
        sid = parse_qs(p.query).get("sessionId", [""])[0]
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        if p.path == "/messages":
            msg = json.loads(raw) if raw else {}
            method = msg.get("method")
            rid = msg.get("id")
            params = msg.get("params", {}) or {}
            # Simulate a mid-session auth challenge on a specific tool.
            if method == "tools/call" and params.get("name") == "boom":
                self.send_response(401)
                self.send_header("WWW-Authenticate",
                                 'Bearer error="insufficient_scope", scope="read write"')
                self.end_headers()
                return
            self.send_response(202)
            self.end_headers()
            if rid is None:
                return
            q = sessions.get(sid)
            if q is None:
                return
            if method == "initialize":
                q.put({"jsonrpc": "2.0", "id": rid, "result": {
                    "protocolVersion": "2024-11-05", "capabilities": {},
                    "serverInfo": {"name": "legacy", "version": "1"}}})
            elif method == "tools/list":
                q.put({"jsonrpc": "2.0", "id": rid, "result": {"tools": [
                    {"name": "echo", "inputSchema": {"type": "object"}},
                    {"name": "boom", "inputSchema": {"type": "object"}}]}})
            elif method == "tools/call":
                text = params.get("arguments", {}).get("text", "")
                q.put({"jsonrpc": "2.0", "id": rid, "result": {
                    "content": [{"type": "text", "text": text}], "isError": False}})
            else:
                q.put({"jsonrpc": "2.0", "id": rid,
                       "error": {"code": -32601, "message": "no"}})
            return
        self.send_response(404)
        self.end_headers()

srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
srv.daemon_threads = True
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
        .expect("spawn python3 legacy challenge server");
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

#[tokio::test]
async fn test_legacy_challenge_capture_and_reconnect() {
    let (_server, port) = start_server();
    let url = format!("http://127.0.0.1:{port}/sse");

    let mut config = McpHttpConfig::new(url.clone());
    config
        .headers
        .insert("Authorization".to_string(), "Bearer good".to_string());
    let mut client = McpClient::connect_legacy_sse(config)
        .await
        .expect("connect legacy");
    client.initialize().await.expect("initialize");

    // A normal call works.
    let ok = client
        .call_tool("echo", json!({ "text": "hi" }))
        .await
        .expect("echo");
    assert_eq!(ok["content"][0]["text"], "hi");

    // A call the server refuses with 401 — the challenge must be captured and
    // surfaced exactly like the Streamable-HTTP transport does.
    let err = client
        .call_tool("boom", json!({}))
        .await
        .expect_err("boom should be refused");
    assert!(err.contains("401"), "got: {err}");
    assert_eq!(client.http_last_status(), Some(401));
    assert!(client
        .http_challenge()
        .expect("challenge captured")
        .contains("insufficient_scope"));
    assert_eq!(client.http_url().as_deref(), Some(url.as_str()));

    // reauthorize_bearer re-opens the legacy stream with the new token and
    // re-handshakes, so subsequent calls work again.
    client
        .reauthorize_bearer("good2")
        .await
        .expect("legacy reconnect");
    let ok2 = client
        .call_tool("echo", json!({ "text": "again" }))
        .await
        .expect("echo after reconnect");
    assert_eq!(ok2["content"][0]["text"], "again");

    client.close().await.ok();
}
