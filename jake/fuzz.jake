# Fuzzing — cargo-fuzz (byte-level) + in-Sema grammar fuzzer. Namespaced `fuzz`.

@group fuzz
@desc "Install the nightly toolchain + cargo-fuzz"
task setup:
    rustup toolchain install nightly
    cargo install cargo-fuzz

@group fuzz
@desc "Run reader + eval byte-level fuzz targets"
task all: [reader, eval]
    echo "byte-level fuzzing done"

@group fuzz
@desc "Fuzz the reader (read + read_many)"
@needs rustup
task reader:
    cd crates/sema-reader && rustup run nightly cargo fuzz run fuzz_read -- -max_total_time=60
    cd crates/sema-reader && rustup run nightly cargo fuzz run fuzz_read_many -- -max_total_time=60

@group fuzz
@desc "Fuzz the evaluator"
@needs rustup
task eval:
    cd crates/sema-eval && rustup run nightly cargo fuzz run fuzz_eval -- -max_total_time=120 -timeout=10

# Grammar-based fuzzer written in Sema itself. Generates random *valid* programs
# and checks a printer/reader round-trip + a compiler/VM value oracle. No
# nightly needed. Every finding reproduces from one integer seed.
#   jake fuzz.grammar n=20000 depth=5 seed=123
@group fuzz
@desc "In-Sema grammar fuzzer (params: n depth seed)"
task grammar n="5000" depth="4" seed="": [release]
    @if eq({{seed}}, "")
        ./scripts/grammar-fuzz.sh check -n {{n}} -d {{depth}}
    @else
        ./scripts/grammar-fuzz.sh check -n {{n}} -d {{depth}} -s {{seed}}
    @end

@group fuzz
@desc "Print sample generated programs from the grammar fuzzer"
task grammar-emit n="5" depth="4": [release]
    ./scripts/grammar-fuzz.sh emit -n {{n}} -d {{depth}}

# Async mode: enables the async/channel/cancellation productions and runs
# batches under an external watchdog, so a runtime hang becomes a finding
# (exit 3 + reproducing seed) instead of a stuck run.
#   jake fuzz.async n=5000 depth=4 seed=123
@group fuzz
@desc "In-Sema grammar fuzzer, async mode (params: n depth seed)"
task async n="5000" depth="4" seed="": [release]
    @if eq({{seed}}, "")
        ./scripts/grammar-fuzz.sh check --async -n {{n}} -d {{depth}}
    @else
        ./scripts/grammar-fuzz.sh check --async -n {{n}} -d {{depth}} -s {{seed}}
    @end

@group fuzz
@desc "Print sample generated async programs from the grammar fuzzer"
task async-emit n="10" depth="4": [release]
    ./scripts/grammar-fuzz.sh emit --async -n {{n}} -d {{depth}}

# Shutdown-leak harness (Rust, crates/sema/tests/fuzz_async_shutdown_test.rs):
# evals emit-mode async programs in-process and asserts zero live tasks plus a
# clean ShutdownReport, on both the default drive path and the selection-scoped
# drive_roots pair mode. #[ignore]d in normal test runs; this recipe is the
# explicit entry point. Seeds base..base+n; a failure prints its seed + program.
#   jake fuzz.async-shutdown n=500 depth=4 seed=123
@group fuzz
@desc "Async shutdown-leak harness (params: n depth seed)"
task async-shutdown n="100" depth="4" seed="0":
    SEMA_FUZZ_SEED={{seed}} SEMA_FUZZ_COUNT={{n}} SEMA_FUZZ_DEPTH={{depth}} \
      cargo nextest run -p sema-lang --test fuzz_async_shutdown_test --run-ignored ignored-only
