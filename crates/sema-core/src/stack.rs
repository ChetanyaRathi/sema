//! Stack-growth guard for deeply recursive work.
//!
//! Recursive value walks (`Display`, `value_to_json`, `pretty_print`) and
//! re-entrant native→VM calls consume the real OS thread stack per level. On a
//! deep-but-finite structure — or a recursive Sema function that maps over its
//! children — this overflows the fixed 8 MB main-thread stack and aborts the
//! process with an uncatchable SIGABRT, *before* the VM's frame guard can turn
//! it into a catchable error. [`maybe_grow`] grows the stack on demand at those
//! recursion points so the process survives to hit the guarded limit instead.

/// Grow when fewer than this many bytes of stack remain.
const RED_ZONE: usize = 128 * 1024;
/// Size of each freshly allocated stack segment.
const STACK_SIZE: usize = 4 * 1024 * 1024;

/// Run `f`, first extending the stack if it is near exhaustion. Cheap when
/// there's ample stack left (a bounds check), so it's safe to call at every
/// level of a recursion.
#[cfg(not(target_arch = "wasm32"))]
pub fn maybe_grow<R>(f: impl FnOnce() -> R) -> R {
    stacker::maybe_grow(RED_ZONE, STACK_SIZE, f)
}

/// wasm cannot grow its stack, so this is a plain call (deep recursion there is
/// bounded by the same limits as before).
#[cfg(target_arch = "wasm32")]
pub fn maybe_grow<R>(f: impl FnOnce() -> R) -> R {
    f()
}
