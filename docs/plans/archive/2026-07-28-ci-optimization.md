# CI optimization & simplification — 2026-07-28

Audit of all 9 workflows + scripts + jake recipes, based on step-level timing of
recent real runs (gh API) and git/docs archaeology. Goal: everything except the
PGO release fails fast and wastes nothing, with **zero weakening** of the
regression gates. Findings below are measured, not estimated, unless marked.

## Measured baseline (per-step, recent green runs)

| Workflow | Wall | Composition |
| --- | --- | --- |
| CI (every push + PR) | **44.2m** | `test` 14.2m; `test-windows` **44.1m advisory, 0/37 ever green**; playground e2e 3.3m |
| — `test` job (14.2m) | | nextest 4.3m · `jake examples` **4.1m (4m05s is a release rebuild, examples run ~2s)** · coverage (advisory) 2.5m · LSP e2e ~0.5m · fmt+clippy+docs-check ~1m · setup ~1m |
| Verify (gates both publishes) | 13.2m | nextest 4.4m · examples **4.4m (same rebuild)** · packaged-crate smoke 2.1m · smoke-bytecode 0.75m · rest <1m; runs **twice per tag** (publish.yml + publish-npm.yml each call it) |
| sema-web tests | 7.8m | `unit` 4.3m (incl. **1.4m compiling wasm-pack from source** on cache miss) → serial `e2e` 3.4m (native build, **no rust-cache**) |
| notebook e2e | 2.2m | fine |
| Publish crates.io | 20.4m | verify 12.8m → publish-crates 7.3m (**no rust-cache**, 16 serial verify-builds + 80s of `sleep 5`) |
| Publish npm | 16.7m | verify 12.7m → 3.9m (2.55m cold wasm build) |
| Release (cargo-dist + PGO) | 39.2m | **accepted as slow — out of scope** |

Cross-cutting: **no `concurrency:` groups, no `timeout-minutes`, no path
filters anywhere**. 4 of the last 5 main pushes were docs-only and each burned
~62 runner-minutes. `test-windows` never saves its cache (rust-cache skips
save on failure, and it always fails), so every run recompiles cold.

## Correctness bugs found by the audit (not speed)

1. **mcpb.yml has never executed — verified: zero runs, no `.mcpb` asset on
   v1.31.5.** Its `release: types [published]` trigger can never fire because
   cargo-dist creates the GitHub Release with the default `GITHUB_TOKEN`, and
   GitHub suppresses workflow triggers for token-created events. Every release
   since 2026-07-17 silently shipped without the MCP bundle / registry entry.
2. **The npm-published wasm bypasses `scripts/wasm-build.sh`.**
   publish-npm.yml:60-66 calls raw `wasm-pack build`, so `@sema-lang/sema-wasm`
   ships **without `--remap-path-prefix` (leaks runner paths — the exact bug
   wasm-build.sh exists to fix per its own header) and without the
   `opt-level="s"`** every other wasm build uses. It's a fourth flag-variant no
   suite tests as-built.
3. **The cargo-dist Release path has no web-runtime freshness gate.** A stale
   committed runtime blocks crates.io/npm (verify) but still reaches GitHub
   Releases / shell installer / Homebrew. `dist-workspace.toml`'s
   `github-build-setup` (`.github/pgo-setup.yml`) is the supported hook to add
   the ~6s `check-web-runtime-fresh.sh` step — it must be fail-hard (the rest
   of pgo-setup.yml is deliberately `set +e`; the new step must not inherit
   that).
4. **The verify-only gates never run per-push.** Packaged-crate smoke,
   freshness check, and publish-list check execute only at tag/dispatch time —
   the exact "invisible until publish" failure mode verify.yml's own header
   documents (16 days red, hid two real bugs; happened twice: dde58688,
   13f1a6b3).
5. **Coverage-hole asymmetry:** notebook-e2e's path filter omits every engine
   crate (a VM change that breaks notebook eval never triggers it) and
   sema-web-tests omits `crates/sema/**` although its e2e shells
   `cargo run -p sema-lang`.
6. **docs-search-gate.sh is wired to no workflow** — a hermetic embedded-asset
   gate of the same class as the packaged smoke, silently dead.
7. Stale comment `jake/wasm.jake:60` says runtime assets are gitignored; they
   are git-tracked (the shipping invariant depends on it). A contributor
   following it would re-create the original shipped-broken bug.

## Plan

### Wave 1 — pure wins, no gate semantics change (CI 44m → ~11m)

1. **Move `test-windows` to a nightly cron workflow** (+ workflow_dispatch).
   Keep the job and the advisory→required plan; when it runs, add the missing
   ripgrep install (conformance tests structurally cannot pass without it),
   `cache-on-failure: true` on rust-cache, `timeout-minutes: 60`, and a
   `ci-windows` nextest profile (retries=0, skip Unix-only pty/proc tests via
   filter — 9 tests × 360s × 2 tries ≈ most of the 36m test tail).
2. **Move coverage + Codecov out of the `test` job** into the same nightly
   workflow (or a parallel advisory job). Was made advisory for flaking
   (2046c907); metrics must not ride the gating critical path. −2.5m.
3. **Kill the examples release-rebuild cost**: set
   `cache-workspace-crates: true` on Swatinem/rust-cache in ci.yml + verify.yml
   (v2.8+; zero behavior change) so `jake examples`' `cargo build --release`
   is incremental. −3.5m in CI, −3.5m in each verify. (Alternative — run
   examples on the debug binary — rejected: release-profile examples are part
   of the gate posture and debug timing risks 30s-timeout flakes.)
4. **Add `concurrency` cancel-in-progress** to ci.yml, sema-web-tests.yml,
   notebook-e2e.yml keyed on `${{ github.workflow }}-${{ github.ref }}`.
   **Never** on publish/release/mcpb (a cancelled half-publish is worse than a
   slow one); reusable workflows inherit the caller's group — keep verify's
   publish invocations out of any cancelling group.
5. **Path/trigger hygiene**:
   - ci.yml: `paths-ignore: [docs/**, website/**, CHANGELOG.md, README.md]` —
     NOT a blanket `**.md` (crates/sema-docs/entries/*.md feed the docs-check
     gate). Check branch protection first: a path-skipped required check blocks
     PR merge.
   - sema-web-tests.yml + notebook-e2e.yml: add `branches: [main]` to the push
     trigger — stops the duplicate run on every tag push (−9 runner-min per
     release) and the push+PR double-run on PR branches.
   - Widen filters per bug #5 above (notebook-e2e + engine crates,
     sema-web-tests + crates/sema/**). Costs ~2.2m per engine push; closes a
     real hole.
6. **`timeout-minutes` on every job**, sized ~2× measured (test 30, verify 25,
   playground 10, sema-web 15, notebook 10, publishes 30, windows 60). Leave
   release.yml alone (dist-generated).

### Wave 2 — one gate definition, jake as source of truth

7. **ci.yml consumes verify.yml** (`uses:` — verify already has
   workflow_call): deletes the byte-duplicated 6-step body that has already
   drifted destructively twice (d2d4a84a: nextest installed after docs-check
   broke every push for weeks; 9af260c3: missing ripgrep), and gives every
   main push the packaged-crate smoke (+2.1m, cheaper after #9), freshness
   check (+6s), and publish-list check (+1s) — closing bug #4 structurally.
   CI keeps extras (LSP e2e; windows/coverage now nightly) as sibling jobs.
   Add the LSP e2e to verify instead if we want publish-gate parity (it's
   ~30-60s warm; verify's header claims parity with CI but currently lacks it).
8. **jake drift closure**: `jake clippy` → `--workspace` (CI is the stricter,
   correct one); add recipes wrapping test-packaged-sema-web.sh and
   check-web-runtime-fresh.sh; extend `jake ci` to match the real gate
   (test.workspace + examples + smoke-bytecode + lint + docs-check + lsp-e2e +
   packaged-web + runtime-fresh + scripts.check); make CI call `jake lint`
   instead of inline cargo fmt/clippy; align nextest `--profile ci` usage; add
   `jake scripts.check` (shellcheck, ~10s) as a CI step; **pin the jake
   version** in the install block (currently `latest` inside the publish gate).
9. **Packaged-crate smoke caching**: point its throwaway
   `CARGO_TARGET_DIR` at `$ROOT/target/packaged-smoke` (inside rust-cache)
   instead of mktemp. The property proven — binary built from the unpacked
   .crate's own files — depends on where sema-lang *source* comes from, not on
   cold third-party deps. Keep `--workspace` packaging, the grep bans, the
   assets-deleted serve proof. −1–1.5m per verify.
10. **sema-web-tests**: pinned `taiki-e/install-action` wasm-pack@0.15.0
    (matches playground; kills the 1.4m source compile), add rust-cache to
    both jobs, merge unit+e2e into one job (halves setup + npm builds;
    ~7.8m → ~5m).
11. **Playwright browser caching** (`~/.cache/ms-playwright` keyed on
    playwright version) in playground-runtime, sema-web-tests, notebook-e2e.
12. **Composite setup action** (`.github/actions/setup-sema`): checkout ver,
    apt deps, toolchain, rust-cache, pinned jake — one place to bump; fixes
    the v4/v6/v7 checkout and Node 22/24 scatter.

### Wave 3 — release path correctness + speed

13. **Fix mcpb.yml trigger** (bug #1): `workflow_run` on Release completion
    (success + tag), keep workflow_dispatch as recovery. Backfill the missing
    bundles for recent releases via dispatch.
14. **Route the npm wasm build through scripts/wasm-build.sh** with the same
    flags as `jake wasm.js-lib-build` (bug #2). Artifact bytes change
    (smaller, path-clean) — scrutinize the next release's sema-web suite.
15. **Freshness gate on the dist path** via pgo-setup.yml, fail-hard (bug #3),
    then `dist generate` + commit.
16. **publish-crates**: add rust-cache, drop the 16× `sleep 5` (cargo publish
    already waits on the index). −3–4m. Keep the fail-loud idempotent loop
    verbatim (it encodes two real incidents).
17. **Merge publish.yml into publish-npm.yml** as a sibling `publish-crates`
    job sharing ONE `needs: verify` — halves verify per tag (−13 runner-min),
    one release pipeline. Hard constraints: the file MUST keep the name
    `publish-npm.yml` (npm Trusted Publishing OIDC is keyed to the filename);
    update `scripts/check-publish-list.sh` WF path in the same commit; both
    publish jobs keep hard `needs: verify` (fail-closed — do NOT replace with
    cross-workflow status lookups, which can fail open and re-create the
    "tests fail but ship" bug 9daf910b).
18. Optional/cheap: `pr-run-mode = "skip"` in dist-workspace.toml (−1m/PR
    noise); wire docs-search-gate.sh into verify or delete it with a docs
    note; fix the jake/wasm.jake:60 stale comment (bug #7); consider
    narrowing the freshness fingerprint's Cargo.lock input to the sema-wasm
    dependency cone (stops 5MB re-vendor commits on unrelated dep bumps) —
    err-safe default is to keep as-is.

## Projected end state

| | Before | After |
| --- | --- | --- |
| Push (Rust change) wall | 44m | **~10–11m** (test ~8m ∥ playground 3.3m ∥ sema-web ~5m) |
| Push (docs-only) | ~62 runner-min | **~0** |
| Verify | 13.2m | **~8–9m** |
| Tag → crates.io published | ~20m | **~13–14m** |
| Verify runs per tag | 2 | 1 |
| Gate definitions | 2 hand-synced copies | 1 (verify, backed by jake) |
| Windows/coverage | 47m advisory on every push | nightly, measuring real debt |
| Packaged/freshness/publish-list gates | tag-time only | **every push** |

## Must-keep (consolidated from all five agents — do not weaken)

- `scripts/test-packaged-sema-web.sh` unconditional in verify — the only
  works-from-checkout/broken-when-installed catcher (`sema web` "run jake"
  bug; out-of-crate icon include_bytes!). Inside it: `cargo package
  --workspace` (per-crate packaging deadlocks on `=X.Y.Z` pins), the
  cfg(web_runtime)/jake-guidance grep bans, untracked-assets rejection, the
  delete-assets-then-serve proof.
- `check-web-runtime-fresh.sh` as INPUT-freshness — never byte-identity
  (host-dependent, unsatisfiable, hid 2 bugs for 16 days), never API-surface
  (misses VM-internal staleness). Keep SANITY_FILES + cargo-tree-derived set.
- playground-runtime invoked **unconditionally from verify** — the "broken
  WASM never ships" compile+browser gate; only the ci.yml invocation may be
  path-filtered. Builds stay routed through scripts/wasm-build.sh.
- `needs: verify` hard edges for BOTH registries; verify keeps
  workflow_dispatch. Advisory legs (windows, coverage) stay OUT of verify.
- `check-publish-list.sh` (sema-otel 1.22.0 half-publish; v1.30.0 order bug);
  keep its dev-dependency-edge exclusion (13f1a6b3 cycle).
- publish.yml's fail-loud idempotent loop + libudev installs; Node 24 pin and
  registry-propagation wait in publish-npm.
- `jake examples` + `jake smoke-bytecode` in every gate (skipping them shipped
  a regression past 4 releases; smoke-bytecode is the only opcode-desync
  catcher). Speed them up; never remove.
- nextest ci profile: slow-timeout 120s × 3 (hang watchdog), retries=1 +
  fail-fast=false (absorbs the documented load-sensitive sibling-interleaving
  family — docs/bugs/2026-07-28).
- sema-web-tests must build the wasm before its suites — three suites
  self-skip green without it.
- release.yml is dist-generated — change via dist-workspace.toml +
  `dist generate` only. PGO slowness accepted.

## Verification procedure for the refactor

1. Each wave lands as its own PR from this worktree branch (`chore/ci-optimize`).
2. Mechanical step-list diff (old vs new workflows) — no gate step may vanish.
3. `gh workflow run verify.yml` dry-run green before any wave merges.
4. After wave 3: one release cut with extra scrutiny (npm wasm bytes change by
   design; confirm mcpb asset appears; confirm Homebrew/installer artifacts).
