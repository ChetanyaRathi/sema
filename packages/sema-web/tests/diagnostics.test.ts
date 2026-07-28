import { describe, it, expect, vi, beforeEach } from "vitest";
import { SemaWebContext, disposeContextResources, registerStream, unregisterStream } from "../src/context.js";
import {
  Diagnostics,
  resolveDevOptions,
  DEFAULT_DEV_LIMIT,
  DEFAULT_SLOW_RENDER_MS,
  MAX_DETAIL_CHARS,
  now,
  type DiagnosticEntry,
} from "../src/diagnostics.js";

function entry(over: Partial<DiagnosticEntry> = {}): DiagnosticEntry {
  return { kind: "error", at: 1, context: "test", ...over };
}

describe("Diagnostics", () => {
  describe("disabled by default", () => {
    it("records nothing and never builds the entry", () => {
      const diag = new Diagnostics();
      const build = vi.fn(() => entry());

      diag.record(build);

      expect(diag.all()).toEqual([]);
      // The builder must not run at all. Merely discarding the result would
      // still pay for the string interpolation on every render in production.
      expect(build).not.toHaveBeenCalled();
    });

    it("still answers queries rather than throwing", () => {
      const diag = new Diagnostics();
      expect(diag.all()).toEqual([]);
      expect(diag.byKind("error")).toEqual([]);
      expect(diag.slowRenders()).toEqual([]);
      expect(diag.dropped).toBe(0);
    });
  });

  describe("recording", () => {
    it("retains entries in insertion order", () => {
      const diag = new Diagnostics({ enabled: true });
      diag.record(() => entry({ context: "first" }));
      diag.record(() => entry({ context: "second" }));

      expect(diag.all().map((e) => e.context)).toEqual(["first", "second"]);
    });

    it("filters by kind", () => {
      const diag = new Diagnostics({ enabled: true });
      diag.record(() => entry({ kind: "error", context: "e" }));
      diag.record(() => entry({ kind: "render", context: "r" }));
      diag.record(() => entry({ kind: "route", context: "rt" }));

      expect(diag.byKind("render").map((e) => e.context)).toEqual(["r"]);
      expect(diag.byKind("stream")).toEqual([]);
    });

    it("all() returns a copy — mutating it cannot corrupt the ring", () => {
      const diag = new Diagnostics({ enabled: true });
      diag.record(() => entry({ context: "kept" }));

      const snapshot = diag.all() as DiagnosticEntry[];
      snapshot.push(entry({ context: "injected" }));
      snapshot.length = 0;

      expect(diag.all().map((e) => e.context)).toEqual(["kept"]);
    });

    it("a throwing builder is swallowed and does not break the caller", () => {
      const diag = new Diagnostics({ enabled: true });

      expect(() =>
        diag.record(() => {
          throw new Error("detail getter blew up");
        }),
      ).not.toThrow();
      expect(diag.all()).toEqual([]);
    });
  });

  describe("bounding", () => {
    it("evicts oldest first and counts the drops", () => {
      const diag = new Diagnostics({ enabled: true, limit: 3 });
      for (let i = 0; i < 5; i++) diag.record(() => entry({ context: `e${i}` }));

      expect(diag.all().map((e) => e.context)).toEqual(["e2", "e3", "e4"]);
      expect(diag.dropped).toBe(2);
    });

    it("stays bounded under a render-loop-sized burst", () => {
      const diag = new Diagnostics({ enabled: true, limit: 10 });
      for (let i = 0; i < 10_000; i++) diag.record(() => entry({ context: `e${i}` }));

      expect(diag.all()).toHaveLength(10);
      expect(diag.dropped).toBe(9_990);
      expect(diag.all()[9].context).toBe("e9999");
    });

    it("treats a non-positive limit as the default instead of dropping everything", () => {
      // A limit of 0 would make the ring silently report an empty timeline,
      // which looks identical to "nothing happened".
      expect(new Diagnostics({ enabled: true, limit: 0 }).limit).toBe(DEFAULT_DEV_LIMIT);
      expect(new Diagnostics({ enabled: true, limit: -5 }).limit).toBe(DEFAULT_DEV_LIMIT);
    });

    it("bounds one entry's bytes, not only the entry count", () => {
      // The ring's own promise is that leaving dev mode on costs nothing. A
      // route diagnostic holds the raw URL, so a 200 KB query value produced a
      // single 200,010-character entry — a hundred of those is 20 MB retained.
      const diag = new Diagnostics({ enabled: true });
      const url = `/search?q=${"x".repeat(200_000)}`;
      diag.record(() => entry({ kind: "route", detail: url }));

      const [recorded] = diag.all();
      expect(recorded.detail!.length).toBeLessThan(MAX_DETAIL_CHARS + 32);
      // Truncated, and it says so — a silently cut detail reads as the whole
      // story and sends you looking for a bug in the wrong place.
      expect(recorded.detail).toContain("/search?q=xxx");
      expect(recorded.detail).toContain("(+");
    });

    it("leaves an ordinary detail exactly as recorded", () => {
      const diag = new Diagnostics({ enabled: true });
      const message = "resource: response was not valid JSON";
      diag.record(() => entry({ detail: message }));

      expect(diag.all()[0].detail).toBe(message);
    });

    it("hands subscribers the same bounded detail the ring keeps", () => {
      const diag = new Diagnostics({ enabled: true });
      const seen: DiagnosticEntry[] = [];
      diag.subscribe((e) => seen.push(e));

      diag.record(() => entry({ detail: "y".repeat(5_000) }));

      expect(seen[0].detail).toBe(diag.all()[0].detail);
    });

    it("clear() empties the ring but preserves the drop count", () => {
      const diag = new Diagnostics({ enabled: true, limit: 2 });
      for (let i = 0; i < 5; i++) diag.record(() => entry());

      diag.clear();

      expect(diag.all()).toEqual([]);
      expect(diag.dropped).toBe(3);
    });
  });

  describe("slow renders", () => {
    it("reports only render entries at or over the threshold", () => {
      const diag = new Diagnostics({ enabled: true, slowRenderMs: 10 });
      diag.record(() => entry({ kind: "render", context: "fast", durationMs: 9.9 }));
      diag.record(() => entry({ kind: "render", context: "exactly", durationMs: 10 }));
      diag.record(() => entry({ kind: "render", context: "slow", durationMs: 40 }));
      // A non-render entry with a duration must not be counted as a slow render.
      diag.record(() => entry({ kind: "stream", context: "stream", durationMs: 999 }));

      expect(diag.slowRenders().map((e) => e.context)).toEqual(["exactly", "slow"]);
    });

    it("treats a render with no recorded duration as fast, not slow", () => {
      const diag = new Diagnostics({ enabled: true, slowRenderMs: 1 });
      diag.record(() => entry({ kind: "render", context: "unmeasured" }));

      expect(diag.slowRenders()).toEqual([]);
    });
  });

  describe("subscribers", () => {
    it("receives entries as they are recorded, without replaying history", () => {
      const diag = new Diagnostics({ enabled: true });
      diag.record(() => entry({ context: "before" }));

      const seen: string[] = [];
      diag.subscribe((e) => seen.push(e.context));
      diag.record(() => entry({ context: "after" }));

      expect(seen).toEqual(["after"]);
    });

    it("unsubscribe stops delivery", () => {
      const diag = new Diagnostics({ enabled: true });
      const seen: string[] = [];
      const off = diag.subscribe((e) => seen.push(e.context));

      diag.record(() => entry({ context: "one" }));
      off();
      diag.record(() => entry({ context: "two" }));

      expect(seen).toEqual(["one"]);
    });

    it("a throwing subscriber does not block siblings or the caller", () => {
      const diag = new Diagnostics({ enabled: true });
      const seen: string[] = [];
      diag.subscribe(() => {
        throw new Error("bad subscriber");
      });
      diag.subscribe((e) => seen.push(e.context));

      expect(() => diag.record(() => entry({ context: "delivered" }))).not.toThrow();
      expect(seen).toEqual(["delivered"]);
      expect(diag.all()).toHaveLength(1);
    });

    it("clearListeners drops every subscriber", () => {
      const diag = new Diagnostics({ enabled: true });
      const seen: string[] = [];
      diag.subscribe((e) => seen.push(e.context));

      diag.clearListeners();
      diag.record(() => entry({ context: "ignored" }));

      expect(seen).toEqual([]);
    });
  });

  describe("now()", () => {
    it("returns a monotonically non-decreasing number", () => {
      const a = now();
      const b = now();
      expect(typeof a).toBe("number");
      expect(b).toBeGreaterThanOrEqual(a);
    });
  });
});

describe("resolveDevOptions", () => {
  it("is fully off when dev is absent or false", () => {
    for (const dev of [undefined, false] as const) {
      const resolved = resolveDevOptions(dev);
      expect(resolved.enabled).toBe(false);
      expect(resolved.overlay).toBe(false);
      expect(resolved.limit).toBe(DEFAULT_DEV_LIMIT);
      expect(resolved.slowRenderMs).toBe(DEFAULT_SLOW_RENDER_MS);
    }
  });

  it("dev: true enables recording but not the overlay", () => {
    const resolved = resolveDevOptions(true);
    expect(resolved.enabled).toBe(true);
    // The overlay is opt-in even in dev mode — it paints over the app.
    expect(resolved.overlay).toBe(false);
  });

  it("honours explicit limit, threshold, and overlay", () => {
    const resolved = resolveDevOptions({ limit: 7, slowRenderMs: 3, overlay: true });
    expect(resolved).toEqual({ enabled: true, limit: 7, overlay: true, slowRenderMs: 3 });
  });

  it("falls back to the default for a nonsense limit", () => {
    expect(resolveDevOptions({ limit: 0 }).limit).toBe(DEFAULT_DEV_LIMIT);
    expect(resolveDevOptions({ limit: -1 }).limit).toBe(DEFAULT_DEV_LIMIT);
  });

  it("an empty object still means enabled", () => {
    expect(resolveDevOptions({}).enabled).toBe(true);
  });
});

describe("SemaWebContext error hook", () => {
  let ctx: SemaWebContext;

  beforeEach(() => {
    ctx = new SemaWebContext();
  });

  it("default handler logs to console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("boom");

    ctx.onerror(error, "test-context");

    expect(spy).toHaveBeenCalledWith("[sema-web] Error in test-context:", error);
    spy.mockRestore();
  });

  it("an installed handler replaces the default", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = vi.fn();
    ctx.onerror = handler;

    const error = new Error("boom");
    ctx.onerror(error, "ctx");

    expect(handler).toHaveBeenCalledWith(error, "ctx");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("records into diagnostics even when the app replaces the handler", () => {
    // The recording layer lives in the getter, so it cannot be assigned away —
    // this is the property that makes the timeline trustworthy in an app that
    // installs its own reporter.
    ctx.diagnostics.enabled = true;
    ctx.onerror = vi.fn();

    ctx.onerror(new Error("captured anyway"), "component:x");

    expect(ctx.diagnostics.byKind("error")).toEqual([
      expect.objectContaining({ kind: "error", context: "component:x", detail: "captured anyway" }),
    ]);
  });

  it("records errors raised as non-Error values", () => {
    ctx.diagnostics.enabled = true;
    ctx.onerror = vi.fn();

    ctx.onerror("just a string" as unknown as Error, "weird");

    expect(ctx.diagnostics.byKind("error")[0].detail).toBe("just a string");
  });

  it("records nothing when dev mode is off", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    ctx.onerror(new Error("boom"), "ctx");

    expect(ctx.diagnostics.all()).toEqual([]);
    spy.mockRestore();
  });
});

describe("stream lifecycle recording", () => {
  let ctx: SemaWebContext;

  beforeEach(() => {
    ctx = new SemaWebContext();
    ctx.diagnostics.enabled = true;
  });

  it("records open and close as a matched pair", () => {
    registerStream(ctx, 4, { kind: "event-source", close: () => {} });
    unregisterStream(ctx, 4);

    expect(ctx.diagnostics.byKind("stream").map((e) => `${e.context} ${e.detail}`)).toEqual([
      "event-source:4 open",
      "event-source:4 close",
    ]);
  });

  it("records nothing for closing a stream that was never registered", () => {
    // An unmatched close would read as a double-close bug in the timeline.
    unregisterStream(ctx, 99);
    expect(ctx.diagnostics.byKind("stream")).toEqual([]);
  });

  it("closing twice records exactly one close", () => {
    registerStream(ctx, 1, { kind: "llm-stream", close: () => {} });
    unregisterStream(ctx, 1);
    unregisterStream(ctx, 1);

    expect(ctx.diagnostics.byKind("stream").filter((e) => e.detail === "close")).toHaveLength(1);
  });

  it("actually mutates ctx.streams, not just the timeline", () => {
    registerStream(ctx, 2, { kind: "event-source", close: () => {} });
    expect(ctx.streams.has(2)).toBe(true);
    unregisterStream(ctx, 2);
    expect(ctx.streams.has(2)).toBe(false);
  });
});

describe("disposeContextResources and diagnostics", () => {
  it("drops subscribers but keeps the recorded timeline readable", () => {
    const ctx = new SemaWebContext();
    ctx.diagnostics.enabled = true;
    const seen: DiagnosticEntry[] = [];
    ctx.diagnostics.subscribe((e) => seen.push(e));
    ctx.diagnostics.record(() => entry({ context: "before-dispose" }));

    disposeContextResources(ctx);
    ctx.diagnostics.record(() => entry({ context: "after-dispose" }));

    // Post-teardown reads are exactly when you want the timeline.
    expect(ctx.diagnostics.all().map((e) => e.context)).toEqual([
      "before-dispose",
      "after-dispose",
    ]);
    // But the overlay's subscription must be gone, or dispose() leaks the DOM
    // nodes it closes over.
    expect(seen.map((e) => e.context)).toEqual(["before-dispose"]);
  });
});
