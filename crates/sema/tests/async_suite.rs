//! Grouped integration-test harness (one linked binary instead of one per file;
//! see docs/build-time-report.md). Member files live in tests/suites/. Files that
//! need process-global isolation (sema_otel::testing::install, env-var toggles)
//! stay as their own top-level test files — do NOT move them in here.

#[macro_use] // make common's macros (eval_tests! et al) visible in the member modules below
mod common;

#[path = "suites/archive_pdf_patch_async_test.rs"]
mod archive_pdf_patch_async_test;
#[path = "suites/async_awaitio_test.rs"]
mod async_awaitio_test;
#[path = "suites/dap_async_breakpoint_test.rs"]
mod dap_async_breakpoint_test;
#[path = "suites/db_async_test.rs"]
mod db_async_test;
#[path = "suites/file_async_test.rs"]
mod file_async_test;
#[path = "suites/io_pool_identity_test.rs"]
mod io_pool_identity_test;
#[path = "suites/kv_async_test.rs"]
mod kv_async_test;
#[path = "suites/pool_map_test.rs"]
mod pool_map_test;
#[path = "suites/proc_pty_async_test.rs"]
mod proc_pty_async_test;
#[path = "suites/shell_concurrent_test.rs"]
mod shell_concurrent_test;
#[path = "suites/stream_async_test.rs"]
mod stream_async_test;
#[path = "suites/stream_file_async_test.rs"]
mod stream_file_async_test;
#[path = "suites/true_cancel_test.rs"]
mod true_cancel_test;
#[path = "suites/wasm_async_debug_test.rs"]
mod wasm_async_debug_test;
