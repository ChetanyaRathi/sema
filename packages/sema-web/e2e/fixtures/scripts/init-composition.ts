import { SemaWeb } from "../../../src/index.ts";
try {
  // Dev mode on so the spec can assert on the diagnostics timeline —
  // duplicate-key detection is dev-gated, and render entries are how we prove
  // a reorder did not re-render the world.
  const web = await SemaWeb.init({ dev: { limit: 500 } });
  (window as any).__semaWeb = web;
  (window as any).__semaDiagnostics = () => web.diagnostics.all();
} catch (e) {
  console.error("SemaWeb init failed:", e);
  (window as any).__semaInitError = String(e);
} finally {
  (window as any).__semaInitialized = true;
}
