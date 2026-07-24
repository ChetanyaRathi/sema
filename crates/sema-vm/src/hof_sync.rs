//! Non-suspending HOF direct-dispatch fast path.
//!
//! A cooperative HOF (`map`/`filter`/`foldl`/…) normally emits one
//! `NativeOutcome::Call` per element, and every HOF *call* round-trips the
//! runtime drive loop (quantum teardown, task-scope swap, clock reads,
//! per-element continuation rebuilds). For cheap callbacks that overhead
//! dominates the useful work by 3–5× (PERF-RESIDUAL-1). When the callback's
//! call graph provably cannot suspend, none of that machinery buys anything:
//! this module lets the HOF native run its element loop synchronously, inside
//! the parent VM's own quantum, on a pooled scratch VM.
//!
//! Two halves:
//!
//! - **Suspension analysis** ([`closure_may_suspend`]): a conservative bytecode
//!   scan over the callback's call graph. `false` ("cannot suspend") is only
//!   produced when every reachable call lands on an inert native, a
//!   callback-driven native whose callback arguments are themselves proven, or
//!   another proven VM closure. Anything unresolvable — a dynamic callee, an
//!   unknown global, a runtime-ABI native without a `CallbackDriven` marking —
//!   is `true`. Verdicts memoize on the `Function`, keyed by the resolving env
//!   chain's version fingerprint, so a global rebind re-analyzes.
//!
//! - **The host** ([`VmHofHost`]): installed by `dispatch_native` for the
//!   duration of one native invocation and offered to the native through
//!   [`NativeCallContext::hof_host`](sema_core::runtime::NativeCallContext).
//!   It validates the callback against the analysis, then drives the HOF's
//!   element loop on a thread-pooled scratch VM — per element: an owned-args
//!   frame setup and one `run_quantum`, nothing else. Instructions consumed
//!   are reported back to the parent VM's quantum countdown, and the session
//!   tells the HOF to hand any remaining elements back to the cooperative
//!   path once the parent's budget is exhausted (`should_yield`).
//!
//! Fairness/cancellation: the chunking boundary is the *element*. Between
//! elements the session honors the parent quantum's instruction budget; within
//! an element the callback runs to completion (loop interrupts still enforce
//! cancellation/deadlines). A callback that suspends anyway — possible only
//! when a global was rebound to a suspending function *while the chain was
//! running* — surfaces as a structured error, never a wrong result.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use hashbrown::HashSet;

use std::num::NonZeroUsize;

use sema_core::runtime::{
    CancellationView, NativeResult, SyncCallbackSession, SyncHofHost, TaskContextHandle,
};
use sema_core::{Env, EvalContext, NativeFn, NativeSuspensionClass, SemaError, Spur, Value};

use crate::restricted::RestrictedRunPolicy;

/// Policy for a flat restricted de-opt drive: effectively unbounded (the
/// parent quantum's fairness machinery still applies at the outer level), one
/// suspension error message shared with the direct sync path.
fn deopt_policy(cancellation: CancellationView) -> RestrictedRunPolicy {
    RestrictedRunPolicy {
        operation: "synchronous HOF callback",
        suspension_error: "callback suspended on the synchronous HOF fast path",
        instruction_limit: NonZeroUsize::MAX,
        transition_limit: NonZeroUsize::MAX,
        deadline: None,
        cancellation,
    }
}

use crate::chunk::Function;
use crate::debug::VmExecResult;
use crate::opcodes::{op, Op};
use crate::vm::{
    extract_vm_closure, is_debug_session_active, snapshot_escaping_call_shared, Closure, VM,
};

/// Don't begin a synchronous run with less parent budget than this — the
/// cooperative path handles the tail of a quantum better than a one-element
/// sync session would.
const SYNC_HOF_MIN_BUDGET: usize = 4_096;

/// Per-element instruction cap. Effectively unbounded: the chunking boundary
/// is the element, so a single element must never observe `QuantumExpired`
/// (there is no way to park a half-run element from inside a native). Loop
/// interrupts still bound runaway elements via cancellation/deadline checks.
const ELEMENT_BUDGET: usize = usize::MAX / 2;

/// Scratch VMs kept per thread for reuse across sync HOF runs. Nested HOFs
/// (a `map` inside a `map` callback) each hold one for their duration.
const POOL_CAP: usize = 8;

/// Maximum sync-session nesting. Every nested non-suspending HOF level adds a
/// full native-dispatch + `run_inner` Rust stack slice; past this depth new
/// HOFs decline the sync path and their cooperative `Call` chains settle in
/// the flat restricted driver instead (`resume_pending_restricted`), keeping
/// deep `map`-in-`map` recursion like `(nest 1000)` off the Rust stack.
const SYNC_HOF_MAX_DEPTH: usize = 16;

thread_local! {
    static SCRATCH_POOL: RefCell<Vec<VM>> = const { RefCell::new(Vec::new()) };
    /// Live nested sync sessions on this thread (see `SYNC_HOF_MAX_DEPTH`).
    static SYNC_DEPTH: Cell<usize> = const { Cell::new(0) };
    /// Sync sessions begun since process start (test observability).
    static SYNC_RUNS: Cell<u64> = const { Cell::new(0) };
}

/// RAII depth ticket for one nested sync session.
struct DepthGuard;

impl DepthGuard {
    fn acquire() -> Option<Self> {
        SYNC_DEPTH.with(|depth| {
            if depth.get() >= SYNC_HOF_MAX_DEPTH {
                return None;
            }
            depth.set(depth.get() + 1);
            Some(Self)
        })
    }
}

impl Drop for DepthGuard {
    fn drop(&mut self) {
        SYNC_DEPTH.with(|depth| depth.set(depth.get() - 1));
    }
}

/// Number of synchronous HOF sessions begun on this thread. Test hook for
/// asserting a HOF actually took the fast path (not just that timing improved).
pub fn sync_hof_runs() -> u64 {
    SYNC_RUNS.with(Cell::get)
}

fn take_pooled_vm(
    globals: Rc<Env>,
    functions: Rc<Vec<Rc<Function>>>,
    native_fns: Rc<Vec<Rc<NativeFn>>>,
) -> VM {
    SCRATCH_POOL.with(|pool| {
        let mut pool = pool.borrow_mut();
        // Prefer an entry that already targets this compilation unit: its warm
        // inline global cache carries over (entries self-validate against
        // `env_version`), which matters enormously for programs issuing
        // millions of tiny HOF calls (deriv-style recursion).
        if let Some(index) = pool
            .iter()
            .position(|vm| vm.targets_unit(&globals, &functions, &native_fns))
        {
            return pool.swap_remove(index);
        }
        match pool.pop() {
            Some(mut vm) => {
                vm.reset_for_task_with_native_fns(globals, functions, native_fns);
                vm
            }
            None => VM::new_for_task_with_native_fns(globals, functions, native_fns),
        }
    })
}

fn release_pooled_vm(mut vm: VM) {
    SCRATCH_POOL.with(|pool| {
        let mut pool = pool.borrow_mut();
        if pool.len() < POOL_CAP {
            // The inline cache stays warm for a same-unit reuse. The values it
            // pins are (possibly stale) resolved globals — bounded, and freed
            // on the entry's next cross-unit reset — unlike the runtime's
            // traced `scratch_callback_vm`, which must release its pins while
            // parked.
            pool.push(vm);
        } else {
            vm.release_parked_scratch_state();
        }
    });
}

/// Per-native-invocation host installed by `dispatch_native`. Borrows the
/// parent VM immutably for its lifetime; mutations it owes the parent
/// (instruction debit, tracked-upvalue sync) are reported through cells and
/// applied by `dispatch_native` after the native returns.
pub(crate) struct VmHofHost<'a> {
    parent: &'a VM,
    ctx: &'a EvalContext,
    task_context: TaskContextHandle,
    consumed: Cell<usize>,
    ran_sync: Cell<bool>,
}

impl<'a> VmHofHost<'a> {
    pub(crate) fn new(
        parent: &'a VM,
        ctx: &'a EvalContext,
        task_context: TaskContextHandle,
    ) -> Self {
        Self {
            parent,
            ctx,
            task_context,
            consumed: Cell::new(0),
            ran_sync: Cell::new(false),
        }
    }

    /// Instructions the sync session(s) consumed, to be debited from the
    /// parent quantum's countdown.
    pub(crate) fn consumed(&self) -> usize {
        self.consumed.get()
    }

    /// True when at least one sync session ran — the parent must then sync
    /// tracked upvalues back to its stack slots.
    pub(crate) fn ran_sync(&self) -> bool {
        self.ran_sync.get()
    }
}

impl SyncHofHost for VmHofHost<'_> {
    fn run_sync_hof(
        &self,
        callable: &Value,
        driver: &mut dyn FnMut(&mut dyn SyncCallbackSession) -> NativeResult,
    ) -> Option<NativeResult> {
        // A live debug session must observe every callback frame through the
        // cooperative debug quantum path.
        if is_debug_session_active() {
            return None;
        }
        let allowance = self.parent.remaining_quantum_budget();
        if allowance < SYNC_HOF_MIN_BUDGET {
            return None;
        }
        if let Some((closure, functions, native_fns)) = extract_vm_closure(callable) {
            let globals = closure.globals.clone()?;
            let _depth = DepthGuard::acquire()?;
            if closure_may_suspend(&closure, &functions, &native_fns) {
                return None;
            }
            // Snapshots convert the parent's open upvalue cells for foreign
            // runs; with no open cell anywhere they are no-ops, and the check
            // holds for the whole session (the parent is parked inside this
            // native dispatch).
            let snapshot_args = self.parent.has_open_upvalue_cells();
            if snapshot_args {
                // Close the callback's own open upvalues against the parent
                // frames once; per-element args are snapshotted in
                // `call_owned`.
                snapshot_escaping_call_shared(self.parent, callable, &[]);
            }
            self.ran_sync.set(true);
            SYNC_RUNS.with(|runs| runs.set(runs.get() + 1));
            let vm = take_pooled_vm(globals.clone(), functions.clone(), native_fns.clone());
            let mut session = VmCallbackSession {
                host: self,
                vm,
                closure,
                globals,
                functions,
                native_fns,
                allowance,
                consumed: 0,
                snapshot_args,
            };
            let result = driver(&mut session);
            self.consumed.set(self.consumed.get() + session.consumed);
            release_pooled_vm(session.vm);
            return Some(result);
        }
        // A genuine native callback (`(map string/to-number xs)`, `(foldl + 0
        // xs)`): an inert native settles synchronously by definition, so the
        // element loop is a plain per-element native invocation — no VM, no
        // instruction spend to account.
        let native = callable.as_native_fn_rc()?;
        if native.suspension_class() != NativeSuspensionClass::Inert {
            return None;
        }
        self.ran_sync.set(true);
        SYNC_RUNS.with(|runs| runs.set(runs.get() + 1));
        let mut session = NativeCallbackSession { host: self, native };
        Some(driver(&mut session))
    }
}

/// Sync session over an inert native callback: each element is one direct
/// native invocation under a per-call [`NativeCallContext`], mirroring the
/// context `dispatch_native` builds (same env, cancellation, task context).
struct NativeCallbackSession<'a, 'b> {
    host: &'a VmHofHost<'b>,
    native: Rc<NativeFn>,
}

impl SyncCallbackSession for NativeCallbackSession<'_, '_> {
    fn call_owned(&mut self, args: &mut [Value]) -> Result<Value, SemaError> {
        if !self.native.escaping_args().is_empty() {
            snapshot_escaping_call_shared(self.host.parent, &Value::NIL, args);
        }
        let mut native_ctx = sema_core::runtime::NativeCallContext {
            hof_host: None,
            eval_context: self.host.ctx,
            task_context: self.host.task_context.clone(),
            call_env: Some(self.host.parent.active_globals()),
            cancellation: self.host.parent.quantum_cancellation_view(),
        };
        match self.native.invoke_runtime(&mut native_ctx, args) {
            Ok(sema_core::runtime::NativeOutcome::Return(value)) => Ok(value),
            Err(error) => Err(error),
            Ok(_) => Err(SemaError::eval(
                "callback suspended on the synchronous HOF fast path",
            )),
        }
    }

    fn should_yield(&self) -> bool {
        false
    }
}

struct VmCallbackSession<'a, 'b> {
    host: &'a VmHofHost<'b>,
    vm: VM,
    closure: Rc<Closure>,
    globals: Rc<Env>,
    functions: Rc<Vec<Rc<Function>>>,
    native_fns: Rc<Vec<Rc<NativeFn>>>,
    allowance: usize,
    consumed: usize,
    /// Whether the parent had any open upvalue cell at session start; when it
    /// didn't, per-element arg snapshots are provably no-ops and skipped.
    snapshot_args: bool,
}

impl SyncCallbackSession for VmCallbackSession<'_, '_> {
    fn call_owned(&mut self, args: &mut [Value]) -> Result<Value, SemaError> {
        // Args can carry closures with open upvalues on the parent's stack
        // (different ones per element), so the snapshot runs per call.
        if self.snapshot_args {
            snapshot_escaping_call_shared(self.host.parent, &Value::NIL, args);
        }
        self.vm.setup_for_call_owned(self.closure.clone(), args)?;
        let quantum = self.vm.run_quantum(
            self.host.ctx,
            ELEMENT_BUDGET,
            self.host.parent.quantum_cancellation_view(),
        );
        self.consumed += quantum.instructions;
        match quantum.outcome {
            Ok(VmExecResult::Finished(value)) => Ok(value),
            Err(error) => {
                // Fail-fast, like the cooperative continuations: the chain
                // aborts, so clear the aborted frames before the VM is pooled.
                self.vm.reset_for_reuse();
                Err(error)
            }
            Ok(VmExecResult::Pending(pending)) => {
                // A nested HOF past the sync-nesting cap emitted its
                // cooperative `Call`. The chain is still proven non-suspending
                // (the analysis covered the whole call graph), so settle it in
                // the flat restricted driver; the parked element VM moves into
                // the driver and a fresh pooled VM serves the next element.
                let replacement = take_pooled_vm(
                    self.globals.clone(),
                    self.functions.clone(),
                    self.native_fns.clone(),
                );
                let parked = std::mem::replace(&mut self.vm, replacement);
                crate::restricted::resume_pending_restricted(
                    self.host.ctx,
                    self.host.task_context.clone(),
                    deopt_policy(self.host.parent.quantum_cancellation_view()),
                    Box::new(parked),
                    pending,
                )
            }
            Ok(_) => {
                self.vm.reset_for_reuse();
                Err(
                    SemaError::eval("callback suspended on the synchronous HOF fast path")
                        .with_hint(
                            "a global binding this callback calls was redefined to a suspending \
                     function while the sequence was being processed; re-run the operation",
                        ),
                )
            }
        }
    }

    fn should_yield(&self) -> bool {
        self.consumed >= self.allowance
    }
}

// ───────────────────────── suspension analysis ─────────────────────────

/// Can calling this closure transitively reach a suspension point?
///
/// Conservative: `false` is a proof (over the bindings visible right now);
/// `true` merely declines the fast path.
pub(crate) fn closure_may_suspend(
    closure: &Rc<Closure>,
    functions: &Rc<Vec<Rc<Function>>>,
    native_fns: &Rc<Vec<Rc<NativeFn>>>,
) -> bool {
    let Some(globals) = closure.globals.as_ref() else {
        return true;
    };
    let mut analysis = Analysis {
        visiting: Vec::new(),
        provisional: Vec::new(),
    };
    let verdict = analysis.function_may_suspend(&closure.func, globals, functions, native_fns);
    // Provisional "cannot suspend" verdicts leaned on in-progress cycle
    // assumptions; they hold only if the whole analysis concluded "cannot".
    if !verdict {
        for (func, fingerprint) in analysis.provisional {
            func.suspend_cache.set(Some((fingerprint, false)));
        }
    }
    verdict
}

/// Version fingerprint of an env chain. Any rebind along the chain changes it,
/// invalidating memoized verdicts that resolved globals through the chain.
fn env_chain_fingerprint(env: &Env) -> u64 {
    let mut fingerprint = 0xcbf2_9ce4_8422_2325u64;
    let mut current = Some(env);
    while let Some(env) = current {
        fingerprint = fingerprint.rotate_left(7).wrapping_mul(0x1000_0000_01b3) ^ env.version.get();
        current = env.parent.as_deref();
    }
    fingerprint
}

/// Where a symbolic stack slot's value came from, as far as callee/callback
/// resolution is concerned. Anything not trackable is `Opaque` (= assume the
/// worst when called).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Origin {
    Opaque,
    /// Pushed by `LoadGlobal` — resolve through the function's env chain.
    Global(Spur),
    /// Pushed by `MakeClosure` — a function in the current unit's table.
    Func(u16),
    /// A keyword constant — keyword-as-function is an inert map lookup.
    Keyword,
}

struct Analysis {
    visiting: Vec<*const Function>,
    /// (function, fingerprint) verdicts computed under an in-progress cycle
    /// assumption — cacheable only if the top-level verdict is "cannot".
    provisional: Vec<(Rc<Function>, u64)>,
}

impl Analysis {
    fn function_may_suspend(
        &mut self,
        func: &Rc<Function>,
        globals: &Rc<Env>,
        functions: &Rc<Vec<Rc<Function>>>,
        native_fns: &Rc<Vec<Rc<NativeFn>>>,
    ) -> bool {
        let fingerprint = env_chain_fingerprint(globals);
        if let Some((cached, verdict)) = func.suspend_cache.get() {
            if cached == fingerprint {
                return verdict;
            }
        }
        let key = Rc::as_ptr(func);
        if self.visiting.contains(&key) {
            // Coinductive: a call cycle that contains no other suspension
            // point cannot suspend. The verdict is validated at top level
            // before any provisional cache write.
            return false;
        }
        let provisional_watermark = self.provisional.len();
        self.visiting.push(key);
        let verdict = self.scan_chunk(func, globals, functions, native_fns);
        self.visiting.pop();
        if verdict {
            // "May suspend" is definitive regardless of cycle assumptions
            // (assumptions only ever suppress suspension). Cache it and drop
            // any provisional proofs discovered underneath — they may have
            // leaned on this function.
            self.provisional.truncate(provisional_watermark);
            func.suspend_cache.set(Some((fingerprint, true)));
        } else if self.visiting.is_empty() {
            func.suspend_cache.set(Some((fingerprint, false)));
        } else {
            self.provisional.push((Rc::clone(func), fingerprint));
        }
        verdict
    }

    /// Resolve a call to `origin` (with `callback_origins` when the callee is
    /// a callback-driven native). True = may suspend.
    fn call_may_suspend(
        &mut self,
        origin: Origin,
        callback_origins: &dyn Fn(&'static [usize]) -> Vec<Origin>,
        globals: &Rc<Env>,
        functions: &Rc<Vec<Rc<Function>>>,
        native_fns: &Rc<Vec<Rc<NativeFn>>>,
    ) -> bool {
        match origin {
            Origin::Keyword => false,
            Origin::Opaque => true,
            Origin::Func(index) => {
                let Some(func) = functions.get(index as usize) else {
                    return true;
                };
                let func = Rc::clone(func);
                self.function_may_suspend(&func, globals, functions, native_fns)
            }
            Origin::Global(spur) => {
                let Some(value) = globals.get(spur) else {
                    return true;
                };
                self.value_call_may_suspend(
                    &value,
                    callback_origins,
                    globals,
                    functions,
                    native_fns,
                )
            }
        }
    }

    fn value_call_may_suspend(
        &mut self,
        value: &Value,
        callback_origins: &dyn Fn(&'static [usize]) -> Vec<Origin>,
        globals: &Rc<Env>,
        functions: &Rc<Vec<Rc<Function>>>,
        native_fns: &Rc<Vec<Rc<NativeFn>>>,
    ) -> bool {
        if let Some((closure, closure_functions, closure_native_fns)) = extract_vm_closure(value) {
            let Some(closure_globals) = closure.globals.clone() else {
                return true;
            };
            return self.function_may_suspend(
                &closure.func,
                &closure_globals,
                &closure_functions,
                &closure_native_fns,
            );
        }
        if let Some(native) = value.as_native_fn_rc() {
            return match native.suspension_class() {
                NativeSuspensionClass::Inert => false,
                NativeSuspensionClass::MaySuspend => true,
                NativeSuspensionClass::CallbackDriven(positions) => {
                    callback_origins(positions).into_iter().any(|callback| {
                        self.call_may_suspend(
                            callback,
                            &|_| vec![Origin::Opaque],
                            globals,
                            functions,
                            native_fns,
                        )
                    })
                }
            };
        }
        // Multimethods dispatch cooperatively; anything else is either not
        // callable (a runtime error, which the cooperative path also raises)
        // or unknown.
        true
    }

    /// Linear scan of one chunk. Symbolic origins are tracked for straight-line
    /// code and wiped at every jump target (path merge); stack *depth* is
    /// trusted across merges because `validate_bytecode` proves all inbound
    /// paths agree. Any decode surprise bails conservatively.
    #[allow(clippy::too_many_lines)]
    fn scan_chunk(
        &mut self,
        func: &Rc<Function>,
        globals: &Rc<Env>,
        functions: &Rc<Vec<Rc<Function>>>,
        native_fns: &Rc<Vec<Rc<NativeFn>>>,
    ) -> bool {
        let chunk = &func.chunk;
        let code = &chunk.code;
        let Some(targets) = collect_jump_targets(chunk) else {
            return true;
        };

        let mut stack: Vec<Origin> = Vec::with_capacity(16);
        let mut locals: Vec<Origin> = vec![Origin::Opaque; chunk.n_locals as usize];
        // Depths recorded for forward-jump targets, resurrecting the scan
        // after a frame-exiting opcode (Return/TailCall/Throw) ends the
        // fallthrough path.
        let mut recorded_depths: hashbrown::HashMap<usize, usize> = hashbrown::HashMap::new();
        let mut depth_known = true;

        let mut pc = 0usize;
        while pc < code.len() {
            if targets.contains(&pc) {
                stack.fill(Origin::Opaque);
                locals.fill(Origin::Opaque);
                if !depth_known {
                    let Some(&depth) = recorded_depths.get(&pc) else {
                        return true;
                    };
                    stack.clear();
                    stack.resize(depth, Origin::Opaque);
                    depth_known = true;
                }
            } else if !depth_known {
                // Unreachable code between a frame exit and the next known
                // target — skip decoding it via the next target.
                let Some(&next) = targets.iter().filter(|&&target| target > pc).min() else {
                    return false;
                };
                pc = next;
                continue;
            }

            let Some(op) = Op::from_u8(code[pc]) else {
                return true;
            };
            let next_pc = pc + instruction_size(op, code, pc);
            if next_pc > code.len() {
                return true;
            }

            match op {
                Op::Const => {
                    let index = read_u16(code, pc + 1) as usize;
                    let origin = match chunk.consts.get(index) {
                        Some(value) if value.as_keyword_spur().is_some() => Origin::Keyword,
                        _ => Origin::Opaque,
                    };
                    stack.push(origin);
                }
                Op::LoadGlobal => {
                    stack.push(Origin::Global(spur_from_bits(read_u32(code, pc + 1))));
                }
                Op::MakeClosure => {
                    stack.push(Origin::Func(read_u16(code, pc + 1)));
                }
                Op::LoadLocal | Op::TakeLocal => {
                    let slot = read_u16(code, pc + 1) as usize;
                    stack.push(locals.get(slot).copied().unwrap_or(Origin::Opaque));
                }
                Op::LoadLocal0 | Op::LoadLocal1 | Op::LoadLocal2 | Op::LoadLocal3 => {
                    let slot = code[pc] as usize - op::LOAD_LOCAL0 as usize;
                    stack.push(locals.get(slot).copied().unwrap_or(Origin::Opaque));
                }
                Op::StoreLocal => {
                    let slot = read_u16(code, pc + 1) as usize;
                    let origin = stack.pop().unwrap_or(Origin::Opaque);
                    if let Some(local) = locals.get_mut(slot) {
                        *local = origin;
                    }
                }
                Op::StoreLocal0 | Op::StoreLocal1 | Op::StoreLocal2 | Op::StoreLocal3 => {
                    let slot = code[pc] as usize - op::STORE_LOCAL0 as usize;
                    let origin = stack.pop().unwrap_or(Origin::Opaque);
                    if let Some(local) = locals.get_mut(slot) {
                        *local = origin;
                    }
                }
                Op::Jump | Op::JumpIfFalse | Op::JumpIfTrue => {
                    let offset = read_i32(code, pc + 1) as i64;
                    if op != Op::Jump && stack.pop().is_none() {
                        return true;
                    }
                    let target = (pc as i64 + op::SIZE_OP_U32 as i64 + offset) as usize;
                    recorded_depths.insert(target, stack.len());
                    if op == Op::Jump {
                        // No fallthrough state survives an unconditional jump.
                        depth_known = false;
                    }
                }
                Op::Call | Op::TailCall => {
                    let argc = read_u16(code, pc + 1) as usize;
                    if stack.len() < argc + 1 {
                        return true;
                    }
                    let args_base = stack.len() - argc;
                    let callee = stack[args_base - 1];
                    let arg_at = |positions: &'static [usize]| {
                        positions
                            .iter()
                            .filter(|&&position| position < argc)
                            .map(|&position| stack[args_base + position])
                            .collect()
                    };
                    if self.call_may_suspend(callee, &arg_at, globals, functions, native_fns) {
                        return true;
                    }
                    stack.truncate(args_base - 1);
                    if op == Op::TailCall {
                        depth_known = false;
                    } else {
                        stack.push(Origin::Opaque);
                    }
                }
                Op::CallGlobal => {
                    let spur = spur_from_bits(read_u32(code, pc + 1));
                    let argc = read_u16(code, pc + 5) as usize;
                    if stack.len() < argc {
                        return true;
                    }
                    let args_base = stack.len() - argc;
                    let arg_at = |positions: &'static [usize]| {
                        positions
                            .iter()
                            .filter(|&&position| position < argc)
                            .map(|&position| stack[args_base + position])
                            .collect()
                    };
                    if self.call_may_suspend(
                        Origin::Global(spur),
                        &arg_at,
                        globals,
                        functions,
                        native_fns,
                    ) {
                        return true;
                    }
                    stack.truncate(args_base);
                    stack.push(Origin::Opaque);
                }
                Op::CallNative => {
                    let native_id = read_u16(code, pc + 1) as usize;
                    let argc = read_u16(code, pc + 3) as usize;
                    if stack.len() < argc {
                        return true;
                    }
                    let Some(native) = native_fns.get(native_id) else {
                        return true;
                    };
                    let args_base = stack.len() - argc;
                    let suspends = match native.suspension_class() {
                        NativeSuspensionClass::Inert => false,
                        NativeSuspensionClass::MaySuspend => true,
                        NativeSuspensionClass::CallbackDriven(positions) => positions
                            .iter()
                            .filter(|&&position| position < argc)
                            .any(|&position| {
                                self.call_may_suspend(
                                    stack[args_base + position],
                                    &|_| vec![Origin::Opaque],
                                    globals,
                                    functions,
                                    native_fns,
                                )
                            }),
                    };
                    if suspends {
                        return true;
                    }
                    stack.truncate(args_base);
                    stack.push(Origin::Opaque);
                }
                Op::CallSelf | Op::SelfTailCall => {
                    // The callee is this function itself: an in-progress
                    // assumption the top level validates.
                    let argc = read_u16(code, pc + 1) as usize;
                    if stack.len() < argc {
                        return true;
                    }
                    stack.truncate(stack.len() - argc);
                    if op == Op::SelfTailCall {
                        depth_known = false;
                    } else {
                        stack.push(Origin::Opaque);
                    }
                }
                Op::Return | Op::Throw => {
                    stack.pop();
                    depth_known = false;
                }
                _ => {
                    // Every remaining opcode is a pure stack transform; apply
                    // its declared effect with opaque results.
                    let operand = match op {
                        Op::MakeList | Op::MakeVector | Op::MakeMap | Op::MakeHashMap => {
                            read_u16(code, pc + 1)
                        }
                        _ => 0,
                    };
                    let effect = op.stack_effect(operand);
                    if (stack.len() as u32) < effect.pops {
                        return true;
                    }
                    stack.truncate(stack.len() - effect.pops as usize);
                    for _ in 0..effect.pushes {
                        stack.push(Origin::Opaque);
                    }
                    if effect.exits_frame {
                        depth_known = false;
                    }
                }
            }
            pc = next_pc;
        }
        false
    }
}

/// All jump targets (and exception handler entries) in `chunk`, or `None` when
/// the bytecode fails to decode.
fn collect_jump_targets(chunk: &crate::chunk::Chunk) -> Option<HashSet<usize>> {
    let code = &chunk.code;
    let mut targets = HashSet::new();
    for entry in &chunk.exception_table {
        targets.insert(entry.handler_pc as usize);
    }
    let mut pc = 0usize;
    while pc < code.len() {
        let op = Op::from_u8(code[pc])?;
        if matches!(op, Op::Jump | Op::JumpIfFalse | Op::JumpIfTrue) {
            let offset = read_i32(code, pc + 1) as i64;
            let target = pc as i64 + op::SIZE_OP_U32 as i64 + offset;
            if target < 0 || target as usize > code.len() {
                return None;
            }
            targets.insert(target as usize);
        }
        pc += instruction_size(op, code, pc);
    }
    Some(targets)
}

/// Total encoded size of the instruction at `pc` (opcode + operands).
fn instruction_size(op: Op, code: &[u8], pc: usize) -> usize {
    match op {
        Op::Const
        | Op::LoadLocal
        | Op::StoreLocal
        | Op::LoadUpvalue
        | Op::StoreUpvalue
        | Op::Call
        | Op::TailCall
        | Op::SelfTailCall
        | Op::CallSelf
        | Op::TakeLocal
        | Op::MakeList
        | Op::MakeVector
        | Op::MakeMap
        | Op::MakeHashMap => op::SIZE_OP_U16,
        Op::StoreGlobal | Op::DefineGlobal | Op::Jump | Op::JumpIfFalse | Op::JumpIfTrue => {
            op::SIZE_OP_U32
        }
        Op::LoadGlobal => op::SIZE_LOAD_GLOBAL,
        Op::CallGlobal => op::SIZE_CALL_GLOBAL,
        Op::CallNative => op::SIZE_CALL_NATIVE,
        Op::MakeClosure => {
            let n_upvalues = if pc + 5 <= code.len() {
                read_u16(code, pc + 3) as usize
            } else {
                0
            };
            op::SIZE_OP + 4 + n_upvalues * 4
        }
        // Exhaustive on purpose (no `_` arm): adding an opcode must classify
        // its encoded size here or this fails to compile — a mis-sized walk
        // would silently desync the suspension scan.
        Op::Nil
        | Op::True
        | Op::False
        | Op::Pop
        | Op::Dup
        | Op::Return
        | Op::Throw
        | Op::Add
        | Op::Sub
        | Op::Mul
        | Op::Div
        | Op::Negate
        | Op::Not
        | Op::Eq
        | Op::Lt
        | Op::Gt
        | Op::Le
        | Op::Ge
        | Op::AddInt
        | Op::SubInt
        | Op::MulInt
        | Op::LtInt
        | Op::EqInt
        | Op::LoadLocal0
        | Op::LoadLocal1
        | Op::LoadLocal2
        | Op::LoadLocal3
        | Op::StoreLocal0
        | Op::StoreLocal1
        | Op::StoreLocal2
        | Op::StoreLocal3
        | Op::Car
        | Op::Cdr
        | Op::Cons
        | Op::IsNull
        | Op::IsPair
        | Op::IsList
        | Op::IsNumber
        | Op::IsString
        | Op::IsSymbol
        | Op::Length
        | Op::Append
        | Op::Get
        | Op::ContainsQ
        | Op::Mod
        | Op::Nth
        | Op::StringLength
        | Op::StringRef
        | Op::StringAppend
        | Op::MutArrGet
        | Op::MutArrSet => op::SIZE_OP,
    }
}

fn read_u16(code: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([code[at], code[at + 1]])
}

fn read_u32(code: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([code[at], code[at + 1], code[at + 2], code[at + 3]])
}

fn read_i32(code: &[u8], at: usize) -> i32 {
    i32::from_le_bytes([code[at], code[at + 1], code[at + 2], code[at + 3]])
}

fn spur_from_bits(bits: u32) -> Spur {
    sema_core::bits_to_spur(bits)
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroUsize;
    use std::rc::Rc;
    use std::time::Duration;

    use sema_core::runtime::{
        CancellationView, NativeOutcome, NativeSuspend, TaskContextHandle, Trace, WaitKind,
    };
    use sema_core::{Env, EvalContext, NativeFn, Value};

    use super::closure_may_suspend;
    use crate::compile_program;
    use crate::restricted::{run_program_restricted, RestrictedRunPolicy};
    use crate::vm::extract_vm_closure;

    struct NilContinuation;

    impl Trace for NilContinuation {
        fn trace(&self, _sink: &mut dyn FnMut(sema_core::cycle::GcEdge<'_>)) -> bool {
            true
        }
    }

    impl sema_core::runtime::NativeContinuation for NilContinuation {
        fn resume(
            self: Box<Self>,
            _context: &mut sema_core::runtime::NativeCallContext<'_>,
            _input: sema_core::runtime::ResumeInput,
        ) -> sema_core::runtime::NativeResult {
            Ok(NativeOutcome::Return(Value::nil()))
        }
    }

    /// Compile `source` (which must evaluate to a lambda) against `globals` and
    /// return the resulting VM-closure value.
    fn closure_value(source: &str, globals: &Rc<Env>) -> Value {
        let forms = sema_reader::read_many(source).expect("source parses");
        let program = compile_program(&forms, None).expect("source compiles");
        run_program_restricted(
            &EvalContext::new(),
            TaskContextHandle::default(),
            program,
            Rc::clone(globals),
            RestrictedRunPolicy {
                operation: "analysis fixture",
                suspension_error: "analysis fixture cannot suspend",
                instruction_limit: NonZeroUsize::new(100_000).unwrap(),
                transition_limit: NonZeroUsize::new(1_000).unwrap(),
                deadline: None,
                cancellation: CancellationView::default(),
            },
        )
        .expect("fixture evaluates")
    }

    fn may_suspend(source: &str, globals: &Rc<Env>) -> bool {
        let value = closure_value(source, globals);
        let (closure, functions, native_fns) =
            extract_vm_closure(&value).expect("fixture returns a VM closure");
        closure_may_suspend(&closure, &functions, &native_fns)
    }

    fn fixture_globals() -> Rc<Env> {
        let globals = Rc::new(Env::new());
        globals.set_str(
            "inert-native",
            Value::native_fn(NativeFn::simple("inert-native", |args| {
                Ok(args.first().cloned().unwrap_or(Value::nil()))
            })),
        );
        globals.set_str(
            "suspendy",
            Value::native_fn(NativeFn::simple_result("suspendy", |_| {
                Ok(NativeOutcome::Suspend(NativeSuspend {
                    wait: WaitKind::Timer(Duration::from_millis(1)),
                    continuation: Box::new(NilContinuation),
                }))
            })),
        );
        globals.set_str(
            "hoflike",
            Value::native_fn(
                NativeFn::simple_with_runtime(
                    "hoflike",
                    |args| Ok(args[0].clone()),
                    |_, args| Ok(NativeOutcome::Return(args[0].clone())),
                )
                .with_callback_suspension(&[0]),
            ),
        );
        globals
    }

    #[test]
    fn pure_and_inert_native_bodies_cannot_suspend() {
        let globals = fixture_globals();
        assert!(!may_suspend("(lambda (x) (+ x 1))", &globals));
        assert!(!may_suspend("(lambda (x) (inert-native x))", &globals));
        // Keyword-as-function is an inert map lookup.
        assert!(!may_suspend("(lambda (m) (:name m))", &globals));
    }

    #[test]
    fn suspension_capable_and_dynamic_callees_are_conservative() {
        let globals = fixture_globals();
        assert!(may_suspend("(lambda (x) (suspendy x))", &globals));
        // Dynamic callee: the parameter itself is called.
        assert!(may_suspend("(lambda (f) (f 1))", &globals));
        // Unknown global.
        assert!(may_suspend("(lambda (x) (no-such-global x))", &globals));
    }

    #[test]
    fn callback_driven_native_resolves_its_callback_argument() {
        let globals = fixture_globals();
        // Inert callback through a callback-driven native: provable.
        assert!(!may_suspend(
            "(lambda (x) (hoflike (lambda (y) (+ y 1)) x))",
            &globals
        ));
        // Suspending callback through the same native: conservative.
        assert!(may_suspend(
            "(lambda (x) (hoflike (lambda (y) (suspendy y)) x))",
            &globals
        ));
        // Opaque callback position: conservative.
        assert!(may_suspend("(lambda (f x) (hoflike f x))", &globals));
    }

    #[test]
    fn verdicts_reanalyze_after_global_rebind() {
        let globals = fixture_globals();
        globals.set_str("helper", closure_value("(lambda (x) (+ x 1))", &globals));
        let cb = closure_value("(lambda (x) (helper x))", &globals);
        let (closure, functions, native_fns) = extract_vm_closure(&cb).unwrap();
        assert!(!closure_may_suspend(&closure, &functions, &native_fns));
        // Rebind the helper to a suspending body: the memoized verdict must
        // not survive the env-chain fingerprint change.
        globals.set_str(
            "helper",
            closure_value("(lambda (x) (suspendy x))", &globals),
        );
        assert!(closure_may_suspend(&closure, &functions, &native_fns));
    }
}
