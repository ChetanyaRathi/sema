/**
 * Event modifiers as the delegator applies them.
 *
 * Mocks nothing: the real `morphdom` and the real `@preact/signals-core`, for
 * the same reason `sip-keys.test.ts` does. `.once` is a claim about node
 * identity surviving a patch, and the `innerHTML`-swap morphdom stub other
 * suites install destroys every node on every render — a `.once` keyed to an
 * element would re-arm against it and a broken implementation would pass.
 *
 * The interpreter is still the shared mock; it is a function registry, not a
 * model of anything under test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SemaWebContext } from "../src/context.js";
import { registerComponentBindings, disposeAllComponents } from "../src/component.js";
import { registerDomBindings } from "../src/dom.js";
import { registerReactiveBindings } from "../src/reactive.js";
import { DELEGATED_EVENTS } from "../src/sip.js";
import { createMockInterpreter } from "./helpers.js";

describe("delegated event modifiers", () => {
  let interp: ReturnType<typeof createMockInterpreter>;
  let ctx: SemaWebContext;
  let errors: Array<{ message: string; context: string }>;
  let app: HTMLElement;

  beforeEach(() => {
    interp = createMockInterpreter();
    ctx = new SemaWebContext();
    errors = [];
    document.body.innerHTML = '<div id="app"></div><div id="other"></div>';
    app = document.getElementById("app")!;
    registerComponentBindings(interp, ctx);
    registerDomBindings(interp, ctx);
    registerReactiveBindings(interp, ctx);
    ctx.onerror = (e, context) => errors.push({ message: e.message, context });
  });

  afterEach(() => {
    disposeAllComponents(ctx);
  });

  const mountView = (view: () => any, selector = "#app", name = "v") => {
    interp.registerFunction(name, view);
    interp.getFunction("component/mount!")!(selector, name);
  };
  const unmount = (selector = "#app") => interp.getFunction("component/unmount!")!(selector);
  const forceRender = (selector = "#app") =>
    interp.getFunction("component/force-render!")!(selector);
  const eventOf = (handle: number) => ctx.handles.get(handle) as Event;
  const createSignal = (v: unknown) => interp.getFunction("__state/create")!(v) as number;
  const readSignal = (id: number) => interp.getFunction("__state/deref")!(id);
  const writeSignal = (id: number, v: unknown) => interp.getFunction("__state/put!")!(id, v);

  /** Dispatch a real bubbling, cancelable event from a node. */
  const fire = (node: Node, type: string, init: EventInit = {}): Event => {
    const ev = new Event(type, { bubbles: true, cancelable: true, ...init });
    node.dispatchEvent(ev);
    return ev;
  };
  const click = (selector: string) => fire(app.querySelector(selector)!, "click");

  // --- .prevent -----------------------------------------------------------

  describe(".prevent", () => {
    it("has already prevented the default by the time the handler runs", () => {
      // The acceptance criterion. A handler that decides whether to submit
      // based on `defaultPrevented` must see the modifier's effect.
      const seen: boolean[] = [];
      interp.registerFunction("save", (h: number) => seen.push(eventOf(h).defaultPrevented));
      mountView(() => [":form", { ":on-submit.prevent": "save", ":id": "f" }]);

      const ev = fire(app.querySelector("#f")!, "submit");

      expect(seen).toEqual([true]);
      expect(ev.defaultPrevented).toBe(true);
    });

    it("leaves the default alone without the modifier", () => {
      const seen: boolean[] = [];
      interp.registerFunction("save", (h: number) => seen.push(eventOf(h).defaultPrevented));
      mountView(() => [":form", { ":on-submit": "save", ":id": "f" }]);

      const ev = fire(app.querySelector("#f")!, "submit");

      expect(seen).toEqual([false]);
      expect(ev.defaultPrevented).toBe(false);
    });

    it("prevents the default even when the handler throws", () => {
      interp.registerFunction("save", () => {
        throw new Error("handler boom");
      });
      mountView(() => [":form", { ":on-submit.prevent": "save", ":id": "f" }]);

      const ev = fire(app.querySelector("#f")!, "submit");

      expect(ev.defaultPrevented).toBe(true);
      expect(errors[0].context).toBe("event:submit:save");
    });
  });

  // --- .stop --------------------------------------------------------------

  describe(".stop", () => {
    it("stops delegated bubbling AFTER the handler has run", () => {
      // The acceptance criterion, in two halves: the handler still observes an
      // un-stopped event, and the ancestor never runs.
      const order: string[] = [];
      const duringHandler: boolean[] = [];
      interp.registerFunction("inner", (h: number) => {
        order.push("inner");
        duringHandler.push(eventOf(h).cancelBubble);
      });
      interp.registerFunction("outer", () => order.push("outer"));
      mountView(() => [
        ":div",
        { ":on-click": "outer" },
        [":button", { ":on-click.stop": "inner", ":id": "b" }, "go"],
      ]);

      const ev = click("#b");

      expect(order).toEqual(["inner"]);
      expect(duringHandler).toEqual([false]);
      // `cancelBubble` reads the stop-propagation flag, which the DOM clears
      // once dispatch finishes; the delegator's own marker is what survives.
      expect((ev as any).__sema_stop).toBe(true);
    });

    it("without it the ancestor handler still runs", () => {
      const order: string[] = [];
      interp.registerFunction("inner", () => order.push("inner"));
      interp.registerFunction("outer", () => order.push("outer"));
      mountView(() => [
        ":div",
        { ":on-click": "outer" },
        [":button", { ":on-click": "inner", ":id": "b" }, "go"],
      ]);

      click("#b");

      expect(order).toEqual(["inner", "outer"]);
    });

    it("stops propagation even when the handler throws", () => {
      const order: string[] = [];
      interp.registerFunction("inner", () => {
        order.push("inner");
        throw new Error("inner boom");
      });
      interp.registerFunction("outer", () => order.push("outer"));
      mountView(() => [
        ":div",
        { ":on-click": "outer" },
        [":button", { ":on-click.stop": "inner", ":id": "b" }, "go"],
      ]);

      click("#b");

      expect(order).toEqual(["inner"]);
      expect(errors.map((e) => e.context)).toEqual(["event:click:inner"]);
    });
  });

  // --- .once --------------------------------------------------------------

  describe(".once", () => {
    it("fires once no matter how many times the event happens", () => {
      const calls = vi.fn();
      interp.registerFunction("buy", calls);
      mountView(() => [":button", { ":on-click.once": "buy", ":id": "b" }, "buy"]);

      click("#b");
      click("#b");
      click("#b");

      expect(calls).toHaveBeenCalledTimes(1);
    });

    it("stays spent across a re-render that preserves the node", () => {
      // The reason `.once` is tracked in a WeakMap and not a DOM attribute:
      // morphdom re-syncs attributes from the freshly rendered clone, so an
      // attribute mark would be restored here and the handler would re-arm.
      const calls = vi.fn();
      interp.registerFunction("buy", calls);
      mountView(() => [":button", { ":on-click.once": "buy", ":id": "b" }, "buy"]);
      const before = app.querySelector("#b")!;

      click("#b");
      forceRender();
      click("#b");

      expect(app.querySelector("#b")).toBe(before);
      expect(calls).toHaveBeenCalledTimes(1);
    });

    it("stays spent across a signal-driven re-render", () => {
      const calls = vi.fn();
      interp.registerFunction("buy", calls);
      const label = createSignal("one");
      mountView(() => [
        ":button",
        { ":on-click.once": "buy", ":id": "b" },
        String(readSignal(label)),
      ]);

      click("#b");
      writeSignal(label, "two");
      expect(app.textContent).toBe("two");
      click("#b");

      expect(calls).toHaveBeenCalledTimes(1);
    });

    it("re-arms on a genuinely new element", () => {
      // No `id` on the button, deliberately: `sipNodeKey` falls back to `id`,
      // and morphdom reuses an id-matched node even under a discarded parent —
      // which would make this test assert the opposite of what it claims.
      const calls = vi.fn();
      interp.registerFunction("buy", calls);
      const key = createSignal(1);
      mountView(() => [
        ":ul",
        {},
        [
          ":li",
          { ":key": readSignal(key) },
          [":button", { ":on-click.once": "buy", ":class": "buy" }, "buy"],
        ],
      ]);
      const before = app.querySelector(".buy")!;

      click(".buy");
      writeSignal(key, 2);
      const after = app.querySelector(".buy")!;
      click(".buy");

      expect(after).not.toBe(before);
      expect(calls).toHaveBeenCalledTimes(2);
    });

    it("is tracked per element, so a sibling sharing the handler is unaffected", () => {
      const calls: string[] = [];
      interp.registerFunction("pick", () => calls.push("pick"));
      mountView(() => [
        ":ul",
        {},
        [":li", { ":key": 1 }, [":button", { ":on-click.once": "pick", ":id": "b1" }, "a"]],
        [":li", { ":key": 2 }, [":button", { ":on-click.once": "pick", ":id": "b2" }, "b"]],
      ]);

      click("#b1");
      click("#b1");
      click("#b2");

      expect(calls).toEqual(["pick", "pick"]);
    });

    it("moves to the wrong row in an unkeyed list, and dev mode says so", () => {
      // Characterization, not an endorsement. `.once` is spent per DOM element
      // and morphdom reuses the position-0 node for whatever item now sits
      // there, so the row the user clicked fires again and the row they never
      // touched is dead. Item identity is not something the framework can
      // recover — only a `:key` supplies it — so what the fix adds is the
      // diagnostic asserted at the end.
      ctx.diagnostics.enabled = true;
      const clicked: string[] = [];
      interp.registerFunction("h", (handle: number) =>
        clicked.push((eventOf(handle).target as Element).textContent!),
      );
      const rows = createSignal(["a", "b"]);
      mountView(() => [
        ":ul",
        {},
        ...(readSignal(rows) as string[]).map((r) => [":li", { ":on-click.once": "h" }, r]),
      ]);
      const items = () => Array.from(app.querySelectorAll("li"));

      items()[0].dispatchEvent(new Event("click", { bubbles: true }));
      writeSignal(rows, ["b", "a"]);
      items()[0].dispatchEvent(new Event("click", { bubbles: true }));
      items()[1].dispatchEvent(new Event("click", { bubbles: true }));

      // "b" was never clicked before the reorder, yet its row is spent; "a" was
      // spent, yet fires again.
      expect(clicked).toEqual(["a", "a"]);
      expect(
        errors.filter((e) => e.context === "sip-render:once-without-key:ul"),
      ).not.toHaveLength(0);
    });

    it("a re-entrant dispatch of the same event cannot fire it twice", () => {
      // The mark is set before the invoke precisely so this cannot recurse.
      const calls: number[] = [];
      interp.registerFunction("buy", () => {
        calls.push(calls.length);
        if (calls.length < 3) click("#b");
      });
      mountView(() => [":button", { ":on-click.once": "buy", ":id": "b" }, "buy"]);

      click("#b");

      expect(calls).toEqual([0]);
    });
  });

  // --- .self --------------------------------------------------------------

  describe(".self", () => {
    it("runs when the element itself is the target", () => {
      const calls = vi.fn();
      interp.registerFunction("close", calls);
      mountView(() => [":div", { ":on-click.self": "close", ":id": "backdrop" }]);

      click("#backdrop");

      expect(calls).toHaveBeenCalledTimes(1);
    });

    it("does not run for an event that bubbled up from a child", () => {
      const calls = vi.fn();
      interp.registerFunction("close", calls);
      mountView(() => [
        ":div",
        { ":on-click.self": "close", ":id": "backdrop" },
        [":button", { ":id": "inside" }, "inside"],
      ]);

      click("#inside");

      expect(calls).not.toHaveBeenCalled();
    });

    it("a filtered-out handler does not preventDefault", () => {
      // Pins the order of operations: `.self` decides before `.prevent` acts.
      const calls = vi.fn();
      interp.registerFunction("close", calls);
      mountView(() => [
        ":div",
        { ":on-click.self.prevent": "close", ":id": "backdrop" },
        [":button", { ":id": "inside" }, "inside"],
      ]);

      const ev = click("#inside");

      expect(calls).not.toHaveBeenCalled();
      expect(ev.defaultPrevented).toBe(false);
    });

    it("a filtered-out handler does not burn its .once", () => {
      const calls = vi.fn();
      interp.registerFunction("close", calls);
      mountView(() => [
        ":div",
        { ":on-click.self.once": "close", ":id": "backdrop" },
        [":button", { ":id": "inside" }, "inside"],
      ]);

      click("#inside");
      click("#backdrop");
      click("#backdrop");

      expect(calls).toHaveBeenCalledTimes(1);
    });

    it("a filtered-out handler does not stop the walk to its ancestors", () => {
      const order: string[] = [];
      interp.registerFunction("mid", () => order.push("mid"));
      interp.registerFunction("outer", () => order.push("outer"));
      mountView(() => [
        ":div",
        { ":on-click": "outer" },
        [
          ":div",
          { ":on-click.self.stop": "mid" },
          [":button", { ":id": "inside" }, "inside"],
        ],
      ]);

      click("#inside");

      expect(order).toEqual(["outer"]);
    });
  });

  // --- .capture -----------------------------------------------------------

  describe(".capture", () => {
    it("runs an ancestor handler before the descendant's", () => {
      const order: string[] = [];
      interp.registerFunction("outer", () => order.push("outer"));
      interp.registerFunction("inner", () => order.push("inner"));
      mountView(() => [
        ":div",
        { ":on-click.capture": "outer" },
        [":button", { ":on-click": "inner", ":id": "b" }, "go"],
      ]);

      click("#b");

      expect(order).toEqual(["outer", "inner"]);
    });

    it("without it the descendant runs first", () => {
      const order: string[] = [];
      interp.registerFunction("outer", () => order.push("outer"));
      interp.registerFunction("inner", () => order.push("inner"));
      mountView(() => [
        ":div",
        { ":on-click": "outer" },
        [":button", { ":on-click": "inner", ":id": "b" }, "go"],
      ]);

      click("#b");

      expect(order).toEqual(["inner", "outer"]);
    });

    it("fires exactly once", () => {
      // Guards the rule that the bubble pass skips capture-marked handlers.
      const calls = vi.fn();
      interp.registerFunction("intercept", calls);
      mountView(() => [":div", { ":on-keydown.capture": "intercept", ":id": "d" }]);

      fire(app.querySelector("#d")!, "keydown");

      expect(calls).toHaveBeenCalledTimes(1);
    });

    it("nested capture handlers run outermost first", () => {
      const order: string[] = [];
      interp.registerFunction("a", () => order.push("a"));
      interp.registerFunction("b", () => order.push("b"));
      mountView(() => [
        ":div",
        { ":on-click.capture": "a" },
        [":div", { ":on-click.capture": "b" }, [":button", { ":id": "t" }, "go"]],
      ]);

      click("#t");

      expect(order).toEqual(["a", "b"]);
    });

    it("with .stop, the descendant's handler never runs", () => {
      const order: string[] = [];
      interp.registerFunction("outer", () => order.push("outer"));
      interp.registerFunction("inner", () => order.push("inner"));
      mountView(() => [
        ":div",
        { ":on-click.capture.stop": "outer" },
        [":button", { ":on-click": "inner", ":id": "b" }, "go"],
      ]);

      click("#b");

      expect(order).toEqual(["outer"]);
    });

    it("costs nothing when no render has declared it", () => {
      // The gate: the capture pass is skipped wholesale for events no render
      // has marked, which is what keeps delegated dispatch a single walk.
      interp.registerFunction("plain", () => {});
      mountView(() => [":button", { ":on-click": "plain", ":id": "b" }, "go"]);

      expect(ctx.captureEvents.has("click")).toBe(false);
    });
  });

  // --- combinations -------------------------------------------------------

  describe("combinations", () => {
    it(".prevent.stop.once: the second dispatch still prevents, but stops nothing", () => {
      // The asymmetry is deliberate. `.prevent` belongs to the declaration —
      // the element still says "this event must not do its default thing", and
      // a navigation it fails to stop cannot be undone. `.stop` only decides
      // which other handlers see the event, so it stays tied to the handler
      // actually running.
      const order: string[] = [];
      const prevented: boolean[] = [];
      interp.registerFunction("inner", (h: number) => {
        order.push("inner");
        prevented.push(eventOf(h).defaultPrevented);
      });
      interp.registerFunction("outer", () => order.push("outer"));
      mountView(() => [
        ":div",
        { ":on-click": "outer" },
        [":button", { ":on-click.prevent.stop.once": "inner", ":id": "b" }, "go"],
      ]);

      const first = click("#b");
      const second = click("#b");

      expect(order).toEqual(["inner", "outer"]);
      expect(prevented).toEqual([true]);
      expect(first.defaultPrevented).toBe(true);
      expect((first as any).__sema_stop).toBe(true);
      expect(second.defaultPrevented).toBe(true);
      expect((second as any).__sema_stop).toBeUndefined();
    });

    it(".prevent.once keeps preventing a submission it has already handled", () => {
      // The failure this ordering exists to stop: with `.once` gating first,
      // the second submit of a `.prevent.once` form navigated the page away.
      const calls = vi.fn();
      interp.registerFunction("save", calls);
      mountView(() => [":form", { ":on-submit.prevent.once": "save", ":id": "f" }]);
      const form = app.querySelector("#f")!;

      const first = fire(form, "submit");
      const second = fire(form, "submit");

      expect(calls).toHaveBeenCalledTimes(1);
      expect(first.defaultPrevented).toBe(true);
      expect(second.defaultPrevented).toBe(true);
    });

    it(".self.once still refuses to prevent for an event it filtered out", () => {
      // The other half of the rule: `.self` means the handler is not this
      // element's at all, so it must not prevent — even though `.prevent` now
      // runs before the `.once` gate.
      const calls = vi.fn();
      interp.registerFunction("close", calls);
      mountView(() => [
        ":div",
        { ":on-click.self.prevent.once": "close", ":id": "backdrop" },
        [":button", { ":id": "inside" }, "inside"],
      ]);

      const bubbled = click("#inside");
      const own = click("#backdrop");

      expect(bubbled.defaultPrevented).toBe(false);
      expect(own.defaultPrevented).toBe(true);
      expect(calls).toHaveBeenCalledTimes(1);
    });

    it(".capture.once fires once across repeated events", () => {
      const calls = vi.fn();
      interp.registerFunction("intercept", calls);
      mountView(() => [
        ":div",
        { ":on-click.capture.once": "intercept" },
        [":button", { ":id": "b" }, "go"],
      ]);

      click("#b");
      click("#b");

      expect(calls).toHaveBeenCalledTimes(1);
    });
  });

  // --- encoder / delegator agreement -------------------------------------

  describe("delegated event coverage", () => {
    it("routes every event name the renderer accepts", () => {
      // The invariant behind the typo diagnostic: SIP refuses an `on-*` name
      // the delegator does not listen for, so the two lists must not be able to
      // drift. A name accepted by the encoder but unrouted renders an attribute
      // that looks right in devtools and can never fire.
      const seen: string[] = [];
      interp.registerFunction("go", (h: number) => seen.push(eventOf(h).type));
      const attrs: Record<string, string> = { ":id": "b" };
      for (const event of DELEGATED_EVENTS) attrs[`:on-${event}`] = "go";
      mountView(() => [":button", attrs, "go"]);

      const button = app.querySelector("#b")!;
      for (const event of DELEGATED_EVENTS) fire(button, event);

      expect(seen).toEqual([...DELEGATED_EVENTS]);
      expect(errors).toEqual([]);
    });

    it("asks for a non-passive listener where a browser would default to passive", () => {
      // jsdom makes nothing passive, so the only honest assertion is the
      // request itself: a passive listener cannot preventDefault, and Chrome
      // defaults `wheel`/`touchstart`/`touchmove` to passive on body/document.
      const spy = vi.spyOn(Element.prototype, "addEventListener");
      try {
        mountView(() => [":div", { ":on-wheel": "go" }]);

        const wheel = spy.mock.calls.filter((call) => call[0] === "wheel");
        const click = spy.mock.calls.filter((call) => call[0] === "click");
        expect(wheel).toHaveLength(2);
        expect(wheel.every((call) => (call[2] as AddEventListenerOptions).passive === false)).toBe(
          true,
        );
        expect(click).toHaveLength(2);
        expect((click[0][2] as AddEventListenerOptions | undefined)?.passive).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    });

    it("covers the events a form actually uses", () => {
      // Named rather than derived, so shrinking the set is a deliberate act:
      // every one of these installed a dead attribute before.
      for (const event of ["mousedown", "mouseup", "mousemove", "wheel", "reset",
        "paste", "copy", "cut", "drop", "dragover", "touchstart"]) {
        expect(DELEGATED_EVENTS).toContain(event);
      }
    });
  });

  // --- unmodified handlers are untouched ---------------------------------

  describe("unmodified handlers", () => {
    it("still dispatch with exactly one argument, a live event handle", () => {
      const args: unknown[][] = [];
      interp.registerFunction("go", (...received: unknown[]) => {
        args.push(received);
        expect(ctx.handles.get(received[0] as number)).toBeInstanceOf(Event);
      });
      mountView(() => [":button", { ":on-click": "go", ":id": "b" }, "go"]);

      click("#b");

      expect(args).toHaveLength(1);
      expect(args[0]).toHaveLength(1);
    });

    it("release the event handle after dispatch", () => {
      let seen = -1;
      interp.registerFunction("go", (h: number) => {
        seen = h;
      });
      mountView(() => [":button", { ":on-click": "go", ":id": "b" }, "go"]);

      click("#b");

      expect(seen).toBeGreaterThan(0);
      expect(ctx.handles.has(seen)).toBe(false);
    });
  });

  // --- mouseenter / mouseleave emulation ---------------------------------

  describe("synthetic mouseenter / mouseleave", () => {
    const mouse = (selector: string, type: string, relatedTarget?: Element | null) => {
      const node = app.querySelector(selector)!;
      node.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget }),
      );
    };

    /** A card wrapping a button, each with its own hover handlers. */
    const mountNested = (log: string[]) => {
      interp.registerFunction("card-enter", () => log.push("card-enter"));
      interp.registerFunction("card-leave", () => log.push("card-leave"));
      interp.registerFunction("btn-enter", () => log.push("btn-enter"));
      interp.registerFunction("btn-leave", () => log.push("btn-leave"));
      mountView(() => [
        ":div",
        { ":id": "card", ":on-mouseenter": "card-enter", ":on-mouseleave": "card-leave" },
        [":button", { ":id": "btn", ":on-mouseenter": "btn-enter", ":on-mouseleave": "btn-leave" }, "buy"],
      ]);
    };

    it("runs every ancestor being entered, outermost first", () => {
      // One pointer move from outside the card onto the button enters both.
      // With only the nearest declaring ancestor resolved, the card's
      // `mouseenter` never ran while its `mouseleave` still did — a hover menu
      // got a close it never got an open for.
      const log: string[] = [];
      mountNested(log);

      mouse("#btn", "mouseover", null);

      expect(log).toEqual(["card-enter", "btn-enter"]);
    });

    it("runs every ancestor being left, innermost first", () => {
      const log: string[] = [];
      mountNested(log);
      mouse("#btn", "mouseover", null);
      log.length = 0;

      mouse("#btn", "mouseout", null);

      expect(log).toEqual(["btn-leave", "card-leave"]);
    });

    it("enter and leave stay balanced across the whole crossing", () => {
      const log: string[] = [];
      mountNested(log);

      mouse("#btn", "mouseover", null);
      mouse("#btn", "mouseout", null);

      expect(log).toEqual(["card-enter", "btn-enter", "btn-leave", "card-leave"]);
    });

    it("does not re-enter an ancestor the pointer never left", () => {
      // Moving from the card's own padding onto the button enters the button
      // only: `relatedTarget` is inside the card, so the card was not entered.
      const log: string[] = [];
      mountNested(log);
      const card = app.querySelector("#card")!;

      mouse("#btn", "mouseover", card);

      expect(log).toEqual(["btn-enter"]);
    });

    it("an outer .stop keeps the inner handler from running", () => {
      const log: string[] = [];
      interp.registerFunction("card-enter", () => log.push("card-enter"));
      interp.registerFunction("btn-enter", () => log.push("btn-enter"));
      mountView(() => [
        ":div",
        { ":id": "card", ":on-mouseenter.stop": "card-enter" },
        [":button", { ":id": "btn", ":on-mouseenter": "btn-enter" }, "buy"],
      ]);

      mouse("#btn", "mouseover", null);

      expect(log).toEqual(["card-enter"]);
    });

    it("honours .once", () => {
      const calls = vi.fn();
      interp.registerFunction("hover", calls);
      mountView(() => [":div", { ":on-mouseenter.once": "hover", ":id": "d" }]);

      mouse("#d", "mouseover");
      mouse("#d", "mouseover");

      expect(calls).toHaveBeenCalledTimes(1);
    });

    it("honours .prevent before the handler", () => {
      const seen: boolean[] = [];
      interp.registerFunction("hover", (h: number) => seen.push(eventOf(h).defaultPrevented));
      mountView(() => [":div", { ":on-mouseleave.prevent": "hover", ":id": "d" }]);

      mouse("#d", "mouseout");

      expect(seen).toEqual([true]);
    });

    it("still fires with .capture — no capture phase exists to move it to", () => {
      // Documented no-op rather than a silent disable: mouseenter is derived
      // from mouseover, so there is nothing to capture.
      const calls = vi.fn();
      interp.registerFunction("hover", calls);
      mountView(() => [":div", { ":on-mouseenter.capture": "hover", ":id": "d" }]);

      mouse("#d", "mouseover");

      expect(calls).toHaveBeenCalledTimes(1);
    });
  });

  // --- edge cases ---------------------------------------------------------

  describe("edge cases", () => {
    it("an event from a non-element target runs nothing and throws nothing", () => {
      const calls = vi.fn();
      interp.registerFunction("go", calls);
      mountView(() => [":div", { ":on-click.prevent": "go", ":id": "d" }, "text"]);
      const text = app.querySelector("#d")!.firstChild!;
      expect(text.nodeType).toBe(3);

      expect(() => fire(text, "click")).not.toThrow();

      expect(calls).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
      expect(ctx.handles.size).toBe(0);
    });

    it("an event fired outside the mount root is ignored", () => {
      const calls = vi.fn();
      interp.registerFunction("go", calls);
      mountView(() => [":button", { ":on-click.capture": "go", ":id": "b" }, "go"]);

      fire(document.getElementById("other")!, "click");

      expect(calls).not.toHaveBeenCalled();
    });

    it("a modifier attribute with no handler attribute dispatches nothing", () => {
      // Hand-written DOM inside a mount target must not confuse the walk.
      interp.registerFunction("go", () => {});
      mountView(() => [":div", { ":id": "d" }]);
      const stray = document.createElement("button");
      stray.setAttribute("data-sema-mods-click", "prevent stop");
      app.querySelector("#d")!.appendChild(stray);

      const ev = fire(stray, "click");

      expect(ev.defaultPrevented).toBe(false);
      expect(ev.cancelBubble).toBe(false);
    });
  });

  // --- teardown -----------------------------------------------------------

  describe("teardown", () => {
    /** Re-create a handler-carrying node inside the (now empty) mount root. */
    const reinsert = (mods?: string): HTMLElement => {
      const el = document.createElement("button");
      el.setAttribute("data-sema-on-click", "go");
      if (mods) el.setAttribute("data-sema-mods-click", mods);
      app.appendChild(el);
      return el;
    };

    it("removes the capture listener on unmount", () => {
      // `removeEventListener` needs the capture flag to match; without it every
      // capture listener survives unmount and keeps dispatching into a dead
      // component.
      const calls = vi.fn();
      interp.registerFunction("go", calls);
      mountView(() => [":button", { ":on-click.capture": "go", ":id": "b" }, "go"]);
      click("#b");
      expect(calls).toHaveBeenCalledTimes(1);

      unmount();
      fire(reinsert("capture"), "click");

      expect(calls).toHaveBeenCalledTimes(1);
    });

    it("removes the bubble listener on unmount", () => {
      const calls = vi.fn();
      interp.registerFunction("go", calls);
      mountView(() => [":button", { ":on-click": "go", ":id": "b" }, "go"]);
      click("#b");

      unmount();
      fire(reinsert(), "click");

      expect(calls).toHaveBeenCalledTimes(1);
    });

    it("removes both listeners when the whole instance is disposed", () => {
      const calls = vi.fn();
      interp.registerFunction("go", calls);
      mountView(() => [":button", { ":on-click.capture": "go", ":id": "b" }, "go"]);

      disposeAllComponents(ctx);
      fire(reinsert("capture"), "click");
      fire(reinsert(), "click");

      expect(calls).not.toHaveBeenCalled();
    });

    it("two mounted components do not dispatch into each other", () => {
      const a = vi.fn();
      const b = vi.fn();
      interp.registerFunction("a-handler", a);
      interp.registerFunction("b-handler", b);
      mountView(() => [":button", { ":on-click.capture": "a-handler", ":id": "ba" }, "a"], "#app", "va");
      mountView(
        () => [":button", { ":on-click.capture": "b-handler", ":id": "bb" }, "b"],
        "#other",
        "vb",
      );

      document.querySelector("#bb")!.dispatchEvent(new Event("click", { bubbles: true }));

      expect(a).not.toHaveBeenCalled();
      expect(b).toHaveBeenCalledTimes(1);
    });
  });

  // --- dom/event-current-target ------------------------------------------

  describe("dom/event-current-target", () => {
    it("names the element that declared the handler, not the mount root", () => {
      let resolved: Element | null = null;
      interp.registerFunction("go", (h: number) => {
        const handle = interp.getFunction("dom/event-current-target")!(h);
        resolved = handle == null ? null : (ctx.handles.get(handle) as Element);
      });
      mountView(() => [
        ":div",
        { ":on-click": "go", ":id": "outer" },
        [":button", { ":id": "b" }, "go"],
      ]);

      click("#b");

      expect(resolved).toBe(app.querySelector("#outer"));
      expect(resolved).not.toBe(app);
    });

    it("is restored after the handler returns", () => {
      const order: string[] = [];
      interp.registerFunction("inner", (h: number) => {
        const handle = interp.getFunction("dom/event-current-target")!(h);
        order.push((ctx.handles.get(handle) as Element).id);
      });
      interp.registerFunction("outer", (h: number) => {
        const handle = interp.getFunction("dom/event-current-target")!(h);
        order.push((ctx.handles.get(handle) as Element).id);
      });
      mountView(() => [
        ":div",
        { ":on-click": "outer", ":id": "outer" },
        [":button", { ":on-click": "inner", ":id": "inner" }, "go"],
      ]);

      click("#inner");

      expect(order).toEqual(["inner", "outer"]);
    });
  });
});
