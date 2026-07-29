# Windows product bugs surfaced by the test-porting wave (2026-07-29)

The Windows test leg's first honest run (nightly harness, PR #135) reduced 189
failures to a handful of root causes. Most were test-portability issues, fixed
in the same PR. These five were REAL product bugs on Windows; none reproduce
on Unix. **Bugs 2, 3, and 4 are fixed in this PR's wave B** (tarball
`has_root` rejection; fmt separator normalization; rollback via a write-mode
handle) with their detector tests re-enabled cross-platform. Bugs 1 and 5
remain open; their detector tests stay red on Windows (or cfg-gated with a
pointer here) until fixed.

## 1. `sema build` executables never find their embedded payload (severity: high)

**FIXED (wave B2, pending Windows CI confirmation).** A `sema build` `.exe`
booted as the plain sema CLI/REPL — `try_run_embedded()`
(`libsui::find_section("semaexec")`) returned `None`. Diagnosis chain: the
resource was structurally present (pefile parses it) but `FindResourceW`
failed with ERROR_RESOURCE_TYPE_NOT_FOUND (1813) — the PE resource directory
was serialized in *insertion* order, while the Win32 API's binary search
requires the spec's sorted order (named-before-ID, ascending). Both writers
in the old pipeline emit unsorted trees: libsui 0.16's own writer, and
editpe 0.1 (IndexMap insertion order). editpe 0.2 serializes sorted
(resource.rs `sorted_keys`), so the fix is: bump editpe to 0.2 and keep
`set_windows_version_info` as the FINAL pass — it re-serializes the whole
tree sorted, and payload + icons + VERSIONINFO all survive API-visible.
Verified structurally on a cross-built exe: root type IDs [3, 10, 14, 16] in
file order (sorted), RT_RCDATA/SEMAEXEC + icons + RT_VERSION present. This
affected every release to date; not a regression from the test wave.
Detected by: 10 `sema build` integration tests + the run-step of
`output_into_existing_directory` (integration_test.rs) + mcp_suite's
`standalone_binary_mode` (spawns a `sema build` binary as an MCP server).

## 2. `extract_tarball` path-escape: rooted driveless entries (severity: high, security)

crates/sema/src/pkg.rs:1319 rejects absolute tar entries via
`path.is_absolute()`. On Windows, a rooted driveless entry like
`/tmp/pwned.txt` is NOT `is_absolute()`, passes the `ParentDir` scan, and
`dest.join(...)` re-roots it onto dest's drive — writing `C:\tmp\pwned.txt`
OUTSIDE the extraction dir. Fix: reject `path.has_root()` (any
`Component::RootDir`/`Prefix`), not just `is_absolute()`.
Detected by: `extract_tarball_rejects_absolute_paths` (pkg.rs tests; the test
now uses a host-absolute entry so it guards the primary property on all
platforms — the driveless-rooted case still needs the product fix + a
dedicated test).

## 3. `sema fmt` non-glob ignore entries never match (severity: medium)

`is_ignored` in `run_fmt` (crates/sema/src/main.rs:3608-3619) compares
normalized `/`-separated ignore prefixes against walked paths that use `\` on
Windows, so literal-prefix entries (`vendor/`) are silently ignored while glob
entries happen to work (the `glob` crate matches either separator). A Windows
user's sema.toml `[fmt] ignore` prefixes do nothing. Fix: normalize the
candidate path's separators before the prefix compare.
Detected by: `fmt_ignore_list_skips_globs_and_prefixes`,
`fmt_check_respects_ignore_list` (misc_suite fmt_cli_test).

## 4. Memory-store flush rollback is a no-op on append handles (severity: medium)

`write_lines` (crates/sema-stdlib/src/memory.rs ~400) opens the JSONL sidecar
with `.append(true)` and rolls back a failed write via
`file.set_len(pre_len)`. Windows append handles carry `FILE_APPEND_DATA`
without `FILE_WRITE_DATA`, so the truncate fails silently and a torn line
survives (CI observed `{"con{"content":"turn-two"...}`). Fix: reopen with
write access (or open read+write and seek to end) for the rollback path.
Detected by: `memory_partial_flush_failure_retries_without_duplicates`
(llm_suite memory_test; `#[cfg(unix)]` with a pointer here).

## 5. Cancelling `mcp/close` over HTTP doesn't sever the transport (severity: low)

On Unix, dropping the in-flight request future closes the connection and the
peer sees the disconnect; on Windows the peer observed no disconnect within
30s (`interruptible_blocking` select path in crates/sema-mcp/src/builtins.rs;
Http `shutdown` in client.rs). Needs Windows-side investigation of
reqwest/hyper teardown semantics when the op future is dropped.
Detected by: `runtime_mcp_close_wait_is_promptly_cancellable`
(mcp_runtime_test; `#[cfg(unix)]` with a pointer here).

## Test-infra debt (not product)

- `tests/common/watchdog.rs` `BoundedDrain::finish` cancels reads with
  `CancelSynchronousIo`, but std's child-stdio pipes are overlapped named
  pipes — it can never cancel them (perpetual `ERROR_NOT_FOUND`); the join
  waits for pipe break instead (~3.3s observed). Fix: duplicate the pipe
  handle before moving the reader into the drain thread and `CancelIoEx` it;
  the drain loop's `ERROR_OPERATION_ABORTED` arm already handles the wakeup.
  Detected by: `windows_inherited_pipe_writer_does_not_block_drain_join`.
- `stdio_server_exited` (mcp_runtime_test.rs) probes liveness with python
  `os.kill(pid, 0)` + `ps`: on Windows `os.kill(pid, 0)` KILLS the process and
  `ps` doesn't exist, so the probe reports "exited" vacuously.
- Checkout CRLF: git's text heuristic + autocrlf mangles all-ASCII binary-ish
  fixtures (the 751-byte PDF; the workflow golden journal). Scoped
  `crates/sema/tests/fixtures/.gitattributes` (`*.pdf binary`) landed with the
  wave; a broader root `.gitattributes` (`*.sema text eol=lf`, `*.sh text
  eol=lf`, `fixtures/** -text`) is the durable fix and still open.
