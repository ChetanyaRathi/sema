# UCR-3: cancelling a rendezvous-matched channel receiver can drop the committed value

**Status:** FIXED (2026-07-16, archived 2026-07-28) — the recommended selection
guard landed in `cancel_waiting` (e4399de3), and the formerly-deferred
deterministic reproduction landed with it: `channel_close_staged_wake_survives_receiver_cancellation`
(2f68a2b9, `crates/sema-vm/src/runtime/tests.rs`) pins the staged-wake window,
alongside `rendezvous_wake_survives_receiver_shutdown_cancellation` for the
inline fast path. Only the general seeded-interleaving/model-checking harness
(archived Task 09) remains a separate idea.
`ChannelRegistry::has_wait(id, key)` now lets `cancel_waiting` skip a
`ProtocolWaitKind::Channel` waiter that is no longer queued in the channel
(already rendezvous-matched): its in-flight `ChannelWake` delivers the committed
value and UCR-1's settlement guard makes the receiver settle `Cancelled`, so the
value is never cancel-dropped. The `dropped_protocol_completions` diagnostic stays
in place as the regression oracle for the future seeded-interleaving test.
**Area:** `sema-vm` runtime — `state.rs` `cancel_waiting` / `finish_protocol_wait`
vs `channel.rs` rendezvous. Found by the Task-03/04 verification sweep, 2026-07-14.
**Severity:** medium (internal lost-completion; no observed Sema-level effect at the
current layer — both the buggy and correct paths settle the receiver `Cancelled`).

## The claim (static analysis)

1. A receiver `R` waits on channel `C`: `protocol_waits[key_R]` exists and `R` is
   in `C.receivers`.
2. A sender's `install_channel_wait` calls `channels.send`, which pops `R` from
   `C.receivers`, enqueues `ChannelWake{key_R, Received(v)}`, and returns `Sent`.
   `pop_wake` moves the wake into `state.pending` as `PendingStage::ChannelWake`.
   `R`'s task record stays `Waiting(key_R)` and `protocol_waits[key_R]` stays.
3. Before that wake is consumed, `R` is cancelled.
4. `cancel_waiting` selects `R` (`Waiting` + cancelled + `protocol_waits` has
   `key_R`), removes the protocol wait, and calls `channels.cancel_wait(C, key_R)`
   which returns `None` (R already popped from `receivers`) — the return is
   discarded (`let _ =`). `R` is resumed cancelled.
5. When the queued `ChannelWake` is later consumed, `finish_protocol_wait` finds
   `protocol_waits.remove(key_R) == None` and returned `Ok(())` — **silently
   dropping `v`**, a value the sender already observed as `Sent`.

## Why it is not yet reproduced

Empirically (three interleavings, incl. shutdown which runs `cancel_waiting`
before draining pending), the value is **not** dropped: the runtime consumes the
`ChannelWake` promptly, so by the time a cancellation could interleave the
receiver has already received `v` and `protocol_waits` is back to 0. The
"matched-but-unconsumed-wake" window in step 3 did not open in any tested drive
ordering. Whether a triggering interleaving exists (e.g. a specific `drive_cursor`
phase, or an internal `CancelPromise` mid-`advance_pending`) needs the seeded /
model-checking harness rather than hand-authored drives.

Probe evidence (removed after diagnosis): after the sender settled,
`protocol_waits == 0` and the receiver had already recorded its rendezvous
response — the wake was consumed before any cancel could orphan it.

## Detection now in place

`RuntimeState.dropped_protocol_completions` counts protocol completions that
carried an undelivered `Received(value)` but arrived after their wait was gone
(`finish_protocol_wait`). A nonzero count is, by definition, this lost-message
bug. `dropped_protocol_completions_for_test()` exposes it; the smoke test
`rendezvous_wake_survives_receiver_shutdown_cancellation` asserts it stays 0 on
the rendezvous+shutdown path. Any future seeded-interleaving test that opens the
window will trip this counter.

## Recommended fix (when a reproduction exists)

Treat a committed rendezvous as a completed operation (consistent with UCR-1):
do not let `cancel_waiting` cancel-and-drop a receiver whose wake is already in
flight — let the wake deliver, and let settlement observe cancellation.

Add `ChannelRegistry::has_wait(id, key) -> bool` and refine `cancel_waiting`'s
selection to skip a `ProtocolWaitKind::Channel` wait whose waiter is no longer
live in the channel (already matched). The in-flight `ChannelWake` then completes
the receiver normally; UCR-1's settlement guard makes it settle `Cancelled`. Land
this **with** a seeded-interleaving regression test that trips
`dropped_protocol_completions` before the fix and holds it at 0 after.
