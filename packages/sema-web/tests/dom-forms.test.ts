/**
 * Form helpers: `dom/event-form-data` and the checkbox/radio/select readers.
 *
 * The shape rules are the whole point — a repeated field name that collapses
 * to its last value, or a key that arrives with a stray colon, is data loss
 * that surfaces as a nil read with no error anywhere. Every rule therefore has
 * a test that fails when it is relaxed.
 *
 * The pure helpers are exercised directly as well as through the bindings,
 * because jsdom will not let a populated file input be driven through a real
 * `FormData` (`Object.defineProperty(input, "files", …)` does not reach its
 * internal file list), and the `File` branch still has to be covered.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { registerDomBindings, resolveForm, formDataToFields, formFields } from "../src/dom.js";
import { SemaWebContext } from "../src/context.js";
import { createMockInterpreter } from "./helpers.js";
import { storeHandle } from "../src/handles.js";

describe("form helpers", () => {
  let interp: ReturnType<typeof createMockInterpreter>;
  let ctx: SemaWebContext;

  beforeEach(() => {
    interp = createMockInterpreter();
    ctx = new SemaWebContext();
    registerDomBindings(interp, ctx);
    document.body.innerHTML = "";
  });

  const call = (name: string, ...args: unknown[]) => interp.getFunction(name)!(...args);

  /** An event whose target is `node`, stored as a handle. */
  const eventOn = (node: Node, type = "submit", extra: Record<string, unknown> = {}): number => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "target", { value: node });
    for (const [key, value] of Object.entries(extra)) {
      Object.defineProperty(ev, key, { value });
    }
    return storeHandle(ev, ctx)!;
  };

  const form = (html: string): HTMLFormElement => {
    document.body.insertAdjacentHTML("beforeend", `<form id="f">${html}</form>`);
    return document.getElementById("f") as HTMLFormElement;
  };

  // --- value shape --------------------------------------------------------

  describe("field shape", () => {
    it("returns a repeated field name as a list", () => {
      // The acceptance criterion.
      const f = form('<input name="tag" value="a"><input name="tag" value="b">');

      expect(call("dom/event-form-data", eventOn(f))).toEqual({ tag: ["a", "b"] });
    });

    it("returns a single occurrence as a bare string, not a one-element list", () => {
      const f = form('<input name="title" value="hello">');

      expect(call("dom/event-form-data", eventOn(f))).toEqual({ title: "hello" });
    });

    it("collects three occurrences into one list, in document order", () => {
      const f = form(
        '<input name="t" value="a"><input name="t" value="b"><input name="t" value="c">',
      );

      expect(call("dom/event-form-data", eventOn(f))).toEqual({ t: ["a", "b", "c"] });
    });

    it("keys carry no colon prefix", () => {
      // Object keys are keywordized on the way into Sema, so `title` becomes
      // `:title`. Prefixing here would yield `::title` and every field would
      // read nil with no error — the exact failure the prefix is meant to fix.
      const f = form('<input name="title" value="hello"><input name="tag" value="a">');

      const fields = call("dom/event-form-data", eventOn(f)) as Record<string, unknown>;

      expect(Object.keys(fields)).toEqual(["title", "tag"]);
      for (const key of Object.keys(fields)) expect(key.startsWith(":")).toBe(false);
    });

    it("survives a field literally named __proto__ without corrupting the result", () => {
      const f = form('<input name="__proto__" value="x"><input name="ok" value="y">');

      const fields = call("dom/event-form-data", eventOn(f)) as Record<string, unknown>;

      expect(fields["__proto__"]).toBe("x");
      expect(fields.ok).toBe("y");
    });

    it("an empty form yields an empty map, not nil", () => {
      const f = form("");

      expect(call("dom/event-form-data", eventOn(f))).toEqual({});
    });
  });

  // --- what FormData includes and excludes --------------------------------

  describe("inclusion rules", () => {
    it("excludes disabled and unnamed controls", () => {
      const f = form(
        '<input name="live" value="1"><input name="dead" value="2" disabled><input value="3">',
      );

      expect(call("dom/event-form-data", eventOn(f))).toEqual({ live: "1" });
    });

    it("includes a checked checkbox as \"on\" and omits an unchecked one", () => {
      const f = form(
        '<input type="checkbox" name="yes" checked><input type="checkbox" name="no">',
      );

      expect(call("dom/event-form-data", eventOn(f))).toEqual({ yes: "on" });
    });

    it("uses an explicit checkbox value when one is given", () => {
      const f = form('<input type="checkbox" name="flag" value="cheese" checked>');

      expect(call("dom/event-form-data", eventOn(f))).toEqual({ flag: "cheese" });
    });

    it("includes only the checked radio of a group", () => {
      const f = form(
        '<input type="radio" name="size" value="s">' +
          '<input type="radio" name="size" value="m" checked>' +
          '<input type="radio" name="size" value="l">',
      );

      expect(call("dom/event-form-data", eventOn(f))).toEqual({ size: "m" });
    });

    it("includes a single select's value and a multi-select's values as a list", () => {
      const f = form(
        '<select name="one"><option value="a">a</option><option value="b" selected>b</option></select>' +
          '<select name="many" multiple>' +
          '<option value="x" selected>x</option>' +
          '<option value="y" selected>y</option>' +
          '<option value="z">z</option>' +
          "</select>",
      );

      expect(call("dom/event-form-data", eventOn(f))).toEqual({ one: "b", many: ["x", "y"] });
    });

    it("describes an empty file input as a name/size/type map", () => {
      // A File JSON-stringifies to `{}` across the WASM boundary, so it has to
      // be flattened before it leaves here.
      const f = form('<input type="file" name="doc">');

      expect(call("dom/event-form-data", eventOn(f))).toEqual({
        doc: { name: "", size: 0, type: "application/octet-stream" },
      });
    });
  });

  // --- formDataToFields directly -----------------------------------------

  describe("formDataToFields", () => {
    it("flattens a populated File to name, size, and type", () => {
      const fd = new FormData();
      fd.append("doc", new File(["abc"], "a.txt", { type: "text/plain" }));

      expect(formDataToFields(fd)).toEqual({
        doc: { name: "a.txt", size: 3, type: "text/plain" },
      });
    });

    it("mixes strings and files under one repeated name", () => {
      const fd = new FormData();
      fd.append("mix", "first");
      fd.append("mix", new File(["ab"], "b.bin", { type: "application/octet-stream" }));

      expect(formDataToFields(fd)).toEqual({
        mix: ["first", { name: "b.bin", size: 2, type: "application/octet-stream" }],
      });
    });

    it("keeps an empty-string value rather than dropping it", () => {
      const fd = new FormData();
      fd.append("note", "");

      expect(formDataToFields(fd)).toEqual({ note: "" });
    });
  });

  // --- nested forms -------------------------------------------------------

  describe("nested forms", () => {
    /**
     * Built with `createElement`, because the HTML parser silently drops a
     * nested `<form>` tag and `innerHTML` cannot express this shape at all.
     */
    const nested = () => {
      const outer = document.createElement("form");
      const inner = document.createElement("form");
      const outerInput = document.createElement("input");
      outerInput.name = "outer";
      outerInput.value = "O";
      const innerInput = document.createElement("input");
      innerInput.name = "inner";
      innerInput.value = "I";
      outer.append(outerInput, inner);
      inner.append(innerInput);
      document.body.appendChild(outer);
      return { outer, inner, outerInput, innerInput };
    };

    it("a target inside the inner form yields only the inner fields", () => {
      const { innerInput } = nested();

      expect(call("dom/event-form-data", eventOn(innerInput, "input"))).toEqual({ inner: "I" });
    });

    it("a target in the outer form yields only the outer fields", () => {
      const { outerInput } = nested();

      expect(call("dom/event-form-data", eventOn(outerInput, "input"))).toEqual({ outer: "O" });
    });

    it("dom/event-form resolves to the nearest owning form", () => {
      const { inner, innerInput } = nested();

      const handle = call("dom/event-form", eventOn(innerInput, "input")) as number;

      expect(ctx.handles.get(handle)).toBe(inner);
    });
  });

  // --- submitter ----------------------------------------------------------

  describe("submitter", () => {
    it("includes the submitting button's own name and value", () => {
      const f = form(
        '<input name="title" value="t">' +
          '<button type="submit" name="action" value="save">save</button>',
      );
      const button = f.querySelector("button")!;

      const fields = call("dom/event-form-data", eventOn(f, "submit", { submitter: button }));

      expect(fields).toEqual({ title: "t", action: "save" });
    });

    it("omits it when the submission had no submitter", () => {
      const f = form(
        '<input name="title" value="t">' +
          '<button type="submit" name="action" value="save">save</button>',
      );

      expect(call("dom/event-form-data", eventOn(f))).toEqual({ title: "t" });
    });

    it("falls back to the plain form when the submitter belongs elsewhere", () => {
      // A foreign submitter is a DOMException; losing the whole extraction
      // over it would be far worse than losing the button's own value.
      const f = form('<input name="title" value="t">');
      const foreign = document.createElement("form");
      const button = document.createElement("button");
      button.name = "action";
      button.value = "save";
      foreign.appendChild(button);
      document.body.appendChild(foreign);

      expect(formFields(f, button)).toEqual({ title: "t" });
    });
  });

  // --- resolveForm --------------------------------------------------------

  describe("resolveForm", () => {
    it("returns a form handed to it directly", () => {
      const f = form('<input name="a" value="1">');
      expect(resolveForm(f)).toBe(f);
    });

    it("resolves a control associated by form=\"id\" from outside the form", () => {
      // `.form` sees this association; `closest("form")` cannot.
      document.body.insertAdjacentHTML(
        "beforeend",
        '<form id="assoc"><input name="in" value="1"></form><input form="assoc" name="out" value="2">',
      );
      const outside = document.querySelector('input[form="assoc"]')!;

      expect(outside.closest("form")).toBeNull();
      expect(resolveForm(outside)).toBe(document.getElementById("assoc"));
    });

    it("walks up to an ancestor form for a non-control element", () => {
      const f = form('<div id="wrap"><span id="deep">x</span></div>');

      expect(resolveForm(document.getElementById("deep"))).toBe(f);
    });

    it("returns null for a form-less element, a text node, and a non-node", () => {
      document.body.insertAdjacentHTML("beforeend", '<div id="loose"></div>');

      expect(resolveForm(document.getElementById("loose"))).toBeNull();
      expect(resolveForm(document.createTextNode("x"))).toBeNull();
      expect(resolveForm(null)).toBeNull();
      expect(resolveForm(42)).toBeNull();
    });
  });

  // --- nil paths ----------------------------------------------------------

  describe("absent and non-element targets", () => {
    it("dom/event-form-data returns nil for a non-element target", () => {
      expect(call("dom/event-form-data", eventOn(document.createTextNode("x")))).toBeNull();
    });

    it("dom/event-form-data returns nil when nothing owns a form", () => {
      document.body.insertAdjacentHTML("beforeend", '<div id="loose"></div>');

      expect(call("dom/event-form-data", eventOn(document.getElementById("loose")!))).toBeNull();
    });

    it("dom/event-form returns nil rather than allocating a handle", () => {
      expect(call("dom/event-form", eventOn(document.createTextNode("x")))).toBeNull();
      expect(call("dom/event-selected-values", eventOn(document.createTextNode("x")))).toBeNull();
      expect(call("dom/event-checked", eventOn(document.createTextNode("x")))).toBeNull();
    });

    it("dom/form-data resolves from a plain element inside a form", () => {
      const f = form('<input name="a" value="1"><span id="deep">x</span>');

      expect(call("dom/form-data", storeHandle(document.getElementById("deep"), ctx))).toEqual({
        a: "1",
      });
      expect(call("dom/form-data", storeHandle(f, ctx))).toEqual({ a: "1" });
    });

    it("dom/form-data returns nil for an element with no owning form", () => {
      document.body.insertAdjacentHTML("beforeend", '<div id="loose"></div>');

      expect(call("dom/form-data", storeHandle(document.getElementById("loose"), ctx))).toBeNull();
    });
  });

  // --- checked ------------------------------------------------------------

  describe("checked helpers", () => {
    it("dom/event-checked reports a checkbox's live state", () => {
      document.body.insertAdjacentHTML("beforeend", '<input type="checkbox" id="c">');
      const box = document.getElementById("c") as HTMLInputElement;

      expect(call("dom/event-checked", eventOn(box, "change"))).toBe(false);
      box.checked = true;
      expect(call("dom/event-checked", eventOn(box, "change"))).toBe(true);
    });

    it("dom/event-checked returns nil for a target with no checked state", () => {
      document.body.insertAdjacentHTML("beforeend", '<div id="d"></div>');

      expect(call("dom/event-checked", eventOn(document.getElementById("d")!, "click"))).toBeNull();
    });

    it("dom/checked? reads an element handle and is false for a non-input", () => {
      document.body.insertAdjacentHTML(
        "beforeend",
        '<input type="radio" id="r" checked><div id="d"></div>',
      );

      expect(call("dom/checked?", storeHandle(document.getElementById("r"), ctx))).toBe(true);
      expect(call("dom/checked?", storeHandle(document.getElementById("d"), ctx))).toBe(false);
    });
  });

  // --- select -------------------------------------------------------------

  describe("selected-values", () => {
    const select = (multiple: boolean, selected: string[]) => {
      const el = document.createElement("select");
      el.multiple = multiple;
      for (const value of ["x", "y", "z"]) {
        const option = document.createElement("option");
        option.value = value;
        option.selected = selected.includes(value);
        el.appendChild(option);
      }
      document.body.appendChild(el);
      return el;
    };

    it("lists every selected option of a multi-select", () => {
      const el = select(true, ["x", "z"]);

      expect(call("dom/selected-values", storeHandle(el, ctx))).toEqual(["x", "z"]);
    });

    it("returns a one-element list for a single select", () => {
      const el = select(false, ["y"]);

      expect(call("dom/selected-values", storeHandle(el, ctx))).toEqual(["y"]);
    });

    it("returns an empty list when a multi-select has nothing selected", () => {
      const el = select(true, []);

      expect(call("dom/selected-values", storeHandle(el, ctx))).toEqual([]);
    });

    it("returns an empty list for an element that is not a select", () => {
      document.body.insertAdjacentHTML("beforeend", '<div id="d"></div>');

      expect(call("dom/selected-values", storeHandle(document.getElementById("d"), ctx))).toEqual(
        [],
      );
    });

    it("dom/event-selected-values reads the event's target", () => {
      const el = select(true, ["y", "z"]);

      expect(call("dom/event-selected-values", eventOn(el, "change"))).toEqual(["y", "z"]);
    });
  });

  // --- dom/event-current-target outside delegation ------------------------

  describe("dom/event-current-target on a plain dom/on! listener", () => {
    it("reports the element the listener was attached to", () => {
      document.body.insertAdjacentHTML("beforeend", '<div id="wrap"><button id="b"></button></div>');
      const wrap = document.getElementById("wrap")!;
      const handle = storeHandle(wrap, ctx)!;
      let resolved: Element | null = null;

      call("dom/on!", handle, "click", (evHandle: number) => {
        const currentHandle = call("dom/event-current-target", evHandle) as number | null;
        resolved = currentHandle == null ? null : (ctx.handles.get(currentHandle) as Element);
      });
      document.getElementById("b")!.dispatchEvent(new Event("click", { bubbles: true }));

      expect(resolved).toBe(wrap);
    });

    it("returns nil for an event that is not being dispatched", () => {
      expect(call("dom/event-current-target", eventOn(document.createElement("div")))).toBeNull();
    });
  });
});
