/**
 * Keyed-list identity for SIP.
 *
 * Deliberately uses the REAL morphdom. `component.test.ts` stubs it with an
 * `innerHTML` swap, which is fine for asserting that markup ends up in the
 * page but destroys every node on every render — the exact behaviour keys
 * exist to prevent. A keyed-list test against that stub would pass while
 * proving nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import morphdom from "morphdom";
import { renderSip, sipNodeKey, SIP_KEY_ATTR } from "../src/sip.js";
import { sipMorphOptions } from "../src/component.js";
import { SemaWebContext } from "../src/context.js";
import { createMockInterpreter } from "./helpers.js";

function render(ctx: SemaWebContext, sip: any): Element {
  const interp = createMockInterpreter();
  return renderSip(sip, interp, ctx) as Element;
}

/**
 * Patch `target` towards the tree `sip` describes, the way a render does.
 *
 * Uses the renderer's own morphdom options rather than a hand-written subset —
 * `onBeforeElUpdated` (which protects what the user is typing) is as much a
 * part of "reordering preserves state" as `getNodeKey` is.
 */
function morph(ctx: SemaWebContext, target: Element, sip: any): void {
  const clone = target.cloneNode(false) as Element;
  clone.appendChild(render(ctx, sip));
  morphdom(target, clone, sipMorphOptions(ctx, document.activeElement));
}

function list(ids: number[]): any {
  return [
    ":ul",
    {},
    ...ids.map((id) => [":li", { ":key": id }, [":input", { ":value": `v${id}` }]]),
  ];
}

describe("SIP :key", () => {
  let ctx: SemaWebContext;

  beforeEach(() => {
    ctx = new SemaWebContext();
    document.body.innerHTML = "";
  });

  describe("rendering", () => {
    it("emits the key as a namespaced data attribute", () => {
      const el = render(ctx, [":li", { ":key": "abc" }, "row"]);
      expect(el.getAttribute(SIP_KEY_ATTR)).toBe("abc");
    });

    it("does not leave a bare `key` attribute in the DOM", () => {
      const el = render(ctx, [":li", { ":key": "abc" }, "row"]);
      expect(el.hasAttribute("key")).toBe(false);
    });

    it("stringifies a numeric key", () => {
      // Sema ids are usually numbers; morphdom compares keys as strings, so a
      // number and its string form must name the same node.
      const el = render(ctx, [":li", { ":key": 42 }, "row"]);
      expect(el.getAttribute(SIP_KEY_ATTR)).toBe("42");
    });

    it("accepts a plain (non-keyword) key attribute", () => {
      const el = render(ctx, [":li", { key: "abc" }, "row"]);
      expect(el.getAttribute(SIP_KEY_ATTR)).toBe("abc");
    });

    it("skips a nil key rather than writing the string 'null'", () => {
      const el = render(ctx, [":li", { ":key": null }, "row"]);
      expect(el.hasAttribute(SIP_KEY_ATTR)).toBe(false);
    });
  });

  describe("sipNodeKey", () => {
    it("reads the key attribute", () => {
      const el = document.createElement("li");
      el.setAttribute(SIP_KEY_ATTR, "k1");
      expect(sipNodeKey(el)).toBe("k1");
    });

    it("falls back to id — morphdom's own default, which we override", () => {
      const el = document.createElement("li");
      el.id = "row-3";
      expect(sipNodeKey(el)).toBe("row-3");
    });

    it("prefers an explicit key over id", () => {
      const el = document.createElement("li");
      el.id = "row-3";
      el.setAttribute(SIP_KEY_ATTR, "k1");
      expect(sipNodeKey(el)).toBe("k1");
    });

    it("returns undefined for an unkeyed element", () => {
      expect(sipNodeKey(document.createElement("li"))).toBeUndefined();
    });

    it("returns undefined for a text node", () => {
      expect(sipNodeKey(document.createTextNode("hi"))).toBeUndefined();
    });
  });

  describe("reordering preserves node identity", () => {
    it("keeps the same DOM node for a key that moved", () => {
      const root = document.createElement("div");
      document.body.appendChild(root);
      morph(ctx, root, list([1, 2, 3]));
      const originalSecond = root.querySelector(`[${SIP_KEY_ATTR}="2"]`)!;

      morph(ctx, root, list([3, 2, 1]));

      const movedSecond = root.querySelector(`[${SIP_KEY_ATTR}="2"]`)!;
      expect(movedSecond).toBe(originalSecond);
    });

    it("actually reorders the rendered order", () => {
      const root = document.createElement("div");
      document.body.appendChild(root);
      morph(ctx, root, list([1, 2, 3]));

      morph(ctx, root, list([3, 1, 2]));

      const keys = Array.from(root.querySelectorAll(`[${SIP_KEY_ATTR}]`)).map((el) =>
        el.getAttribute(SIP_KEY_ATTR),
      );
      expect(keys).toEqual(["3", "1", "2"]);
    });

    it("keeps focus and the typed value on the row that moved", () => {
      // The user-visible symptom keys exist to fix: without them morphdom
      // matches by position, so reordering retargets a half-typed input.
      const root = document.createElement("div");
      document.body.appendChild(root);
      morph(ctx, root, list([1, 2, 3]));

      const input = root
        .querySelector(`[${SIP_KEY_ATTR}="2"]`)!
        .querySelector("input") as HTMLInputElement;
      input.focus();
      input.value = "half typed";
      expect(document.activeElement).toBe(input);

      morph(ctx, root, list([3, 2, 1]));

      const after = root
        .querySelector(`[${SIP_KEY_ATTR}="2"]`)!
        .querySelector("input") as HTMLInputElement;
      expect(after).toBe(input);
      expect(after.value).toBe("half typed");
      expect(document.activeElement).toBe(after);
    });

    it("removing a keyed row leaves the surviving rows' nodes intact", () => {
      const root = document.createElement("div");
      document.body.appendChild(root);
      morph(ctx, root, list([1, 2, 3]));
      const first = root.querySelector(`[${SIP_KEY_ATTR}="1"]`)!;
      const third = root.querySelector(`[${SIP_KEY_ATTR}="3"]`)!;

      morph(ctx, root, list([1, 3]));

      expect(root.querySelector(`[${SIP_KEY_ATTR}="2"]`)).toBeNull();
      expect(root.querySelector(`[${SIP_KEY_ATTR}="1"]`)).toBe(first);
      expect(root.querySelector(`[${SIP_KEY_ATTR}="3"]`)).toBe(third);
    });

    it("inserting a row does not disturb existing nodes", () => {
      const root = document.createElement("div");
      document.body.appendChild(root);
      morph(ctx, root, list([1, 3]));
      const first = root.querySelector(`[${SIP_KEY_ATTR}="1"]`)!;
      const third = root.querySelector(`[${SIP_KEY_ATTR}="3"]`)!;

      morph(ctx, root, list([1, 2, 3]));

      expect(root.querySelector(`[${SIP_KEY_ATTR}="1"]`)).toBe(first);
      expect(root.querySelector(`[${SIP_KEY_ATTR}="3"]`)).toBe(third);
      expect(root.querySelector(`[${SIP_KEY_ATTR}="2"]`)).not.toBeNull();
    });

    it("an unkeyed list still reorders correctly, just without identity", () => {
      // Keys are opt-in; unkeyed lists must keep working as before.
      const root = document.createElement("div");
      document.body.appendChild(root);
      const unkeyed = (ids: number[]) => [":ul", {}, ...ids.map((id) => [":li", {}, `row${id}`])];
      morph(ctx, root, unkeyed([1, 2, 3]));

      morph(ctx, root, unkeyed([3, 2, 1]));

      expect(Array.from(root.querySelectorAll("li")).map((el) => el.textContent)).toEqual([
        "row3",
        "row2",
        "row1",
      ]);
    });

    it("falls back to id for stability when no :key is given", () => {
      const root = document.createElement("div");
      document.body.appendChild(root);
      const byId = (ids: number[]) => [":ul", {}, ...ids.map((id) => [":li", { ":id": `r${id}` }])];
      morph(ctx, root, byId([1, 2]));
      const first = root.querySelector("#r1")!;

      morph(ctx, root, byId([2, 1]));

      expect(root.querySelector("#r1")).toBe(first);
    });
  });

  describe("duplicate keys", () => {
    it("are reported through ctx.onerror in dev mode", () => {
      ctx.diagnostics.enabled = true;
      const errors: string[] = [];
      ctx.onerror = (e) => errors.push(e.message);

      render(ctx, [":ul", {}, [":li", { ":key": "a" }], [":li", { ":key": "a" }]]);

      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('Duplicate SIP :key "a"');
      expect(errors[0]).toContain("<ul>");
    });

    it("still render — a warning must not blank the list", () => {
      ctx.diagnostics.enabled = true;
      ctx.onerror = () => {};

      const el = render(ctx, [":ul", {}, [":li", { ":key": "a" }, "one"], [":li", { ":key": "a" }, "two"]]);

      expect(el.children).toHaveLength(2);
      expect(el.textContent).toBe("onetwo");
    });

    it("are recorded in the dev timeline", () => {
      ctx.diagnostics.enabled = true;
      ctx.onerror = () => {};

      render(ctx, [":ul", {}, [":li", { ":key": "a" }], [":li", { ":key": "a" }]]);

      expect(ctx.diagnostics.byKind("error")[0].context).toBe("sip-render:duplicate-key:ul");
    });

    it("are not checked when dev mode is off", () => {
      const onerror = vi.fn();
      ctx.onerror = onerror;

      render(ctx, [":ul", {}, [":li", { ":key": "a" }], [":li", { ":key": "a" }]]);

      expect(onerror).not.toHaveBeenCalled();
    });

    it("report once per repeated key, not once per element", () => {
      ctx.diagnostics.enabled = true;
      const errors: string[] = [];
      ctx.onerror = (e) => errors.push(e.message);

      render(ctx, [
        ":ul",
        {},
        [":li", { ":key": "a" }],
        [":li", { ":key": "a" }],
        [":li", { ":key": "a" }],
      ]);

      expect(errors).toHaveLength(2);
    });

    it("the same key under different parents is not a duplicate", () => {
      // Keys only need to be unique among siblings, as in every other
      // framework — requiring global uniqueness would make components
      // uncomposable.
      ctx.diagnostics.enabled = true;
      const onerror = vi.fn();
      ctx.onerror = onerror;

      render(ctx, [
        ":div",
        {},
        [":ul", {}, [":li", { ":key": "a" }]],
        [":ul", {}, [":li", { ":key": "a" }]],
      ]);

      expect(onerror).not.toHaveBeenCalled();
    });

    it("unkeyed siblings are never duplicates of each other", () => {
      ctx.diagnostics.enabled = true;
      const onerror = vi.fn();
      ctx.onerror = onerror;

      render(ctx, [":ul", {}, [":li", {}], [":li", {}], [":li", {}]]);

      expect(onerror).not.toHaveBeenCalled();
    });
  });

  describe(".once on unkeyed siblings", () => {
    const dev = (): string[] => {
      ctx.diagnostics.enabled = true;
      const errors: string[] = [];
      ctx.onerror = (e) => errors.push(e.message);
      return errors;
    };
    const row = (attrs: Record<string, unknown>) => [":li", attrs, "row"];

    it("is reported in dev mode — the spent mark can move to another item", () => {
      // `.once` is spent per DOM element and morphdom matches unkeyed siblings
      // by position, so a reorder hands the spent mark to a different item.
      // Nothing in the framework can recover item identity here; the diagnostic
      // is the fix.
      const errors = dev();

      render(ctx, [":ul", {}, row({ ":on-click.once": "h" }), row({ ":on-click.once": "h" })]);

      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(".once handler on an unkeyed <li>");
      expect(errors[0]).toContain("Give each sibling a :key");
    });

    it("records the diagnostic under its own context", () => {
      dev();

      render(ctx, [":ul", {}, row({ ":on-click.once": "h" }), row({ ":on-click.once": "h" })]);

      expect(ctx.diagnostics.byKind("error")[0].context).toBe("sip-render:once-without-key:ul");
    });

    it("says nothing once the rows carry a :key", () => {
      const errors = dev();

      render(ctx, [
        ":ul",
        {},
        row({ ":key": 1, ":on-click.once": "h" }),
        row({ ":key": 2, ":on-click.once": "h" }),
      ]);

      expect(errors).toEqual([]);
    });

    it("says nothing for an id, which morphdom keys on too", () => {
      const errors = dev();

      render(ctx, [
        ":ul",
        {},
        row({ ":id": "r1", ":on-click.once": "h" }),
        row({ ":id": "r2", ":on-click.once": "h" }),
      ]);

      expect(errors).toEqual([]);
    });

    it("says nothing about a lone .once button among mixed siblings", () => {
      // The overwhelmingly common shape — a single submit button in a form —
      // must not warn, or the diagnostic becomes noise everyone filters out.
      const errors = dev();

      render(ctx, [
        ":div",
        {},
        [":p", {}, "hello"],
        [":p", {}, "world"],
        [":button", { ":on-click.once": "buy" }, "buy"],
      ]);

      expect(errors).toEqual([]);
    });

    it("reports once per parent, not once per row", () => {
      const errors = dev();

      render(ctx, [
        ":ul",
        {},
        row({ ":on-click.once": "h" }),
        row({ ":on-click.once": "h" }),
        row({ ":on-click.once": "h" }),
      ]);

      expect(errors).toHaveLength(1);
    });

    it("says nothing about unkeyed rows without .once", () => {
      const errors = dev();

      render(ctx, [":ul", {}, row({ ":on-click": "h" }), row({ ":on-click": "h" })]);

      expect(errors).toEqual([]);
    });

    it("is not checked when dev mode is off", () => {
      const onerror = vi.fn();
      ctx.onerror = onerror;

      render(ctx, [":ul", {}, row({ ":on-click.once": "h" }), row({ ":on-click.once": "h" })]);

      expect(onerror).not.toHaveBeenCalled();
    });
  });
});
