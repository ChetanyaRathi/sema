#!/usr/bin/env bash

# Single entry point for every wasm-pack build in this repo.
#
# Exists to make the compiled WASM byte-identical across machines. rustc bakes
# absolute source paths into the binary (panic/debug strings from dependencies,
# e.g. `/Users/you/.cargo/registry/src/.../regex-1.12.3/src/lib.rs`), so a build
# on a laptop and the same build on a CI runner differ by thousands of bytes.
# That made the committed browser runtime under `crates/sema/src/web/assets/`
# impossible to verify: verify.yml rebuilds it and requires `git diff --quiet`,
# which no contributor could ever satisfy from their own machine. It also meant
# every shipped artifact leaked the maintainer's home directory.
#
# `--remap-path-prefix` rewrites those three roots (CARGO_HOME, the rustc
# sysroot, this checkout) to fixed names, so the output depends on the source,
# not on where it was built.
#
# Usage: scripts/wasm-build.sh <wasm-pack args...>

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CARGO_ROOT="${CARGO_HOME:-$HOME/.cargo}"
SYSROOT="$(rustc --print sysroot)"

# CARGO_ENCODED_RUSTFLAGS, not RUSTFLAGS: the flags are \x1f-separated, so a
# single flag may contain spaces. The wasm link flags below are exactly that
# (`link-args=--stack-first -z stack-size=16777216`) — passing them through the
# space-separated RUSTFLAGS splits `-z` into its own argument and rustc dies
# with "Unrecognized option: 'z'".
#
# Either variable REPLACES `target.<triple>.rustflags` from .cargo/config.toml —
# they do not merge — so setting one naively would silently drop the wasm stack
# configuration and produce a binary that overflows on deep recursion. Read that
# array out of the config and prepend it rather than restating it here, so the
# config stays the single source of truth for those flags.
CARGO_ENCODED_RUSTFLAGS="$(python3 - "$ROOT/.cargo/config.toml" "$CARGO_ROOT" "$SYSROOT" "$ROOT" <<'PY'
import pathlib
import sys
import tomllib

config_path, cargo_root, sysroot, checkout = sys.argv[1:5]
config = tomllib.loads(pathlib.Path(config_path).read_text())
base = config.get("target", {}).get("wasm32-unknown-unknown", {}).get("rustflags")
if not base:
    raise SystemExit(
        f"wasm-build: no [target.wasm32-unknown-unknown] rustflags in {config_path}. "
        "If they moved, update this script — dropping them silently would ship a "
        "WASM binary with the wrong stack size."
    )
# Remap targets are arbitrary but must be identical on every machine.
remaps = [
    f"--remap-path-prefix={cargo_root}=/cargo",
    f"--remap-path-prefix={sysroot}=/rustc",
    f"--remap-path-prefix={checkout}=/sema",
]
sys.stdout.write("\x1f".join([*base, *remaps]))
PY
)"
export CARGO_ENCODED_RUSTFLAGS

exec wasm-pack build "$@"
