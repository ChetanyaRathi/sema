/**
 * Playwright global setup: refuse to report on a binary of unknown vintage.
 *
 * Its own file because both harnesses resolve a global-setup module by its
 * default export, so one module cannot carry both policies. Every browser
 * fixture boots the real VM, so an absent binary is a failure here.
 */
import { assertWasmFresh } from "./wasm-freshness.js";

export default function globalSetup(): void {
  assertWasmFresh({ requireBuilt: true });
}
