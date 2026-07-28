# Sibling-interleaving test failures: what is actually known (2026-07-28)

**Status: unexplained, not reproduced. The first version of this document
asserted a mechanism and recommended a fix; investigation showed the
recommendation was wrong and the mechanism unverified. Both are corrected
below.**

## The observation

Four consecutive `cargo nextest run --workspace` runs each failed a *different*
test and passed all 7305 others:

| Run | Failed |
| --- | --- |
| 1 | `agent_async_test::concurrent_agents_overlap_and_peak_inflight` |
| 2 | `agent_runtime_test::concurrent_agents_overlap_via_runtime` |
| 3 | `stream_async_test::sema_stream_rate_pacing_uses_a_structural_timer` |
| 4 | `llm_root_nonblocking_test::disk_cache_hit_parks_while_a_sibling_runs` |

All four belong to the family that proves a runtime operation parks the VM
thread rather than pinning it.

## What is NOT known, and should have been captured

**The assertion text was never recorded** — only the test names from the FAIL
lines. That matters more than it sounds. `disk_cache_hit_parks_while_a_sibling_runs`
carries two assertions: the channel order, *and* `recorder.call_count() == 0`
("the disk cache hit must not call the provider"). A failure of the second is a
real cache bug, not a timing artifact, and nothing recorded distinguishes them.

**Anyone who reproduces this must run with `--failure-output immediate` and
paste the assertion.** Everything below is unresolved without it.

## Reproduction attempts, all negative

Since the observation, on the same machine:

- 4 full-workspace runs, idle machine: all 7306 pass
- 1 full-workspace run under 16 deliberate CPU spinners: all 7306 pass (113s vs
  ~50s, so the contention was real)
- 6 targeted runs of the four owning binaries together: all pass

CPU contention does not reproduce it. During the original failures an unrelated
`crossgen2` .NET build was running, and the runs directly followed heavy npm and
Playwright activity — so I/O or memory pressure remain untested hypotheses.

## What the investigation DID establish: the tests are sound

Both sibling forms in the suite are legitimate designs, and the first version of
this document was wrong to call one of them redundant.

```sema
(async/spawn (fn () (sleep 10) (channel/send out "sibling")))   ; timed,  40 sites
(async/spawn (fn () (channel/send out "sibling")))              ; causal, 35 sites
```

Measured against the real binary:

| Root behaviour | Sibling | Order | Proves |
| --- | --- | --- | --- |
| returns immediately, no yield | zero-delay | **root** first | causal form discriminates |
| parks (`async/sleep 50`) | zero-delay | sibling first | ” |
| long pure computation | zero-delay | sibling first | VM yields mid-computation |
| parks 100 ms | `sleep 10` | sibling first | timed form discriminates |

So:

- The **causal** form proves the root yielded at all rather than returning
  synchronously. Sound, and race-free.
- The **timed** form proves the root spent ≥10 ms in a state where the runtime
  could still service timers. Strictly stronger, at the cost of a margin that
  load can erode.

Neither is lazy test-writing, and **rewriting the timed sites into the causal
form — which the first version of this document recommended — would have
weakened 40 tests for no reason.**

A methodological note, since it cost two wrong conclusions here: probing this
with a long computation as the "non-parking" root is misleading. The VM yields
during ordinary computation, so a 2-million-iteration loop lets the sibling in
and makes the causal form look vacuous. The root has to be *trivially* fast for
the negative case to mean anything.

## The one part that is straightforwardly fragile

The `concurrent_agents_overlap_*` tests assert `wall_ms < 700`, an explicit
wall-clock **upper** bound. That is load-sensitive by construction regardless of
anything above. Their companion assertion, `io_peak_inflight() >= 2`, is a lower
bound and is trustworthy either way.

The general rule: **lower bounds and orderings are load-safe; upper bounds are
not.**

## Open questions, in priority order

1. What did the four failures actually assert? Nothing proceeds without this.
2. Should the `wall_ms < N` upper bounds be replaced by the `io_peak_inflight()`
   lower bound those same tests already carry? That is the one change here with
   a clear payoff and no loss of coverage.
3. Is the failure I/O-related rather than CPU-related? The original runs
   followed heavy npm/Playwright activity with an unrelated .NET build running;
   CPU contention alone is ruled out.

## Related

`crates/sema/tests/agent_runtime_test.rs`, `agent_async_test.rs` and
`suites/stream_file_async_test.rs` carry module-level notes about wall-clock
sensitivity in their own tests. The `stream_file_async_test` note describes a
*separately confirmed* case (11 subprocess tests timing out together at exactly
10.0s under full CPU load, reproduced and then cleared), and stands.
