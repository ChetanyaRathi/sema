//! Sema Debug Adapter Protocol (DAP) server.
//!
//! # Known limitations
//!
//! - **Dynamically loaded/imported code is not debuggable** (§7.4 #4). Code
//!   reached via `(load ...)` or `(import ...)` is evaluated by the
//!   tree-walking interpreter, which does not participate in the VM debug loop.
//!   Breakpoints set in such files will not be hit. When a debug session is
//!   active the evaluator emits a one-time warning (surfaced as a DAP `Output`
//!   event) the first time `load`/`import` runs, so this failure is no longer
//!   silent. Making those files fully debuggable would require running them
//!   under the VM debug loop and is out of scope.
//! - **Single reported thread** (§7.4 #5). The `threads` request returns one
//!   hardcoded `main` thread. Debugged execution runs a single VM
//!   synchronously, so this is correct for synchronous programs. Async VM tasks
//!   (channels) are not enumerated as DAP threads; there is currently no cheap,
//!   correct way to surface them.

pub mod protocol;
pub mod server;
pub mod transport;

pub async fn run_server() {
    eprintln!("Sema DAP server starting on stdio...");
    server::run().await;
}
