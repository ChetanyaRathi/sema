/**
 * Two owners, one callback handle.
 *
 * Regression coverage for finding 9 of
 * `docs/bugs/2026-07-28-sema-web-adversarial-findings.md`: two components that
 * registered the *same* named `on-unmount` function shared one handle, so the
 * first teardown released it and the second component's teardown never ran —
 * reported only as `Unknown callback handle: 1`, long after the fact.
 *
 * The boundary is modelled rather than mocked away, because the defect only
 * exists in its exact double-dedupe shape:
 *
 * - `allocate_callback_handle` (crates/sema-wasm/src/lib.rs) returns ONE handle
 *   per identical Sema value, keyed on the value's raw bits, and
 *   `release_callback` removes it with no refcount;
 * - `_wrapCallbackHandle` (packages/sema/src/index.ts) memoizes ONE JS wrapper
 *   per handle, so both owners hold the same object.
 *
 * {@link SemaBridge} below reproduces exactly that and nothing else: a released
 * handle makes its wrapper throw the bridge's own message, which is what the
 * browser reported. `tests/component-lifecycle-sema.test.ts` runs the same
 * scenario through the real WASM interpreter.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SemaWebContext } from "../src/context.js";
import { registerComponentBindings, disposeAllComponents } from "../src/component.js";
import { registerReactiveBindings } from "../src/reactive.js";
import type { SemaCallback } from "../src/callbacks.js";
import { createMockInterpreter } from "./helpers.js";

/** A Sema function value, as far as the boundary is concerned. */
type SemaValue = (...args: any[]) => any;

/** The wasm callback table plus the JS wrapper cache, and nothing else. */
class SemaBridge {
  private nextId = 1;
  private byId = new Map<number, SemaValue>();
  private idByValue = new Map<SemaValue, number>();
  private wrappers = new Map<number, SemaCallback>();

  /** Hand a Sema value to JS the way the bridge does, deduping on the value. */
  marshal(value: SemaValue): SemaCallback {
    let id = this.idByValue.get(value);
    if (id == null) {
      id = this.nextId++;
      this.byId.set(id, value);
      this.idByValue.set(value, id);
    }
    const cached = this.wrappers.get(id);
    if (cached) return cached;

    const handle = id;
    const wrapper = ((...args: any[]) => {
      const fn = this.byId.get(handle);
      if (!fn) throw new Error(`Unknown callback handle: ${handle}`);
      return fn(...args);
    }) as SemaCallback;
    wrapper.__semaCallbackHandle = handle;
    wrapper.__semaRelease = () => {
      const fn = this.byId.get(handle);
      this.wrappers.delete(handle);
      this.byId.delete(handle);
      if (fn) this.idByValue.delete(fn);
    };
    this.wrappers.set(id, wrapper);
    return wrapper;
  }

  /** Handles still allocated — a leak check with the bridge's own bookkeeping. */
  liveHandles(): number {
    return this.byId.size;
  }
}

describe("a Sema callback shared by two owners", () => {
  let interp: ReturnType<typeof createMockInterpreter>;
  let ctx: SemaWebContext;
  let bridge: SemaBridge;
  let errors: Array<{ message: string; context: string }>;

  beforeEach(() => {
    interp = createMockInterpreter();
    ctx = new SemaWebContext();
    bridge = new SemaBridge();
    errors = [];
    document.body.innerHTML = '<div id="a"></div><div id="b"></div>';
    registerComponentBindings(interp, ctx);
    registerReactiveBindings(interp, ctx);
    ctx.onerror = (e, context) => errors.push({ message: e.message, context });
  });

  afterEach(() => {
    disposeAllComponents(ctx);
    vi.useRealTimers();
  });

  const mountAt = (selector: string, name: string, view: () => any) => {
    interp.registerFunction(name, view);
    interp.getFunction("component/mount!")!(selector, name, undefined);
  };
  const unmountAt = (selector: string) => interp.getFunction("component/unmount!")!(selector);
  const addEffect = (deps: unknown, fn: unknown) =>
    interp.getFunction("__component/effect")!(deps, fn);
  const addUnmount = (fn: unknown) => interp.getFunction("__component/on-unmount")!(fn);

  it("runs both components' on-unmount hooks, in either teardown order", () => {
    const teardown = vi.fn();
    // One Sema value, two mount points — `(define (shared-teardown) …)` used by
    // both, which is the natural way to reuse a teardown.
    const view = () => {
      addUnmount(bridge.marshal(teardown));
      return [":div", {}, "leaf"];
    };
    mountAt("#a", "leaf-a", view);
    mountAt("#b", "leaf-b", view);

    unmountAt("#a");
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);

    unmountAt("#b");
    expect(teardown).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([]);
  });

  it("releases the shared handle once both owners are gone", () => {
    const teardown = vi.fn();
    const view = () => {
      addUnmount(bridge.marshal(teardown));
      return [":div", {}, "leaf"];
    };
    mountAt("#a", "leaf-a", view);
    mountAt("#b", "leaf-b", view);
    expect(bridge.liveHandles()).toBe(1);

    unmountAt("#a");
    // Still live: the second component is holding it.
    expect(bridge.liveHandles()).toBe(1);

    unmountAt("#b");
    expect(bridge.liveHandles()).toBe(0);
  });

  it("runs both effect cleanups when two components return the same one", () => {
    const cleanup = vi.fn();
    const view = () => {
      addEffect([], bridge.marshal(() => bridge.marshal(cleanup)));
      return [":div", {}, "leaf"];
    };
    mountAt("#a", "leaf-a", view);
    mountAt("#b", "leaf-b", view);

    unmountAt("#a");
    unmountAt("#b");

    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([]);
    expect(bridge.liveHandles()).toBe(0);
  });

  it("keeps one interval alive when its twin over the same function is cleared", () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const first = interp.getFunction("js/set-interval")!(bridge.marshal(tick), 100) as number;
    interp.getFunction("js/set-interval")!(bridge.marshal(tick), 100);

    interp.getFunction("js/clear-interval")!(first);
    vi.advanceTimersByTime(250);

    // The surviving interval used to fail with "Unknown callback handle".
    expect(tick).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([]);
  });

  it("still releases a singly owned callback exactly once", () => {
    const teardown = vi.fn();
    mountAt("#a", "solo", () => {
      addUnmount(bridge.marshal(teardown));
      return [":div", {}, "solo"];
    });
    expect(bridge.liveHandles()).toBe(1);

    unmountAt("#a");

    expect(teardown).toHaveBeenCalledTimes(1);
    expect(bridge.liveHandles()).toBe(0);
  });

  it("does not strand a handle when a re-render re-registers the same function", () => {
    const teardown = vi.fn();
    mountAt("#a", "solo", () => {
      addUnmount(bridge.marshal(teardown));
      return [":div", {}, "solo"];
    });

    interp.getFunction("component/force-render!")!("#a");
    interp.getFunction("component/force-render!")!("#a");
    unmountAt("#a");

    expect(teardown).toHaveBeenCalledTimes(1);
    expect(bridge.liveHandles()).toBe(0);
  });
});
