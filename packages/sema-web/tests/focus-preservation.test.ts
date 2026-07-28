/**
 * What a re-render may and may not do to the element the user is working in.
 *
 * The renderer protects a focused INPUT / TEXTAREA / SELECT from morphdom,
 * because morphdom's own handlers for those tags assign `value` and
 * `selectedIndex` from the freshly rendered clone and would throw away what the
 * user typed or picked. Everything morphdom would otherwise have done to the
 * element then falls to the renderer, and *that* is what these tests pin: an
 * exemption from the value sync is not an exemption from the patch.
 *
 * Uses the REAL morphdom, like `sip-keys.test.ts` and for the same reason: the
 * `innerHTML`-swap stub other suites install rebuilds every node, so a focused
 * element would never survive to be patched at all and a broken implementation
 * would pass.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SemaWebContext } from "../src/context.js";
import { registerComponentBindings, disposeAllComponents } from "../src/component.js";
import { registerReactiveBindings } from "../src/reactive.js";
import { createMockInterpreter } from "./helpers.js";

describe("focused-element morph", () => {
  let interp: ReturnType<typeof createMockInterpreter>;
  let ctx: SemaWebContext;
  let errors: Array<{ message: string; context: string }>;
  let app: HTMLElement;

  beforeEach(() => {
    interp = createMockInterpreter();
    ctx = new SemaWebContext();
    errors = [];
    document.body.innerHTML = '<div id="app"></div>';
    app = document.getElementById("app")!;
    registerComponentBindings(interp, ctx);
    registerReactiveBindings(interp, ctx);
    ctx.onerror = (e, context) => errors.push({ message: e.message, context });
  });

  afterEach(() => {
    disposeAllComponents(ctx);
  });

  const mountView = (view: () => any) => {
    interp.registerFunction("v", view);
    interp.getFunction("component/mount!")!("#app", "v");
  };
  const createSignal = (v: unknown) => interp.getFunction("__state/create")!(v) as number;
  const readSignal = (id: number) => interp.getFunction("__state/deref")!(id);
  const writeSignal = (id: number, v: unknown) => interp.getFunction("__state/put!")!(id, v);
  const fire = (node: Node, type: string): Event => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    node.dispatchEvent(ev);
    return ev;
  };

  describe("attributes", () => {
    it("removes an attribute the new render no longer declares", () => {
      const phase = createSignal(0);
      mountView(() =>
        readSignal(phase) === 0
          ? [":input", { ":id": "i", ":class": "armed", ":required": true, ":aria-invalid": "true" }]
          : [":input", { ":id": "i" }],
      );
      const input = app.querySelector("#i") as HTMLInputElement;
      input.focus();
      expect(document.activeElement).toBe(input);
      expect(input.getAttribute("class")).toBe("armed");

      writeSignal(phase, 1);

      expect(app.querySelector("#i")).toBe(input);
      expect(input.hasAttribute("class")).toBe(false);
      expect(input.hasAttribute("required")).toBe(false);
      expect(input.hasAttribute("aria-invalid")).toBe(false);
    });

    it("still applies an attribute the new render adds", () => {
      const phase = createSignal(0);
      mountView(() =>
        readSignal(phase) === 0
          ? [":input", { ":id": "i" }]
          : [":input", { ":id": "i", ":class": "error", ":aria-invalid": "true" }],
      );
      const input = app.querySelector("#i") as HTMLInputElement;
      input.focus();

      writeSignal(phase, 1);

      expect(input.getAttribute("class")).toBe("error");
      expect(input.getAttribute("aria-invalid")).toBe("true");
    });

    it("leaves the live value alone while the attributes change around it", () => {
      // The reason this whole path exists. A render that reaches the element
      // must not retype the user's input.
      const phase = createSignal(0);
      mountView(() =>
        readSignal(phase) === 0
          ? [":input", { ":id": "i", ":value": "rendered", ":class": "a" }]
          : [":input", { ":id": "i", ":value": "rendered", ":class": "b" }],
      );
      const input = app.querySelector("#i") as HTMLInputElement;
      input.focus();
      input.value = "half typed";

      writeSignal(phase, 1);

      expect(input.value).toBe("half typed");
      expect(input.getAttribute("class")).toBe("b");
    });

    it("updates an unfocused sibling the ordinary way", () => {
      // The control that isolates the branch: the same removal through
      // morphdom's own attribute sync.
      const phase = createSignal(0);
      mountView(() => [
        ":div",
        {},
        [":input", { ":id": "focused" }],
        readSignal(phase) === 0
          ? [":input", { ":id": "other", ":class": "armed" }]
          : [":input", { ":id": "other" }],
      ]);
      (app.querySelector("#focused") as HTMLInputElement).focus();

      writeSignal(phase, 1);

      expect(app.querySelector("#other")!.hasAttribute("class")).toBe(false);
    });
  });

  describe("delegated handlers", () => {
    it("stops dispatching a handler the new render removed", () => {
      // The damaging half of a missed removal: `data-sema-on-*` is what the
      // delegator matches on, so a stale one keeps calling a handler the
      // current render does not declare — forever, with no error anywhere.
      const calls = vi.fn();
      interp.registerFunction("bump", calls);
      const armed = createSignal(true);
      mountView(() =>
        readSignal(armed)
          ? [":input", { ":id": "i", ":on-keydown": "bump" }]
          : [":input", { ":id": "i" }],
      );
      const input = app.querySelector("#i") as HTMLInputElement;
      input.focus();

      fire(input, "keydown");
      expect(calls).toHaveBeenCalledTimes(1);
      writeSignal(armed, false);
      fire(input, "keydown");

      expect(input.hasAttribute("data-sema-on-keydown")).toBe(false);
      expect(calls).toHaveBeenCalledTimes(1);
      expect(errors).toEqual([]);
    });

    it("stops applying a modifier the new render dropped", () => {
      const armed = createSignal(true);
      interp.registerFunction("go", () => {});
      mountView(() =>
        readSignal(armed)
          ? [":input", { ":id": "i", ":on-keydown.prevent": "go" }]
          : [":input", { ":id": "i", ":on-keydown": "go" }],
      );
      const input = app.querySelector("#i") as HTMLInputElement;
      input.focus();
      expect(fire(input, "keydown").defaultPrevented).toBe(true);

      writeSignal(armed, false);

      expect(input.hasAttribute("data-sema-mods-keydown")).toBe(false);
      expect(fire(input, "keydown").defaultPrevented).toBe(false);
    });
  });

  describe("a focused <select>", () => {
    const options = (): string[] =>
      Array.from(app.querySelectorAll("option")).map((o) => o.getAttribute("value")!);

    it("receives options the new render added", () => {
      // A dependent dropdown whose options load asynchronously must update for
      // the user who has it focused — precisely the user about to pick from it.
      const list = createSignal(["a"]);
      mountView(() => [
        ":select",
        { ":id": "s" },
        ...(readSignal(list) as string[]).map((o) => [":option", { ":value": o }, o]),
      ]);
      const select = app.querySelector("#s") as HTMLSelectElement;
      select.focus();
      expect(options()).toEqual(["a"]);

      writeSignal(list, ["a", "b", "c"]);

      expect(options()).toEqual(["a", "b", "c"]);
      expect(app.querySelector("#s")).toBe(select);
      expect(document.activeElement).toBe(select);
    });

    it("loses options the new render removed", () => {
      const list = createSignal(["a", "b", "c"]);
      mountView(() => [
        ":select",
        { ":id": "s" },
        ...(readSignal(list) as string[]).map((o) => [":option", { ":value": o }, o]),
      ]);
      (app.querySelector("#s") as HTMLSelectElement).focus();

      writeSignal(list, ["a"]);

      expect(options()).toEqual(["a"]);
    });

    it("keeps what the user picked across an option patch", () => {
      // Selecting sets the `selected` *property*; only markup sets the
      // attribute morphdom drives `selectedIndex` from. Patching the options
      // must not therefore silently reset the choice.
      const list = createSignal(["a", "b"]);
      mountView(() => [
        ":select",
        { ":id": "s" },
        ...(readSignal(list) as string[]).map((o) => [":option", { ":value": o }, o]),
      ]);
      const select = app.querySelector("#s") as HTMLSelectElement;
      select.focus();
      select.value = "b";

      writeSignal(list, ["a", "b", "c"]);

      expect(select.value).toBe("b");
    });

    it("does not force a selection when the picked option is gone", () => {
      const list = createSignal(["a", "b"]);
      mountView(() => [
        ":select",
        { ":id": "s" },
        ...(readSignal(list) as string[]).map((o) => [":option", { ":value": o }, o]),
      ]);
      const select = app.querySelector("#s") as HTMLSelectElement;
      select.focus();
      select.value = "b";

      writeSignal(list, ["a"]);

      expect(options()).toEqual(["a"]);
      expect(select.value).toBe("a");
    });

    it("keeps every pick of a focused multi-select", () => {
      const list = createSignal(["a", "b"]);
      mountView(() => [
        ":select",
        { ":id": "s", ":multiple": true },
        ...(readSignal(list) as string[]).map((o) => [":option", { ":value": o }, o]),
      ]);
      const select = app.querySelector("#s") as HTMLSelectElement;
      select.focus();
      for (const option of Array.from(select.options)) option.selected = true;

      writeSignal(list, ["a", "b", "c"]);

      expect(Array.from(select.selectedOptions).map((o) => o.value)).toEqual(["a", "b"]);
    });
  });

  describe("a focused <textarea>", () => {
    it("keeps its live value when the render changes its default text", () => {
      // TEXTAREA is deliberately exempt from the child patch: its child text
      // node IS the default value, and morphdom's TEXTAREA handler pushes that
      // into the live value.
      const phase = createSignal(0);
      mountView(() => [
        ":textarea",
        { ":id": "t", ":class": readSignal(phase) === 0 ? "a" : "b" },
        readSignal(phase) === 0 ? "first" : "second",
      ]);
      const area = app.querySelector("#t") as HTMLTextAreaElement;
      area.focus();
      area.value = "half typed";

      writeSignal(phase, 1);

      expect(area.value).toBe("half typed");
      expect(area.getAttribute("class")).toBe("b");
    });
  });
});
