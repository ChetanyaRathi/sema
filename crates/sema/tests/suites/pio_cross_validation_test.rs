//! Cross-validation of Sema's PIO assembler against reference encodings from the
//! `pio` Rust crate (v0.3, the assembler rp2040-hal uses).
//!
//! The reference bytes live in `tests/fixtures/pio_golden.json`, generated ONCE by
//! `tools/pio-golden` (a tiny out-of-workspace crate) so the pio/lalrpop proc-macro
//! stack is not compiled on every test build. Each test evaluates the Sema-side
//! `pio/*` builtins and asserts byte-for-byte equality with the frozen reference.
//! To add a case or bump the pio crate, extend the generator and re-run it (see
//! `tools/pio-golden/src/main.rs` for the command), then mirror the case here.

use sema_eval::Interpreter;

/// Reference encoding for a named case, from the committed golden fixture.
fn golden(name: &str) -> Vec<u8> {
    static GOLDEN: std::sync::OnceLock<std::collections::BTreeMap<String, String>> =
        std::sync::OnceLock::new();
    let map = GOLDEN.get_or_init(|| {
        serde_json::from_str(include_str!("../fixtures/pio_golden.json"))
            .expect("pio_golden.json is valid JSON")
    });
    let hex = map
        .get(name)
        .unwrap_or_else(|| panic!("no golden entry for {name}; re-run tools/pio-golden"));
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}

/// Helper: evaluate a Sema expression and extract the :instructions bytevector.
fn sema_assemble(expr: &str) -> Vec<u8> {
    let interp = Interpreter::new();
    let full = format!("(get (pio/assemble {expr}) :instructions)");
    let result = interp
        .eval_str(&full)
        .unwrap_or_else(|e| panic!("Sema eval failed for: {full}\nError: {e}"));
    result
        .as_bytevector()
        .unwrap_or_else(|| panic!("Expected bytevector from: {full}\nGot: {result}"))
        .to_vec()
}

/// Helper: evaluate a single Sema PIO instruction (no labels needed).
fn sema_single(instr: &str) -> Vec<u8> {
    sema_assemble(&format!("(list {instr})"))
}

// ═══════════════════════════════════════════════════════════════════
// SET instructions (opcode 111)
// ═══════════════════════════════════════════════════════════════════

#[test]
fn xval_set_pins_0() {
    let reference = golden("xval_set_pins_0");
    assert_eq!(sema_single("(pio/set :pins 0)"), reference);
}

#[test]
fn xval_set_pins_1() {
    let reference = golden("xval_set_pins_1");
    assert_eq!(sema_single("(pio/set :pins 1)"), reference);
}

#[test]
fn xval_set_pins_31() {
    let reference = golden("xval_set_pins_31");
    assert_eq!(sema_single("(pio/set :pins 31)"), reference);
}

#[test]
fn xval_set_x_0() {
    let reference = golden("xval_set_x_0");
    assert_eq!(sema_single("(pio/set :x 0)"), reference);
}

#[test]
fn xval_set_x_31() {
    let reference = golden("xval_set_x_31");
    assert_eq!(sema_single("(pio/set :x 31)"), reference);
}

#[test]
fn xval_set_y_15() {
    let reference = golden("xval_set_y_15");
    assert_eq!(sema_single("(pio/set :y 15)"), reference);
}

#[test]
fn xval_set_pindirs_1() {
    let reference = golden("xval_set_pindirs_1");
    assert_eq!(sema_single("(pio/set :pindirs 1)"), reference);
}

// ═══════════════════════════════════════════════════════════════════
// NOP / MOV instructions (opcode 101)
// ═══════════════════════════════════════════════════════════════════

#[test]
fn xval_nop() {
    let reference = golden("xval_nop");
    assert_eq!(sema_single("(pio/nop)"), reference);
}

#[test]
fn xval_mov_x_y() {
    let reference = golden("xval_mov_x_y");
    assert_eq!(sema_single("(pio/mov :x :y)"), reference);
}

#[test]
fn xval_mov_y_x() {
    let reference = golden("xval_mov_y_x");
    assert_eq!(sema_single("(pio/mov :y :x)"), reference);
}

#[test]
fn xval_mov_x_invert_y() {
    let reference = golden("xval_mov_x_invert_y");
    assert_eq!(sema_single("(pio/mov :x :!y)"), reference);
}

#[test]
fn xval_mov_x_reverse_y() {
    let reference = golden("xval_mov_x_reverse_y");
    assert_eq!(sema_single("(pio/mov :x :y :reverse)"), reference);
}

#[test]
fn xval_mov_pins_isr() {
    let reference = golden("xval_mov_pins_isr");
    assert_eq!(sema_single("(pio/mov :pins :isr)"), reference);
}

#[test]
fn xval_mov_osr_null() {
    let reference = golden("xval_mov_osr_null");
    assert_eq!(sema_single("(pio/mov :osr :null)"), reference);
}

#[test]
fn xval_mov_isr_osr() {
    let reference = golden("xval_mov_isr_osr");
    assert_eq!(sema_single("(pio/mov :isr :osr)"), reference);
}

#[test]
fn xval_mov_exec_invert_status() {
    let reference = golden("xval_mov_exec_invert_status");
    assert_eq!(sema_single("(pio/mov :exec :!status)"), reference);
}

// ═══════════════════════════════════════════════════════════════════
// IN instructions (opcode 010)
// ═══════════════════════════════════════════════════════════════════

#[test]
fn xval_in_pins_1() {
    let reference = golden("xval_in_pins_1");
    assert_eq!(sema_single("(pio/in :pins 1)"), reference);
}

#[test]
fn xval_in_pins_8() {
    let reference = golden("xval_in_pins_8");
    assert_eq!(sema_single("(pio/in :pins 8)"), reference);
}

#[test]
fn xval_in_pins_32() {
    let reference = golden("xval_in_pins_32");
    assert_eq!(sema_single("(pio/in :pins 32)"), reference);
}

#[test]
fn xval_in_x_32() {
    let reference = golden("xval_in_x_32");
    assert_eq!(sema_single("(pio/in :x 32)"), reference);
}

#[test]
fn xval_in_null_4() {
    let reference = golden("xval_in_null_4");
    assert_eq!(sema_single("(pio/in :null 4)"), reference);
}

#[test]
fn xval_in_isr_16() {
    let reference = golden("xval_in_isr_16");
    assert_eq!(sema_single("(pio/in :isr 16)"), reference);
}

#[test]
fn xval_in_osr_8() {
    let reference = golden("xval_in_osr_8");
    assert_eq!(sema_single("(pio/in :osr 8)"), reference);
}

// ═══════════════════════════════════════════════════════════════════
// OUT instructions (opcode 011)
// ═══════════════════════════════════════════════════════════════════

#[test]
fn xval_out_pins_1() {
    let reference = golden("xval_out_pins_1");
    assert_eq!(sema_single("(pio/out :pins 1)"), reference);
}

#[test]
fn xval_out_pins_32() {
    let reference = golden("xval_out_pins_32");
    assert_eq!(sema_single("(pio/out :pins 32)"), reference);
}

#[test]
fn xval_out_x_32() {
    let reference = golden("xval_out_x_32");
    assert_eq!(sema_single("(pio/out :x 32)"), reference);
}

#[test]
fn xval_out_y_8() {
    let reference = golden("xval_out_y_8");
    assert_eq!(sema_single("(pio/out :y 8)"), reference);
}

#[test]
fn xval_out_null_1() {
    let reference = golden("xval_out_null_1");
    assert_eq!(sema_single("(pio/out :null 1)"), reference);
}

#[test]
fn xval_out_pindirs_4() {
    let reference = golden("xval_out_pindirs_4");
    assert_eq!(sema_single("(pio/out :pindirs 4)"), reference);
}

#[test]
fn xval_out_pc_5() {
    let reference = golden("xval_out_pc_5");
    assert_eq!(sema_single("(pio/out :pc 5)"), reference);
}

#[test]
fn xval_out_isr_16() {
    let reference = golden("xval_out_isr_16");
    assert_eq!(sema_single("(pio/out :isr 16)"), reference);
}

#[test]
fn xval_out_exec_16() {
    let reference = golden("xval_out_exec_16");
    assert_eq!(sema_single("(pio/out :exec 16)"), reference);
}

// ═══════════════════════════════════════════════════════════════════
// PUSH instructions (opcode 100, bit7=0)
// ═══════════════════════════════════════════════════════════════════

#[test]
fn xval_push_block() {
    let reference = golden("xval_push_block");
    assert_eq!(sema_single("(pio/push)"), reference);
}

#[test]
fn xval_push_noblock() {
    let reference = golden("xval_push_noblock");
    assert_eq!(sema_single("(pio/push :no-block)"), reference);
}

#[test]
fn xval_push_iffull_block() {
    let reference = golden("xval_push_iffull_block");
    assert_eq!(sema_single("(pio/push :iffull)"), reference);
}

#[test]
fn xval_push_iffull_noblock() {
    let reference = golden("xval_push_iffull_noblock");
    assert_eq!(sema_single("(pio/push :iffull :no-block)"), reference);
}

// ═══════════════════════════════════════════════════════════════════
// PULL instructions (opcode 100, bit7=1)
// ═══════════════════════════════════════════════════════════════════

#[test]
fn xval_pull_block() {
    let reference = golden("xval_pull_block");
    assert_eq!(sema_single("(pio/pull)"), reference);
}

#[test]
fn xval_pull_noblock() {
    let reference = golden("xval_pull_noblock");
    assert_eq!(sema_single("(pio/pull :no-block)"), reference);
}

#[test]
fn xval_pull_ifempty_block() {
    let reference = golden("xval_pull_ifempty_block");
    assert_eq!(sema_single("(pio/pull :ifempty)"), reference);
}

#[test]
fn xval_pull_ifempty_noblock() {
    let reference = golden("xval_pull_ifempty_noblock");
    assert_eq!(sema_single("(pio/pull :ifempty :no-block)"), reference);
}

// ═══════════════════════════════════════════════════════════════════
// WAIT instructions (opcode 001)
// ═══════════════════════════════════════════════════════════════════

#[test]
fn xval_wait_gpio_0_high() {
    let reference = golden("xval_wait_gpio_0_high");
    assert_eq!(sema_single("(pio/wait 1 :gpio 0)"), reference);
}

#[test]
fn xval_wait_gpio_15_low() {
    let reference = golden("xval_wait_gpio_15_low");
    assert_eq!(sema_single("(pio/wait 0 :gpio 15)"), reference);
}

#[test]
fn xval_wait_pin_0_high() {
    let reference = golden("xval_wait_pin_0_high");
    assert_eq!(sema_single("(pio/wait 1 :pin 0)"), reference);
}

#[test]
fn xval_wait_irq_3() {
    let reference = golden("xval_wait_irq_3");
    assert_eq!(sema_single("(pio/wait 1 :irq 3)"), reference);
}

#[test]
fn xval_wait_irq_rel() {
    let reference = golden("xval_wait_irq_rel");
    assert_eq!(sema_single("(pio/wait 1 :irq 0 :rel)"), reference);
}

// ═══════════════════════════════════════════════════════════════════
// IRQ instructions (opcode 110)
// ═══════════════════════════════════════════════════════════════════

#[test]
fn xval_irq_set_0() {
    let reference = golden("xval_irq_set_0");
    assert_eq!(sema_single("(pio/irq :set 0)"), reference);
}

#[test]
fn xval_irq_set_7() {
    let reference = golden("xval_irq_set_7");
    assert_eq!(sema_single("(pio/irq :set 7)"), reference);
}

#[test]
fn xval_irq_wait_2() {
    let reference = golden("xval_irq_wait_2");
    assert_eq!(sema_single("(pio/irq :wait 2)"), reference);
}

#[test]
fn xval_irq_clear_5() {
    let reference = golden("xval_irq_clear_5");
    assert_eq!(sema_single("(pio/irq :clear 5)"), reference);
}

#[test]
fn xval_irq_set_rel() {
    let reference = golden("xval_irq_set_rel");
    assert_eq!(sema_single("(pio/irq :set 0 :rel)"), reference);
}

#[test]
fn xval_irq_wait_rel() {
    let reference = golden("xval_irq_wait_rel");
    assert_eq!(sema_single("(pio/irq :wait 3 :rel)"), reference);
}

// ═══════════════════════════════════════════════════════════════════
// JMP instructions (opcode 000) — all 8 conditions
// ═══════════════════════════════════════════════════════════════════

#[test]
fn xval_jmp_always() {
    let reference = golden("xval_jmp_always");
    assert_eq!(sema_assemble("(list 'target (pio/jmp 'target))"), reference);
}

#[test]
fn xval_jmp_not_x() {
    let reference = golden("xval_jmp_not_x");
    assert_eq!(
        sema_assemble("(list 'target (pio/jmp :!x 'target))"),
        reference
    );
}

#[test]
fn xval_jmp_x_dec() {
    let reference = golden("xval_jmp_x_dec");
    assert_eq!(
        sema_assemble("(list 'target (pio/jmp :x-- 'target))"),
        reference
    );
}

#[test]
fn xval_jmp_not_y() {
    let reference = golden("xval_jmp_not_y");
    assert_eq!(
        sema_assemble("(list 'target (pio/jmp :!y 'target))"),
        reference
    );
}

#[test]
fn xval_jmp_y_dec() {
    let reference = golden("xval_jmp_y_dec");
    assert_eq!(
        sema_assemble("(list 'target (pio/jmp :y-- 'target))"),
        reference
    );
}

#[test]
fn xval_jmp_x_ne_y() {
    let reference = golden("xval_jmp_x_ne_y");
    assert_eq!(
        sema_assemble("(list 'target (pio/jmp :x!=y 'target))"),
        reference
    );
}

#[test]
fn xval_jmp_pin() {
    let reference = golden("xval_jmp_pin");
    assert_eq!(
        sema_assemble("(list 'target (pio/jmp :pin 'target))"),
        reference
    );
}

#[test]
fn xval_jmp_not_osre() {
    let reference = golden("xval_jmp_not_osre");
    assert_eq!(
        sema_assemble("(list 'target (pio/jmp :!osre 'target))"),
        reference
    );
}

// ═══════════════════════════════════════════════════════════════════
// Delay encoding
// ═══════════════════════════════════════════════════════════════════

#[test]
fn xval_nop_delay_1() {
    let reference = golden("xval_nop_delay_1");
    assert_eq!(sema_single("(pio/delay 1 (pio/nop))"), reference);
}

#[test]
fn xval_nop_delay_15() {
    let reference = golden("xval_nop_delay_15");
    assert_eq!(sema_single("(pio/delay 15 (pio/nop))"), reference);
}

#[test]
fn xval_nop_delay_31() {
    let reference = golden("xval_nop_delay_31");
    assert_eq!(sema_single("(pio/delay 31 (pio/nop))"), reference);
}

#[test]
fn xval_set_delay_7() {
    let reference = golden("xval_set_delay_7");
    assert_eq!(sema_single("(pio/delay 7 (pio/set :pins 1))"), reference);
}

// ═══════════════════════════════════════════════════════════════════
// Multi-instruction programs with labels
// ═══════════════════════════════════════════════════════════════════

#[test]
fn xval_hello_pio() {
    // The canonical hello.pio from pico-examples:
    //   pull block
    //   out pins, 1
    //   jmp start
    let reference = golden("xval_hello_pio");
    assert_eq!(
        sema_assemble("(list 'start (pio/pull) (pio/out :pins 1) (pio/jmp 'start))"),
        reference
    );
}

#[test]
fn xval_blink_program() {
    // Simple blink: set pins 1, nop[31], set pins 0, nop[31]
    let reference = golden("xval_blink_program");
    assert_eq!(
        sema_assemble(
            "(list (pio/set :pins 1) (pio/delay 31 (pio/nop)) (pio/set :pins 0) (pio/delay 31 (pio/nop)))"
        ),
        reference
    );
}

#[test]
fn xval_forward_jump() {
    // jmp end, nop, nop (end label)
    let reference = golden("xval_forward_jump");
    assert_eq!(
        sema_assemble("(list (pio/jmp 'end) (pio/nop) 'end (pio/nop))"),
        reference
    );
}

#[test]
fn xval_count_down_loop() {
    // set x 10, loop: jmp x-- loop, nop
    let reference = golden("xval_count_down_loop");
    assert_eq!(
        sema_assemble("(list (pio/set :x 10) 'loop (pio/jmp :x-- 'loop) (pio/nop))"),
        reference
    );
}

#[test]
fn xval_pull_out_loop() {
    // Typical data output pattern: pull, out pins 8, jmp start
    let reference = golden("xval_pull_out_loop");
    assert_eq!(
        sema_assemble("(list 'start (pio/pull) (pio/out :pins 8) (pio/jmp 'start))"),
        reference
    );
}

#[test]
fn xval_in_push_loop() {
    // Typical data input pattern: in pins 8, push, jmp start
    let reference = golden("xval_in_push_loop");
    assert_eq!(
        sema_assemble("(list 'start (pio/in :pins 8) (pio/push) (pio/jmp 'start))"),
        reference
    );
}

// ═══════════════════════════════════════════════════════════════════
// Side-set encoding
// ═══════════════════════════════════════════════════════════════════

#[test]
fn xval_side_set_1bit() {
    // set pins 0 with side-set 1 (1 bit)
    let reference = golden("xval_side_set_1bit");
    assert_eq!(
        sema_assemble("(list (pio/side 1 (pio/set :pins 0))) {:side-set-bits 1}"),
        reference
    );
}

#[test]
fn xval_side_set_2bit() {
    // nop with side-set 3 (2 bits)
    let reference = golden("xval_side_set_2bit");
    assert_eq!(
        sema_assemble("(list (pio/side 3 (pio/nop))) {:side-set-bits 2}"),
        reference
    );
}

#[test]
fn xval_side_set_with_delay() {
    // set pins 1, side-set 1, delay 3 (1 side-set bit, 4 delay bits)
    let reference = golden("xval_side_set_with_delay");
    assert_eq!(
        sema_assemble("(list (pio/side 1 (pio/delay 3 (pio/set :pins 1)))) {:side-set-bits 1}"),
        reference
    );
}
