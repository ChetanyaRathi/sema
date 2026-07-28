// The only fixture that reaches the runtime the way a consumer does: by
// package name, through the manifest's `exports` map, into the built
// `dist/index.js`. Every other fixture imports `../../../src/index.ts`, so the
// published artifact's sole validation would otherwise be that tsup exited 0 —
// which is exactly how an unreachable `exports` entry shipped once already.
import { SemaWeb } from "@sema-lang/sema-web";

const errors: string[] = [];
(window as any).__semaErrors = errors;

try {
  const web = await SemaWeb.init({
    onerror(error: Error, context: string) {
      errors.push(`${context}: ${error.message}`);
    },
  });
  (window as any).__semaWeb = web;
} catch (e) {
  console.error("SemaWeb init failed:", e);
  (window as any).__semaInitError = String(e);
} finally {
  (window as any).__semaInitialized = true;
}
