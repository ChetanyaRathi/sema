import { SemaWeb } from "../../../src/index.ts";
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
