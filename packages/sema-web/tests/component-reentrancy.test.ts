/**
 * Render re-entrancy: lifecycle bodies that render, unmount, or re-shape the
 * component they are running inside.
 *
 * Regression coverage for findings 10, 18 and 19 of
 * `docs/bugs/2026-07-28-sema-web-adversarial-findings.md`. All three are the
 * same shape — user code reaching back into the component while its render or
 * its lifecycle flush is still on the stack — and all three failed silently:
 *
 * - `component/force-render!` from an effect body recursed until the JS stack
 *   overflowed and orphaned a render effect that kept firing after unmount;
 * - `component/unmount!` from an effect body discarded that effect's cleanup
 *   and left a live slot on the destroyed component;
 * - a render that changed its slot count ran an `on-unmount` hook mid-life and
 *   then ran it again at teardown.
 *
 * Mocks nothing but the interpreter (a function registry): the real
 * `@preact/signals-core` is what makes "one render" a meaningful count, and the
 * real `morphdom` is what a nested render actually patches with.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SemaWebContext } from "../src/context.js";
import { registerComponentBindings, disposeAllComponents, lifecycleSlots } from "../src/component.js";
import { registerReactiveBindings } from "../src/reactive.js";
import type { SemaCallback } from "../src/callbacks.js";
import { createMockInterpreter } from "./helpers.js";

/** A Sema callback as it arrives from WASM: a wrapper carrying a release hook. */
function marshalled(impl: (...args: any[]) => any, release?: () => void): SemaCallback {
  const fn = ((...args: any[]) => impl(...args)) as SemaCallback;
  fn.__semaRelease = release ?? (() => {});
  return fn;
}

describe("component render re-entrancy", () => {
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

  const mountView = (name: string, view: () => any) => {
    interp.registerFunction(name, view);
    interp.getFunction("component/mount!")!("#app", name, undefined);
  };
  const unmount = () => interp.getFunction("component/unmount!")!("#app");
  const forceRender = () => interp.getFunction("component/force-render!")!("#app");
  const addEffect = (deps: unknown, fn: unknown) =>
    interp.getFunction("__component/effect")!(deps, fn);
  const addUnmount = (fn: unknown) => interp.getFunction("__component/on-unmount")!(fn);
  const createSignal = (v: unknown) => interp.getFunction("__state/create")!(v) as number;
  const readSignal = (id: number) => interp.getFunction("__state/deref")!(id);
  const writeSignal = (id: number, v: unknown) => interp.getFunction("__state/put!")!(id, v);
  const component = () => ctx.mountedComponents.get("#app")!;

  // --- force-render! from inside a render (finding 10) ---------------------

  describe("component/force-render! while the component is already rendering", () => {
    it("is refused from an effect body instead of recursing", () => {
      let renders = 0;
      mountView("v", () => {
        renders += 1;
        addEffect([], marshalled(() => forceRender()));
        return [":div", {}, "x"];
      });

      // One render. Before the guard this recursed ~174 deep and ended in
      // "Maximum call stack size exceeded".
      expect(renders).toBe(1);
      expect(errors).toHaveLength(1);
      expect(errors[0].context).toBe("force-render:v");
      expect(errors[0].message).toMatch(/already rendering/);
    });

    it("leaves no orphaned render effect firing after unmount", () => {
      let renders = 0;
      const sid = createSignal(0);
      mountView("v", () => {
        renders += 1;
        readSignal(sid);
        addEffect([], marshalled(() => forceRender()));
        return [":div", {}, "x"];
      });
      expect(renders).toBe(1);

      writeSignal(sid, 1);
      expect(renders).toBe(2);

      unmount();
      writeSignal(sid, 2);

      // The nested render effect used to be unreachable by unmount, because the
      // outer call overwrote `component.dispose` with its own disposer.
      expect(renders).toBe(2);
    });

    it("is refused from a render body", () => {
      let renders = 0;
      mountView("v", () => {
        renders += 1;
        forceRender();
        return [":div", {}, "x"];
      });

      expect(renders).toBe(1);
      expect(errors.map((e) => e.context)).toEqual(["force-render:v"]);
    });

    it("still re-renders when called from an event handler", () => {
      let renders = 0;
      mountView("v", () => {
        renders += 1;
        return [":div", {}, "x"];
      });

      forceRender();
      forceRender();

      expect(renders).toBe(3);
      expect(errors).toEqual([]);
    });
  });

  // --- unmount! from inside a lifecycle body (finding 18) ------------------

  describe("component/unmount! from inside an effect body", () => {
    it("runs the cleanup the body returned instead of stranding it", () => {
      const cleanup = vi.fn();
      mountView("v", () => {
        addEffect(
          [],
          marshalled(() => {
            unmount();
            return marshalled(cleanup);
          }),
        );
        return [":div", {}, "d"];
      });

      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("leaves no lifecycle slot behind on the destroyed component", () => {
      const held: any[] = [];
      mountView("v", () => {
        held.push(component());
        addEffect(
          [],
          marshalled(() => {
            unmount();
            return null;
          }),
        );
        return [":div", {}, "d"];
      });
      const destroyed = held[0];

      expect(ctx.mountedComponents.has("#app")).toBe(false);
      expect(ctx.mountedComponentsById.has(destroyed.instanceId)).toBe(false);
      expect(lifecycleSlots(destroyed)).toHaveLength(0);
      expect(destroyed.ownedLifecycleSlots.size).toBe(0);
      expect(destroyed.pendingLifecycle.size).toBe(0);
      expect(document.getElementById("app")!.innerHTML).toBe("");
    });

    it("runs the cleanups of the slots registered before it, exactly once each", () => {
      const order: string[] = [];
      mountView("v", () => {
        addEffect(
          [],
          marshalled(() => marshalled(() => order.push("first-cleanup"))),
        );
        addEffect(
          [],
          marshalled(() => {
            unmount();
            return marshalled(() => order.push("second-cleanup"));
          }),
        );
        return [":div", {}, "d"];
      });

      expect(order).toEqual(["first-cleanup", "second-cleanup"]);
    });

    it("releases every callback handle the destroyed render was holding", () => {
      const released: string[] = [];
      mountView("v", () => {
        addEffect(
          [],
          marshalled(
            () => {
              unmount();
              return marshalled(() => {}, () => released.push("cleanup"));
            },
            () => released.push("body"),
          ),
        );
        // A second slot the flush never reaches: its handle must still come back.
        addEffect([], marshalled(() => null, () => released.push("later-body")));
        return [":div", {}, "d"];
      });

      expect(released.sort()).toEqual(["body", "cleanup", "later-body"]);
    });

    it("runs a pruned slot's cleanup once when that cleanup unmounts the component", () => {
      // The cleanup re-enters teardown over the very slot list the flush is
      // walking, so both paths see the same slot. Each cleanup still runs once.
      const order: string[] = [];
      const sid = createSignal(0);
      mountView("v", () => {
        const phase = readSignal(sid) as number;
        addEffect([], marshalled(() => marshalled(() => order.push("keeper-cleanup"))));
        if (phase === 0) {
          addEffect(
            [],
            marshalled(() =>
              marshalled(() => {
                order.push("dropped-cleanup");
                unmount();
              }),
            ),
          );
        }
        return [":div", {}, String(phase)];
      });

      writeSignal(sid, 1);

      expect(order).toEqual(["dropped-cleanup", "keeper-cleanup"]);
      expect(ctx.mountedComponents.size).toBe(0);
    });

    it("does not repaint the DOM when a render body unmounts its own component", () => {
      mountView("v", () => {
        unmount();
        return [":div", {}, "ghost"];
      });

      expect(document.getElementById("app")!.innerHTML).toBe("");
      expect(ctx.mountedComponents.has("#app")).toBe(false);
    });
  });

  // --- writing state during a render (finding 29) --------------------------

  describe("a render body that writes state it also reads", () => {
    it("is reported with the cause named, not as a bare 'Cycle detected'", () => {
      const sid = createSignal(0);
      mountView("v", () => {
        const n = readSignal(sid) as number;
        writeSignal(sid, n + 1);
        return [":div", {}, String(n)];
      });

      expect(errors).toHaveLength(1);
      expect(errors[0].context).toBe("component:v");
      // The reactive library's own message is kept — it is the evidence — and
      // the sentence that tells the user what to change is added to it.
      expect(errors[0].message).toContain("Cycle detected");
      expect(errors[0].message).toContain("wrote reactive state that it also reads");
    });

    it("leaves an ordinary render error's message untouched", () => {
      mountView("v", () => {
        throw new Error("plain boom");
      });

      expect(errors).toEqual([{ message: "plain boom", context: "component:v" }]);
    });
  });

  // --- a render that changes its slot shape (finding 19) -------------------

  describe("a render that changes its lifecycle slot sequence", () => {
    it("does not run an on-unmount hook that merely moved index", () => {
      const hook = vi.fn();
      const sid = createSignal(0);
      mountView("v", () => {
        const phase = readSignal(sid) as number;
        addEffect([], marshalled(() => null));
        if (phase > 0) addEffect([], marshalled(() => null));
        addUnmount(marshalled(hook));
        return [":div", {}, String(phase)];
      });

      writeSignal(sid, 1);

      // The hook used to fire here — mid-life, on a component still on screen —
      // and then fire a second time at teardown.
      expect(hook).not.toHaveBeenCalled();

      unmount();
      expect(hook).toHaveBeenCalledTimes(1);
    });

    it("reports the kind change that re-keyed the slots", () => {
      const sid = createSignal(0);
      mountView("v", () => {
        const phase = readSignal(sid) as number;
        addEffect([], marshalled(() => null));
        if (phase > 0) addEffect([], marshalled(() => null));
        addUnmount(marshalled(() => {}));
        return [":div", {}, String(phase)];
      });
      expect(errors).toEqual([]);

      writeSignal(sid, 1);

      expect(errors).toHaveLength(1);
      expect(errors[0].context).toBe("lifecycle:v#1");
      expect(errors[0].message).toMatch(/changed from \(on-unmount …\) to \(effect …\)/);
    });

    it("reports an on-unmount hook a later render stopped registering", () => {
      const hook = vi.fn();
      const sid = createSignal(0);
      mountView("v", () => {
        const phase = readSignal(sid) as number;
        addEffect([], marshalled(() => null));
        if (phase === 0) addUnmount(marshalled(hook));
        return [":div", {}, String(phase)];
      });

      writeSignal(sid, 1);

      expect(hook).not.toHaveBeenCalled();
      expect(errors).toHaveLength(1);
      expect(errors[0].context).toBe("lifecycle:v#1");
      expect(errors[0].message).toMatch(/will never run/);

      unmount();
      expect(hook).not.toHaveBeenCalled();
    });

    it("still prunes and cleans up an effect slot a later render drops", () => {
      // The documented, supported side of the same machinery: an effect that
      // disappears is cleaned up, and nothing is reported.
      const cleanup = vi.fn();
      const sid = createSignal(0);
      mountView("v", () => {
        const phase = readSignal(sid) as number;
        addEffect([], marshalled(() => null));
        if (phase === 0) {
          addEffect([], marshalled(() => marshalled(cleanup)));
        }
        return [":div", {}, String(phase)];
      });

      writeSignal(sid, 1);

      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(lifecycleSlots(component())).toHaveLength(1);
      expect(errors).toEqual([]);
    });
  });
});
