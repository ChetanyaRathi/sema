/**
 * Composed children own their own lifecycle, local state, and resources.
 *
 * Regression coverage for the architectural defect the 2026-07-28 adversarial
 * pass found from five angles at once (findings 1, 2, 3, 7 and 8 in
 * `docs/bugs/2026-07-28-sema-web-adversarial-findings.md`):
 *
 *   `component/render` invokes a child as an ordinary Sema call inside the
 *   parent's render, so the render-context stack still named the *mounting*
 *   component. Every child's `effect` / `on-unmount` / `local` / `resource`
 *   therefore landed in the mounting component's bucket, matched positionally.
 *
 * The user-visible results were all silent: switching a branch kept the old
 * child's effect running and never started the new one's; removing a keyed row
 * tore down a *different* row's effect; every row of a list shared one `local`
 * cell.
 *
 * These tests drive the real Sema prelude through the real interpreter, because
 * the defect lives in the interaction between the `component/render` macro and
 * the host's scope bookkeeping — a mock interpreter cannot express it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderSema, type SemaScreen } from "../src/testing.js";
import { localCell } from "../src/context.js";

const WASM = resolve(process.cwd(), "../sema-wasm/pkg/sema_wasm_bg.wasm");

beforeEach(() => {
  const bytes = readFileSync(WASM);
  // Routed, not blanket: a resource spec returns a URL that the runtime then
  // fetches, so answering every request with the wasm module makes a resource
  // resolve to the module's own bytes.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any) => {
      const url = String(input?.url ?? input);
      if (url.endsWith(".wasm")) {
        return new Response(bytes, { headers: { "Content-Type": "application/wasm" } });
      }
      return new Response(JSON.stringify({ url }), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

let screen: SemaScreen | null = null;
afterEach(() => {
  screen?.dispose();
  screen = null;
});

/** Shared preamble: a log both parent and children append to. */
const LOG = `
(def log (state (list)))
(define (note msg) (put! log (append @log (list msg))))
(define (log-text) (string-join @log ";"))
`;

describe("composed child lifecycle", () => {
  it("runs the new child's effect and the old child's cleanup when a branch switches", async () => {
    // Finding 2. The routing pattern the README and routing.md both show:
    // a conditional over component/render.
    screen = await renderSema(
      `${LOG}
      (def route (state "a"))
      (defcomponent kid-a (props)
        (effect (list) (fn () (note "A-run") (fn () (note "A-clean"))))
        [:div "A"])
      (defcomponent kid-b (props)
        (effect (list) (fn () (note "B-run") (fn () (note "B-clean"))))
        [:div "B"])
      (defcomponent shell ()
        [:main (if (equal? @route "a")
                 (component/render kid-a {})
                 (component/render kid-b {}))])`,
      { mount: "shell", wasmUrl: WASM },
    );

    expect(screen.run("(log-text)")).toContain("A-run");

    screen.run('(put! route "b")');

    const log = screen.run("(log-text)");
    // The departing child's cleanup runs, and the arriving child's body does.
    expect(log).toContain("A-clean");
    expect(log).toContain("B-run");
  });

  it("tears down only the removed row's effect, and leaves its siblings running", async () => {
    // Finding 1. Removing row `a` used to run row `c`'s cleanup and orphan
    // row `a`'s — the DOM had stable identity via :key, the slot array had none.
    screen = await renderSema(
      `${LOG}
      (def rows (state (list {:id "a"} {:id "b"} {:id "c"})))
      (defcomponent kid (props)
        (effect (list)
          (fn () (fn () (note (string-append "close:" (:id props))))))
        [:li {:key (:id props)} (:id props)])
      (defcomponent page ()
        [:ul (map (fn (r) (component/render kid (assoc r :key (:id r)))) @rows)])`,
      { mount: "page", wasmUrl: WASM },
    );

    screen.run("(put! rows (cdr @rows))");

    const log = screen.run("(log-text)");
    expect(log).toContain("close:a");
    expect(log).not.toContain("close:b");
    expect(log).not.toContain("close:c");
  });

  it("gives each row of a list its own local cell", async () => {
    // Finding 8: `(local ...)` was keyed by name alone, so every row shared one.
    screen = await renderSema(
      `${LOG}
      (defcomponent kid (props)
        (def n (local "n" (:id props)))
        [:li {:key (:id props)} @n])
      (defcomponent page ()
        [:ul (map (fn (r) (component/render kid r))
                  (list {:id "1"} {:id "2"} {:id "3"}))])`,
      { mount: "page", wasmUrl: WASM },
    );

    expect(screen.text("ul")).toBe("123");
  });

  it("keeps a child's state with it across a reorder", async () => {
    // The payoff of keying scope on :key — the same key that governs DOM
    // identity now governs state identity.
    screen = await renderSema(
      `${LOG}
      (def rows (state (list {:id "1"} {:id "2"})))
      (defcomponent kid (props)
        (def n (local "n" (:id props)))
        [:li {:key (:id props)} @n])
      (defcomponent page ()
        [:ul (map (fn (r) (component/render kid (assoc r :key (:id r)))) @rows)])`,
      { mount: "page", wasmUrl: WASM },
    );
    expect(screen.text("ul")).toBe("12");

    screen.run("(put! rows (reverse @rows))");

    // Each row keeps the cell it seeded, so reversing shows them reversed
    // rather than re-seeding both from their new positions.
    expect(screen.text("ul")).toBe("21");
  });

  it("releases a departed child's local cells", async () => {
    // The other half of finding 8: per-row cells were keyed by scope but never
    // pruned, so `localState` only ever grew for the life of the mounted root —
    // unbounded for a churning list (search results, infinite scroll, a
    // paginated table).
    screen = await renderSema(
      `${LOG}
      (def rows (state (list {:id "a"} {:id "b"} {:id "c"})))
      (defcomponent kid (props)
        (def n (local "seen" (:id props)))
        [:li {:key (:id props)} @n])
      (defcomponent page ()
        [:ul (map (fn (r) (component/render kid (assoc r :key (:id r)))) @rows)])`,
      { mount: "page", wasmUrl: WASM },
    );
    const root = () => screen!.context.mountedComponents.get("#app")!;
    expect(root().localState.size).toBe(3);
    const signalsWithThreeRows = screen.snapshot().signals;

    screen.run("(put! rows (cdr @rows))");

    expect(screen.text("ul")).toBe("bc");
    expect(root().localState.size).toBe(2);
    expect(screen.snapshot().signals).toBe(signalsWithThreeRows - 1);
    expect(screen.errors).toEqual([]);
  });

  it("releases the local cells of a child that owns nothing else", async () => {
    // A child with no effect and no resource owns no lifecycle slot, so the
    // departure sweep has to notice it from its local cells alone.
    screen = await renderSema(
      `${LOG}
      (def show (state #t))
      (defcomponent kid (props)
        (def n (local "n" 7))
        [:span (number->string @n)])
      (defcomponent page ()
        [:main (if @show (component/render kid {}) [:em "empty"])])`,
      { mount: "page", wasmUrl: WASM },
    );
    const root = () => screen!.context.mountedComponents.get("#app")!;
    expect(root().localState.size).toBe(1);

    screen.run("(put! show #f)");

    expect(screen.text("main")).toBe("empty");
    expect(root().localState.size).toBe(0);
  });

  it("keeps the mounting component's own local cells across renders", async () => {
    // Control: scope "" is entered by every render, so the root's own cells are
    // never candidates for the departure sweep.
    screen = await renderSema(
      `${LOG}
      (def tick (state 0))
      (defcomponent page ()
        (def n (local "kept" 41))
        [:p (number->string @n) "/" (number->string @tick)])`,
      { mount: "page", wasmUrl: WASM },
    );
    const root = () => screen!.context.mountedComponents.get("#app")!;
    const cell = localCell(root(), "kept");
    expect(cell).toBeDefined();

    screen.run("(put! tick 3)");

    expect(localCell(root(), "kept")).toBe(cell);
    expect(screen.text()).toBe("41/3");
  });

  it("does not leak a departed child's slots into the leak count", async () => {
    screen = await renderSema(
      `${LOG}
      (def show (state #t))
      (defcomponent kid (props)
        (effect (list) (fn () (fn () (note "gone"))))
        [:div "kid"])
      (defcomponent page ()
        [:main (if @show (component/render kid {}) [:span "empty"])])`,
      { mount: "page", wasmUrl: WASM },
    );

    screen.run("(put! show #f)");

    expect(screen.run("(log-text)")).toContain("gone");
    // leaks() reports only non-zero counts, so a clean teardown is the empty
    // object rather than a zero for every category.
    expect(screen.leaks().lifecycleSlots ?? 0).toBe(0);
  });

  it("leaves an uncomposed component's behaviour exactly as before", async () => {
    // The mounting component is scope "", so a component with no composed
    // children takes the same path it always did.
    screen = await renderSema(
      `${LOG}
      (def tick (state 0))
      (defcomponent solo ()
        (effect (list @tick) (fn () (note (string-append "run:" (number->string @tick)))))
        [:div (number->string @tick)])`,
      { mount: "solo", wasmUrl: WASM },
    );
    expect(screen.run("(log-text)")).toContain("run:0");

    screen.run("(put! tick 1)");

    expect(screen.run("(log-text)")).toContain("run:0;run:1");
  });
});

describe("composed child resources", () => {
  it("gives each composed child its own resource, not one shared by all", async () => {
    // Finding 3. Keyed on the owner alone, the key was the PARENT's id for
    // every child: one spec won, one request went out, and every card
    // rendered that one child's data.
    screen = await renderSema(
      `(def calls (state (list)))
       (defcomponent card (props)
         (def u (resource "user"
                  (fn ()
                    (put! calls (append @calls (list (:id props))))
                    (string-append "user-" (:id props)))))
         [:li (if (:loading @u) "loading" (:value @u))])
       (defcomponent page ()
         [:ul (component/render card {:key "1" :id "1"})
              (component/render card {:key "2" :id "2"})])`,
      { mount: "page", wasmUrl: WASM },
    );
    await screen.flush();

    // Both specs ran, each with its own id.
    const calls = screen.run("(string-join @calls \",\")");
    expect(calls).toContain("1");
    expect(calls).toContain("2");
    // Each card resolved its OWN url. Asserted on markup rather than text
    // because the decoded JSON body lands as an attribute, not a text node.
    expect(screen.html("ul")).toContain("user-1");
    expect(screen.html("ul")).toContain("user-2");
  });

  it("disposes a departed child's resource", async () => {
    // Finding 7: a named resource inside a route/list child was never released
    // when the child left the tree.
    screen = await renderSema(
      `(def show (state #t))
       (defcomponent card (props)
         (def u (resource "user" (fn () "value")))
         [:span (if (:loading @u) "loading" (:value @u))])
       (defcomponent page ()
         [:main (if @show (component/render card {}) [:em "empty"])])`,
      { mount: "page", wasmUrl: WASM },
    );
    await screen.flush();
    expect(screen.snapshot().resources).toBe(1);

    screen.run("(put! show #f)");
    await screen.flush();

    expect(screen.snapshot().resources).toBe(0);
  });
});
