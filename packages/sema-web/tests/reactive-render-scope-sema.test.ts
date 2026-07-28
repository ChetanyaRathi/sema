/**
 * `(watch …)` and `(computed …)` from a render body, through the REAL
 * interpreter and the real WASM callback boundary.
 *
 * The mock-interpreter suite (`tests/reactive-render-scope.test.ts`) pins the
 * bookkeeping; this one proves the Sema forms reach it. Two things only the
 * real boundary can show: `(computed expr)` is a macro that allocates a fresh
 * closure — and therefore a fresh callback handle — on every expansion, and a
 * watch that swaps its callback must hand the superseded handle back without
 * invalidating one the survivor is still holding.
 *
 * Skipped when the WASM package has not been built, so a JS-only contributor is
 * not told the reactive system is broken when the real message is "run the wasm
 * build".
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

describeWithSema("render-body reactivity through the real WASM boundary", () => {
  it("keeps one live watch across many renders", async () => {
    // Finding 16: 31 renders left 31 live watches, each invoking a Sema
    // callback on every change and each holding a WASM callback handle.
    screen = await renderSema(
      `(def n (state 0))
      (def other (state "a"))
      (def hits (state 0))
      (define (bump-hits old new) (put! hits (+ @hits 1)))
      (defcomponent view ()
        (watch other bump-hits)
        [:p (number->string @n)])`,
      { mount: "view" },
    );

    for (let i = 1; i <= 20; i++) screen.run(`(put! n ${i})`);

    expect(screen.snapshot().watches).toBe(1);
    expect(screen.text()).toBe("20");

    screen.run('(put! other "b")');
    expect(screen.run("@hits")).toBe("1");

    // The guidance is said once, not once per render.
    expect(screen.errorContexts()).toEqual(["watch:view"]);
  });

  it("invokes the latest render's closure", async () => {
    screen = await renderSema(
      `(def n (state 0))
      (def other (state "a"))
      (def seen (state ""))
      (defcomponent view ()
        (let ((generation (number->string @n)))
          (watch other (fn (old new) (put! seen (string-append generation ":" new))))
          [:p generation]))`,
      { mount: "view" },
    );

    screen.run("(put! n 7)");
    screen.run('(put! other "b")');

    // A memoized subscription serving the first render's closure would report
    // "0:b" — stale data dressed up as a fix for a leak.
    expect(screen.run("@seen")).toBe('"7:b"');
  });

  it("keeps one live computed across many renders", async () => {
    screen = await renderSema(
      `(def n (state 1))
      (defcomponent view ()
        (let ((doubled (computed (* @n 2))))
          [:p (number->string @doubled)]))`,
      { mount: "view" },
    );

    const before = screen.snapshot().signals;
    for (let i = 2; i <= 20; i++) screen.run(`(put! n ${i})`);

    expect(screen.text()).toBe("40");
    // One derivation alive, not 20 — and the value tracks the render that read
    // it, which a memoized computed would not.
    expect(screen.snapshot().signals).toBe(before);
    expect(screen.errors).toEqual([]);
  });

  it("gives each row of a list its own watch", async () => {
    // The render scope is part of the key, so composed children do not collapse
    // onto one registration the way `local` and `resource` used to.
    screen = await renderSema(
      `(def rows (state (list "a" "b" "c")))
      (def tick (state 0))
      (def hits (state 0))
      (define (bump-hits old new) (put! hits (+ @hits 1)))
      (defcomponent row (props)
        (watch tick bump-hits)
        [:li {:key (:id props)} (:id props)])
      (defcomponent page ()
        (cons :ul (map (fn (r) (component/render row {:id r :key r})) @rows)))`,
      { mount: "page" },
    );

    expect(screen.snapshot().watches).toBe(3);

    screen.run('(put! rows (list "a" "b"))');
    expect(screen.snapshot().watches).toBe(2);

    screen.run("(put! tick 1)");
    expect(screen.run("@hits")).toBe("2");
  });

  it("leaves nothing behind at unmount", async () => {
    screen = await renderSema(
      `(def n (state 0))
      (def other (state "a"))
      (defcomponent view ()
        (watch other (fn (old new) nil))
        (let ((doubled (computed (* @n 2))))
          [:p (number->string @doubled)]))`,
      { mount: "view" },
    );
    screen.run("(put! n 1)");
    screen.run("(put! n 2)");

    screen.run('(component/unmount! "#app")');
    expect(screen.snapshot().watches).toBe(0);
    expect(screen.snapshot().mounted).toBe(0);
  });
});
