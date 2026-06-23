//! Gate (Slice 2): breakpoints INSIDE async tasks STOP + CONTINUE in the
//! COOPERATIVE (WASM playground) debugger — `VM::start_cooperative` /
//! `run_cooperative`, NOT the blocking native `execute_debug`.
//!
//! This replicates the cooperative WASM flow WITHOUT a browser, mirroring
//! `SemaPlayground::debug_start` in `crates/sema-wasm/src/lib.rs`:
//! read_many_with_spans → compile_program_with_spans → DebugState::new_headless
//! + set_valid_breakpoint_lines + set_breakpoints → init_scheduler →
//! start_cooperative, then run_cooperative to simulate Continue.
//!
//! Why the native gate (`dap_async_breakpoint_test.rs`) is not enough: the
//! cooperative path is step-driven and must NOT block on a command channel — it
//! RETURNS `VmExecResult::Stopped(info)` to JS and resumes via a later
//! `run_cooperative`. Slice 1 fixed only the blocking native path.
//!
//! Contract under test: `start_cooperative` returns `Stopped` whose info line ==
//! the async breakpoint line (control: a SYNC-line breakpoint already does this —
//! it proves the harness). A follow-up `run_cooperative` (simulating Continue)
//! eventually returns `Finished`.

#![cfg(not(target_arch = "wasm32"))]

use std::path::PathBuf;

use sema_eval::Interpreter;
use sema_vm::{DebugState, StepMode, VmExecResult, VM};

/// CONTROL: sync breakpoint stops + continues cooperatively. Proves the harness
/// is valid (so a failure of the async case below is a real gap, not a broken
/// test). This already works today.
#[test]
fn coop_sync_breakpoint_full_cycle() {
    let interpreter = Interpreter::new();
    let source = "(define x 1)\n(define y (+ x 2))\n(+ x y)\n";

    let (vals, span_map) = sema_reader::read_many_with_spans(source).unwrap();
    let source_file = PathBuf::from("<playground>");
    let prog =
        sema_vm::compile_program_with_spans(&vals, &span_map, Some(source_file.clone())).unwrap();
    sema_vm::init_scheduler(interpreter.global_env.clone(), Vec::new());

    let valid = sema_vm::valid_breakpoint_lines(&prog.closure, &prog.functions);
    let snapped = sema_vm::snap_breakpoint_line(2, &valid).unwrap();
    let mut debug = DebugState::new_headless();
    debug.set_valid_breakpoint_lines(sema_vm::valid_breakpoint_lines_by_file(
        &prog.closure,
        &prog.functions,
    ));
    debug.set_breakpoints(&source_file, &[snapped]);
    debug.step_mode = StepMode::Continue;
    debug.instructions_remaining = 5_000_000;

    let mut vm = VM::new(
        interpreter.global_env.clone(),
        prog.functions,
        &[],
        prog.main_cache_slots,
    )
    .unwrap();

    let first = vm
        .start_cooperative(prog.closure.clone(), &interpreter.ctx, &mut debug)
        .unwrap();
    match first {
        VmExecResult::Stopped(info) => assert_eq!(info.line, 2),
        other => panic!("expected Stopped on sync bp, got {other:?}"),
    }

    let mut finished = false;
    for _ in 0..10_000 {
        debug.instructions_remaining = 5_000_000;
        match vm.run_cooperative(&interpreter.ctx, &mut debug).unwrap() {
            VmExecResult::Finished(_) => {
                finished = true;
                break;
            }
            _ => {}
        }
    }
    assert!(finished, "sync program should finish after Continue");
}

/// THE GATE: a breakpoint on a line that runs only INSIDE an async task must
/// surface cooperatively as `Stopped` (line == the async breakpoint line), and a
/// follow-up `run_cooperative` (Continue) must drive it to `Finished`.
#[test]
fn coop_async_task_breakpoint_stops_and_continues() {
    let interpreter = Interpreter::new();
    // Line 2 is `(+ 1 2)` — executes only inside the spawned task body.
    let source = "(define p (async/spawn (fn ()\n  (+ 1 2))))\n(await p)\n";

    let (vals, span_map) = sema_reader::read_many_with_spans(source).unwrap();
    let source_file = PathBuf::from("<playground>");
    let prog =
        sema_vm::compile_program_with_spans(&vals, &span_map, Some(source_file.clone())).unwrap();
    sema_vm::init_scheduler(interpreter.global_env.clone(), Vec::new());

    let valid = sema_vm::valid_breakpoint_lines(&prog.closure, &prog.functions);
    let snapped =
        sema_vm::snap_breakpoint_line(2, &valid).expect("async bp line snaps to executable line");
    assert_eq!(snapped, 2, "the (+ 1 2) line should be directly executable");

    let mut debug = DebugState::new_headless();
    debug.set_valid_breakpoint_lines(sema_vm::valid_breakpoint_lines_by_file(
        &prog.closure,
        &prog.functions,
    ));
    debug.set_breakpoints(&source_file, &[snapped]);
    debug.step_mode = StepMode::Continue;
    debug.instructions_remaining = 5_000_000;

    let mut vm = VM::new(
        interpreter.global_env.clone(),
        prog.functions,
        &[],
        prog.main_cache_slots,
    )
    .unwrap();

    let first = vm
        .start_cooperative(prog.closure.clone(), &interpreter.ctx, &mut debug)
        .expect("cooperative start does not error");

    match first {
        VmExecResult::Stopped(info) => {
            assert_eq!(
                info.line, 2,
                "async-task breakpoint should stop on line 2 (inside the thunk), got {info:?}"
            );
        }
        other => panic!(
            "expected Stopped inside the async task, got {other:?} \
             (the async stop was swallowed — Slice 2 not implemented)"
        ),
    }

    // Continue: re-enter cooperatively and drive to completion.
    let mut finished = false;
    for _ in 0..10_000 {
        debug.instructions_remaining = 5_000_000;
        match vm
            .run_cooperative(&interpreter.ctx, &mut debug)
            .expect("run_cooperative does not error on resume")
        {
            VmExecResult::Finished(_) => {
                finished = true;
                break;
            }
            _ => {}
        }
    }
    assert!(
        finished,
        "async program must finish after Continue from the task breakpoint"
    );
}
