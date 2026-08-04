#!/usr/bin/env bash

# Driver for the Sema grammar fuzzer (fuzz/grammar-fuzz.sema).
#
# Runs the in-language fuzzer, which checks two correctness oracles over randomly
# generated Sema programs:
#   * round-trip:  (= form (read (str form)))           — printer/reader symmetry
#   * value oracle: (= expected (eval form))            — compiler/VM correctness
# and detects hard VM crashes (panics; release is panic=abort) via a seed
# breadcrumb so every finding is reproducible from one integer seed.
#
# Usage:
#   scripts/grammar-fuzz.sh [check] [--async] [-n COUNT] [-d DEPTH] [-s SEED] [-b BATCH] [-t BUDGET] [-v]
#   scripts/grammar-fuzz.sh emit  [--async] [-n COUNT] [-d DEPTH] [-s SEED] [-o FILE]
#
# Options:
#   --async    enable the async productions (SEMA_FUZZ_ASYNC=1). Check mode then
#              runs seeds in batches of BATCH per subprocess, each batch under an
#              external watchdog: a program that never settles is killed and
#              reported as a HANG finding with its seed (from the breadcrumb).
#              The watchdog is external on purpose — an in-program async/timeout
#              rides the same timer wheel whose wedging is one of the bug shapes
#              under test.
#   -n COUNT   iterations / programs (default: 5000 for check, 20 for emit)
#   -d DEPTH   max generation depth (default: 4)
#   -s SEED    base seed (default: random)
#   -b BATCH   async check mode: seeds per subprocess batch (default: 100)
#   -t BUDGET  async check mode: per-program time budget in seconds (default: 5).
#              A batch of N seeds gets a deadline of N*BUDGET. This is only a
#              net for runtime hangs, never a performance bound.
#   -o FILE    emit mode: write programs to FILE instead of stdout
#   -v         verbose (check mode: also print passing forms)
#
# Exit status:
#   0  all checks passed
#   1  a deterministic mismatch was found (round-trip or value oracle)
#   2  a hard crash (VM panic) was found; reproducing seed is printed
#   3  a hang was found (async watchdog); reproducing seed is printed

set -uo pipefail # no -e: inspect the fuzzer's 0/1/2 exit status instead of aborting

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

MODE="check"
case "${1:-}" in
  check | emit)
    MODE="$1"
    shift
    ;;
esac

# Strip the long --async flag before getopts (getopts only handles short options).
ASYNC="0"
args=()
for a in "$@"; do
  if [ "$a" = "--async" ]; then ASYNC="1"; else args+=("$a"); fi
done
set -- ${args[@]+"${args[@]}"}

COUNT=""
DEPTH="4"
SEED=""
OUT=""
VERBOSE="0"
BATCH="100"
BUDGET="5"

while getopts "n:d:s:o:b:t:v" opt; do
  case "$opt" in
    n) COUNT="$OPTARG" ;;
    d) DEPTH="$OPTARG" ;;
    s) SEED="$OPTARG" ;;
    o) OUT="$OPTARG" ;;
    b) BATCH="$OPTARG" ;;
    t) BUDGET="$OPTARG" ;;
    v) VERBOSE="1" ;;
    *)
      echo "usage: $0 [check|emit] [--async] [-n COUNT] [-d DEPTH] [-s SEED] [-b BATCH] [-t BUDGET] [-o FILE] [-v]" >&2
      exit 64
      ;;
  esac
done

# Default counts per mode.
if [ -z "$COUNT" ]; then
  if [ "$MODE" = "emit" ]; then COUNT="20"; else COUNT="5000"; fi
fi

# Random seed if not pinned.
if [ -z "$SEED" ]; then
  SEED=$((($(date +%s) ^ ($$ << 13) ^ ${RANDOM:-0}) % 1000000000))
fi

# Parse an unsigned decimal integer and remove leading zeroes. Normalizing is
# required because Bash arithmetic otherwise treats values such as 08 as octal.
normalize_uint() {
  local label="$1"
  local value="$2"
  local allow_zero="$3"
  case "$value" in
    "" | *[!0-9]*)
      echo "$label must be a non-negative decimal integer (got '$value')" >&2
      return 1
      ;;
  esac
  while [ "${value#0}" != "$value" ]; do
    value="${value#0}"
  done
  [ -n "$value" ] || value="0"
  if [ "$allow_zero" != "1" ] && [ "$value" = "0" ]; then
    echo "$label must be greater than zero" >&2
    return 1
  fi
  printf '%s\n' "$value"
}

normalize_int() {
  local label="$1"
  local value="$2"
  local sign=""
  case "$value" in
    -*)
      sign="-"
      value="${value#-}"
      ;;
    +*) value="${value#+}" ;;
  esac
  value="$(normalize_uint "$label" "$value" 1)" || return 1
  if [ "$sign" = "-" ] && [ "$value" != "0" ]; then
    printf -- '-%s\n' "$value"
  else
    printf '%s\n' "$value"
  fi
}

COUNT="$(normalize_uint COUNT "$COUNT" 0)" || exit 64
DEPTH="$(normalize_uint DEPTH "$DEPTH" 1)" || exit 64
SEED="$(normalize_int SEED "$SEED")" || exit 64
BATCH="$(normalize_uint BATCH "$BATCH" 0)" || exit 64
BUDGET="$(normalize_uint BUDGET "$BUDGET" 0)" || exit 64

# Locate (or build) the sema binary after validation, so invalid input fails
# promptly without starting a release build.
BIN=""
for cand in "$ROOT/target/release/sema" "$ROOT/target/debug/sema" "$(command -v sema 2>/dev/null || true)"; do
  if [ -n "$cand" ] && [ -x "$cand" ]; then
    BIN="$cand"
    break
  fi
done
if [ -z "$BIN" ]; then
  echo "==> building release binary (cargo build --release -p sema-lang)" >&2
  cargo build --release -p sema-lang || {
    echo "build failed" >&2
    exit 70
  }
  BIN="$ROOT/target/release/sema"
fi

export SEMA_FUZZ_COUNT="$COUNT"
export SEMA_FUZZ_DEPTH="$DEPTH"
export SEMA_FUZZ_SEED="$SEED"
export SEMA_FUZZ_VERBOSE="$VERBOSE"
[ "$ASYNC" = "1" ] && export SEMA_FUZZ_ASYNC="1"

# The fuzzer program is overridable so the watchdog machinery can be tested with
# a hand-written hanging/crashing program without touching the real fuzzer.
FUZZ_PROG="${SEMA_FUZZ_PROG:-$ROOT/fuzz/grammar-fuzz.sema}"

# Env-var prefix for reproduction lines (async findings need the gate re-enabled).
REPRO_ENV=""
[ "$ASYNC" = "1" ] && REPRO_ENV="SEMA_FUZZ_ASYNC=1 "

if [ "$MODE" = "emit" ]; then
  export SEMA_FUZZ_MODE="emit"
  [ -n "$OUT" ] && export SEMA_FUZZ_OUT="$OUT"
  exec "$BIN" "$FUZZ_PROG"
fi

# check mode: use a crash breadcrumb so a hard panic is still reproducible.
CRASH_FILE="$(mktemp)"
trap 'rm -f "$CRASH_FILE"' EXIT
export SEMA_FUZZ_CRASH_FILE="$CRASH_FILE"

# Print the reproduction commands for the breadcrumb seed.
print_repro() {
  local seed="$1"
  echo "  reproduce with: ${REPRO_ENV}SEMA_FUZZ_SEED=$seed SEMA_FUZZ_COUNT=1 SEMA_FUZZ_DEPTH=$DEPTH \\" >&2
  echo "                  $BIN $FUZZ_PROG" >&2
  echo "  or:             ${REPRO_ENV}SEMA_FUZZ_MODE=emit SEMA_FUZZ_SEED=$seed SEMA_FUZZ_COUNT=1 SEMA_FUZZ_DEPTH=$DEPTH \\" >&2
  echo "                  $BIN $FUZZ_PROG   # to see the offending program" >&2
}

# Report a hard crash (e.g. SIGABRT from panic=abort) and exit 2.
report_crash() {
  local status="$1"
  local last
  last="$(cat "$CRASH_FILE" 2>/dev/null || true)"
  echo "" >&2
  echo "CRASH: sema exited with status $status (likely a VM panic)" >&2
  if [ -n "$last" ] && [ "$last" != "ok" ]; then
    print_repro "$last"
  else
    echo "  (no breadcrumb captured; rerun with the same -s SEED to reproduce)" >&2
  fi
  exit 2
}

# Exit status 1 is ambiguous: the fuzzer's controlled failure path (mismatches
# were reported, the run completed, the breadcrumb was cleared to "ok"), or an
# error the oracle's try could not catch (e.g. a runtime invariant fault) that
# aborted the fuzzer mid-iteration, leaving the in-flight seed in the
# breadcrumb. The second is crash-class: report it and exit 2. Such faults can
# depend on runtime state left by earlier iterations in the same process, so
# the reproduction runs from the batch's base seed up through the aborting
# seed, not COUNT=1. Takes the batch base seed; returns 0 when the status was
# a controlled mismatch.
classify_status_1() {
  local base="$1"
  local last count
  last="$(cat "$CRASH_FILE" 2>/dev/null || true)"
  if [ -n "$last" ] && [ "$last" != "ok" ]; then
    count=$((last - base + 1))
    echo "" >&2
    echo "ABORT: an uncatchable eval error ended the run mid-iteration (seed $last)" >&2
    echo "  reproduce with: ${REPRO_ENV}SEMA_FUZZ_SEED=$base SEMA_FUZZ_COUNT=$count SEMA_FUZZ_DEPTH=$DEPTH \\" >&2
    echo "                  $BIN $FUZZ_PROG   # may need state from earlier seeds in the batch" >&2
    echo "  aborting program: ${REPRO_ENV}SEMA_FUZZ_MODE=emit SEMA_FUZZ_SEED=$last SEMA_FUZZ_COUNT=1 SEMA_FUZZ_DEPTH=$DEPTH \\" >&2
    echo "                  $BIN $FUZZ_PROG" >&2
    exit 2
  fi
  return 0
}

if [ "$ASYNC" != "1" ]; then
  # Deterministic sweep: one subprocess, no watchdog (the async grammar is off,
  # so no generated program can park).
  "$BIN" "$FUZZ_PROG"
  status=$?
  if [ "$status" -eq 0 ]; then
    exit 0
  elif [ "$status" -eq 1 ]; then
    classify_status_1 "$SEED"
    # Controlled mismatch; the sema program already printed reproduction info.
    exit 1
  else
    report_crash "$status"
  fi
fi

# Async check mode: run seeds in batches of BATCH per subprocess, each batch
# under an external watchdog. If the batch exceeds its deadline the subprocess
# is killed and the breadcrumb seed is reported as a HANG finding (exit 3).
mismatch=0
remaining="$COUNT"
batch_seed="$SEED"
while [ "$remaining" -gt 0 ]; do
  n="$BATCH"
  [ "$n" -gt "$remaining" ] && n="$remaining"
  deadline=$((n * BUDGET))
  SEMA_FUZZ_SEED="$batch_seed" SEMA_FUZZ_COUNT="$n" "$BIN" "$FUZZ_PROG" &
  pid=$!
  waited=0
  hung=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$deadline" ]; then
      hung=1
      kill -KILL "$pid" 2>/dev/null
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid" 2>/dev/null
  status=$?
  if [ "$hung" -eq 1 ]; then
    last="$(cat "$CRASH_FILE" 2>/dev/null || true)"
    echo "" >&2
    echo "HANG: batch (seeds $batch_seed..$((batch_seed + n - 1))) exceeded its ${deadline}s deadline; killed" >&2
    if [ -n "$last" ] && [ "$last" != "ok" ]; then
      print_repro "$last"
    else
      echo "  (no breadcrumb captured; rerun with -s $batch_seed to reproduce)" >&2
    fi
    exit 3
  fi
  case "$status" in
    0) ;;
    1)
      classify_status_1 "$batch_seed"
      mismatch=1 # mismatch already reported with its seed; keep fuzzing later batches
      ;;
    *) report_crash "$status" ;;
  esac
  batch_seed=$((batch_seed + n))
  remaining=$((remaining - n))
done
exit "$mismatch"
