/**
 * On-page dev overlay for Sema Web.
 *
 * A small fixed-position panel that tails `ctx.diagnostics` — errors, renders,
 * route changes, stream lifecycle, script loads — so you can see what the
 * runtime is doing without opening the console or wiring up a reporter.
 *
 * This module is only ever reached through a dynamic `import()` guarded by
 * `dev: { overlay: true }`, so it is a separate chunk that a production bundle
 * never pulls in. Keep it dependency-free for that reason: importing anything
 * shared from here would drag that dependency back into the main graph.
 *
 * @module
 */

import type { SemaWebContext } from "./context.js";
import type { DiagnosticEntry, DiagnosticKind } from "./diagnostics.js";

/** How many rows the overlay shows. Independent of the ring's own limit. */
const VISIBLE_ROWS = 30;

const KIND_COLORS: Record<DiagnosticKind, string> = {
  error: "#ff6b6b",
  render: "#74c0fc",
  route: "#ffd43b",
  stream: "#63e6be",
  script: "#b197fc",
};

function formatEntry(entry: DiagnosticEntry): string {
  const duration =
    typeof entry.durationMs === "number" ? ` ${entry.durationMs.toFixed(1)}ms` : "";
  const detail = entry.detail ? ` — ${entry.detail}` : "";
  return `${entry.context}${duration}${detail}`;
}

/**
 * Mount the dev overlay and start tailing diagnostics.
 *
 * Returns a disposer that removes the panel and unsubscribes. Safe to call in
 * a non-DOM environment: it becomes a no-op rather than throwing, so
 * server-side rendering or a jsdom-less test does not need to special-case it.
 */
export function mountDevOverlay(ctx: SemaWebContext): () => void {
  if (typeof document === "undefined" || !document.body) {
    return () => {};
  }

  const panel = document.createElement("div");
  panel.setAttribute("data-sema-dev-overlay", "");
  panel.style.cssText = [
    "position:fixed",
    "right:8px",
    "bottom:8px",
    "z-index:2147483647",
    "max-width:min(520px, 90vw)",
    "max-height:40vh",
    "overflow:auto",
    "background:rgba(17,17,17,0.92)",
    "color:#e9ecef",
    "font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace",
    "padding:8px 10px",
    "border-radius:6px",
    "box-shadow:0 4px 16px rgba(0,0,0,0.4)",
    // The overlay is a read-only tail; letting it swallow clicks would make it
    // an invisible hit-target over the app it is supposed to be observing.
    "pointer-events:none",
    "white-space:pre-wrap",
  ].join(";");
  // Set separately as well: jsdom's `cssText` parser drops `pointer-events`,
  // so relying on the shorthand alone makes this untestable (and would fail
  // silently in any other engine that skips a property it doesn't know).
  panel.style.pointerEvents = "none";

  const header = document.createElement("div");
  header.setAttribute("data-sema-dev-header", "");
  header.style.cssText = "opacity:0.6;margin-bottom:4px";
  panel.appendChild(header);

  const list = document.createElement("div");
  list.setAttribute("data-sema-dev-rows", "");
  panel.appendChild(list);

  const render = () => {
    const entries = ctx.diagnostics.all();
    const shown = entries.slice(-VISIBLE_ROWS);
    const dropped = ctx.diagnostics.dropped;
    header.textContent =
      `sema-web dev — ${entries.length} event${entries.length === 1 ? "" : "s"}` +
      (dropped > 0 ? ` (+${dropped} dropped)` : "");

    list.textContent = "";
    for (const entry of shown) {
      const row = document.createElement("div");
      row.style.color = KIND_COLORS[entry.kind] ?? "#e9ecef";
      row.textContent = `${entry.kind}  ${formatEntry(entry)}`;
      list.appendChild(row);
    }
  };

  render();
  document.body.appendChild(panel);

  // Re-render on the next frame rather than per event: a component render loop
  // can emit hundreds of entries in one tick, and repainting the overlay for
  // each would make the overlay itself the performance problem it is reporting.
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    const run = () => {
      scheduled = false;
      render();
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(run);
    } else {
      setTimeout(run, 16);
    }
  };

  const unsubscribe = ctx.diagnostics.subscribe(schedule);

  return () => {
    unsubscribe();
    panel.remove();
  };
}
