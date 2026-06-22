//! Gap-3: with no provider installed, the Decision #16 detector reports "no real
//! provider", and an `Off`-mode embedded interpreter installs nothing. Own binary
//! (must run in a process where nothing has touched the global provider).

#![cfg(not(target_arch = "wasm32"))]

use sema::InterpreterBuilder;
use sema_otel::TelemetryMode;

#[test]
fn no_provider_is_detected_and_off_installs_nothing() {
    // Fresh process: the global default is the Noop provider.
    assert!(
        !sema_otel::host_global_is_real(),
        "no real provider should be detected by default"
    );

    // Off mode is a pure no-op and must not install anything.
    let _interp = InterpreterBuilder::new()
        .with_telemetry(TelemetryMode::Off)
        .build();
    assert!(
        !sema_otel::host_global_is_real(),
        "Off mode must never install a global provider"
    );
}
