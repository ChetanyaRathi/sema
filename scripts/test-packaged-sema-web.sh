#!/usr/bin/env bash
# Prove that the published sema-lang crate contains and embeds the complete
# browser runtime. The build runs from the unpacked .crate, not the checkout.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
SERVER_PID=""

if grep -R -n -E 'cfg\(web_runtime\)|jake wasm\.web-runtime' \
  "$ROOT/crates/sema/src" \
  "$ROOT/crates/sema/tests"; then
  echo "packaged web smoke: optional runtime configuration or end-user Jake guidance found" >&2
  exit 1
fi

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

PACKAGE_TARGET="$TMP/package-target"
CARGO_TARGET_DIR="$PACKAGE_TARGET" cargo package \
  --manifest-path "$ROOT/Cargo.toml" \
  -p sema-lang \
  --allow-dirty \
  --offline \
  --no-verify

CRATE="$(find "$PACKAGE_TARGET/package" -maxdepth 1 -name 'sema-lang-*.crate' -print -quit)"
if [[ -z "$CRATE" ]]; then
  echo "packaged web smoke: cargo did not produce a sema-lang .crate" >&2
  exit 1
fi

mkdir -p "$TMP/unpacked"
tar -xzf "$CRATE" -C "$TMP/unpacked"
PACKAGE_DIR="$(find "$TMP/unpacked" -mindepth 1 -maxdepth 1 -type d -name 'sema-lang-*' -print -quit)"
if [[ -z "$PACKAGE_DIR" ]]; then
  echo "packaged web smoke: sema-lang package directory is missing" >&2
  exit 1
fi

ASSETS=(
  morphdom-esm.js
  sema-web.js
  sema/backends/indexed-db.js
  sema/backends/local-storage.js
  sema/backends/memory.js
  sema/backends/session-storage.js
  sema/backends/web-storage.js
  sema/index.js
  sema/vfs.js
  sema_wasm.js
  sema_wasm_bg.wasm
  signals-core.module.js
)
for asset in "${ASSETS[@]}"; do
  if [[ ! -s "$PACKAGE_DIR/src/web/assets/$asset" ]]; then
    echo "packaged web smoke: missing src/web/assets/$asset in $(basename "$CRATE")" >&2
    exit 1
  fi
done

# Package manifests correctly replace workspace paths with registry versions.
# Patch those packages back to this checkout so the smoke remains runnable on
# unreleased commits while the sema-lang source itself stays the actual .crate.
mkdir -p "$PACKAGE_DIR/.cargo"
{
  echo '[patch.crates-io]'
  for crate in core reader vm eval stdlib llm fmt workflow lsp dap docs notebook mcp otel io; do
    printf 'sema-%s = { path = "%s/crates/sema-%s" }\n' "$crate" "$ROOT" "$crate"
  done
} >"$PACKAGE_DIR/.cargo/config.toml"

BUILD_TARGET="$TMP/build-target"
(
  cd "$PACKAGE_DIR"
  CARGO_TARGET_DIR="$BUILD_TARGET" cargo build --bin sema
)

printf '(display "packaged web runtime")\n' >"$TMP/app.sema"
PORT="$(python3 - <<'PY'
import socket

with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"

"$BUILD_TARGET/debug/sema" web "$TMP/app.sema" \
  --host 127.0.0.1 \
  --port "$PORT" \
  --no-open \
  >"$TMP/server.stdout" \
  2>"$TMP/server.stderr" &
SERVER_PID=$!

SHELL_HTML="$TMP/shell.html"
for _ in $(seq 1 100); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    wait "$SERVER_PID" || true
    SERVER_PID=""
    echo "packaged web smoke: sema web exited before serving" >&2
    cat "$TMP/server.stderr" >&2
    exit 1
  fi
  if curl -fsS "http://127.0.0.1:$PORT/" >"$SHELL_HTML" 2>/dev/null; then
    break
  fi
  sleep 0.1
done

if [[ ! -s "$SHELL_HTML" ]] || ! grep -q '<div id="app"></div>' "$SHELL_HTML"; then
  echo "packaged web smoke: application shell was not served" >&2
  cat "$TMP/server.stderr" >&2
  exit 1
fi

curl -fsS "http://127.0.0.1:$PORT/__sema/sema_wasm_bg.wasm" >/dev/null
echo "packaged web smoke: PASS"
