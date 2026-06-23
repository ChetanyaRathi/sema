//! Process-wide multi-thread Tokio runtime shared by every blocking stdlib leaf
//! that has been converted to the cooperative `AwaitIo` yield (currently `http/*`
//! and `shell`).
//!
//! A *single* shared runtime (rather than a per-VM-thread one) lets N in-flight
//! offloaded operations overlap: an `async/spawn`'d task parks on `AwaitIo` while
//! the VM thread runs its siblings, each launching its own future on this one
//! runtime. We never depend on `sema-llm`'s runtime — stdlib must not depend on
//! `sema-llm` — so the runtime is owned here, in stdlib, and reused by both the
//! http and shell slices so there is exactly ONE such runtime per process.

use std::sync::OnceLock;

use tokio::runtime::Runtime;

static STDLIB_SHARED_RT: OnceLock<Runtime> = OnceLock::new();

/// Get (initializing on first use) the process-wide shared runtime that drives
/// offloaded stdlib I/O (http round-trips, subprocess execution) concurrently.
pub(crate) fn stdlib_shared_rt() -> &'static Runtime {
    STDLIB_SHARED_RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("STDLIB_SHARED_RT")
    })
}
