# Benchmarks

## 1BRC (One Billion Row Challenge)

The [1 Billion Row Challenge](https://github.com/gunnarmorling/1brc) is a data processing benchmark that reads weather station measurements and computes min/mean/max per station. It exercises I/O, string parsing, hash table accumulation, and numeric aggregation.

The benchmark suite lives in `benchmarks/1brc/` and includes implementations in 15+ Lisp dialects for comparison.

## Data Files

Data files are stored in `benchmarks/data/` and are **gitignored** (they can be large — up to 1.3GB).

### Generating Test Data

```bash
python3 benchmarks/1brc/generate-test-data.py 1000000 benchmarks/data/bench-1m.txt
python3 benchmarks/1brc/generate-test-data.py 10000000 benchmarks/data/bench-10m.txt
python3 benchmarks/1brc/generate-test-data.py 100000000 benchmarks/data/bench-100m.txt
```

Or using Sema itself:

```bash
cargo run -- examples/benchmarks/1brc-generate.sema -- 10000 benchmarks/data/measurements.txt
```

## Running Benchmarks

Build a release binary first:

```bash
cargo build --release
```

### Tree-walker (default)

```bash
time ./target/release/sema benchmarks/1brc/1brc.sema -- benchmarks/data/bench-1m.txt
```

### Bytecode VM

```bash
time ./target/release/sema --vm benchmarks/1brc/1brc.sema -- benchmarks/data/bench-1m.txt
```

### Multi-dialect comparison (Docker)

Use `linux/amd64` on native x86-64 Linux, or when you explicitly need to
reproduce the published amd64 comparison:

```bash
docker build --platform linux/amd64 -f benchmarks/1brc/Dockerfile -t sema-1brc-bench .
docker run --platform linux/amd64 --rm \
  -v $(pwd)/benchmarks/data/bench-10m.txt:/data/measurements.txt:ro \
  -v $(pwd)/benchmarks/1brc/results:/results \
  sema-1brc-bench /data/measurements.txt
```

On Apple Silicon, Racket may abort under x86-64 Docker emulation. Use a native
arm64 image if you want the Racket row to run locally. This is not the exact
published matrix: Debian bookworm does not provide `chezscheme` on arm64, so
the Chez row is skipped there.

```bash
docker build --platform linux/arm64 -f benchmarks/1brc/Dockerfile -t sema-1brc-bench .
docker run --platform linux/arm64 --rm \
  -v $(pwd)/benchmarks/data/bench-10m.txt:/data/measurements.txt:ro \
  -v $(pwd)/benchmarks/1brc/results:/results \
  sema-1brc-bench /data/measurements.txt
```

Do not compare amd64 and arm64 benchmark rows as the same environment.
