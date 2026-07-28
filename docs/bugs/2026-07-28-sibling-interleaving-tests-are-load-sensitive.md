# The `parks_while_a_sibling_runs` family is load-sensitive (2026-07-28)

18 tests across 10 files in `crates/sema/tests/` prove that a blocking-looking
operation actually parks the VM thread cooperatively. They all use one shape:

```sema
(let ((out (channel/new 2)))
  (async/spawn (fn () (sleep 10) (channel/send out "sibling")))
  (channel/send out (llm/complete "root"))
  (list (channel/recv out) (channel/recv out)))
```

and assert `"sibling"` arrives first. The logic is sound: if the root operation
pinned the VM thread, the sibling's timer could not fire during it.

**But the assertion is a race between two durations**, and it holds only while
the sibling's 10 ms sleep reliably beats the root operation. Under
`cargo nextest run --workspace` — 7306 tests contending for the same cores — a
10 ms sleep can overshoot by an order of magnitude, the order flips, and the
test reports "the runtime still blocks the VM thread" when the runtime is fine.

## Evidence

Four consecutive full-workspace runs, on an otherwise idle machine, each failed
a *different* member of the family and passed every other test:

| Run | Failed |
| --- | --- |
| 1 | `agent_async_test::concurrent_agents_overlap_and_peak_inflight` |
| 2 | `agent_runtime_test::concurrent_agents_overlap_via_runtime` |
| 3 | `stream_async_test::sema_stream_rate_pacing_uses_a_structural_timer` |
| 4 | `llm_root_nonblocking_test::disk_cache_hit_parks_while_a_sibling_runs` |

Every one of them passes in isolation: the pacing test 10/10 here, and 20/20
earlier under twelve deliberate CPU burners. **That earlier stress test was not
representative** — twelve spinning shells are far less contention than 7306
tests, and it produced a confident "not flaky" verdict that was wrong. Isolation
runs and synthetic load both under-report this; only the real full-workspace run
reproduces it.

`#[serial]` does not help. It serializes these tests against each other, but
nextest still runs the rest of the workspace in parallel processes alongside
them.

## Why it matters

`.github/workflows/verify.yml` gates crates.io and npm publishing on a green
workspace suite. An intermittently red member of an 18-test family means the
publish gate fails for reasons unrelated to the change being published, which
trains everyone to re-run rather than read.

## The fix, not yet applied

Make the sibling's progress **causal rather than timed**. `async/spawn` is lazy —
a spawned task first runs when the spawner parks — so a sibling with *no* sleep
already discriminates:

- root parks cooperatively -> the spawned sibling runs during the park and sends first
- root pins the thread -> nothing else can run, so the root sends first

That removes the duration race entirely while proving the same property.

**One caveat per test, which is why this is not a blind find-and-replace.** The
sibling must not be able to win for a reason unrelated to the property under
test. `sema_stream_rate_pacing_uses_a_structural_timer` is the known example: the
Sema-backed `llm/stream` parks for its *offload* regardless of whether the rate
limiter parks, so a zero-delay sibling wins either way and the test would pass
against a broken pacing implementation. That one needs a second, load-monotone
assertion — a wall-clock **lower** bound (`elapsed >= the pacing interval`),
which load can only make more true.

The general rule this family should follow: **lower bounds and orderings are
load-safe; upper bounds are not.**

## Related

`crates/sema/tests/agent_runtime_test.rs`, `agent_async_test.rs` and
`suites/stream_file_async_test.rs` carry module-level notes describing the same
hazard for their own tests, added the same day.
