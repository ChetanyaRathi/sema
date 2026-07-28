/**
 * Component lifecycle against the REAL interpreter and the real WASM callback
 * boundary.
 *
 * The mock-interpreter suites model that boundary (see
 * `tests/component-callback-sharing.test.ts`); this one drives it. Three of the
 * 2026-07-28 findings live entirely in the interaction between the runtime's
 * ownership bookkeeping and the bridge's handle dedupe, and a model can only
 * ever be evidence about the model:
 *
 * - finding 9: two components registering the same named `on-unmount` share ONE
 *   wasm handle, and the first teardown used to release it;
 * - finding 10: `component/force-render!` from inside an effect body;
 * - finding 18: `component/unmount!` from inside an effect body.
 *
 * Skipped when the WASM package has not been built, so a JS-only contributor is
 * not told the component system is broken when the real message is "run the
 * wasm build".
 */
import { describe, it, expect, afterEach } from "vitest";
import { renderSema, disposeAllScreens, semaWasmAvailable, type SemaScreen } from "../src/testing.js";

const describeWithSema = semaWasmAvailable() ? describe : describe.skip;

let screen: SemaScreen | null = null;
afterEach(() => {
  screen?.dispose();
  screen = null;
  disposeAllScreens();
});

/** Shared preamble: a log every component appends to. */
const LOG = `
(def log (state (list)))
(define (note msg) (put! log (append @log (list msg))))
(define (log-text) (string-join @log ";"))
`;

describeWithSema("lifecycle through the real WASM boundary", () => {
  it("runs both components' teardown when they share one named on-unmount", async () => {
    // Finding 9. `(on-unmount shared-teardown)` — a global's *value*, so both
    // mounts receive the same handle and the same JS wrapper.
    screen = await renderSema(
      `${LOG}
      (define (shared-teardown) (note "down"))
      (defcomponent leaf () (on-unmount shared-teardown) [:div "leaf"])`,
      { html: '<div id="a"></div><div id="b"></div>', target: "#a", mount: "leaf" },
    );
    screen.run('(mount! "#b" leaf)');

    screen.run('(component/unmount! "#a")');
    expect(screen.run("(log-text)")).toBe('"down"');

    screen.run('(component/unmount! "#b")');

    // Used to stay at one "down" and report `Unknown callback handle: 1`.
    expect(screen.run("(log-text)")).toBe('"down;down"');
    expect(screen.errors).toEqual([]);
  });

  it("refuses component/force-render! from inside an effect body", async () => {
    // Finding 10: 174 renders and a stack overflow, then renders that outlived
    // the component because the nested effect's disposer was overwritten.
    //
    // Renders are counted off the dev timeline rather than from Sema: a counter
    // written by the render body would make the render depend on the signal it
    // writes, which is a different (and documented) loop.
    screen = await renderSema(
      `(def gen (state 0))
      (defcomponent boom ()
        (effect (list) (fn () (component/force-render! "#app")))
        [:div (number->string @gen)])`,
      { mount: "boom" },
    );
    const renders = () =>
      screen!.diagnostics.byKind("render").filter((e) => e.context === "component:boom").length;

    expect(renders()).toBe(1);
    expect(screen.errorContexts()).toEqual(["force-render:boom"]);

    screen.run("(put! gen 1)");
    expect(renders()).toBe(2);

    screen.run('(component/unmount! "#app")');
    screen.run("(put! gen 2)");

    // No zombie renders: the destroyed component is not re-rendering.
    expect(renders()).toBe(2);
  });

  it("runs the cleanup of an effect body that unmounts its own component", async () => {
    // Finding 18: the returned cleanup vanished with no diagnostic, and the
    // destroyed component kept a live slot.
    screen = await renderSema(
      `${LOG}
      (defcomponent selfdestruct ()
        (effect (list)
          (fn ()
            (component/unmount! "#app")
            (fn () (note "d-cleanup"))))
        [:div "d"])`,
      { mount: "selfdestruct" },
    );

    expect(screen.run("(log-text)")).toBe('"d-cleanup"');
    expect(screen.context.mountedComponents.size).toBe(0);
    expect(screen.snapshot().lifecycleSlots).toBe(0);
    expect(screen.errors).toEqual([]);
  });

  it("keeps an on-unmount hook from firing early when the slot sequence changes", async () => {
    // Finding 19: the hook fired mid-life AND again at teardown.
    screen = await renderSema(
      `${LOG}
      (def phase (state 0))
      (defcomponent keyed ()
        (effect (list) (fn () nil))
        (if (> @phase 0) (effect (list) (fn () nil)) nil)
        (on-unmount (fn () (note "bye")))
        [:div (number->string @phase)])`,
      { mount: "keyed" },
    );

    screen.run("(put! phase 1)");
    expect(screen.run("(log-text)")).toBe('""');
    // The re-keying itself is now reported rather than silent.
    expect(screen.errorContexts()).toEqual(["lifecycle:keyed#1"]);

    screen.run('(component/unmount! "#app")');
    expect(screen.run("(log-text)")).toBe('"bye"');
  });

  it("still runs a composed child's on-unmount when the child leaves the tree", async () => {
    // The other half of the finding 19 contract: a hook does not run because a
    // slot was re-keyed, but a child instance disappearing IS a teardown.
    screen = await renderSema(
      `${LOG}
      (def show (state #t))
      (defcomponent kid (props) (on-unmount (fn () (note "kid-down"))) [:div "kid"])
      (defcomponent page ()
        [:main (if @show (component/render kid {}) [:span "empty"])])`,
      { mount: "page" },
    );
    expect(screen.run("(log-text)")).toBe('""');

    screen.run("(put! show #f)");

    expect(screen.run("(log-text)")).toBe('"kid-down"');
    expect(screen.errors).toEqual([]);
  });

  it("leaves an ordinary effect and on-unmount pair untouched", async () => {
    // The control: nothing above changes the shape every component uses.
    screen = await renderSema(
      `${LOG}
      (def n (state 0))
      (defcomponent view ()
        (effect (list @n) (fn () (note (string-append "run:" (number->string @n)))
                                 (fn () (note "clean"))))
        (on-unmount (fn () (note "bye")))
        [:div (number->string @n)])`,
      { mount: "view" },
    );
    expect(screen.run("(log-text)")).toBe('"run:0"');

    screen.run("(update! n (fn (v) (+ v 1)))");
    expect(screen.run("(log-text)")).toBe('"run:0;clean;run:1"');

    screen.unmount();
    expect(screen.run("(log-text)")).toBe('"run:0;clean;run:1;bye;clean"');
    expect(screen.errors).toEqual([]);
    expect(screen.leaks()).toEqual({});
  });
});
