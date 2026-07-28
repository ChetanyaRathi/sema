/**
 * Props, children, and composition.
 *
 * Two halves, tested separately because they fail differently:
 *
 * - The **JS half** owns marshalling. Its failure mode is silent: a prop whose
 *   key kept its colon reads as nil inside the component with no error
 *   anywhere, so these tests assert on the exact object handed to the
 *   interpreter, not on rendered output.
 * - The **Sema half** (`COMPONENT_SEMA_PRELUDE`) owns the macros. Its failure
 *   mode is a thrown `SemaWeb.create()`. It is covered in
 *   `component-sema.test.ts`, against a real interpreter.
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

const { registerComponentBindings, disposeAllComponents, normalizeProps } = await import(
  "../src/component.js"
);

describe("normalizeProps", () => {
  it("strips the leading colon from keyword keys", () => {
    expect(normalizeProps({ ":items": [1], ":theme": "dark" })).toEqual({
      items: [1],
      theme: "dark",
    });
  });

  it("leaves plain keys alone", () => {
    expect(normalizeProps({ items: [1] })).toEqual({ items: [1] });
  });

  it("recurses into nested maps", () => {
    // A nested prop map hits the same problem one level down, where it is even
    // harder to spot.
    expect(normalizeProps({ ":user": { ":name": "ada", ":prefs": { ":theme": "dark" } } })).toEqual({
      user: { name: "ada", prefs: { theme: "dark" } },
    });
  });

  it("recurses through arrays", () => {
    expect(normalizeProps({ ":rows": [{ ":id": 1 }, { ":id": 2 }] })).toEqual({
      rows: [{ id: 1 }, { id: 2 }],
    });
  });

  it("passes primitives through untouched", () => {
    expect(normalizeProps("plain")).toBe("plain");
    expect(normalizeProps(42)).toBe(42);
    expect(normalizeProps(null)).toBeNull();
  });

  it("does not strip a colon that is not leading", () => {
    expect(normalizeProps({ "data:id": 1 })).toEqual({ "data:id": 1 });
  });

  it("preserves an empty map", () => {
    expect(normalizeProps({})).toEqual({});
  });
});

describe("mounting with props", () => {
  let interp: ReturnType<typeof createMockInterpreter>;
  let ctx: SemaWebContext;
  let received: any[][];

  beforeEach(() => {
    interp = createMockInterpreter();
    ctx = new SemaWebContext();
    document.body.innerHTML = '<div id="app"></div>';
    registerComponentBindings(interp, ctx);
    received = [];
    interp.registerFunction("my-view", (...args: any[]) => {
      received.push(args);
      return ["div", {}, "rendered"];
    });
  });

  afterEach(() => {
    disposeAllComponents(ctx);
    vi.restoreAllMocks();
  });

  const mount = (props?: unknown) =>
    interp.getFunction("component/mount!")!("#app", "my-view", props);

  it("calls a component with NO arguments when no props are given", () => {
    // Load-bearing: passing an argument to a zero-parameter Sema function is
    // an arity error, and every component predating props is zero-parameter.
    mount();
    expect(received).toEqual([[]]);
  });

  it("treats an explicit nil the same as omitted", () => {
    mount(null);
    expect(received).toEqual([[]]);
  });

  it("passes props as a single argument when given", () => {
    mount({ ":title": "Hello" });
    expect(received).toEqual([[{ title: "Hello" }]]);
  });

  it("normalizes keyword keys before handing them back to Sema", () => {
    mount({ ":items": [1, 2], ":nested": { ":deep": true } });
    expect(received[0][0]).toEqual({ items: [1, 2], nested: { deep: true } });
  });

  it("passes an empty map through as an empty map, not as absent", () => {
    mount({});
    expect(received).toEqual([[{}]]);
  });

  it("stores props on the mounted component", () => {
    mount({ ":a": 1 });
    expect(ctx.mountedComponents.get("#app")!.props).toEqual({ a: 1 });
  });

  it("records null props for an unparameterized mount", () => {
    mount();
    expect(ctx.mountedComponents.get("#app")!.props).toBeNull();
  });

  it("reuses the same props on a forced re-render", () => {
    mount({ ":title": "Hello" });
    received.length = 0;

    interp.getFunction("component/force-render!")!("#app");

    expect(received).toEqual([[{ title: "Hello" }]]);
  });

  it("replacing a mount swaps the props too", () => {
    mount({ ":title": "first" });
    mount({ ":title": "second" });

    expect(ctx.mountedComponents.get("#app")!.props).toEqual({ title: "second" });
  });

  describe("validation", () => {
    it("rejects a list", () => {
      expect(() => mount([1, 2, 3])).toThrow(/props must be a map, got list/);
    });

    it("rejects a string", () => {
      expect(() => mount("nope")).toThrow(/props must be a map, got string/);
    });

    it("rejects a number", () => {
      expect(() => mount(42)).toThrow(/props must be a map, got number/);
    });
  });

  describe("error context", () => {
    it("names the component when it has no props", () => {
      const contexts: string[] = [];
      ctx.onerror = (_e, c) => contexts.push(c);
      interp.registerFunction("bad-view", () => {
        throw new Error("boom");
      });

      interp.getFunction("component/mount!")!("#app", "bad-view");

      expect(contexts).toEqual(["component:bad-view"]);
    });

    it("names the prop keys when it has props", () => {
      const contexts: string[] = [];
      ctx.onerror = (_e, c) => contexts.push(c);
      interp.registerFunction("bad-view", () => {
        throw new Error("boom");
      });

      interp.getFunction("component/mount!")!("#app", "bad-view", { ":title": "x", ":count": 1 });

      expect(contexts).toEqual(["component:bad-view{title,count}"]);
    });

    it("does not leak prop VALUES into the error context", () => {
      // This string reaches whatever error reporter the app installed. Props
      // routinely hold user data and auth tokens.
      const contexts: string[] = [];
      ctx.onerror = (_e, c) => contexts.push(c);
      interp.registerFunction("bad-view", () => {
        throw new Error("boom");
      });

      interp.getFunction("component/mount!")!("#app", "bad-view", { ":token": "hunter2" });

      expect(contexts[0]).toContain("token");
      expect(contexts[0]).not.toContain("hunter2");
    });
  });
});

describe("__component/report-error", () => {
  let interp: ReturnType<typeof createMockInterpreter>;
  let ctx: SemaWebContext;

  beforeEach(() => {
    interp = createMockInterpreter();
    ctx = new SemaWebContext();
    registerComponentBindings(interp, ctx);
  });

  it("routes a child failure through onerror under the child's own name", () => {
    const seen: Array<{ message: string; context: string }> = [];
    ctx.onerror = (e, context) => seen.push({ message: e.message, context });

    interp.getFunction("__component/report-error")!("todo-row", "child blew up");

    expect(seen).toEqual([{ message: "child blew up", context: "component:todo-row" }]);
  });

  it("records the failure in the dev timeline", () => {
    ctx.diagnostics.enabled = true;
    ctx.onerror = () => {};

    interp.getFunction("__component/report-error")!("todo-row", "child blew up");

    expect(ctx.diagnostics.byKind("error")[0]).toMatchObject({
      context: "component:todo-row",
      detail: "child blew up",
    });
  });
});
