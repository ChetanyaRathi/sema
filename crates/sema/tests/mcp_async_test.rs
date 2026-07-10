//! Acceptance gate for MCP-4 / issue #96: the MCP client builtins
//! (`mcp/connect`, `mcp/call`, `mcp/tools`, `mcp/close`) must offload under the
//! cooperative scheduler instead of blocking the whole VM thread.
//!
//! Every mock server here is a small stdio JSON-RPC Python script (matching
//! `mcp_builtin_test.rs`/`mcp_cassette_test.rs`'s harness), extended with
//! deterministic coordination (marker files, a busy flag) so the assertions
//! below are ordering/completion signals — never wall-clock timing thresholds.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use sema::{Interpreter, Value};
use sema_llm::builtins::{install_cassette, take_cassette};
use sema_llm::cassette::{Cassette, CassetteMode};

/// A unique path under the system temp dir for one test's scratch file(s).
fn unique_temp_path(tag: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!(
        "sema-mcp-async-{tag}-{}-{n}.marker",
        std::process::id()
    ))
}

/// Sema string-literal-encode a Rust string (for interpolating into a
/// generated Sema program, e.g. a marker file path).
fn sema_str(s: &str) -> String {
    let encoded = serde_json::to_string(s).expect("string encodes to JSON");
    // JSON string syntax is a valid Sema string literal.
    encoded
}

// ── Scenario 1: cross-connection overlap ────────────────────────────────────
//
// Server A withholds its `tools/call` response until it observes a marker
// file that server B's handler touches — a one-directional signal proving B
// received (and answered) its own request while A's was still in flight. Two
// `async/spawn`ed calls, one to each server, both completing proves the
// overlap; a serialized/blocking implementation deadlocks (A waits forever
// for a marker B's task never gets a chance to write) and the surrounding
// `async/timeout` turns that into a clean test failure instead of a hang.

const SERVER_WITHHOLDS_UNTIL_MARKER: &str = r#"
import json, sys, os, time
def send(m):
    sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()
initialized = False
marker = sys.argv[1]
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    r = json.loads(line); method = r.get("method"); rid = r.get("id")
    if rid is None:
        if method == "notifications/initialized":
            initialized = True
        continue
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": "2025-11-25", "capabilities": {},
            "serverInfo": {"name": "withholds", "version": "1"}}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": rid, "result": {"tools": [
            {"name": "wait_for_marker", "description": "wait",
             "inputSchema": {"type": "object", "properties": {}}}]}})
    elif method == "tools/call":
        deadline = time.time() + 10
        seen = False
        while time.time() < deadline:
            if os.path.exists(marker):
                seen = True
                break
            time.sleep(0.01)
        text = "a-saw-marker" if seen else "a-timed-out-without-marker"
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "content": [{"type": "text", "text": text}], "isError": False}})
    else:
        send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "no"}})
"#;

const SERVER_TOUCHES_MARKER: &str = r#"
import json, sys
def send(m):
    sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()
initialized = False
marker = sys.argv[1]
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    r = json.loads(line); method = r.get("method"); rid = r.get("id")
    if rid is None:
        if method == "notifications/initialized":
            initialized = True
        continue
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": "2025-11-25", "capabilities": {},
            "serverInfo": {"name": "touches", "version": "1"}}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": rid, "result": {"tools": [
            {"name": "touch_marker", "description": "touch",
             "inputSchema": {"type": "object", "properties": {}}}]}})
    elif method == "tools/call":
        open(marker, "w").close()
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "content": [{"type": "text", "text": "b-done"}], "isError": False}})
    else:
        send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "no"}})
"#;

#[test]
fn cross_connection_overlap_proves_no_serialization() {
    let marker = unique_temp_path("overlap");
    let _ = std::fs::remove_file(&marker);
    let marker_arg = sema_str(&marker.to_string_lossy());

    let interp = Interpreter::new();
    let a_encoded = sema_str(SERVER_WITHHOLDS_UNTIL_MARKER);
    let b_encoded = sema_str(SERVER_TOUCHES_MARKER);
    interp
        .eval_str(&format!(
            r#"(define a (mcp/connect {{:command "python3" :args ["-c" {a_encoded} {marker_arg}]}}))"#
        ))
        .expect("connect a");
    interp
        .eval_str(&format!(
            r#"(define b (mcp/connect {{:command "python3" :args ["-c" {b_encoded} {marker_arg}]}}))"#
        ))
        .expect("connect b");

    let program = r#"
        (async/timeout 15000
          (async/spawn (fn ()
            (async/all
              (list
                (async/spawn (fn () (mcp/call a "wait_for_marker" {})))
                (async/spawn (fn () (mcp/call b "touch_marker" {}))))))))
    "#;
    let result = interp
        .eval_str(program)
        .expect("both connections' calls complete without deadlock");
    let items = result.as_seq().expect("async/all returns a list");
    assert_eq!(items.len(), 2);
    let texts: Vec<&str> = items.iter().map(|v| v.as_str().unwrap()).collect();
    assert!(
        texts.contains(&"a-saw-marker"),
        "server A must have observed B's marker before answering (proves in-flight overlap); got {texts:?}"
    );
    assert!(texts.contains(&"b-done"), "got {texts:?}");

    interp.eval_str("(mcp/close a)").ok();
    interp.eval_str("(mcp/close b)").ok();
    let _ = std::fs::remove_file(&marker);
}

// ── Scenario 2: scheduler not stalled by a slow call ────────────────────────
//
// One task makes a `mcp/call` to a server that sleeps briefly before
// answering; a sibling task does no I/O at all. A completion-order assertion
// via a channel (not a sleep) proves the sibling finished BEFORE the slow
// call resolved — impossible if the call blocked the VM thread.

const SLOW_SERVER: &str = r#"
import json, sys, time
def send(m):
    sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()
initialized = False
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    r = json.loads(line); method = r.get("method"); rid = r.get("id")
    if rid is None:
        if method == "notifications/initialized":
            initialized = True
        continue
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": "2025-11-25", "capabilities": {},
            "serverInfo": {"name": "slow", "version": "1"}}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": rid, "result": {"tools": [
            {"name": "slow", "description": "slow",
             "inputSchema": {"type": "object", "properties": {}}}]}})
    elif method == "tools/call":
        time.sleep(0.4)
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "content": [{"type": "text", "text": "slow-done"}], "isError": False}})
    else:
        send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "no"}})
"#;

#[test]
fn scheduler_not_stalled_sibling_completes_before_slow_call() {
    let interp = Interpreter::new();
    let encoded = sema_str(SLOW_SERVER);
    interp
        .eval_str(&format!(
            r#"(define server (mcp/connect {{:command "python3" :args ["-c" {encoded}]}}))"#
        ))
        .expect("connect");

    let program = r#"
        (let ((order (channel/new 2)))
          (async/all
            (list
              (async/spawn (fn ()
                (mcp/call server "slow" {})
                (channel/send order "slow-call")))
              (async/spawn (fn ()
                (channel/send order "sibling")))))
          (list (channel/recv order) (channel/recv order)))
    "#;
    let result = interp
        .eval_str(program)
        .expect("both tasks complete without stalling the scheduler");
    let items = result.as_seq().expect("a list of two order markers");
    let order: Vec<&str> = items.iter().map(|v| v.as_str().unwrap()).collect();
    assert_eq!(
        order,
        vec!["sibling", "slow-call"],
        "the no-I/O sibling must finish and record its marker BEFORE the \
         slow mcp/call resolves — a blocking implementation would record \
         [slow-call, sibling] instead (got {order:?})"
    );

    interp.eval_str("(mcp/close server)").ok();
}

// ── Shared: a server with a per-connection busy flag + incrementing counter ─
//
// Used by scenarios 3 (same-handle queueing) and 4 (queue wakeup). A second
// `tools/call` arriving before the first has been answered is a hard
// server-side error — proof the client serialized requests on this ONE
// connection, exactly as the MCP wire protocol requires.

const BUSY_COUNTER_SERVER: &str = r#"
import json, sys, time
def send(m):
    sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()
initialized = False
busy = False
counter = 0
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    r = json.loads(line); method = r.get("method"); rid = r.get("id")
    if rid is None:
        if method == "notifications/initialized":
            initialized = True
        continue
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": "2025-11-25", "capabilities": {},
            "serverInfo": {"name": "busy-counter", "version": "1"}}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": rid, "result": {"tools": [
            {"name": "count", "description": "increment",
             "inputSchema": {"type": "object", "properties": {}}}]}})
    elif method == "tools/call":
        if busy:
            send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32000,
                  "message": "overlap detected: a second request arrived before the first response was sent"}})
            continue
        busy = True
        time.sleep(0.05)
        counter += 1
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "content": [{"type": "text", "text": "call-%d" % counter}], "isError": False}})
        busy = False
    else:
        send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "no"}})
"#;

fn connect_busy_counter_expr() -> String {
    let encoded = sema_str(BUSY_COUNTER_SERVER);
    format!(r#"(define server (mcp/connect {{:command "python3" :args ["-c" {encoded}]}}))"#)
}

// ── Scenario 3: same-handle queueing ────────────────────────────────────────

#[test]
fn same_handle_queueing_serializes_two_concurrent_calls() {
    let interp = Interpreter::new();
    interp
        .eval_str(&connect_busy_counter_expr())
        .expect("connect");

    let program = r#"
        (async/all
          (list
            (async/spawn (fn () (mcp/call server "count" {})))
            (async/spawn (fn () (mcp/call server "count" {})))))
    "#;
    let result = interp.eval_str(program).expect(
        "both queued calls must succeed — a server-side overlap error means the \
                  client sent a second request before the first was answered",
    );
    let items = result.as_seq().expect("a list of two results");
    let mut vals: Vec<&str> = items.iter().map(|v| v.as_str().unwrap()).collect();
    vals.sort_unstable();
    assert_eq!(vals, vec!["call-1", "call-2"]);

    interp.eval_str("(mcp/close server)").ok();
}

// ── Scenario 4: queue wakeup (lost-wakeup regression) ───────────────────────

#[test]
fn queue_wakeup_five_queued_calls_all_complete() {
    let interp = Interpreter::new();
    interp
        .eval_str(&connect_busy_counter_expr())
        .expect("connect");

    // A generous but bounded timeout: this is a deadlock-prevention gate (all
    // N queued calls must eventually complete), not a timing assertion — see
    // the module doc. If the check-in `notify_io_complete()` were dropped, the
    // scheduler's bounded `io_park` fallback still recovers (just slower);
    // this test's job is to catch a genuine stuck-forever regression in the
    // Acquire-phase requeue loop.
    let program = r#"
        (async/timeout 20000
          (async/spawn (fn ()
            (async/all
              (list
                (async/spawn (fn () (mcp/call server "count" {})))
                (async/spawn (fn () (mcp/call server "count" {})))
                (async/spawn (fn () (mcp/call server "count" {})))
                (async/spawn (fn () (mcp/call server "count" {})))
                (async/spawn (fn () (mcp/call server "count" {}))))))))
    "#;
    let result = interp
        .eval_str(program)
        .expect("all five queued calls must complete, not park forever");
    let items = result.as_seq().expect("a list of five results");
    assert_eq!(items.len(), 5);
    let mut vals: Vec<&str> = items.iter().map(|v| v.as_str().unwrap()).collect();
    vals.sort_unstable();
    assert_eq!(
        vals,
        vec!["call-1", "call-2", "call-3", "call-4", "call-5"],
        "every queued call must have run exactly once, strictly sequentially"
    );

    interp.eval_str("(mcp/close server)").ok();
}

// ── Scenario 5: cancellation tombstones the connection ──────────────────────
//
// The mock server sleeps a few real seconds before answering (long enough
// that a short `async/timeout` always wins the race, short enough the
// orphaned child process exits on its own soon after — no indefinite zombie).

const SLEEPY_SERVER: &str = r#"
import json, sys, time
def send(m):
    sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()
initialized = False
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    r = json.loads(line); method = r.get("method"); rid = r.get("id")
    if rid is None:
        if method == "notifications/initialized":
            initialized = True
        continue
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": "2025-11-25", "capabilities": {},
            "serverInfo": {"name": "sleepy", "version": "1"}}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": rid, "result": {"tools": [
            {"name": "hang", "description": "never answers promptly",
             "inputSchema": {"type": "object", "properties": {}}}]}})
    elif method == "tools/call":
        time.sleep(3)
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "content": [{"type": "text", "text": "too-late"}], "isError": False}})
    else:
        send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "no"}})
"#;

#[test]
fn cancellation_tombstones_connection_and_interpreter_stays_healthy() {
    let interp = Interpreter::new();
    let encoded = sema_str(SLEEPY_SERVER);
    interp
        .eval_str(&format!(
            r#"(define h (mcp/connect {{:command "python3" :args ["-c" {encoded}]}}))"#
        ))
        .expect("connect");

    let program = r#"
        (try
          (async/timeout 200 (async/spawn (fn () (mcp/call h "hang" {}))))
          (catch e :caught))
    "#;
    let result = interp
        .eval_str(program)
        .expect("timeout-abandoned mcp/call evaluated");
    assert_eq!(
        result,
        Value::keyword("caught"),
        "async/timeout must win the race against the slow server"
    );

    // A follow-up call on the now-tombstoned handle must fail fast with the
    // documented reason + reconnect hint — never hang.
    let err = interp
        .eval_str(r#"(mcp/call h "hang" {})"#)
        .expect_err("a tombstoned handle must error, not hang or silently succeed");
    let msg = err.to_string();
    assert!(
        msg.contains("connection lost") && msg.contains("cancelled mid-call"),
        "expected the documented tombstone message, got: {msg}"
    );

    // The interpreter/run remains healthy: ordinary evaluation still works
    // and no task is left orphaned in the scheduler.
    let healthy = interp
        .eval_str("(+ 1 2)")
        .expect("interpreter must remain usable after the cancellation");
    assert_eq!(healthy, Value::int(3));
    assert_eq!(
        sema_vm::scheduler_task_count(),
        0,
        "the cancelled task must be reaped, not left orphaned in the scheduler"
    );
}

// ── Scenario 6: sync (non-async) context is unchanged ───────────────────────

#[test]
fn sync_context_mcp_call_is_unaffected_by_the_async_offload() {
    let interp = Interpreter::new();
    interp
        .eval_str(&connect_busy_counter_expr())
        .expect("connect");

    // A plain top-level (non-async-context) call: fully synchronous, exactly
    // as before this change — no scheduler, no yield, no offload.
    let result = interp
        .eval_str(r#"(mcp/call server "count" {})"#)
        .expect("sync mcp/call");
    assert_eq!(result.as_str(), Some("call-1"));

    interp.eval_str("(mcp/close server)").ok();
}

// ── Scenario 7: cassette replay stays synchronous in async context ─────────

const REPLAY_COUNTER_SERVER: &str = r#"
import json, sys
initialized = False
counter = 0
def send(m):
    sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    r = json.loads(line); method = r.get("method"); rid = r.get("id")
    if rid is None:
        if method == "notifications/initialized":
            initialized = True
        continue
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": "2025-11-25", "capabilities": {},
            "serverInfo": {"name": "replay-counter", "version": "1"}}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": rid, "result": {"tools": [
            {"name": "count", "description": "increment",
             "inputSchema": {"type": "object", "properties": {}}}]}})
    elif method == "tools/call":
        counter += 1
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "content": [{"type": "text", "text": "call-%d" % counter}], "isError": False}})
    else:
        send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "no"}})
"#;

fn tape_path() -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!(
        "sema-mcp-async-cassette-{}-{}/tape.ndjson",
        std::process::id(),
        n
    ))
}

#[test]
fn cassette_replay_stays_synchronous_inside_async_task() {
    let tape = tape_path();
    let interp = Interpreter::new();
    let encoded = sema_str(REPLAY_COUNTER_SERVER);
    interp
        .eval_str(&format!(
            r#"(define server (mcp/connect {{:command "python3" :args ["-c" {encoded}]}}))"#
        ))
        .expect("connect");

    // --- Record (sync, top level): the real call runs and is taped. ---
    install_cassette(Cassette::load(tape.clone(), CassetteMode::Record));
    let r1 = interp
        .eval_str(r#"(mcp/call server "count" {})"#)
        .expect("record call");
    assert_eq!(r1.as_str(), Some("call-1"));
    take_cassette()
        .expect("cassette installed")
        .save()
        .expect("save tape");

    // --- Replay INSIDE an async task: must resolve without ever offloading
    //     (no live server touch — the counter must NOT advance). ---
    install_cassette(Cassette::load(tape, CassetteMode::Replay));
    let r2 = interp
        .eval_str(r#"(await (async/spawn (fn () (mcp/call server "count" {}))))"#)
        .expect("replay call inside async task");
    assert_eq!(
        r2.as_str(),
        Some("call-1"),
        "replay in async context must return the recorded value, not re-hit the server"
    );

    // --- Proof: drop the cassette and call for real → the server advances to
    //     call-2, confirming the async replay above did NOT touch it. ---
    take_cassette();
    let r3 = interp
        .eval_str(r#"(mcp/call server "count" {})"#)
        .expect("live call");
    assert_eq!(r3.as_str(), Some("call-2"));

    interp.eval_str("(mcp/close server)").ok();
}
