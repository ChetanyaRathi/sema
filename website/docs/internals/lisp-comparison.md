# Lisp Dialect Benchmark

How does Sema compare to other Lisp dialects on a real-world I/O-heavy workload? This page benchmarks fifteen Lisp dialects on the [1 Billion Row Challenge](https://github.com/gunnarmorling/1brc) — read weather-station measurements and compute min/mean/max per station. It is not a synthetic micro-benchmark; it exercises I/O, string parsing, hash-table accumulation, and numeric aggregation in a tight loop.

::: warning A benchmark ranks implementations, not just runtimes
Each dialect's **optimized** entry uses a comparable best effort — a hand-rolled integer×10 temperature parser and, where it helps the runtime, block/byte I/O. Even so, results partly reflect *how each program is written*, not pure runtime throughput. The [dialect notes](#dialect-notes) say where each number comes from; the [simple table](#simple-idiomatic) shows the same workload written the obvious way.
:::

## Benchmark

One same-machine run: **macOS 15.6, Apple M2 Max, native Homebrew runtimes, 10,000,000 rows (~124 MiB), best of 3, single-threaded.** Sema is the **v1.29.0 PGO build**. All fifteen implementations produce byte-identical output. PicoLisp is omitted — no native Homebrew formula.

### Optimized — best effort per dialect

Each implementation tuned to a comparable level (hand-rolled int×10 parser; block/byte I/O where the runtime benefits). Relative to the fastest (Fennel).

| Dialect           | Time (ms) | Relative | Runtime              |
| ----------------- | --------- | -------- | -------------------- |
| **Fennel/LuaJIT** | 523       | 1.0x     | JIT compiler         |
| **SBCL**          | 876       | 1.7x     | Native compiler      |
| **Racket**        | 1,411     | 2.7x     | JIT (Chez backend)   |
| **Chez Scheme**   | 1,466     | 2.8x     | Native compiler      |
| **Gambit**        | 2,306     | 4.4x     | Native compiler (C)  |
| **Clojure**       | 2,739     | 5.2x     | JVM (JIT)            |
| **Sema**          | 3,577     | 6.8x     | Bytecode VM          |
| **Guile**         | 4,448     | 8.5x     | Bytecode VM + JIT    |
| **Janet**         | 5,054     | 9.7x     | Bytecode VM          |
| **Chicken**       | 5,722     | 10.9x    | Native compiler (C)  |
| **Gauche**        | 7,162     | 13.7x    | Bytecode VM          |
| **Emacs Lisp**    | 8,080     | 15.4x    | Bytecode VM          |
| **ECL**           | 8,804     | 16.8x    | Native compiler (C)  |
| **newLISP**       | 9,027     | 17.3x    | Interpreter          |
| **Kawa**          | 18,266    | 34.9x    | JVM (JIT)            |

### Simple / idiomatic

The same workload written the obvious way in each dialect — built-in number parser, per-line I/O, standard data structures. No hand-rolled parsers, no block reads. Closer to "raw runtime on naive code." Relative to the fastest (Gambit).

| Dialect           | Time (ms) | Relative |
| ----------------- | --------- | -------- |
| **Gambit**        | 2,345     | 1.0x     |
| **Chez Scheme**   | 2,491     | 1.1x     |
| **Fennel/LuaJIT** | 2,640     | 1.1x     |
| **Clojure**       | 2,752     | 1.2x     |
| **SBCL**          | 2,994     | 1.3x     |
| **Guile**         | 5,146     | 2.2x     |
| **Sema**          | 6,462     | 2.8x     |
| **newLISP**       | 8,296     | 3.5x     |
| **Chicken**       | 9,066     | 3.9x     |
| **Janet**         | 9,936     | 4.2x     |
| **ECL**           | 13,212    | 5.6x     |
| **Emacs Lisp**    | 16,302    | 7.0x     |
| **Gauche**        | 16,571    | 7.1x     |
| **Kawa**          | 17,758    | 7.6x     |

The gap between the two tables is itself the story. Where optimized ≪ simple (Fennel, Racket, Janet, Gauche — and, since the July 2026 runtime work, Sema at 1.8× between its entries), most of the win came from a hand-rolled parser and block/byte I/O. Where they're close (Clojure, newLISP), the runtime was already doing the work and there was little left to hand-tune.

## Dialect notes

What's behind each number — and which results are runtime ceilings versus implementation choices.

### Fennel / LuaJIT — the JIT runs away with it

Fennel compiled to LuaJIT is **the fastest entry, ahead of SBCL** (532 ms). LuaJIT's tracing JIT compiles the hot byte-scan loop to native code; with a `string.byte` integer parser and 1 MiB block reads it chews through ~250 MB/s. It's the clearest "runtime does the heavy lifting" result — but note its *simple* version is 2.7 s (5× slower), so the win is the optimized byte loop being unusually JIT-friendly, not a free lunch.

### SBCL — native code + `(safety 0)`

SBCL compiles to native machine code; in a type-specialized hot path there is no interpreter loop. With `(declare (optimize (speed 3) (safety 0)))`, block `read-sequence` I/O, an integer×10 parser, and in-place `setf` struct mutation, the inner loop runs near C speed. 25+ years of compiler work (descended from CMUCL). Its 1.3× → 1.0x optimization gain (simple 3.0 s → optimized 0.9 s) is the largest in the suite.

### Racket — byte I/O over the Chez backend

Racket reads 1 MiB byte blocks, scans for `;`/newline with O(1) `subbytes` slicing, and parses int×10. Its CS backend (Chez under the hood) plus byte strings put it third overall, just ahead of Chez itself — a notable result for a runtime usually thought of as "the teaching language."

### Chez Scheme — the other native compiler

Chez compiles to native code via a [nanopass framework](https://nanopass.org/). With a custom char-by-char parser and `make-hashtable`/`string-hash` it lands just behind Racket. The remaining gap to SBCL is mostly per-line string allocation versus SBCL's block parser.

### Gambit — compiled Scheme via C

`gsc` compiles Scheme to C to a native binary. It got the same int×10 parser as the other Schemes, but the win was negligible here — `read-line` + `substring` + string hashing dominate the loop, so I/O, not number parsing, is the bottleneck.

### Clojure — JVM tax + warmup

Clojure's time includes JVM startup and JIT warmup, real costs for a single-shot script. `line-seq` + a transient map is idiomatic but not zero-cost, and `Double/parseDouble` handles the full IEEE-754 spec. Steady-state throughput is better than the wall-clock suggests; it trades raw speed for compactness.

### Guile — Scheme bytecode VM + JIT

Guile 3 has a bytecode VM with a native JIT on supported platforms. With a hand-rolled int×10 parser it lands ahead of Janet and Chicken — though its JIT no longer keeps it ahead of Sema's plain interpreter.

### Janet — the closest architectural peer

Janet is the most architecturally comparable to Sema: an embeddable scripting language, bytecode VM, GC-based, no native compiler. Head to head, **Sema (3.6 s) lands ~1.4× ahead of Janet (5.1 s)** — a reversal of earlier editions of this benchmark, where Janet led by 1.6×. What flipped it: the July 2026 runtime work gave Sema the same tools Janet's implementation leans on — byte-oriented line folding (`bytes/*`, no UTF-8 navigation) and in-place mutable stat arrays — plus compiler work Janet's register VM doesn't need (last-use move semantics, a direct self-call opcode). Janet's simple entry (9.9 s vs Sema's 6.5 s) shows the same reversal on naive code. Still the comparison to watch.

### Chicken — compiled Scheme, I/O bound

Chicken compiles Scheme to C via `csc -O3` with an int×10 parser. The remaining gap is per-line I/O allocation and Chicken's continuation-passing-style C ("Cheney on the MTA"), whose trampolining the C compiler can't fully optimize away.

### Gauche — byte scanning over UTF-8 strings

Gauche stores strings as **UTF-8 indexed by character**, so a `substring`/`string-index` implementation pays O(k) navigation per slice to convert character positions to byte offsets — a trap that can make a mature, well-engineered runtime look slow. The implementation here sidesteps it: read the whole file into a `u8vector`, scan **bytes** directly, parse int×10. That lands Gauche mid-pack at 7.2 s, ahead of Sema — and is a good reminder that on a char-indexed runtime, byte-oriented I/O is the difference between near-last and respectable.

### Sema — the fastest VM in the table

Sema (3.6 s) is the **fastest bytecode-VM entry**, ahead of Guile's JIT-assisted 4.4 s, with no JIT and no native codegen; only the native compilers and JITs sit above it. Earlier editions of this benchmark put Sema at the "interpreter floor" (8.1 s) — NaN-boxed immutable values, `Rc` reference counting, and no way to express the byte-oriented implementations the fast dialects use. The July 2026 runtime work removed exactly those ceilings: `file/fold-lines-bytes` + `bytes/*` ops for byte scanning, `mutable-array` stats updated in place, an int×10 parse primitive, last-use move semantics in the compiler (`TakeLocal`) plus an owned-args callback protocol — so fold accumulators reach the copy-on-write gates with a unique reference and idiomatic immutable-update code mutates in place — and a direct self-call opcode. The simple entry (6.5 s, the same naive code as before) shows the runtime-only share of those wins: it got 1.6× faster without its source changing. See [Performance Internals](./performance.md).

### Emacs Lisp — buffer-based I/O

Emacs loads the whole file into a buffer with `insert-file-contents-literally` and parses int×10 directly from buffer characters with no substring extraction — strong for a venerable bytecode VM.

### ECL — Common Lisp via C

ECL compiles Common Lisp through C with `compile-file`, with an int×10 parser. The gap to SBCL is ECL's less aggressive native code generation.

### newLISP — a small, simple interpreter

newLISP's accumulation uses a hash, but on this 40-station dataset the data structure hardly matters — with so few stations even a linear scan is cheap, and per-row interpreter overhead dominates either way. A faithful picture of a deliberately minimal interpreter.

### Kawa — JVM Scheme, slower than expected

Kawa compiles Scheme to JVM bytecode. Even with Java interop (`BufferedReader`, `java.util.HashMap`), Scheme-on-JVM data representation, startup, and JIT warmup leave it last.

## What this benchmark doesn't show

This is one workload. Different benchmarks would reorder things:

- **CPU-bound computation** (fibonacci, sorting): the native compilers and JITs would pull further ahead; the I/O here amortizes some of the interpreter gap.
- **Startup time:** included in wall-clock but not isolated — it hits the JVM dialects (Clojure, Kawa) hardest.
- **Memory usage:** not measured; JVM runtimes carry a higher baseline than small standalone ones like Janet or Sema.
- **Multi-threaded:** Clojure, SBCL, Janet, and Guile can parallelize; Sema is single-threaded (its async/channels are cooperative, not parallel).
- **Developer experience:** Clojure's REPL, Racket's DrRacket, and SBCL's SLIME are far more mature than Sema's.

## Methodology

- **Dataset:** 10,000,000 rows (~124 MiB), 40 weather stations, from the [1BRC spec](https://github.com/gunnarmorling/1brc).
- **Environment:** macOS 15.6 / Apple M2 Max, native Homebrew runtimes (July 2026). Sema 1.29.0 (PGO). Gauche 0.9.15. Others are the current Homebrew formulae / downloaded binaries.
- **Measurement:** wall-clock, best of 3 consecutive runs per dialect, via `benchmarks/1brc/run-native-benchmarks.py` (all dialects measured together in one session). Sema is timed as the prebuilt PGO binary (`jake build-pgo`, run with `SEMA_SKIP_BUILD=1`).
- **Verification:** all fifteen implementations produce byte-identical normalized output (sorted stations, 1-decimal rounding) — checked every run.
- **Implementations:** each *optimized* entry uses a comparable best effort (hand-rolled int×10 parser; block/byte I/O where the runtime benefits); the *simple* table uses each dialect's naive idiom. PicoLisp is omitted (no native Homebrew formula).

### Reproducing

```bash
# Generate test data (or use benchmarks/data/bench-10m.txt)
python3 benchmarks/1brc/generate-test-data.py 10000000 benchmarks/data/bench-10m.txt

# Build the PGO Sema binary, then run the native matrix against it
jake build-pgo
SEMA_SKIP_BUILD=1 ./benchmarks/1brc/run-native-benchmarks.py benchmarks/data/bench-10m.txt
```

Implementation source: [`benchmarks/1brc/`](https://github.com/sema-lisp/sema/tree/main/benchmarks/1brc) (optimized) and [`benchmarks/1brc/simple/`](https://github.com/sema-lisp/sema/tree/main/benchmarks/1brc/simple) (simple/idiomatic).

<script setup>
import { onMounted } from 'vue'

onMounted(() => {
  document.querySelectorAll('table tr').forEach(row => {
    const firstCell = row.querySelector('td:first-child')
    if (firstCell && firstCell.textContent.trim().startsWith('Sema')) {
      row.classList.add('sema-row')
    }
  })
})
</script>

<style>
.sema-row {
  background: linear-gradient(90deg, rgba(245, 158, 11, 0.18), rgba(245, 158, 11, 0.06)) !important;
}
.sema-row td {
  font-weight: 600;
}
.sema-row td:first-child {
  border-left: 3px solid #f59e0b !important;
}
</style>
