/**
 * SIP `on-*` event attributes: modifier parsing and encoding.
 *
 * The renderer half of event modifiers — what lands in the DOM. The delegator
 * half (what the modifiers actually *do*) lives in `event-modifiers.test.ts`,
 * where a real mount and the real morphdom are needed to observe it.
 *
 * The invariant these tests exist to hold is that the handler attribute keeps
 * carrying exactly the handler name: the delegator's upward walk matches on
 * `data-sema-on-<event>` and reads the value as a function name, so encoding
 * modifiers into the value would break every existing dispatch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  renderSip,
  parseEventAttrKey,
  readEventModifiers,
  eventModsAttr,
  EVENT_MODIFIERS,
  NO_EVENT_MODIFIERS,
  SIP_EVENT_MODS_PREFIX,
} from "../src/sip.js";
import { SemaWebContext } from "../src/context.js";
import { createMockInterpreter } from "./helpers.js";

describe("SIP event modifiers — rendering", () => {
  let interp: ReturnType<typeof createMockInterpreter>;
  let ctx: SemaWebContext;
  let errors: Array<{ message: string; context: string }>;

  beforeEach(() => {
    interp = createMockInterpreter();
    ctx = new SemaWebContext();
    errors = [];
    ctx.onerror = (e, context) => errors.push({ message: e.message, context });
  });

  const render = (attrs: Record<string, unknown>): HTMLElement =>
    renderSip([":button", attrs], interp, ctx) as HTMLElement;

  it("writes the handler name and the modifier separately", () => {
    const el = render({ ":on-click.prevent": "handle-click" });

    expect(el.getAttribute("data-sema-on-click")).toBe("handle-click");
    expect(el.getAttribute("data-sema-mods-click")).toBe("prevent");
    expect(errors).toEqual([]);
  });

  it("omits the modifier attribute entirely for an unmodified handler", () => {
    // Absence is the delegator's fast path — it must stay observably absent.
    const el = render({ ":on-click": "handle-click" });

    expect(el.getAttribute("data-sema-on-click")).toBe("handle-click");
    expect(el.hasAttribute("data-sema-mods-click")).toBe(false);
  });

  it("encodes modifiers in a canonical order regardless of how they were written", () => {
    // A re-render that reshuffles the source order must not churn the attribute.
    expect(render({ ":on-click.stop.prevent": "h" }).getAttribute("data-sema-mods-click")).toBe(
      "prevent stop",
    );
    expect(render({ ":on-click.prevent.stop": "h" }).getAttribute("data-sema-mods-click")).toBe(
      "prevent stop",
    );
  });

  it("dedupes a repeated modifier", () => {
    expect(render({ ":on-click.once.once": "h" }).getAttribute("data-sema-mods-click")).toBe("once");
  });

  it("encodes all five modifiers at once", () => {
    const el = render({ ":on-click.self.capture.once.stop.prevent": "h" });
    expect(el.getAttribute("data-sema-mods-click")).toBe("prevent stop once capture self");
  });

  it("accepts a plain (non-keyword) modified key", () => {
    const el = render({ "on-click.stop": "h" });
    expect(el.getAttribute("data-sema-mods-click")).toBe("stop");
  });

  it("keeps handler and modifiers in separate attributes for a hyphenated event name", () => {
    // The reason the modifier attribute is `data-sema-mods-<event>` and not
    // `data-sema-on-<event>-mods`: an event name may contain hyphens, so the
    // suffix form would make `{:on-foo-mods "h"}` indistinguishable from the
    // modifier set of event `foo`. Asserted on the encoding directly — the
    // renderer only writes routable event names, and none of those has a
    // hyphen, so this property has no rendering-level witness left.
    expect(parseEventAttrKey("on-my-event.stop")).toEqual({
      ok: true,
      event: "my-event",
      modifiers: ["stop"],
    });
    expect(eventModsAttr("my-event")).toBe("data-sema-mods-my-event");
    expect(eventModsAttr("foo")).not.toBe("data-sema-on-foo-mods");
  });

  it("records the event in ctx.captureEvents only for .capture", () => {
    render({ ":on-click.prevent": "h" });
    expect(ctx.captureEvents.size).toBe(0);

    render({ ":on-keydown.capture": "h" });
    expect(Array.from(ctx.captureEvents)).toEqual(["keydown"]);
  });
});

describe("SIP event modifiers — rejection", () => {
  let interp: ReturnType<typeof createMockInterpreter>;
  let ctx: SemaWebContext;
  let errors: Array<{ message: string; context: string }>;

  beforeEach(() => {
    interp = createMockInterpreter();
    ctx = new SemaWebContext();
    errors = [];
    ctx.onerror = (e, context) => errors.push({ message: e.message, context });
  });

  const render = (attrs: Record<string, unknown>): HTMLElement =>
    renderSip([":button", attrs], interp, ctx) as HTMLElement;

  it("rejects an unknown modifier rather than silently ignoring it", () => {
    // A dropped `.prevnt` lets a form navigate away with no signal anywhere.
    const el = render({ ":on-submit.prevnt": "save" });

    expect(el.hasAttribute("data-sema-on-submit")).toBe(false);
    expect(el.hasAttribute("data-sema-mods-submit")).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].context).toBe("sip-render:on-handler");
    expect(errors[0].message).toContain('Invalid event modifier "prevnt"');
    expect(errors[0].message).toContain("on-submit.prevnt");
    expect(errors[0].message).toContain("supported: prevent, stop, once, capture, self");
  });

  it("rejects an empty modifier", () => {
    const el = render({ ":on-click.": "h" });

    expect(el.hasAttribute("data-sema-on-click")).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Invalid event modifier ""');
  });

  it("rejects one bad modifier among good ones", () => {
    const el = render({ ":on-click.prevent.nope.stop": "h" });

    expect(el.hasAttribute("data-sema-on-click")).toBe(false);
    expect(el.hasAttribute("data-sema-mods-click")).toBe(false);
    expect(errors[0].message).toContain('Invalid event modifier "nope"');
  });

  it("keeps the existing message verbatim for a missing event name", () => {
    // The pre-existing error path, which modifiers must not have reworded.
    const el = render({ ":on-.prevent": "h" });

    expect(el.hasAttribute("data-sema-mods-")).toBe(false);
    expect(errors).toEqual([
      { message: "Invalid event handler attribute: on-.prevent", context: "sip-render:on-handler" },
    ]);
  });

  it("keeps the existing message for an empty on- key", () => {
    const el = render({ ":on-": "handle-click" });

    expect(el.hasAttribute("data-sema-on-")).toBe(false);
    expect(errors).toEqual([
      { message: "Invalid event handler attribute: on-", context: "sip-render:on-handler" },
    ]);
  });

  it("leaves no orphan modifier attribute when the handler NAME is invalid", () => {
    const el = render({ ":on-click.prevent": "123bad" });

    expect(el.hasAttribute("data-sema-on-click")).toBe(false);
    expect(el.hasAttribute("data-sema-mods-click")).toBe(false);
    expect(errors).toEqual([
      { message: "Invalid event handler name: 123bad", context: "sip-render:on-handler" },
    ]);
  });

  it("leaves no orphan modifier attribute when the handler VALUE is not a string", () => {
    const el = render({ ":on-click.stop": 42 });

    expect(el.hasAttribute("data-sema-on-click")).toBe(false);
    expect(el.hasAttribute("data-sema-mods-click")).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("must be a string");
  });

  it("a nil handler value is skipped without an error, modifiers or not", () => {
    const el = render({ ":on-click.stop": null });

    expect(el.hasAttribute("data-sema-on-click")).toBe(false);
    expect(el.hasAttribute("data-sema-mods-click")).toBe(false);
    expect(errors).toEqual([]);
  });

  it("rejects a typo in the EVENT name, which the delegator could never route", () => {
    // The whole point: `.prevent` on an event nothing listens for prevents
    // nothing, so the form navigates away. One transposition, and before this
    // the only signal was the missing behaviour itself.
    const el = render({ ":on-sumbit.prevent": "save" });

    expect(el.hasAttribute("data-sema-on-sumbit")).toBe(false);
    expect(el.hasAttribute("data-sema-mods-sumbit")).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].context).toBe("sip-render:on-handler");
    expect(errors[0].message).toContain('Unknown event "sumbit"');
    expect(errors[0].message).toContain('Did you mean "submit"?');
  });

  it("names the bubbling stand-in for an event that cannot be delegated", () => {
    const el = render({ ":on-focus": "select-all" });

    expect(el.hasAttribute("data-sema-on-focus")).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Event "focus"');
    expect(errors[0].message).toContain("does not bubble");
    expect(errors[0].message).toContain('Use "focusin"');
  });

  it("rejects a custom event name and points at dom/on!", () => {
    // A web component's event does bubble, but the delegator listens for a
    // fixed set — so an attribute for it is inert. Refused with the escape
    // hatch named rather than rendered and silently dead.
    const el = render({ ":on-picker-change.stop": "h" });

    expect(el.hasAttribute("data-sema-on-picker-change")).toBe(false);
    expect(el.hasAttribute("data-sema-mods-picker-change")).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Unknown event "picker-change"');
    expect(errors[0].message).toContain("dom/on!");
  });

  it("offers no suggestion when nothing is close", () => {
    render({ ":on-telepathy": "h" });

    expect(errors[0].message).toContain('Unknown event "telepathy"');
    expect(errors[0].message).not.toContain("Did you mean");
  });

  it("a rejected handler does not stop the rest of the attributes rendering", () => {
    const el = renderSip(
      [":button", { ":on-click.nope": "h", ":class": "btn", ":id": "b1" }],
      interp,
      ctx,
    ) as HTMLElement;

    expect(el.getAttribute("class")).toBe("btn");
    expect(el.id).toBe("b1");
  });
});

describe("parseEventAttrKey", () => {
  it.each([
    ["on-click", "click", []],
    ["on-submit.prevent", "submit", ["prevent"]],
    ["on-click.stop.once", "click", ["stop", "once"]],
    ["on-my-event.self", "my-event", ["self"]],
    ["on-keydown.capture", "keydown", ["capture"]],
    ["on-click.once.stop.prevent", "click", ["prevent", "stop", "once"]],
  ])("parses %p", (key, event, modifiers) => {
    expect(parseEventAttrKey(key)).toEqual({ ok: true, event, modifiers });
  });

  it.each([
    ["on-", "Invalid event handler attribute: on-"],
    ["on-.prevent", "Invalid event handler attribute: on-.prevent"],
    ["on-9bad", "Invalid event handler attribute: on-9bad"],
    ["on-has space", "Invalid event handler attribute: on-has space"],
  ])("rejects %p with the event-name message", (key, error) => {
    expect(parseEventAttrKey(key)).toEqual({ ok: false, error });
  });

  it.each(["on-click.prevnt", "on-click.", "on-click.PREVENT", "on-click.prevent.x"])(
    "rejects %p as a bad modifier",
    (key) => {
      const parsed = parseEventAttrKey(key);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("Invalid event modifier");
    },
  );

  it("exposes the supported modifiers as a stable list", () => {
    expect(EVENT_MODIFIERS).toEqual(["prevent", "stop", "once", "capture", "self"]);
  });
});

describe("readEventModifiers", () => {
  const withAttr = (value?: string): Element => {
    const el = document.createElement("button");
    if (value !== undefined) el.setAttribute(eventModsAttr("click"), value);
    return el;
  };

  it("returns the shared all-false singleton when the attribute is absent", () => {
    // Identity, not just equality: the hot dispatch path must not allocate.
    expect(readEventModifiers(withAttr(), "click")).toBe(NO_EVENT_MODIFIERS);
  });

  it("returns the singleton for an empty attribute value", () => {
    expect(readEventModifiers(withAttr(""), "click")).toBe(NO_EVENT_MODIFIERS);
  });

  it("decodes a single modifier", () => {
    expect(readEventModifiers(withAttr("stop"), "click")).toEqual({
      prevent: false,
      stop: true,
      once: false,
      capture: false,
      self: false,
    });
  });

  it("decodes several modifiers", () => {
    const mods = readEventModifiers(withAttr("prevent stop once"), "click");
    expect(mods.prevent).toBe(true);
    expect(mods.stop).toBe(true);
    expect(mods.once).toBe(true);
    expect(mods.capture).toBe(false);
    expect(mods.self).toBe(false);
  });

  it("ignores garbage tokens instead of throwing", () => {
    // Hand-written or third-party DOM can hold anything; a bad token must not
    // take down a dispatch.
    const mods = readEventModifiers(withAttr("garbage constructor __proto__ self"), "click");
    expect(mods.self).toBe(true);
    expect(mods.prevent).toBe(false);
  });

  it("reads the attribute for the requested event only", () => {
    const el = withAttr("prevent");
    expect(readEventModifiers(el, "submit")).toBe(NO_EVENT_MODIFIERS);
  });

  it("the all-false singleton is frozen", () => {
    expect(Object.isFrozen(NO_EVENT_MODIFIERS)).toBe(true);
  });

  it("eventModsAttr composes the documented prefix", () => {
    expect(SIP_EVENT_MODS_PREFIX).toBe("data-sema-mods-");
    expect(eventModsAttr("submit")).toBe("data-sema-mods-submit");
  });
});

describe("SIP event modifiers — attribute lifecycle", () => {
  it("a re-render that drops the modifier drops the attribute", () => {
    // morphdom syncs attributes from the freshly rendered clone, so this is the
    // property that keeps a removed `.prevent` from lingering in the DOM.
    const interp = createMockInterpreter();
    const ctx = new SemaWebContext();
    const withMod = renderSip([":button", { ":on-click.prevent": "h" }], interp, ctx) as HTMLElement;
    const withoutMod = renderSip([":button", { ":on-click": "h" }], interp, ctx) as HTMLElement;

    expect(withMod.hasAttribute("data-sema-mods-click")).toBe(true);
    expect(withoutMod.hasAttribute("data-sema-mods-click")).toBe(false);
  });

  it("modifiers survive on a child rendered inside a list", () => {
    const list = renderSip(
      [
        ":ul",
        {},
        [":li", { ":key": 1 }, [":button", { ":on-click.stop": "pick" }, "a"]],
        [":li", { ":key": 2 }, [":button", { ":on-click.stop": "pick" }, "b"]],
      ],
      createMockInterpreter(),
      new SemaWebContext(),
    ) as HTMLElement;

    const encoded = Array.from(list.querySelectorAll("button")).map((b) =>
      b.getAttribute("data-sema-mods-click"),
    );
    expect(encoded).toEqual(["stop", "stop"]);
  });

  it("does not touch console.error — everything routes through ctx.onerror", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = new SemaWebContext();
    ctx.onerror = () => {};
    renderSip([":button", { ":on-click.bogus": "h" }], createMockInterpreter(), ctx);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
