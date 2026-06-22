# Sema as a C-Linkable / FFI Library (`sema-ffi`): Feasibility Study

> **Status:** Exploratory / feasibility only — **no code committed, nothing greenlit.** This document records a multi-agent investigation into whether Sema could ship as a C-ABI shared library so it can be embedded from C/C++, PHP (FFI ext), Dart (`dart:ffi`), and other FFI-capable runtimes. It captures the design that would work, the hard constraints, and an honest effort estimate.
>
> **Date:** 2026-06-22
> **Related:** `docs/plans/2026-03-11-embedding-api-improvements.md` (Rust embedding-API gaps — step limit, typed registration, value conversion), `crates/sema-wasm/` (the existing thin-binding precedent).

---

## 1. TL;DR Verdict

**Feasible, with no architectural blocker — but it is a multi-week logistics project, not a weekend wrapper, and one of its load-bearing assumptions ("ship a lean no-tokio build") is false today.**

Sema is already cleanly embeddable behind a public Rust API (`sema::Interpreter` / `InterpreterBuilder`), and `sema-wasm` proves the same interface marshals across a foreign boundary. A C ABI is that same exercise aimed at C instead of JS. Every hard problem (NaN-boxed `Value`, `Rc` `!Send`, thread-local interner, panics) is solved by the well-trodden **opaque-handle + serialization** pattern that Lua (`lua_State*`), QuickJS (`JSRuntime*`), and Wren (`WrenVM*`) all use.

| Target | Feasibility | Notes |
|---|---|---|
| **C / C++** | **High** | Native fit. Opaque pointer + JSON (or handle) + explicit free is idiomatic C. |
| **PHP (FFI ext)** | **High, but JSON-only** | `FFI::cdef` over a flat header works. **Host-defined callbacks and granular value handles do NOT translate cleanly to PHP** — PHP must use the `eval_json` envelope as its sole data channel. |
| **Dart (`dart:ffi`)** | **Medium-High** | `ffigen` + `Opaque` map cleanly. **`NativeFinalizer` must NOT be attached to `sema_free`** (off-thread `Rc`/interner drop = guaranteed UB). Explicit `close()` on the owning isolate only. |
| **Overall** | **High feasibility / Medium-High effort** | Honest full-surface estimate is **~9–12 weeks**, not the 4–6 a naive read suggests, because of a stdlib feature-gating prerequisite, TLS cross-compile reality, and a panic-safety spike. |

**The single non-negotiable tax is thread affinity:** Sema is `Rc`-everywhere with a thread-local string interner, so an interpreter and all its values are bound to the thread that created them. There is no Arc rewrite in scope. Every host must pin one interpreter to one thread.

---

## 2. Why explore this

The reach goal: let people embed Sema as a scripting/automation language in non-Rust hosts (PHP apps, Dart/Flutter apps, C/C++ tools) by shipping one shared library per platform plus thin per-language shims and embedding guides — the same way Lua, Wren, and QuickJS are embedded today. The Rust embedding story already exists (`sema::Interpreter`); this is about projecting it through a C ABI.

---

## 3. Current architecture: the facts that constrain the design

All verified against the tree at the time of writing.

- **Public embedding API** (`crates/sema/src/lib.rs`): `Interpreter` / `InterpreterBuilder` with `eval_str`, `eval`, `register_fn(F: Fn(&[Value]) -> Result<Value> + 'static)`, `load_file`, `preload_module`, `global_env`. Returns `Result<Value, SemaError>`. Builder has `with_stdlib` / `with_llm` / `with_sandbox`.
- **`Value` is a NaN-boxed `#[repr(transparent)] struct Value(u64)`** (`sema-core/src/value.rs:649`). Immediates (nil, bool, int, float, char, symbol, keyword) live inline in the u64; heap variants (String, List, Map, Lambda, NativeFn, …) store tagged `Rc<T>` pointers (`from_rc_ptr`, `value.rs:737`). Clone bumps an `Rc` strong count; Drop calls `Rc::from_raw` + decrement (`value.rs:1639`, `1693`). **A raw u64 is not safe to pass by value across FFI** — the C side cannot uphold the refcount/Drop contract, and a corrupted tag = heap corruption.
- **The string interner is thread-local** (`thread_local! static INTERNER: RefCell<Rodeo>`, `value.rs:22`). Symbol/keyword `Value`s carry a 32-bit `Spur` packed into the NaN-box (`spur_to_bits`/`bits_to_spur`, with a compile-time assert that `Spur` is 4 bytes). **A `Spur` minted on thread A is meaningless on thread B** — `resolve()` panics or returns garbage.
- **`Rc` is `!Send + !Sync`** — single-threaded by design, no `Arc` anywhere. Moving an `Rc`-bearing `Value` to another thread and dropping it corrupts a non-atomic refcount (UB).
- **Re-entrancy is supported same-thread** via `CURRENT_VM: RefCell<Vec<*mut VM>>` (`sema-vm/src/vm.rs:162`) + `run_nested_closure` / `frame_floor` (`vm.rs:218`, `735`). A stdlib HOF that calls a Sema closure routes back into the live VM, so `set!`-through-upvalues works (`docs/bugs/vm-set-lost-through-hof-callbacks.md`). **The async scheduler is single-threaded cooperative** (`sema-vm/src/scheduler.rs`) — spawned tasks run on the *same* thread with snapshotted upvalues, not a worker thread.
- **LLM calls block the calling thread.** Each provider owns a `tokio::runtime::Runtime::new()` (multi-threaded) and `block_on`s the request (`sema-llm/src/http.rs:45`). Today no `Value`/interner construction happens inside the provider futures (they decode to plain Rust structs and assemble `Value`s on the caller side after `block_on` returns) — but **this invariant is load-bearing and undocumented**.
- **Thread-global mutable state beyond the interner:** `CURRENT_VM`, the scheduler slot (`scheduler.rs`), output hooks (`sema-core/src/output_hook.rs:8`), and the async-signal thread-locals (`sema-core/src/async_signal.rs:52..209`). **These are per-thread, NOT per-interpreter** — two interpreters on one thread share them.
- **Panics can occur** in the VM hot path (~dozens of `unwrap`/`expect` in `vm.rs`), in `bits_to_spur` on a corrupt symbol (`value.rs:60`), and via the bytecode validation gap (C11 in `docs/limitations.md`) where a malformed program underflows the VM stack. **A panic must never unwind into C** (UB).
- **`sema-stdlib` has NO feature gating.** `crates/sema-stdlib/Cargo.toml` depends *unconditionally* on `tokio`, `reqwest`, `axum`, `tokio-stream`, `rusqlite`, `serialport` (and PDF crates). `src/{http,server,sqlite}.rs` call them directly. **There is no "core + stdlib, no tokio" build today.**

---

## 4. The hard constraints (design rules)

Non-negotiable. Any implementation must honor every one.

1. **One interpreter, one thread, forever.** An interpreter and every value handle derived from it are valid only on the thread that called `sema_new`. Enforced with a `ThreadId` stamp + `SEMA_ERR_WRONG_THREAD` on mismatch (turns UB into a clean error). **For PHP/Dart this check is mandatory, not optional.**
2. **One interpreter per thread, period.** Because `INTERNER`, `CURRENT_VM`, the scheduler, output hooks, and async-signal slots are *thread-global*, two interpreters on the same thread share them — a panic or leaked state in one corrupts the other. Reject a second `sema_new` on a thread that already holds a live interpreter (or fully document the hazard).
3. **Never expose a raw `Value(u64)`.** All values cross as opaque handles or as serialized JSON — never as the raw u64 (refcount/Drop/tag/thread-local-`Spur` all unupholdable from C).
4. **No panic crosses the boundary.** Every `extern "C"` entry wraps its body in `std::panic::catch_unwind` (plain `extern "C"`, abort-on-unwind — not `extern "C-unwind"`). `catch_unwind` forces `AssertUnwindSafe` over the `RefCell`/`Rc`-bearing interpreter, which is a *false* safety claim unless recovery is real → **on any caught panic, poison the interpreter AND reset the thread-global slots** (`CURRENT_VM` vector, scheduler slot, output hook, async-signal thread-locals). A per-handle poison flag alone is insufficient (Rule 2). Re-entrant eval (C→eval→callback→eval) needs `catch_unwind` *inside* the `NativeFn` too, or a panic in eval-from-callback unwinds through C.
5. **`tokio block_on` blocks the calling thread.** Acceptable for PHP (per-request) and dedicated Dart isolates; a footgun for cooperative event loops. The LLM feature is opt-in; document "this blocks your thread." Also: switch the LLM runtime to `new_current_thread()` and document the "no `Value`/interner touch inside provider futures" invariant before shipping `llm` in an FFI build.
6. **Ownership is explicit and one-directional.** Rust frees what Rust allocates (`sema_value_free`, `sema_string_free`); the host frees what the host allocates. No cross-allocator frees. Every returned pointer has a documented owner and matching free fn.
7. **Re-entrancy is same-thread only, and `sema_eval_str`-from-callback is a FRESH evaluation.** A host callback may call `sema_eval_str`, but that goes through the public entry point → a brand-new top-level VM, **not** the nested `run_nested_closure` path. So `set!`-through-upvalues semantics do **not** transfer to the FFI callback path. To invoke a *passed-in Sema closure* with live-VM semantics, expose a distinct `sema_call_value(fn_handle, args)` that routes through `call_callback`/`run_nested_closure`.
8. **Handles are validated, not trusted.** Opaque structs via `Box::into_raw`; null-check + thread-check every entry. Value-constructor functions (`sema_int`, `sema_symbol`, …) also touch the thread-local interner, so they must be callable only on the interpreter's thread (ideally take the interpreter handle so they can thread-check).

---

## 5. Proposed C ABI surface

A new crate `crates/sema-ffi` (`crate-type = ["cdylib", "staticlib"]`). All fns `#[no_mangle] pub extern "C"`, all bodies panic-guarded + thread-checked. `sema.h` generated by cbindgen and committed. The surface below already folds in the adversarial corrections (owned strings, owned list elements, `sema_call_value`, JSON callback for PHP, integer-typed enums).

```c
/* ===== Opaque types ===== */
typedef struct SemaInterpreter SemaInterpreter;
typedef struct SemaValue       SemaValue;

/* ===== Status / tags as integers (cbindgen: typedef uint32_t + #define, NOT C enums —
   PHP FFI::cdef cannot parse enum constants; values are a frozen ABI contract) ===== */
typedef uint32_t SemaStatus;
#define SEMA_OK 0
#define SEMA_ERR_EVAL 1
#define SEMA_ERR_SYNTAX 2
#define SEMA_ERR_TYPE 3
#define SEMA_ERR_UNBOUND 4
#define SEMA_ERR_STEP_LIMIT 5
#define SEMA_ERR_INVALID_UTF8 6
#define SEMA_ERR_NULL_PTR 7
#define SEMA_ERR_WRONG_THREAD 8
#define SEMA_ERR_PANIC 9

typedef uint32_t SemaTag;   /* SEMA_T_NIL=0, _BOOL, _INT, _FLOAT, _STRING, _SYMBOL,
                               _KEYWORD, _CHAR, _LIST, _MAP, _LAMBDA, _NATIVE_FN, _OTHER */

/* ===== Lifecycle ===== */
SemaInterpreter* sema_new(void);
SemaInterpreter* sema_new_with_opts(int stdlib, int llm, int sandbox);
void             sema_free(SemaInterpreter* interp);            /* same thread only */
void             sema_set_step_limit(SemaInterpreter*, uint64_t limit);
void             sema_reset_steps(SemaInterpreter*);
uint32_t         sema_abi_version(void);
int              sema_has_feature(const char* name);           /* "llm","stdlib" → 1/0 (lean-build discovery) */

/* ===== Evaluation =====
   JSON path (PRIMARY for PHP/Dart): returns {"value":..,"output":[..],"error":null|".."} ;
   caller frees with sema_string_free. Step counter auto-resets per call. */
char*      sema_eval_json(SemaInterpreter*, const char* code);

/* Handle path (C/Rust, and Dart when lossless values are needed): */
SemaStatus sema_eval_str(SemaInterpreter*, const char* code, SemaValue** out_value);

/* ===== Value inspection / extraction ===== */
SemaTag sema_value_tag(const SemaValue*);
int     sema_value_as_bool (const SemaValue*, int*     out);   /* 1 ok, 0 wrong-type */
int     sema_value_as_int  (const SemaValue*, int64_t* out);
int     sema_value_as_float(const SemaValue*, double*  out);
char*   sema_value_as_string(const SemaValue*);                /* OWNED copy (symbols/keywords have no
                                                                  borrowable buffer); free w/ sema_string_free */
char*   sema_value_to_json (const SemaValue*);                 /* owned; sema_string_free */
size_t  sema_list_len(const SemaValue*);
SemaValue* sema_list_get(const SemaValue*, size_t idx);        /* OWNED (cheap Rc bump); caller frees.
                                                                  Borrowed children aren't possible given
                                                                  Rc<Vec<Value>> storage. */
/* map iteration returns owned key/val handles per step, same rationale */
typedef struct SemaMapIter SemaMapIter;
SemaMapIter* sema_map_iter_new(const SemaValue* map);
int          sema_map_iter_next(SemaMapIter*, SemaValue** out_key, SemaValue** out_val);
void         sema_map_iter_free(SemaMapIter*);

/* ===== Value construction (owned; only on the interpreter's thread) ===== */
SemaValue* sema_int(int64_t);
SemaValue* sema_float(double);
SemaValue* sema_bool(int);
SemaValue* sema_nil(void);
SemaValue* sema_string(const char* utf8);
SemaValue* sema_value_from_json(const char* json);             /* PREFERRED constructor for PHP/Dart */
SemaValue* sema_list(SemaValue** elems, size_t len);           /* consumes element handles */

/* ===== Host callbacks =====
   C/Rust + Dart ONLY (NOT PHP — see §7b). Handle-based:
   callback gets borrowed arg handles (do not free); on success sets *out (owned, runtime frees);
   on error returns non-zero + optional malloc'd *err (runtime copies+frees). */
typedef SemaStatus (*SemaFnCallback)(const SemaValue* const* args, size_t argc,
                                     void* userdata, SemaValue** out, char** err);
SemaStatus sema_register_fn(SemaInterpreter*, const char* name,
                            SemaFnCallback cb, void* userdata);
SemaStatus sema_register_fn_with_dtor(SemaInterpreter*, const char* name,
                                      SemaFnCallback cb, void* userdata,
                                      void (*dtor)(void*));     /* owned userdata — ship in v1, not "later" */

/* JSON-string callback variant — the ONLY shape PHP FFI handles cleanly: */
typedef char* (*SemaJsonFnCallback)(const char* args_json, void* userdata);
SemaStatus sema_register_fn_json(SemaInterpreter*, const char* name,
                                 SemaJsonFnCallback cb, void* userdata);

/* Invoke a passed-in Sema closure with LIVE-VM semantics (≠ eval_str; see Rule 7) */
SemaStatus sema_call_value(SemaInterpreter*, const SemaValue* fn,
                           const SemaValue* const* args, size_t argc, SemaValue** out);

/* ===== Errors / memory ===== */
const char* sema_last_error(const SemaInterpreter*);   /* borrowed until next call; C only */
SemaStatus  sema_last_error_code(const SemaInterpreter*);
void        sema_value_free(SemaValue*);
void        sema_string_free(char*);
```

**Shape rationale**
- Dual path is deliberate: `sema_eval_json` (one call → parse → done, no handle bookkeeping) serves PHP/Dart; the handle path serves C/Rust consumers who need lossless values.
- Callbacks are an `extern "C" fn` pointer + `void* userdata` — the only FFI-safe analogue of `Fn(&[Value]) -> Result<Value>`. Inside the shim it's wrapped in a Rust closure registered as a `NativeFn`; args are boxed into temporary handles for the call and invalidated after (so a callback that stashes a child pointer can't UAF).

---

## 6. Marshaling model

**Primary = JSON envelope for PHP/Dart; opaque handles for C/Rust.** (The earlier instinct to make handles primary was reconsidered: the marquee Rust consumer, Token Editor, can link `sema-eval` directly and bypass the C layer entirely, and the *actual* FFI consumers — PHP/Dart — both strongly prefer JSON.)

- **Handles** keep `Spur`/`Rc`/NaN-box details entirely inside Rust; C can never corrupt a tag or pointer. A handle is an opaque `*mut SemaValue` boxing one `Value`. List/map element access returns **owned** handles (a cheap `Rc` bump) — *borrowed* children are not achievable because elements live inside `Rc<Vec<Value>>`/`Rc<BTreeMap>` with no persistent per-element box to point at.
- **JSON** reuses `sema-core/src/json.rs` (`value_to_json_lossy`) and the proven `sema-wasm` `{"value","output","error"}` envelope. The lossiness is real and must be a **versioned, documented schema** (how symbols, keywords, chars, maps-with-keyword-keys serialize; NaN/Inf→null; lambdas stringify; int/float token rules for `json_decode`/`jsonDecode`) with round-trip tests. For PHP/Dart this is the *only* data channel, so re-rank its lossiness impact to Medium and pin the contract.
- **Strings** are UTF-8. `sema_value_as_string` returns an **owned** copy (symbols/keywords have no borrowable buffer); only genuine `Rc<String>` values could be borrowed, so owned-always is the safe uniform rule.

---

## 7. Per-target shim plan

### (a) C — header + example
cbindgen emits `include/sema.h`; link `libsema.{so,dylib,a}`. The full handle + callback surface is available here.

```c
#include "sema.h"
SemaStatus square(const SemaValue* const* a, size_t n, void* ud, SemaValue** out, char** err) {
    int64_t x;
    if (n != 1 || !sema_value_as_int(a[0], &x)) { *err = strdup("square: want 1 int"); return SEMA_ERR_TYPE; }
    *out = sema_int(x * x); return SEMA_OK;
}
int main(void) {
    SemaInterpreter* in = sema_new();
    sema_register_fn(in, "square", square, NULL);
    SemaValue* v;
    if (sema_eval_str(in, "(square 9)", &v) == SEMA_OK) { int64_t r; sema_value_as_int(v, &r); /* 81 */ sema_value_free(v); }
    sema_free(in);
}
```

### (b) PHP — `FFI::cdef`, **JSON-envelope only, no PHP-defined callbacks**
PHP-FPM/CLI is process-per-request and single-threaded → thread affinity is a non-issue in the common case. **Do not** expose the handle API or `sema_register_fn` to PHP userland (PHP's callbacks-from-C leak by design and the `char**`/cross-allocator out-params are fragile). If PHP-defined builtins are truly needed, use `sema_register_fn_json` (JSON string in, JSON string out). Enum values are referenced as integer literals (PHP FFI can't parse enum constants), so ship a CI-checked `Sema` constants class mirroring the `#define`s.

```php
final class Sema {
    private FFI $ffi; private $h;
    function __construct() {
        $this->ffi = FFI::cdef('
            typedef struct SemaInterpreter SemaInterpreter;
            SemaInterpreter* sema_new(void);
            void sema_free(SemaInterpreter*);
            char* sema_eval_json(SemaInterpreter*, const char*);
            void sema_string_free(char*);
        ', __DIR__.'/libsema.so');
        $this->h = $this->ffi->sema_new();
    }
    function eval(string $code): array {
        $p = $this->ffi->sema_eval_json($this->h, $code);
        $j = FFI::string($p);                 // copies into a PHP string
        $this->ffi->sema_string_free($p);     // free Rust's buffer (never expose raw char* to userland)
        return json_decode($j, true);         // ['value'=>.., 'output'=>[..], 'error'=>null]
    }
    function __destruct() { $this->ffi->sema_free($this->h); }
}
```
Distribution: build the `.so` in a **manylinux2014** container (glibc 2.17) for x86_64 + aarch64, `strip -s`, ship `libsema.so` + `sema.h` in a Composer package bundling the right binary per platform. Mandate **one interpreter per worker process/coroutine-scheduler, pinned, never touched from a task worker** — drop any "message-passing queue" suggestion (not implementable over a synchronous FFI handle from PHP userland).

### (c) Dart — `ffigen` + explicit `close()`, **no `NativeFinalizer` on `sema_free`**
`ffigen` generates bindings from `sema.h`; `Opaque` for the interpreter. **`NativeFinalizer` must not be attached to `sema_free`** — the finalizer thread is not the isolate thread, and an off-thread `Rc`/interner drop is *guaranteed* UB the moment it fires. Use explicit `close()` on the owning isolate; if a leak guard is wanted, attach a finalizer to a no-op token that only logs "you forgot close()". Host callbacks must use `NativeCallable.isolateLocal` (Dart 3.5+) — `.listener` is async/queued and cannot return a value to the VM synchronously.

```dart
final class Sema {
  static final _lib = DynamicLibrary.open('libsema.so');
  static final _new = _lib.lookupFunction<Pointer<Void> Function(), Pointer<Void> Function()>('sema_new');
  static final _free = _lib.lookupFunction<Void Function(Pointer<Void>), void Function(Pointer<Void>)>('sema_free');
  static final _eval = _lib.lookupFunction<Pointer<Utf8> Function(Pointer<Void>, Pointer<Utf8>),
                                           Pointer<Utf8> Function(Pointer<Void>, Pointer<Utf8>)>('sema_eval_json');
  final Pointer<Void> _h;
  Sema() : _h = _new();
  Map<String, dynamic> eval(String code) {
    final c = code.toNativeUtf8();
    try { final out = _eval(_h, c); final m = jsonDecode(out.toDartString()); /* sema_string_free(out) */ return m; }
    finally { malloc.free(c); }
  }
  void close() => _free(_h);   // MUST run on the creating isolate
}
```
Distribution: Dart 3.5+ native assets / a pub package bundling `libsema.{so,dylib,dll}` per platform. Docs: one `Sema` per isolate, `close()` on the owning isolate, never cross isolate boundaries.

---

## 8. Build & packaging

**Crate layout** (`crates/sema-ffi/`): `Cargo.toml` (`crate-type=["cdylib","staticlib"]`), `build.rs` (cbindgen→`include/sema.h`), `src/lib.rs` (panic-guarded, thread-checked extern surface), `src/marshal.rs` (Value↔handle/JSON, error flattening), committed `include/sema.h`, `tests/ffi_test.rs` + `tests/c_interop.c`, `README.md`.

**⚠ Prerequisite — feature-gate `sema-stdlib` (this does not exist yet).** Today `--features stdlib` *is* the heavy build: tokio + reqwest + a TLS stack + axum + SQLite + serialport, all unconditional. There is no lean ~6 MB artifact to ship. Two honest options:
- **(a)** Ship one honestly-heavy artifact (~15–20 MB) and drop the lean-size claims; or
- **(b)** Add **Phase P-1**: carve `http`/`server`/`sqlite`/`pdf`/`serial` behind `sema-stdlib` features — a real multi-day refactor across a large crate with its own test matrix, landing *before* P0.

**TLS / cross-compile:** mandate `reqwest`'s `rustls-tls` (no system OpenSSL) to dodge the #1 cross-compile pain point; Windows uses schannel; macOS `.dylib` redistribution needs notarization or downstream embedders hit Gatekeeper quarantine.

**cbindgen:** pin `cbindgen` exactly, hand-tune a `cbindgen.toml` (emit `typedef uint32_t` + `#define` for the status/tag "enums" so PHP's `FFI::cdef` agrees), and make the CI drift-guard a **semantic** check (compile a C file against the header), not a brittle byte-diff. Treat header curation as real work, not turnkey.

**Prebuilt matrix** (new `.github/workflows/release-ffi.yml`, tag-triggered): `x86_64`/`aarch64` Linux (manylinux2014 — note aarch64-in-container is cross-compilation), Intel/Apple-Silicon macOS, Windows MSVC. Strip on Unix, upload `{*.so,*.dylib,*.a,sema.dll,sema.h}` tarballs to the GitHub Release. Gate behind the existing `verify` job. `sema-ffi` joins the workspace version bump (one more `=X.Y.Z` inter-crate pin — the release `sed` one-liner and `grep -c` counts each rise by one). It need not be published to crates.io (hosts consume binaries).

---

## 9. Effort & phasing (honest estimate)

| Phase | Scope | Effort |
|---|---|---|
| **P-1 — stdlib feature-gating** *(prerequisite for any "lean" build)* | Carve http/server/sqlite/pdf/serial behind `sema-stdlib` features; swap to `rustls-tls`. | **M** (~1 wk) |
| **P0a — MVP eval-only C ABI** | Crate skeleton, `crate-type`, cbindgen, opaque `SemaInterpreter`, `sema_new/free/set_step_limit`, `sema_eval_json`, `sema_last_error`, thread-id stamping, C interop test. **This alone unblocks PHP+Dart.** | **S** (~1 wk) |
| **P0b — panic safety** | `catch_unwind` macro on every entry, mandatory poison-on-panic + thread-global slot reset, nested `catch_unwind` in callbacks. **Gated on a spike proving VM thread-locals are recoverable after a caught unwind.** | **M** (~1 wk + spike) |
| **P1 — handle marshaling** | `SemaValue` handles, tag + accessors (owned strings/children), constructors, `from_json`, list/map iteration, frees. *Demote below P3/P4 — JSON is the v1 value contract; add handles when a C/C++ lossless-value consumer materializes.* | **M** (~1 wk) |
| **P2 — host callbacks** | `sema_register_fn` (+`_with_dtor`, +`_json`), closure→`NativeFn`, arg-handle boxing/invalidation, `sema_call_value`, re-entrancy + nested-panic tests. | **L** (~1.5–2 wk) |
| **P3 — PHP shim** | `FFI::cdef` JSON-only wrapper, constants class, manylinux build, Composer packaging, leak-canary test. | **M** (~1 wk) |
| **P4 — Dart shim** | `ffigen`, explicit-close model (no finalizer→free), `NativeCallable.isolateLocal`, native-assets/pub packaging. | **M** (~1–1.5 wk) |
| **P5 — prebuilt binary matrix** | `release-ffi.yml` (5 targets, rustls, strip), GH Release upload, semantic header guard, verify-gate, version-bump slot. | **L** (~2 wk — TLS cross-compile + macOS notarization) |

**Critical path to "PHP/Dart can run Sema":** P0a → P3/P4 (JSON-only). **MVP demoable in ~1 week** (P0a alone). **Honest full surface ≈ 9–12 weeks** — roughly 2× a naive read, because of P-1, the panic-safety spike, L-sized callbacks, and the real cross-compile/distribution cost. P3 and P4 parallelize across people.

---

## 10. Risks & open questions (ranked)

1. **Thread-affinity violations in the wild** (High/High). Hosts will share an interpreter across threads/isolates. Mitigation: `ThreadId` stamp + `SEMA_ERR_WRONG_THREAD` (mandatory for PHP/Dart), loud docs, correct example code.
2. **Panic recovery soundness** (Medium/High). `AssertUnwindSafe` is a false claim unless poison + thread-global reset is real and complete. **Open question:** can VM thread-locals (`CURRENT_VM`, scheduler) be cheaply reset after a caught unwind, or must poisoning be terminal (force-recreate)? Needs a spike before P0b is sized as done.
3. **The "lean build" doesn't exist** (High/Medium). `sema-stdlib` isn't feature-gated; the size/safety claims behind "no tokio in lean" are invalid until P-1 lands. Decide (a) heavy-only vs (b) gate-first.
4. **Dart `NativeFinalizer` off-thread free** (Medium/High). Off-thread `Rc`/interner drop = UB. Resolved by *not* attaching the finalizer to `sema_free`; explicit `close()` only.
5. **PHP can't do host callbacks cleanly** (Medium/Medium). Resolved by JSON-only PHP surface + `sema_register_fn_json` if needed.
6. **`userdata` lifetime leaks** (Medium/Medium). Ship `sema_register_fn_with_dtor` in v1, not "later."
7. **JSON lossiness is the *only* PHP/Dart channel** (High/Medium). Pin + version the JSON value schema; round-trip tests.
8. **Cross-compile/distribution trap** (Medium/Medium). rustls mandatory, macOS notarization, aarch64-in-container is real cross-compilation.
9. **ABI stability burden** (Low near-term/Medium long-term). `sema_abi_version()` + semver; keep v1 minimal; `_v2` fns for breaking changes.
10. **Bytecode validation gap (C11) as untrusted-input surface** (Low/Medium). Recommend source-only eval in v1; don't expose `.semac` loading initially.

---

## 11. Recommendation

The verdict — **Sema is C-embeddable via opaque-handle + serialization with no architectural blocker** — is sound. If pursued, the right shape is:

- **MVP = `sema_eval_json` only** (P0a), behind a documented one-interpreter-per-thread contract, with mandatory thread-id checks. This alone gives PHP and Dart a working "run Sema, get JSON back" story in ~1 week and is the leanest thing that proves value.
- Treat the JSON envelope as the **v1 value contract** (pin its schema); defer the full handle + callback surface until a concrete C/C++ consumer needs lossless values.
- Do **not** start without deciding the stdlib feature-gating question (P-1) and running the panic-recovery spike (P0b) — those are the two places the naive plan is wrong.

This is worth doing as a small, well-scoped MVP if there is real demand for embedding Sema in PHP/Dart/C hosts; it is **not** a weekend wrapper, and it should not be sold internally as one.

---

*Investigation: 9-agent workflow (5 parallel internals/external-research readers → architect synthesis → 3 adversarial reviewers for correctness, ergonomics, and scope). The reviewers materially corrected the first-pass design — those corrections are folded into §4–§9 above.*
