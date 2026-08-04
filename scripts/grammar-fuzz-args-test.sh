#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRIVER="$ROOT/scripts/grammar-fuzz.sh"

assert_usage_error() {
  local expected="$1"
  shift
  local output status
  set +e
  output="$("$DRIVER" "$@" 2>&1)"
  status=$?
  set -e
  if [ "$status" -ne 64 ]; then
    echo "expected exit 64 for: $*; got $status" >&2
    echo "$output" >&2
    return 1
  fi
  if [[ "$output" != *"$expected"* ]]; then
    echo "expected '$expected' for: $*" >&2
    echo "$output" >&2
    return 1
  fi
}

assert_usage_error "BATCH must be greater than zero" check --async -n 1 -b 0
assert_usage_error "BATCH must be a non-negative decimal integer" check --async -n 1 -b nope
assert_usage_error "BUDGET must be greater than zero" check --async -n 1 -t 0
assert_usage_error "COUNT must be greater than zero" check -n 0
assert_usage_error "DEPTH must be a non-negative decimal integer" check -d -1

# Leading zeroes are valid decimal input and must not reach Bash as octal.
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$TEST_ROOT"' EXIT
cat >"$TEST_ROOT/sema" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TEST_ROOT/sema"
PATH="$TEST_ROOT:$PATH" \
  "$DRIVER" check --async -n 01 -d 00 -s -08 -b 01 -t 01 >/dev/null

echo "grammar-fuzz argument tests: clean"
