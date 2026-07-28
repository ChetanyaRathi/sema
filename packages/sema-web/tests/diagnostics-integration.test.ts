/**
 * End-to-end coverage for the dev-mode timeline: that the *runtime* actually
 * feeds it.
 *
 * `diagnostics.test.ts` proves the recorder behaves. This file proves the
 * instrumentation exists at each source — component renders, route changes,
 * script loads, stream lifecycle — because a recorder nothing calls is a
 * recorder that reports an empty timeline and looks like a healthy app.
 *
 * Each block also asserts the *disabled* case, which is the property that
 * keeps dev mode honest: instrumentation must cost nothing in production.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SemaWebContext } from "../src/context.js";
import { createMockInterpreter } from "./helpers.js";

vi.mock("morphdom", () => ({
  default: vi.fn((fromNode: Element, toNode: Element, opts?: any) => {
    if (opts?.childrenOnly) fromNode.innerHTML = toNode.innerHTML;
    return fromNode;
  }),
}));

vi.mock("@preact/signals-core", () => ({
  signal: (val: any) => ({ value: val, peek: () => val }),
  computed: (fn: () => any) => ({
    get value() {
      return fn();
    },
  }),
  effect: (fn: () => void) => {
    fn();
    return () => {};
  },
  batch: (fn: () => void) => fn(),
  untracked: <T>(fn: () => T): T => fn(),
}));

const { registerComponentBindings, disposeAllComponents } = await import("../src/component.js");
const { registerRouterBindings } = await import("../src/router.js");
const { loadScripts } = await import("../src/loader.js");

describe("component render diagnostics", () => {
  let interp: ReturnType<typeof createMockInterpreter>;
  let ctx: SemaWebContext;

  beforeEach(() => {
    interp = createMockInterpreter();
    ctx = new SemaWebContext();
    document.body.innerHTML = '<div id="app"></div>';
    registerComponentBindings(interp, ctx);
  });

  afterEach(() => {
    disposeAllComponents(ctx);
    vi.restoreAllMocks();
  });

  function mountView() {
    interp.registerFunction("my-view", () => ["div", {}, "hello"]);
    interp.getFunction("component/mount!")!("#app", "my-view");
  }

  it("records a render entry naming the component", () => {
    ctx.diagnostics.enabled = true;

    mountView();

    const renders = ctx.diagnostics.byKind("render");
    expect(renders.length).toBeGreaterThanOrEqual(1);
    expect(renders[0].context).toBe("component:my-view");
  });

  it("records a measured duration", () => {
    ctx.diagnostics.enabled = true;

    mountView();

    const [render] = ctx.diagnostics.byKind("render");
    expect(typeof render.durationMs).toBe("number");
    expect(render.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("surfaces an over-budget render through slowRenders()", () => {
    ctx.diagnostics.enabled = true;
    // Threshold of 0 makes any real render qualify, so this asserts the wiring
    // (duration reaches slowRenders) without depending on machine speed.
    ctx.diagnostics.slowRenderMs = 0;

    mountView();

    expect(ctx.diagnostics.slowRenders().map((e) => e.context)).toContain("component:my-view");
  });

  it("records nothing when dev mode is off", () => {
    mountView();
    expect(ctx.diagnostics.all()).toEqual([]);
  });

  it("a render that throws records the error, not a render", () => {
    ctx.diagnostics.enabled = true;
    ctx.onerror = vi.fn();
    interp.registerFunction("bad-view", () => {
      throw new Error("render exploded");
    });

    interp.getFunction("component/mount!")!("#app", "bad-view");

    expect(ctx.diagnostics.byKind("error")).toEqual([
      expect.objectContaining({ context: "component:bad-view", detail: "render exploded" }),
    ]);
    expect(ctx.diagnostics.byKind("render")).toEqual([]);
  });
});

describe("router diagnostics", () => {
  let interp: ReturnType<typeof createMockInterpreter>;
  let ctx: SemaWebContext;

  beforeEach(() => {
    interp = createMockInterpreter();
    ctx = new SemaWebContext();
    window.location.hash = "";
    registerRouterBindings(interp, ctx);
  });

  it("records the matched handler on init", () => {
    ctx.diagnostics.enabled = true;
    window.location.hash = "#/todos";

    interp.getFunction("router/init!")!({ "/todos": "todo-page" });

    expect(ctx.diagnostics.byKind("route").at(-1)).toMatchObject({
      context: "route",
      detail: "/todos -> todo-page",
    });
  });

  it("records an unmatched path explicitly rather than leaving it blank", () => {
    ctx.diagnostics.enabled = true;
    window.location.hash = "#/nowhere";

    interp.getFunction("router/init!")!({ "/todos": "todo-page" });

    expect(ctx.diagnostics.byKind("route").at(-1)!.detail).toBe("/nowhere -> (no match)");
  });

  it("records each navigation", () => {
    ctx.diagnostics.enabled = true;
    interp.getFunction("router/init!")!({ "/a": "a-page", "/b": "b-page" });
    const before = ctx.diagnostics.byKind("route").length;

    interp.getFunction("router/replace!")!("/b");

    const after = ctx.diagnostics.byKind("route");
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)!.detail).toBe("/b -> b-page");
  });

  it("records nothing when dev mode is off", () => {
    interp.getFunction("router/init!")!({ "/a": "a-page" });
    expect(ctx.diagnostics.all()).toEqual([]);
  });
});

describe("loader diagnostics", () => {
  let ctx: SemaWebContext;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ctx = new SemaWebContext();
    ctx.diagnostics.enabled = true;
    document.body.innerHTML = "";
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  function addInline(code: string) {
    const el = document.createElement("script");
    el.setAttribute("type", "text/sema");
    el.textContent = code;
    document.body.appendChild(el);
  }

  it("numbers inline scripts so a failure names which one", async () => {
    addInline("(one)");
    addInline("(two)");
    addInline("(three)");
    const evalStr = vi
      .fn()
      .mockReturnValueOnce({ value: "1", output: [], error: null })
      .mockReturnValueOnce({ value: null, output: [], error: "bad form" })
      .mockReturnValueOnce({ value: "3", output: [], error: null });

    await loadScripts({ evalStr }, undefined, ctx);

    const failure = ctx.diagnostics.byKind("script").find((e) => e.detail === "bad form");
    expect(failure?.context).toBe("inline-script:1");
    // The console message carries the same label — "Error in inline script"
    // is useless on a page with three of them.
    expect(errorSpy).toHaveBeenCalledWith("[sema-web] Error in inline-script:1: bad form");
  });

  it("labels external scripts by src", async () => {
    const el = document.createElement("script");
    el.setAttribute("type", "text/sema");
    el.setAttribute("src", "/app.sema");
    document.body.appendChild(el);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, text: async () => "(hello)" }),
    );

    await loadScripts(
      { evalStr: () => ({ value: null, output: [], error: "kaboom" }) },
      undefined,
      ctx,
    );

    expect(ctx.diagnostics.byKind("script").at(-1)).toMatchObject({
      context: "script:/app.sema",
      detail: "kaboom",
    });
    vi.unstubAllGlobals();
  });

  it("records a successful evaluation, not only failures", async () => {
    addInline("(ok)");

    await loadScripts({ evalStr: () => ({ value: "1", output: [], error: null }) }, undefined, ctx);

    expect(ctx.diagnostics.byKind("script")).toEqual([
      expect.objectContaining({ context: "inline-script:0", detail: "evaluated" }),
    ]);
  });

  it("records a fetch failure against the failing URL", async () => {
    const el = document.createElement("script");
    el.setAttribute("type", "text/sema");
    el.setAttribute("src", "/missing.sema");
    document.body.appendChild(el);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" }),
    );

    await loadScripts({ evalStr: vi.fn() }, undefined, ctx);

    expect(ctx.diagnostics.byKind("script").at(-1)).toMatchObject({
      context: "script:/missing.sema",
      detail: "Failed to fetch /missing.sema: 404 Not Found",
    });
    vi.unstubAllGlobals();
  });

  it("an external script does not consume an inline index", async () => {
    // Inline numbering must count inline scripts only; interleaving an
    // external one must not shift the numbers a developer sees.
    const ext = document.createElement("script");
    ext.setAttribute("type", "text/sema");
    ext.setAttribute("src", "/a.sema");
    document.body.appendChild(ext);
    addInline("(inline-zero)");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => "(x)" }));

    await loadScripts(
      { evalStr: () => ({ value: null, output: [], error: null }) },
      undefined,
      ctx,
    );

    const contexts = ctx.diagnostics.byKind("script").map((e) => e.context);
    expect(contexts).toEqual(["script:/a.sema", "inline-script:0"]);
    vi.unstubAllGlobals();
  });

  it("works with no reporter at all", async () => {
    // `loadScripts` is a public export; calling it standalone must not require
    // a context.
    addInline("(ok)");
    await expect(
      loadScripts({ evalStr: () => ({ value: "1", output: [], error: null }) }),
    ).resolves.toHaveLength(1);
  });

  it("records nothing when dev mode is off", async () => {
    ctx.diagnostics.enabled = false;
    addInline("(ok)");

    await loadScripts({ evalStr: () => ({ value: "1", output: [], error: null }) }, undefined, ctx);

    expect(ctx.diagnostics.all()).toEqual([]);
  });
});
