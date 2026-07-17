# Shell script style — `scripts/*.sh`

House style for shell scripts in this repo. It's opinionated and tuned to what
we actually run (jake-driven, CI-gating, macOS-first), not a generic guide. The
exemplar is [`scripts/pack-mcpb.sh`](../scripts/pack-mcpb.sh); when in doubt,
copy its shape. Formatting and lint are enforced by `jake scripts.check` (shellcheck
+ shfmt); the header, `set`, naming, and exec-bit rules below are convention —
followed by every script in `scripts/`, not machine-checked.

It borrows from the [Google Shell Style Guide](https://google.github.io/styleguide/shellguide.html)
and the ["unofficial bash strict mode"](https://web.archive.org/web/2024/https://redsymbol.net/articles/unofficial-bash-strict-mode/),
but overrides them where our reality differs (e.g. shebang, `set` exceptions).

## Header

Every script opens with this block — one-line purpose, the *why*, and usage. Rationale over mechanics (same rule as the rest of the codebase: keep the
why, drop change-narration).

```bash
#!/usr/bin/env bash

# One-line summary: what it produces or proves.
#
# Longer description: how it works and, crucially, WHY — the invariant it
# guards, the incident it prevents, or the non-obvious constraint. Skip this
# paragraph only for genuinely trivial scripts.
#
# Usage: scripts/name.sh [--flag VALUE] [args]
#   --flag   what it does                       (default: X)
#
# Env: KNOB (default Y)          # only if it reads env vars
# Requires: tool1, tool2         # only if it needs external tools

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
```

Rules:

- **Shebang is always `#!/usr/bin/env bash`.** All our scripts already are. This
  deliberately overrides Google's `#!/bin/bash` — we run on macOS, where stock
  `/bin/bash` is an ancient 3.2 and Homebrew's bash lives elsewhere on `PATH`.
- **A blank line after the shebang** (not a `#` spacer), then a **single-line
  summary** in the imperative ("Build the …", "Guard: …"), then a `#` gap and the
  longer description. No filename line — the path already names the file; a header
  line just drifts on rename.
- **Breathing room:** a blank line between the header comment and `set`, and a
  blank line after `set` before the first statement. Give the code room.
- Include `Usage:`/`Env:`/`Requires:` lines only when they apply. Keep any
  `Usage:` text in sync with a `usage()` heredoc if the script has one.

## Safety

- **Default to `set -euo pipefail`.** `-e` aborts on any unchecked failure, `-u`
  turns unset-variable typos into errors (matters next to `rm -rf "$X/"`), and
  `pipefail` surfaces failures mid-pipeline instead of masking them.
- **Sanctioned exception — loop-and-tally / exit-code-inspecting runners.** A
  script whose job is to run many things and *count* failures (rather than stop
  at the first) may drop `-e`. Once every failable command is explicitly checked
  (`if ! cmd`, `status=$?`, `|| ((fail++))`), `-e` adds nothing but false
  confidence — and dropping it makes the explicit-checking discipline visible.
  These use `set -uo pipefail` (or `set -u`). **When you drop `-e`, say why on
  the `set` line** — e.g.
  `set -uo pipefail  # no -e: tally example failures, don't abort on first`.
  `build-examples.sh`, `run-examples.sh`, and `grammar-fuzz.sh` do this.
  (Tallying is also fine *with* `-e` if each command's status is captured before
  it can trip errexit — `smoke-bytecode.sh` keeps `-euo pipefail` and counts
  failures safely. Either is acceptable; be deliberate.) See
  [BashFAQ/105](https://mywiki.wooledge.org/BashFAQ/105) for why `set -e` is not
  a substitute for real error checks.
- **To let one command fail under `-e`**, append `|| true` (or use `if ! cmd`) —
  don't drop `-e` globally.
- **Quote every expansion** — `"$var"`, `"$@"`, `"$(cmd)"`. `cd … || exit`.
  Guard arithmetic that can be zero: `((n++)) || true`.
- **Temp dirs:** `WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT`.
- **`printf`, not `echo -e`** (portable, and safe under macOS Bash 3.2 — avoid
  `mapfile`/associative arrays for the same reason).
- We intentionally do **not** set `IFS=$'\n\t'` by default — none of our scripts
  need it and it surprises readers. Add it locally only where you're iterating
  over newline-delimited data.

## Structure

Top-to-bottom: **header → `set` → constants → helpers → functions → execution.**
Keep functions together; don't hide executable code between them.

- **`ROOT` idiom** (when the script needs repo paths), canonical form:
  `ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"` — prefer
  `${BASH_SOURCE[0]}` over `$0` (survives sourcing/symlinks).
- **Helpers:** for scripts that emit progress + fatal errors, use the
  `pack-mcpb.sh` pair — `log()` to stdout/stderr, `die()` to stderr with a
  `name:` prefix and a non-zero exit:
  ```bash
  log() { printf '== %s\n' "$*"; }
  die() { printf 'name: %s\n' "$1" >&2; exit "${2:-1}"; }
  ```
- **Section banners** for multi-phase scripts: `# ── Title ──────────`. They're
  `shfmt`-stable and aid navigation; keep them sparse.
- **Constants** `UPPER_CASE`; function-local vars `lower_case` + `local`;
  env-overridable defaults via `${VAR:-default}`.
- **Arg parsing:** `while [[ $# -gt 0 ]]; do case "$1" in …` for long options;
  `getopts` for short-only. Don't mix the two in one pass.
- **A `main()` function is optional.** Google mandates one once a script has any
  other function; most of ours are small linear utilities where it's overkill.
  Reach for `main "$@"` only when a script grows several functions and a linear
  read stops being obvious. `shdoc`-style doc generation is not used — plain
  header + `usage()` carries the value for glue scripts.

## Formatting & linting

- **Format:** `shfmt -i 2 -ci` (2-space indent, indented `case` bodies). Run
  `jake scripts.fmt` to apply, `jake scripts.fmt-check` to verify.
- **Lint:** `shellcheck -S warning`. We gate at `warning` (real bugs +
  portability) and skip subjective `info`/`style` nags. Silence a specific
  finding narrowly with `# shellcheck disable=SCxxxx` **plus a reason comment**,
  never by lowering the global gate.
- **`jake scripts.check`** runs both and is the pre-commit gate for shell.
- Keep the executable bit set (`chmod +x`) on every `scripts/*.sh`.
