/**
 * `watch` and `computed` allocated from a component's render body.
 *
 * Unlike `(local name …)` and `(resource name …)` these two primitives have no
 * name to memoize on, so every render used to allocate a fresh live one: 31
 * renders left 31 live watches, each invoking a Sema callback on every change
 * to the signal it watches and each holding a WASM callback handle until
 * unmount. The render that allocated them owns them, so a new pass recycles
 * what the previous pass allocated.
 *
 * Real `@preact/signals-core` and real `morphdom` throughout — "one live watch"
 * is a statement about signals-core subscriptions, which a stubbed `effect`
 * cannot express. The interpreter is the shared mock: a function registry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SemaWebContext } from "../src/context.js";
import { registerComponentBindings, disposeAllComponents } from "../src/component.js";
import { registerReactiveBindings } from "../src/reactive.js";
import type { SemaCallback } from "../src/callbacks.js";
import { createMockInterpreter } from "./helpers.js";

/** A Sema callback as it arrives from WASM: a fresh wrapper carrying a release hook. */
function marshalled(impl: (...args: any[]) => any, release?: () => void): SemaCallback {
  const fn = ((...args: any[]) => impl(...args)) as SemaCallback;
  fn.__semaRelease = release ?? (() => {});
  return fn;
}

describe("reactive registrations made during a render", () => {
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
    interp.getFunction("component/mount!")!("#app", name, null);
  };
  const unmount = () => interp.getFunction("component/unmount!")!("#app");
  const createSignal = (v: unknown) => interp.getFunction("__state/create")!(v) as number;
  const readSignal = (id: number) => interp.getFunction("__state/deref")!(id);
  const writeSignal = (id: number, v: unknown) => interp.getFunction("__state/put!")!(id, v);
  const addWatch = (id: number, fn: SemaCallback) =>
    interp.getFunction("__state/watch")!(id, fn) as number;
  const addComputed = (fn: SemaCallback) =>
    interp.getFunction("__state/computed-create")!(fn) as number;
  const addEffect = (deps: unknown, fn: unknown) =>
    interp.getFunction("__component/effect")!(deps, fn);
  const component = () => ctx.mountedComponents.get("#app")!;

  describe("watch", () => {
    it("keeps exactly one live registration across many renders", () => {
      const n = createSignal(0);
      const other = createSignal("a");
      const observed: unknown[] = [];
      mountView("v", () => {
        addWatch(other, marshalled((_old, next) => observed.push(next)));
        return [":p", {}, String(readSignal(n))];
      });

      for (let i = 1; i <= 30; i++) writeSignal(n, i);

      expect(ctx.watchDisposers.size).toBe(1);
      expect(component().ownedWatchIds.size).toBe(1);

      // The surviving registration is live, and it is the only one: 31 renders
      // used to mean 31 callbacks per change.
      writeSignal(other, "b");
      expect(observed).toEqual(["b"]);
    });

    it("hands the superseded render's callback handle back", () => {
      const n = createSignal(0);
      const other = createSignal("a");
      const released: number[] = [];
      let seq = 0;
      mountView("v", () => {
        const id = seq++;
        addWatch(other, marshalled(() => {}, () => released.push(id)));
        return [":p", {}, String(readSignal(n))];
      });

      writeSignal(n, 1);
      writeSignal(n, 2);

      // Renders 0 and 1 are superseded; render 2's registration is still live.
      expect(released).toEqual([0, 1]);
      unmount();
      expect(released).toEqual([0, 1, 2]);
    });

    it("names the render body once, not once per render", () => {
      const n = createSignal(0);
      const other = createSignal("a");
      mountView("v", () => {
        addWatch(other, marshalled(() => {}));
        return [":p", {}, String(readSignal(n))];
      });

      for (let i = 1; i <= 5; i++) writeSignal(n, i);

      const reported = errors.filter((e) => e.context === "watch:v");
      expect(reported).toHaveLength(1);
      expect(reported[0].message).toContain("memoized per render");
      expect(reported[0].message).toContain("(on-mount");
    });

    it("keeps one subscription rather than re-subscribing per render", () => {
      const n = createSignal(0);
      const other = createSignal("a");
      const handles: number[] = [];
      mountView("v", () => {
        handles.push(addWatch(other, marshalled(() => {})));
        return [":p", {}, String(readSignal(n))];
      });

      writeSignal(n, 1);
      writeSignal(n, 2);

      // The registration survives the render that made it; only its callback is
      // swapped. Disposing and rebuilding instead would drop the "previous
      // value" baseline and, when the render also reads the watched signal,
      // race the render against the notification it is supposed to observe.
      expect(new Set(handles).size).toBe(1);
    });

    it("invokes the latest render's callback, not the first one's", () => {
      const n = createSignal(0);
      const other = createSignal("a");
      const observed: string[] = [];
      mountView("v", () => {
        const generation = String(readSignal(n));
        addWatch(other, marshalled((_old, next) => observed.push(`${generation}:${next}`)));
        return [":p", {}, generation];
      });

      writeSignal(n, 1);
      writeSignal(other, "b");

      expect(observed).toEqual(["1:b"]);
    });

    it("does not subscribe the render to the signal it watches", () => {
      const n = createSignal(0);
      const other = createSignal("a");
      let renders = 0;
      mountView("v", () => {
        renders++;
        addWatch(other, marshalled(() => {}));
        return [":p", {}, String(readSignal(n))];
      });

      expect(renders).toBe(1);
      writeSignal(other, "b");

      // Taking the "previous value" baseline is bookkeeping. Reading it tracked
      // subscribed the render to a signal it never reads, so a change re-ran the
      // whole component — and, with the registration owned by the render, could
      // dispose the watch before it observed the change that triggered it.
      expect(renders).toBe(1);
    });

    it("keeps two watches on one signal in the same body distinct", () => {
      const n = createSignal(0);
      const other = createSignal("a");
      const first: unknown[] = [];
      const second: unknown[] = [];
      mountView("v", () => {
        addWatch(other, marshalled((_old, next) => first.push(next)));
        addWatch(other, marshalled((_old, next) => second.push(next)));
        return [":p", {}, String(readSignal(n))];
      });

      writeSignal(n, 1);
      expect(ctx.watchDisposers.size).toBe(2);

      writeSignal(other, "b");
      expect(first).toEqual(["b"]);
      expect(second).toEqual(["b"]);
    });

    it("disposes a watch the render stopped registering", () => {
      const n = createSignal(0);
      const other = createSignal("a");
      const observed: unknown[] = [];
      mountView("v", () => {
        if ((readSignal(n) as number) === 0) {
          addWatch(other, marshalled((_old, next) => observed.push(next)));
        }
        return [":p", {}, String(readSignal(n))];
      });

      expect(ctx.watchDisposers.size).toBe(1);
      writeSignal(n, 1);
      expect(ctx.watchDisposers.size).toBe(0);

      writeSignal(other, "b");
      expect(observed).toEqual([]);
    });

    it("leaves a watch created from an effect body alone", () => {
      const n = createSignal(0);
      const other = createSignal("a");
      mountView("v", () => {
        addEffect(null, marshalled(() => {
          addWatch(other, marshalled(() => {}));
          return null;
        }));
        return [":p", {}, String(readSignal(n))];
      });

      writeSignal(n, 1);

      // An effect body is not a render: its registrations are owned by the
      // component and released at teardown. Finding 20 covers the duplication
      // that a dep-less effect re-run produces; recycling must not pre-empt it.
      expect(ctx.watchDisposers.size).toBe(2);
      expect(errors.filter((e) => e.context === "watch:v")).toHaveLength(0);
    });

    it("leaves a watch created outside any component alone", () => {
      const other = createSignal("a");
      const observed: unknown[] = [];
      addWatch(other, marshalled((_old, next) => observed.push(next)));

      const n = createSignal(0);
      mountView("v", () => [":p", {}, String(readSignal(n))]);
      writeSignal(n, 1);
      writeSignal(other, "b");

      expect(ctx.watchDisposers.size).toBe(1);
      expect(observed).toEqual(["b"]);
    });

    it("releases every registration at unmount", () => {
      const n = createSignal(0);
      const other = createSignal("a");
      mountView("v", () => {
        addWatch(other, marshalled(() => {}));
        return [":p", {}, String(readSignal(n))];
      });
      writeSignal(n, 1);

      unmount();
      expect(ctx.watchDisposers.size).toBe(0);
    });
  });

  describe("computed", () => {
    it("keeps exactly one live signal across many renders", () => {
      const n = createSignal(0);
      const before = ctx.signals.size;
      mountView("v", () => {
        const doubled = addComputed(marshalled(() => (readSignal(n) as number) * 2));
        return [":p", {}, String(readSignal(doubled))];
      });

      for (let i = 1; i <= 30; i++) writeSignal(n, i);

      // One computed alive, not 31.
      expect(ctx.signals.size).toBe(before + 1);
      expect(ctx.signalFinalizers.size).toBe(1);
      expect(component().ownedSignalIds.size).toBe(1);
      expect(document.getElementById("app")!.textContent).toBe("60");
    });

    it("recycling is invisible: each render reads its own value", () => {
      const n = createSignal(2);
      mountView("v", () => {
        const doubled = addComputed(marshalled(() => (readSignal(n) as number) * 2));
        return [":p", {}, String(readSignal(doubled))];
      });

      expect(document.getElementById("app")!.textContent).toBe("4");
      writeSignal(n, 5);
      expect(document.getElementById("app")!.textContent).toBe("10");
      // Unlike `watch`, a per-render computed is a derivation, not a
      // subscription — recycling it changes nothing observable, so it is not
      // reported.
      expect(errors).toEqual([]);
    });

    it("leaves a computed created outside a render alone", () => {
      const n = createSignal(3);
      const doubled = addComputed(marshalled(() => (readSignal(n) as number) * 2));
      const before = ctx.signals.size;

      mountView("v", () => [":p", {}, String(readSignal(doubled))]);
      writeSignal(n, 4);

      expect(ctx.signals.size).toBe(before);
      expect(document.getElementById("app")!.textContent).toBe("8");
    });
  });

  it("a render that throws still releases what it allocated before throwing", () => {
    const n = createSignal(0);
    const other = createSignal("a");
    mountView("v", () => {
      addWatch(other, marshalled(() => {}));
      if ((readSignal(n) as number) > 0) throw new Error("boom");
      return [":p", {}, "ok"];
    });

    writeSignal(n, 1);
    expect(errors.some((e) => e.context === "component:v")).toBe(true);
    // The failed render's own registration is the live one; the successful
    // render's was recycled before the body ran.
    expect(ctx.watchDisposers.size).toBe(1);

    writeSignal(n, 0);
    expect(ctx.watchDisposers.size).toBe(1);
  });
});
