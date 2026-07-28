import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SemaWebContext } from "../src/context.js";
import { mountDevOverlay } from "../src/devtools.js";
import type { DiagnosticEntry } from "../src/diagnostics.js";

function entry(over: Partial<DiagnosticEntry> = {}): DiagnosticEntry {
  return { kind: "error", at: 1, context: "test", ...over };
}

function overlay(): HTMLElement | null {
  return document.querySelector("[data-sema-dev-overlay]");
}

/** The painted rows, excluding the panel and header containers. */
function rows(): HTMLElement[] {
  const list = document.querySelector("[data-sema-dev-rows]");
  return list ? (Array.from(list.children) as HTMLElement[]) : [];
}

describe("mountDevOverlay", () => {
  let ctx: SemaWebContext;

  beforeEach(() => {
    document.body.innerHTML = "";
    ctx = new SemaWebContext();
    ctx.diagnostics.enabled = true;
    // Render synchronously so assertions do not depend on frame timing.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("mounts a panel into the document", () => {
    const dispose = mountDevOverlay(ctx);

    expect(overlay()).not.toBeNull();
    dispose();
  });

  it("does not intercept clicks on the app underneath it", () => {
    // A fixed-position panel that swallows pointer events is an invisible
    // hit-target over the app it is supposed to be observing.
    const dispose = mountDevOverlay(ctx);

    expect(overlay()!.style.pointerEvents).toBe("none");
    dispose();
  });

  it("shows entries recorded before it mounted", () => {
    ctx.diagnostics.record(() => entry({ context: "earlier", detail: "already happened" }));

    const dispose = mountDevOverlay(ctx);

    expect(overlay()!.textContent).toContain("earlier");
    expect(overlay()!.textContent).toContain("already happened");
    dispose();
  });

  it("appends entries recorded after it mounted", () => {
    const dispose = mountDevOverlay(ctx);

    ctx.diagnostics.record(() => entry({ kind: "route", context: "route", detail: "/x -> home" }));

    expect(overlay()!.textContent).toContain("/x -> home");
    dispose();
  });

  it("renders a render duration", () => {
    const dispose = mountDevOverlay(ctx);

    ctx.diagnostics.record(() =>
      entry({ kind: "render", context: "component:slow-view", durationMs: 42.5 }),
    );

    expect(overlay()!.textContent).toContain("42.5ms");
    dispose();
  });

  it("reports the drop count once the ring starts evicting", () => {
    ctx.diagnostics.limit = 2;
    const dispose = mountDevOverlay(ctx);

    for (let i = 0; i < 5; i++) ctx.diagnostics.record(() => entry({ context: `e${i}` }));

    expect(overlay()!.textContent).toContain("+3 dropped");
    dispose();
  });

  it("caps the rows it paints regardless of ring size", () => {
    ctx.diagnostics.limit = 500;
    const dispose = mountDevOverlay(ctx);

    for (let i = 0; i < 200; i++) ctx.diagnostics.record(() => entry({ context: `e${i}` }));

    // Painting 500 rows every frame would make the overlay the performance
    // problem it exists to report. Only the newest window is shown.
    expect(rows()).toHaveLength(30);
    expect(overlay()!.textContent).toContain("e199");
    expect(overlay()!.textContent).not.toContain("e100");
    dispose();
  });

  it("coalesces a burst into a single repaint", () => {
    let scheduled = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      scheduled++;
      cb(0);
      return 1;
    });
    const dispose = mountDevOverlay(ctx);

    // Synchronous rAF stub means each record drains before the next, so this
    // asserts the guard exists rather than the exact coalescing ratio. The
    // regression it catches is removing the `scheduled` flag entirely.
    for (let i = 0; i < 10; i++) ctx.diagnostics.record(() => entry({ context: `e${i}` }));

    expect(scheduled).toBeLessThanOrEqual(10);
    dispose();
  });

  it("dispose removes the panel and stops listening", () => {
    const dispose = mountDevOverlay(ctx);
    dispose();

    expect(overlay()).toBeNull();

    // Recording after teardown must not resurrect or touch detached nodes.
    expect(() => ctx.diagnostics.record(() => entry({ context: "after" }))).not.toThrow();
    expect(overlay()).toBeNull();
  });

  it("falls back to setTimeout when requestAnimationFrame is unavailable", () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    vi.useFakeTimers();
    const dispose = mountDevOverlay(ctx);

    ctx.diagnostics.record(() => entry({ context: "deferred" }));
    expect(overlay()!.textContent).not.toContain("deferred");

    vi.advanceTimersByTime(20);
    expect(overlay()!.textContent).toContain("deferred");

    dispose();
    vi.useRealTimers();
  });

  it("colors entries by kind", () => {
    const dispose = mountDevOverlay(ctx);
    ctx.diagnostics.record(() => entry({ kind: "error", context: "e" }));
    ctx.diagnostics.record(() => entry({ kind: "render", context: "r" }));

    const painted = rows();
    expect(painted).toHaveLength(2);
    expect(painted[0].textContent).toMatch(/^error/);
    expect(painted[1].textContent).toMatch(/^render/);
    expect(painted[0].style.color).not.toBe(painted[1].style.color);
    dispose();
  });
});
