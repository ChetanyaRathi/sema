import { SemaWeb } from "../../../src/index.ts";
const errors: string[] = [];
(window as any).__semaErrors = errors;
try {
  // Dev mode on: render entries are the only honest way to count renders from
  // outside, since a Sema-side counter written by a render body would make the
  // render depend on the signal it writes.
  const web = await SemaWeb.init({
    dev: { limit: 1000 },
    onerror(error: Error, context: string) {
      errors.push(`${context}: ${error.message}`);
    },
  });
  (window as any).__semaWeb = web;
  (window as any).__semaRenders = (component: string) =>
    web.diagnostics.all().filter((e) => e.kind === "render" && e.context === `component:${component}`)
      .length;
} catch (e) {
  console.error("SemaWeb init failed:", e);
  (window as any).__semaInitError = String(e);
} finally {
  (window as any).__semaInitialized = true;
}
