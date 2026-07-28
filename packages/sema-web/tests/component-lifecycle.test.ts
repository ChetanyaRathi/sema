/**
 * Component-scoped lifecycle: `(effect deps fn)` and `(on-unmount fn)`.
 *
 * Deliberately mocks **nothing**. Both the real `morphdom` and the real
 * `@preact/signals-core` are used, because the two properties that matter here
 * cannot be observed against a stub:
 *
 * - "the effect body runs after the DOM patch" is meaningless against the
 *   `innerHTML`-swap morphdom stub other suites install;
 * - "reading a signal inside an effect body does not subscribe the render to
 *   it" is a statement about signals-core's tracking, which a mock `effect`
 *   that just calls its argument does not have.
 *
 * The interpreter is still the shared mock — it is a function registry, not a
 * model of anything under test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SemaWebContext } from "../src/context.js";
import { registerComponentBindings, disposeAllComponents, depsEqual, lifecycleSlots } from "../src/component.js";
import { registerReactiveBindings } from "../src/reactive.js";
import type { SemaCallback } from "../src/callbacks.js";
import { createMockInterpreter } from "./helpers.js";

/**
 * A Sema callback as it actually arrives from WASM: a fresh JS wrapper object
 * every time the same Sema value crosses the boundary, carrying the
 * `__semaRelease` handle-release hook.
 */
function marshalled(impl: (...args: any[]) => any, release?: () => void): SemaCallback {
  const fn = ((...args: any[]) => impl(...args)) as SemaCallback;
  fn.__semaRelease = release ?? (() => {});
  return fn;
}

describe("component lifecycle", () => {
  let interp: ReturnType<typeof createMockInterpreter>;
  let ctx: SemaWebContext;
  let errors: Array<{ message: string; context: string }>;

  beforeEach(() => {
    interp = createMockInterpreter();
    ctx = new SemaWebContext();
    errors = [];
    document.body.innerHTML = '<div id="app"></div>';
    registerComponentBindings(interp, ctx);
    registerReactiveBindings(interp, ctx);
    ctx.onerror = (e, context) => errors.push({ message: e.message, context });
  });

  afterEach(() => {
    disposeAllComponents(ctx);
    vi.useRealTimers();
  });

  const mountView = (name: string, view: () => any, props?: unknown) => {
    interp.registerFunction(name, view);
    interp.getFunction("component/mount!")!("#app", name, props);
  };
  const unmount = () => interp.getFunction("component/unmount!")!("#app");
  const addEffect = (deps: unknown, fn: unknown) =>
    interp.getFunction("__component/effect")!(deps, fn);
  const addUnmount = (fn: unknown) => interp.getFunction("__component/on-unmount")!(fn);
  const createSignal = (v: unknown) => interp.getFunction("__state/create")!(v) as number;
  const readSignal = (id: number) => interp.getFunction("__state/deref")!(id);
  const writeSignal = (id: number, v: unknown) => interp.getFunction("__state/put!")!(id, v);
  const component = () => ctx.mountedComponents.get("#app")!;
  const appText = () => document.getElementById("app")!.textContent;

  // --- on-unmount ---------------------------------------------------------

  describe("on-unmount", () => {
    it("runs exactly once when the component is unmounted", () => {
      const hook = vi.fn();
      mountView("v", () => {
        addUnmount(marshalled(hook));
        return [":p", {}, "hi"];
      });

      expect(hook).not.toHaveBeenCalled();
      unmount();
      expect(hook).toHaveBeenCalledTimes(1);
    });

    it("does not run on a re-render", () => {
      const hook = vi.fn();
      const sid = createSignal(0);
      mountView("v", () => {
        addUnmount(marshalled(hook));
        return [":p", {}, String(readSignal(sid))];
      });

      writeSignal(sid, 1);
      writeSignal(sid, 2);
      expect(appText()).toBe("2");
      expect(hook).not.toHaveBeenCalled();

      unmount();
      expect(hook).toHaveBeenCalledTimes(1);
    });

    it("runs when the whole instance is disposed", () => {
      const hook = vi.fn();
      mountView("v", () => {
        addUnmount(marshalled(hook));
        return [":p", {}, "hi"];
      });

      disposeAllComponents(ctx);
      expect(hook).toHaveBeenCalledTimes(1);
    });

    it("runs hooks in reverse registration order", () => {
      const order: string[] = [];
      mountView("v", () => {
        addUnmount(marshalled(() => order.push("first")));
        addUnmount(marshalled(() => order.push("second")));
        return [":p", {}, "hi"];
      });

      unmount();
      expect(order).toEqual(["second", "first"]);
    });

    it("a throwing hook is reported, its sibling still runs, and teardown completes", () => {
      const sibling = vi.fn();
      mountView("v", () => {
        addUnmount(
          marshalled(() => {
            throw new Error("unmount boom");
          }),
        );
        addUnmount(marshalled(sibling));
        return [":p", {}, "hi"];
      });
      const instanceId = component().instanceId;

      expect(() => unmount()).not.toThrow();

      expect(errors).toContainEqual({ message: "unmount boom", context: "on-unmount:v#0" });
      expect(sibling).toHaveBeenCalledTimes(1);
      expect(ctx.mountedComponents.has("#app")).toBe(false);
      expect(ctx.mountedComponentsById.has(instanceId)).toBe(false);
      expect(document.getElementById("app")!.innerHTML).toBe("");
    });

    it("throws when called outside a component render", () => {
      expect(() => addUnmount(marshalled(() => {}))).toThrow(
        /outside of a component render context/,
      );
    });

    it("releases its callback exactly once", () => {
      const release = vi.fn();
      mountView("v", () => {
        addUnmount(marshalled(() => {}, release));
        return [":p", {}, "hi"];
      });

      unmount();
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  // --- effect -------------------------------------------------------------

  describe("effect", () => {
    it("runs the body after the DOM patch, not before it", () => {
      let seen: string | null = "<unset>";
      mountView("v", () => {
        addEffect(
          [],
          marshalled(() => {
            seen = appText();
            return null;
          }),
        );
        return [":p", {}, "painted"];
      });

      expect(seen).toBe("painted");
    });

    it("with an empty deps list runs once across re-renders", () => {
      const body = vi.fn();
      const sid = createSignal(0);
      mountView("v", () => {
        addEffect([], marshalled(body));
        return [":p", {}, String(readSignal(sid))];
      });

      writeSignal(sid, 1);
      writeSignal(sid, 2);

      expect(appText()).toBe("2");
      expect(body).toHaveBeenCalledTimes(1);
    });

    it("cleans up before re-running when deps change", () => {
      const order: string[] = [];
      const sid = createSignal(1);
      let run = 0;
      mountView("v", () => {
        const n = readSignal(sid) as number;
        addEffect(
          [n],
          marshalled(() => {
            const id = ++run;
            order.push(`body${id}`);
            return marshalled(() => order.push(`cleanup${id}`));
          }),
        );
        return [":p", {}, String(n)];
      });

      writeSignal(sid, 2);
      expect(order).toEqual(["body1", "cleanup1", "body2"]);
    });

    it("does not re-run when deps are unchanged", () => {
      const order: string[] = [];
      const sid = createSignal(0);
      mountView("v", () => {
        readSignal(sid);
        addEffect(
          [7],
          marshalled(() => {
            order.push("body");
            return marshalled(() => order.push("cleanup"));
          }),
        );
        return [":p", {}, "x"];
      });

      writeSignal(sid, 1);
      writeSignal(sid, 2);
      expect(order).toEqual(["body"]);
    });

    it("with nil deps re-runs every render, cleaning up first", () => {
      const order: string[] = [];
      const sid = createSignal(0);
      let run = 0;
      mountView("v", () => {
        const n = readSignal(sid) as number;
        addEffect(
          null,
          marshalled(() => {
            const id = ++run;
            order.push(`body${id}`);
            return marshalled(() => order.push(`cleanup${id}`));
          }),
        );
        return [":p", {}, String(n)];
      });

      writeSignal(sid, 1);
      expect(order).toEqual(["body1", "cleanup1", "body2"]);
    });

    it("compares deps structurally, so a re-marshalled map is not a change", () => {
      // A Sema map crosses into JS through JSON, so the same map is a brand new
      // JS object on every render. An identity comparison would re-run this
      // effect forever.
      const body = vi.fn();
      const sid = createSignal(0);
      mountView("v", () => {
        readSignal(sid);
        addEffect([{ ":id": 1, ":tags": ["a", "b"] }], marshalled(body));
        return [":p", {}, "x"];
      });

      writeSignal(sid, 1);
      writeSignal(sid, 2);
      expect(body).toHaveBeenCalledTimes(1);
    });

    it("re-runs when a structurally different map dep arrives", () => {
      const body = vi.fn();
      const sid = createSignal(1);
      mountView("v", () => {
        const n = readSignal(sid) as number;
        addEffect([{ ":id": n }], marshalled(body));
        return [":p", {}, String(n)];
      });

      writeSignal(sid, 2);
      expect(body).toHaveBeenCalledTimes(2);
    });

    it("runs its cleanup exactly once at teardown", () => {
      const cleanup = vi.fn();
      mountView("v", () => {
        addEffect(
          [],
          marshalled(() => marshalled(cleanup)),
        );
        return [":p", {}, "x"];
      });

      unmount();
      disposeAllComponents(ctx);
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("reports a throwing body and keeps rendering", () => {
      const sid = createSignal(0);
      mountView("v", () => {
        const n = readSignal(sid) as number;
        addEffect(
          [n],
          marshalled(() => {
            throw new Error("effect boom");
          }),
        );
        return [":p", {}, `n=${n}`];
      });

      expect(errors).toEqual([{ message: "effect boom", context: "effect:v#0" }]);
      expect(appText()).toBe("n=0");

      writeSignal(sid, 1);
      expect(appText()).toBe("n=1");
      expect(errors).toHaveLength(2);
    });

    it("reports a throwing cleanup and still runs the next body", () => {
      const sid = createSignal(1);
      const bodies: number[] = [];
      mountView("v", () => {
        const n = readSignal(sid) as number;
        addEffect(
          [n],
          marshalled(() => {
            bodies.push(n);
            return marshalled(() => {
              throw new Error("cleanup boom");
            });
          }),
        );
        return [":p", {}, String(n)];
      });

      writeSignal(sid, 2);

      expect(errors).toEqual([{ message: "cleanup boom", context: "effect-cleanup:v#0" }]);
      expect(bodies).toEqual([1, 2]);
    });

    it("owns an interval created in its body and stops it at unmount", () => {
      vi.useFakeTimers();
      const tick = vi.fn();
      mountView("v", () => {
        addEffect(
          [],
          marshalled(() => {
            interp.getFunction("js/set-interval")!(marshalled(tick), 100);
            return null;
          }),
        );
        return [":p", {}, "x"];
      });

      expect(component().ownedIntervalIds.size).toBe(1);
      vi.advanceTimersByTime(250);
      expect(tick).toHaveBeenCalledTimes(2);

      unmount();
      vi.advanceTimersByTime(1000);
      expect(tick).toHaveBeenCalledTimes(2);
      expect(ctx.intervals.size).toBe(0);
    });

    it("owns a watch created in its body and disposes it at unmount", () => {
      const observed: unknown[] = [];
      const sid = createSignal(0);
      mountView("v", () => {
        addEffect(
          [],
          marshalled(() => {
            interp.getFunction("__state/watch")!(
              sid,
              marshalled((_old: unknown, next: unknown) => observed.push(next)),
            );
            return null;
          }),
        );
        return [":p", {}, "x"];
      });

      const watchIds = component().ownedWatchIds;
      expect(watchIds.size).toBe(1);

      writeSignal(sid, 1);
      expect(observed).toEqual([1]);

      unmount();
      writeSignal(sid, 2);
      expect(observed).toEqual([1]);
      expect(ctx.watchDisposers.size).toBe(0);
    });

    it("ownership is a teardown guarantee, not a re-run guarantee", () => {
      // Pins the contract the README and website/docs/web/components.md state:
      // an effect body that re-runs adds to what its last run created, so a
      // body that creates a subscription and can re-run MUST return a cleanup.
      // Documented rather than fixed by the runtime (finding 20): the framework
      // owns these for teardown, and scoping them to the slot would silently
      // dispose streams and resources an app may still be holding.
      const observed: unknown[] = [];
      const dep = createSignal(0);
      const watched = createSignal(0);
      mountView("v", () => {
        const n = readSignal(dep) as number;
        addEffect(
          [n],
          marshalled(() => {
            interp.getFunction("__state/watch")!(
              watched,
              marshalled((_old: unknown, next: unknown) => observed.push(next)),
            );
            return null;
          }),
        );
        return [":p", {}, String(n)];
      });

      writeSignal(dep, 1);
      writeSignal(watched, 99);

      expect(component().ownedWatchIds.size).toBe(2);
      expect(observed).toEqual([99, 99]);

      unmount();
      writeSignal(watched, 100);
      expect(observed).toEqual([99, 99]);
      expect(ctx.watchDisposers.size).toBe(0);
    });

    it("a cleanup that disposes what the body created keeps a re-run at one", () => {
      const observed: unknown[] = [];
      const dep = createSignal(0);
      const watched = createSignal(0);
      mountView("v", () => {
        const n = readSignal(dep) as number;
        addEffect(
          [n],
          marshalled(() => {
            const watchId = interp.getFunction("__state/watch")!(
              watched,
              marshalled((_old: unknown, next: unknown) => observed.push(next)),
            );
            return marshalled(() => interp.getFunction("__state/unwatch")!(watchId));
          }),
        );
        return [":p", {}, String(n)];
      });

      writeSignal(dep, 1);
      writeSignal(watched, 99);

      expect(component().ownedWatchIds.size).toBe(1);
      expect(observed).toEqual([99]);
    });

    it("reading a signal in the body does not subscribe the render to it", () => {
      let renders = 0;
      const sid = createSignal(0);
      mountView("v", () => {
        renders += 1;
        addEffect(
          [],
          marshalled(() => {
            readSignal(sid);
            return null;
          }),
        );
        return [":p", {}, "static"];
      });

      expect(renders).toBe(1);
      writeSignal(sid, 1);
      expect(renders).toBe(1);
    });

    it("a body that writes a signal the render reads settles after one extra render", () => {
      let renders = 0;
      const sid = createSignal(0);
      mountView("v", () => {
        renders += 1;
        const n = readSignal(sid) as number;
        addEffect(
          [],
          marshalled(() => {
            writeSignal(sid, 42);
            return null;
          }),
        );
        return [":p", {}, String(n)];
      });

      expect(renders).toBe(2);
      expect(appText()).toBe("42");
    });

    it("prunes a slot a later render stops registering", () => {
      const cleanup = vi.fn();
      const sid = createSignal(0);
      mountView("v", () => {
        const n = readSignal(sid) as number;
        addEffect([], marshalled(() => null));
        if (n === 0) {
          addEffect(
            [],
            marshalled(() => marshalled(cleanup)),
          );
        }
        return [":p", {}, String(n)];
      });

      expect(lifecycleSlots(component())).toHaveLength(2);

      writeSignal(sid, 1);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(lifecycleSlots(component())).toHaveLength(1);
    });

    it("throws when called outside a component render", () => {
      expect(() => addEffect([], marshalled(() => {}))).toThrow(
        /outside of a component render context/,
      );
    });

    it.each([
      ["a string", "nope"],
      ["a number", 42],
      ["a map", { ":a": 1 }],
    ])("rejects %s as deps, reporting it as a render failure", (_label, deps) => {
      mountView("v", () => {
        addEffect(deps, marshalled(() => null));
        return [":p", {}, "x"];
      });

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toMatch(/deps must be a list or nil/);
      expect(errors[0].context).toBe("component:v");
      expect(lifecycleSlots(component())).toHaveLength(0);
    });

    it("leaves live effects running when a later render throws", () => {
      // A failed render registered nothing usable. Treating its empty
      // registration list as "this render dropped every effect" would tear
      // down working subscriptions on a transient error.
      const cleanup = vi.fn();
      const sid = createSignal(0);
      mountView("v", () => {
        const n = readSignal(sid) as number;
        if (n > 0) throw new Error("late boom");
        addEffect(
          [],
          marshalled(() => marshalled(cleanup)),
        );
        return [":p", {}, String(n)];
      });

      writeSignal(sid, 1);

      expect(errors).toEqual([{ message: "late boom", context: "component:v" }]);
      expect(cleanup).not.toHaveBeenCalled();
      expect(lifecycleSlots(component())).toHaveLength(1);

      unmount();
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("releases the pending callback of a render that throws, without running the body", () => {
      const body = vi.fn();
      const release = vi.fn();
      mountView("v", () => {
        addEffect([], marshalled(body, release));
        throw new Error("render boom");
      });

      expect(body).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
      expect(component().pendingLifecycle).toHaveLength(0);
      expect(lifecycleSlots(component())).toHaveLength(0);
      expect(errors).toEqual([{ message: "render boom", context: "component:v" }]);
    });
  });

  // --- ownership / leaks --------------------------------------------------

  describe("ownership", () => {
    it("leaves no lifecycle state behind after unmount", () => {
      mountView("v", () => {
        addEffect(
          [],
          marshalled(() => marshalled(() => {})),
        );
        addUnmount(marshalled(() => {}));
        return [":p", {}, "x"];
      });
      const held = component();

      unmount();

      expect(lifecycleSlots(held)).toHaveLength(0);
      expect(held.pendingLifecycle).toHaveLength(0);
      expect(ctx.mountedComponents.size).toBe(0);
      expect(ctx.mountedComponentsById.size).toBe(0);
    });

    it("leaves no lifecycle state behind after disposing the instance", () => {
      mountView("v", () => {
        addEffect(
          [],
          marshalled(() => marshalled(() => {})),
        );
        addUnmount(marshalled(() => {}));
        return [":p", {}, "x"];
      });
      const held = component();

      disposeAllComponents(ctx);

      expect(lifecycleSlots(held)).toHaveLength(0);
      expect(held.pendingLifecycle).toHaveLength(0);
      expect(ctx.mountedComponents.size).toBe(0);
    });

    it("unmounting twice does not run any cleanup again", () => {
      const cleanup = vi.fn();
      const hook = vi.fn();
      mountView("v", () => {
        addEffect(
          [],
          marshalled(() => marshalled(cleanup)),
        );
        addUnmount(marshalled(hook));
        return [":p", {}, "x"];
      });

      unmount();
      unmount();

      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(hook).toHaveBeenCalledTimes(1);
    });

    it("remounting the same selector tears the previous lifecycle down first", () => {
      const cleanup = vi.fn();
      interp.registerFunction("v", () => {
        addEffect(
          [],
          marshalled(() => marshalled(cleanup)),
        );
        return [":p", {}, "x"];
      });

      interp.getFunction("component/mount!")!("#app", "v");
      interp.getFunction("component/mount!")!("#app", "v");

      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(lifecycleSlots(component())).toHaveLength(1);
    });

    it("releases each body and cleanup handle exactly once across run, re-run and unmount", () => {
      const released: string[] = [];
      const sid = createSignal(1);
      mountView("v", () => {
        const n = readSignal(sid) as number;
        addEffect(
          [n],
          marshalled(
            () => marshalled(() => {}, () => released.push(`cleanup${n}`)),
            () => released.push(`body${n}`),
          ),
        );
        return [":p", {}, String(n)];
      });

      expect(released).toEqual([]);

      writeSignal(sid, 2);
      // Retiring slot 0 hands back both handles the first run was holding.
      expect(released).toEqual(["cleanup1", "body1"]);

      unmount();
      expect(released).toEqual(["cleanup1", "body1", "cleanup2", "body2"]);
    });

    it("releases the duplicate callback a deps-equal re-registration marshalled", () => {
      const released: number[] = [];
      const sid = createSignal(0);
      let registrations = 0;
      mountView("v", () => {
        const n = readSignal(sid) as number;
        const id = ++registrations;
        addEffect(
          [],
          marshalled(() => null, () => released.push(id)),
        );
        return [":p", {}, String(n)];
      });

      writeSignal(sid, 1);
      // The second render's copy is dead on arrival; the first is still live.
      expect(released).toEqual([2]);

      unmount();
      expect(released).toEqual([2, 1]);
    });
  });

  // --- depsEqual ----------------------------------------------------------

  describe("depsEqual", () => {
    it("treats an absent deps list as never equal", () => {
      expect(depsEqual(null, null)).toBe(false);
      expect(depsEqual(null, [])).toBe(false);
      expect(depsEqual([], null)).toBe(false);
    });

    it("treats two empty lists as equal", () => {
      expect(depsEqual([], [])).toBe(true);
    });

    it("rejects lists of different length", () => {
      expect(depsEqual([1], [1, 2])).toBe(false);
    });

    it("compares primitives by value, with NaN equal to itself", () => {
      expect(depsEqual([1, "a", true, null], [1, "a", true, null])).toBe(true);
      expect(depsEqual([NaN], [NaN])).toBe(true);
      expect(depsEqual([0], [-0])).toBe(false);
      expect(depsEqual([1], ["1"])).toBe(false);
    });

    it("compares maps structurally", () => {
      expect(depsEqual([{ ":a": 1 }], [{ ":a": 1 }])).toBe(true);
      expect(depsEqual([{ ":a": 1 }], [{ ":a": 2 }])).toBe(false);
      expect(depsEqual([{ ":a": 1 }], [{ ":b": 1 }])).toBe(false);
      expect(depsEqual([{ ":a": 1 }], [{ ":a": 1, ":b": 2 }])).toBe(false);
    });

    it("compares nested lists and maps structurally", () => {
      expect(depsEqual([[1, [2, { ":x": 3 }]]], [[1, [2, { ":x": 3 }]]])).toBe(true);
      expect(depsEqual([[1, [2, { ":x": 3 }]]], [[1, [2, { ":x": 4 }]]])).toBe(false);
    });

    it("does not confuse a list with a map", () => {
      expect(depsEqual([[]], [{}])).toBe(false);
    });

    it("treats two distinct callbacks as different", () => {
      expect(depsEqual([marshalled(() => 1)], [marshalled(() => 1)])).toBe(false);
    });

    it("treats one shared callback as the same dep", () => {
      const fn = marshalled(() => 1);
      expect(depsEqual([fn], [fn])).toBe(true);
    });
  });
});
