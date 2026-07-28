/**
 * Validate the component system's Sema macros against a real interpreter.
 *
 * `COMPONENT_SEMA_PRELUDE` defines `mount!`, `defcomponent`, and
 * `component/render` as Sema *macros* inside a TypeScript string. Macros are
 * the least verifiable thing in this package: the type checker cannot see
 * them, the bundler cannot see them, and every other test mocks `evalStr`, so
 * a malformed quasiquote reaches users as a thrown `SemaWeb.create()`.
 *
 * The interpreter here is the WASM build, reached through `renderSema`, which
 * is where the prelude actually runs in production — `registerComponentBindings`
 * evaluates it during `SemaWeb.create()`, so booting the runtime *is* the
 * registration test. The host natives the prelude calls are shadowed by Sema
 * definitions ({@link HOST_STUBS}) that echo their arguments, which is what
 * makes an expansion observable without a DOM.
 *
 * Skipped when the WASM package has not been built, so a JS-only contributor is
 * not told their component system is broken when the real message is "run the
 * wasm build".
 */
import { describe, it, expect, afterEach } from "vitest";
import { renderSema, disposeAllScreens, semaWasmAvailable } from "../src/testing.js";

const describeWithSema = semaWasmAvailable() ? describe : describe.skip;

/**
 * Sema-side shadows for the JS-registered natives the prelude calls.
 *
 * `component/mount!` echoes its arguments so the `mount!` macro's expansion is
 * observable without a DOM. A top-level `define` rebinds the name the prelude's
 * wrappers resolve at call time, so these win over the real bindings.
 */
const HOST_STUBS = `
(define (component/mount! sel name props)
  (println "MOUNT|" sel "|" name "|" props)
  nil)
(define (__component/local n i) i)
(define (__component/on-mount f) nil)
(define (__component/effect deps f) (println "EFFECT|" deps) nil)
(define (__component/on-unmount f) (println "UNMOUNT-HOOK") nil)
(define (__component/report-error name msg) (println "ERR|" name "|" msg) nil)
`;

/** Evaluate a program against the prelude, returning everything it printed. */
async function runSema(program: string): Promise<string> {
  const screen = await renderSema(`${HOST_STUBS}\n${program}`);
  return screen.output.join("\n").trim();
}

afterEach(() => disposeAllScreens());

describeWithSema("component Sema prelude", () => {
  it("loads without error", async () => {
    expect(await runSema('(println "loaded")')).toContain("loaded");
  });

  describe("defcomponent", () => {
    it("keeps a zero-parameter component callable with no arguments", async () => {
      // Every component written before props existed is this shape.
      expect(await runSema('(defcomponent v () "ok") (println (v))')).toBe("ok");
    });

    it("lets a one-parameter component be called with no arguments", async () => {
      // Sema raises an arity error for a plain one-parameter function called
      // with none, which would make `(mount! "#app" view)` fail for any
      // component that declares props.
      expect(
        await runSema('(defcomponent v (props) (if (map? props) "map" "other")) (println (v))'),
      ).toBe("map");
    });

    it("defaults absent props to an empty map, not nil", async () => {
      expect(await runSema('(defcomponent v (props) (println (:missing props))) (v)')).toBe("nil");
    });

    it("passes supplied props through", async () => {
      expect(await runSema('(defcomponent v (props) (println (:title props))) (v {:title "T"})')).toBe(
        "T",
      );
    });

    it("supports multi-form bodies", async () => {
      expect(
        await runSema('(defcomponent v (props) (define x 1) (+ x 41)) (println (v))'),
      ).toBe("42");
    });

    it("supports multi-form bodies in the zero-parameter shape too", async () => {
      expect(await runSema('(defcomponent v () (define x 2) (* x 21)) (println (v))')).toBe("42");
    });
  });

  describe("mount!", () => {
    it("stringifies a component symbol", async () => {
      expect(await runSema('(defcomponent v () "x") (mount! "#app" v)')).toContain(
        "MOUNT| #app | v |",
      );
    });

    it("accepts a string component name", async () => {
      expect(await runSema('(mount! "#app" "v")')).toContain("MOUNT| #app | v |");
    });

    it("passes nil props when none are given", async () => {
      // nil, not {} — the JS side reads nil as "call with no arguments".
      expect(await runSema('(defcomponent v () "x") (mount! "#app" v)')).toMatch(
        /MOUNT\|.*\| nil$/m,
      );
    });

    it("forwards a props map", async () => {
      const out = await runSema('(defcomponent v (props) "x") (mount! "#app" v {:title "T"})');
      expect(out).toContain('{:title "T"}');
    });

    it("evaluates a props expression rather than quoting it", async () => {
      const out = await runSema(
        '(define n 41) (defcomponent v (props) "x") (mount! "#app" v {:count (+ n 1)})',
      );
      expect(out).toContain("{:count 42}");
    });
  });

  describe("lifecycle", () => {
    it("forwards a deps list to the host verbatim", async () => {
      expect(await runSema("(effect (list 1 2) (fn () nil))")).toBe("EFFECT| (1 2)");
    });

    it("forwards nil deps, the spelling for 'after every render'", async () => {
      expect(await runSema("(effect nil (fn () nil))")).toBe("EFFECT| nil");
    });

    it("forwards an empty deps list, the spelling for 'run once'", async () => {
      expect(await runSema("(effect (list) (fn () nil))")).toBe("EFFECT| ()");
    });

    it("forwards on-unmount", async () => {
      expect(await runSema("(on-unmount (fn () nil))")).toBe("UNMOUNT-HOOK");
    });

    it("keeps effect at two arguments", async () => {
      // Not a variadic with an optional deps list: an arity error at the call
      // site reads better than a silently deps-less effect.
      const out = await runSema('(println (try (effect (list)) (catch e "arity")))');
      expect(out).toBe("arity");
    });

    it("expands inside a defcomponent body alongside props and local", async () => {
      const out = await runSema(
        "(defcomponent v (props)" +
          '  (define n (local "n" 0))' +
          "  (effect (list (:id props)) (fn () nil))" +
          "  (on-unmount (fn () nil))" +
          '  (list :p (:id props)))' +
          "(println (v {:id 7}))",
      );
      expect(out).toBe(["EFFECT| (7)", "UNMOUNT-HOOK", "(:p 7)"].join("\n"));
    });
  });

  describe("component/render", () => {
    it("invokes the child with its props", async () => {
      expect(
        await runSema(
          '(defcomponent child (props) (list :span (:label props)))' +
            '(println (component/render child {:label "hi"}))',
        ),
      ).toBe('(:span "hi")');
    });

    it("passes children through :children", async () => {
      expect(
        await runSema(
          '(defcomponent layout (props) (list :div (:children props)))' +
            '(println (component/render layout {} (list :p "kid")))',
        ),
      ).toBe("(:div ((:p \"kid\")))");
    });

    it("passes multiple children in order", async () => {
      expect(
        await runSema(
          '(defcomponent layout (props) (list :div (:children props)))' +
            '(println (component/render layout {} (list :p "a") (list :p "b")))',
        ),
      ).toBe('(:div ((:p "a") (:p "b")))');
    });

    it("gives an empty children list when none are passed", async () => {
      expect(
        await runSema(
          '(defcomponent c (props) (println (length (:children props))))' +
            '(component/render c {})',
        ),
      ).toBe("0");
    });

    it("works with no props argument at all", async () => {
      expect(
        await runSema('(defcomponent c (props) (list :span "bare")) (println (component/render c))'),
      ).toBe('(:span "bare")');
    });

    it("tolerates a non-map props argument instead of corrupting the call", async () => {
      expect(
        await runSema(
          '(defcomponent c (props) (println (map? props))) (component/render c "not-a-map")',
        ),
      ).toBe("#t");
    });

    it("composes: a child rendering a grandchild", async () => {
      expect(
        await runSema(
          '(defcomponent leaf (props) (list :b (:v props)))' +
            '(defcomponent mid (props) (list :i (component/render leaf {:v (:v props)})))' +
            '(println (component/render mid {:v "deep"}))',
        ),
      ).toBe('(:i (:b "deep"))');
    });

    it("isolates a throwing child: reports its own name and renders nil", async () => {
      const out = await runSema(
        '(defcomponent boom (props) (error "child blew up")) (println (component/render boom {}))',
      );
      // Attributed to `boom`, not to whatever component contained it.
      expect(out).toContain("ERR| boom | child blew up");
      expect(out.trim().endsWith("nil")).toBe(true);
    });

    it("a throwing child does not take the parent's subtree down", async () => {
      const out = await runSema(
        '(defcomponent boom (props) (error "nope"))' +
          '(defcomponent page (props) (list :main "before" (component/render boom {}) "after"))' +
          '(println (page))',
      );
      expect(out).toContain('(:main "before" nil "after")');
    });

    it("isolates a throwing child inside a map callback", async () => {
      // The shape that forced this guard to be removed on 2026-07-27: rendering
      // a list of children. Safe again since the VM fix
      // (docs/limitations.md section 38).
      const out = await runSema(
        '(defcomponent boom (props) (error "row failed"))' +
          '(defcomponent page (props)' +
          '  (cons :ul (map (fn (r) (component/render boom r)) (list {:id 1} {:id 2}))))' +
          '(println (page))',
      );
      expect(out).toContain("ERR| boom | row failed");
      expect(out).toContain("(:ul nil nil)");
    });

    it("renders a child by string name when given one", async () => {
      expect(
        await runSema(
          '(defcomponent child (props) (list :span "named"))' +
            '(println (component/render child {}))',
        ),
      ).toBe('(:span "named")');
    });
  });

  it("a props map survives a full parent -> child -> grandchild chain", async () => {
    // The composition acceptance test: props threaded down two levels, with
    // children injected at each, all in one render.
    const out = await runSema(
      '(defcomponent badge (props) (list :em (:text props)))' +
        '(defcomponent row (props) (list :li (:name props) (component/render badge {:text (:tag props)}) (:children props)))' +
        '(defcomponent table (props) (cons :ul (map (fn (r) (component/render row r (list :small "x"))) (:rows props))))' +
        '(println (table {:rows (list {:name "a" :tag "T1"} {:name "b" :tag "T2"})}))',
    );
    expect(out).toBe(
      '(:ul (:li "a" (:em "T1") ((:small "x"))) (:li "b" (:em "T2") ((:small "x"))))',
    );
  });
});
