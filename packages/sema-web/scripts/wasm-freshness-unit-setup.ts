/**
 * Vitest global setup: refuse to report on a binary of unknown vintage.
 *
 * A *stale* binary fails the run; an absent one does not, because the suites
 * that need the VM gate themselves on `semaWasmAvailable()` and skip. Telling a
 * JS-only contributor the runtime is broken when the real message is "run the
 * wasm build" is how a gate gets deleted.
 */
import { assertWasmFresh } from "./wasm-freshness.js";

export default function globalSetup(): void {
  assertWasmFresh({ requireBuilt: false });
}
