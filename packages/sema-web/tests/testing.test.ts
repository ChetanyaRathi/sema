/**
 * The testing harness, tested against itself.
 *
 * `renderSema` boots the real WASM interpreter with the real bindings, so these
 * tests are also the only place in this suite where the whole stack — macro
 * expansion, value marshalling, SIP rendering, delegated events, lifecycle,
 * teardown — runs end to end in one program. A harness whose own helpers are
 * unverified is worse than no harness: every test written on top of it inherits
 * the defect and reports it as a failure of the component under test.
 *
 * Skipped when the WASM binary has not been built, matching the other
 * real-interpreter suites: "run the build" should not read as "your component
 * is broken".
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync } from "node:fs";
import {
  renderSema,
  disposeAllScreens,
  semaWasmAvailable,
  resolveSemaWasmPath,
} from "../src/testing.js";

const describeWithWasm = semaWasmAvailable() ? describe : describe.skip;

/** A counter component: the smallest thing that exercises render + event + state. */
const COUNTER = `
  (def count (state 0))
  (defcomponent view () [:button {:on-click "bump"} (str @count)])
  (define (bump ev) (update! count (fn (n) (+ n 1))))
`;

afterEach(() => {
  disposeAllScreens();
  vi.restoreAllMocks();
});

describe("wasm discovery", () => {
  it("resolves a path that exists, or none at all", () => {
    const path = resolveSemaWasmPath();
    // Never a path that is merely plausible: `semaWasmAvailable` gates whole
    // suites on this, so a non-existent path would skip nothing and then fail
    // every test with a wasm-bindgen error instead.
    expect(path === null || existsSync(path)).toBe(true);
  });

  it("agrees with semaWasmAvailable", () => {
    expect(semaWasmAvailable()).toBe(resolveSemaWasmPath() !== null);
  });
});

describeWithWasm("renderSema", () => {
  describe("booting", () => {
    it("renders a mounted component into the default container", async () => {
      const screen = await renderSema(COUNTER, { mount: "view" });
      expect(screen.html()).toBe('<button data-sema-on-click="bump">0</button>');
    });

    it("evaluates source without mounting when no component is named", async () => {
      const screen = await renderSema('(def x 1)');
      expect(screen.html()).toBe("");
      expect(screen.run("x")).toBe("1");
    });

    it("accepts an empty source", async () => {
      const screen = await renderSema("");
      expect(screen.run("(+ 1 1)")).toBe("2");
    });

    it("uses custom html and a custom target", async () => {
      const screen = await renderSema('(defcomponent view () [:p "in root"])', {
        html: '<main id="root"></main>',
        target: "#root",
        mount: "view",
      });
      expect(screen.container.tagName).toBe("MAIN");
      expect(screen.text()).toBe("in root");
    });

    it("raises with the interpreter's own message when the source fails", async () => {
      await expect(renderSema("(this-is-not-bound)")).rejects.toThrow(
        /source failed to evaluate.*Unbound variable: this-is-not-bound/s,
      );
    });

    it("raises naming the target when it is not in the document", async () => {
      await expect(renderSema("", { target: "#missing" })).rejects.toThrow(
        /mount target "#missing" is not in the document/,
      );
    });

    it("leaves nothing live behind when the target is missing", async () => {
      // The runtime is created before the target is looked up, so a bad target
      // must still dispose it — otherwise every such test leaks a WASM instance.
      await renderSema("", { target: "#missing" }).catch(() => {});
      disposeAllScreens();
      // A second boot proves the first did not wedge the shared WASM module.
      const screen = await renderSema("");
      expect(screen.run("(+ 1 1)")).toBe("2");
    });
  });

  describe("props", () => {
    const VIEW = '(defcomponent view (props) [:p (str (:title props))])';

    it("passes plain-keyed props through as keyword lookups", async () => {
      const screen = await renderSema(VIEW, { mount: "view", props: { title: "plain" } });
      expect(screen.text()).toBe("plain");
    });

    it("accepts keyword-prefixed keys too", async () => {
      const screen = await renderSema(VIEW, { mount: "view", props: { ":title": "colon" } });
      expect(screen.text()).toBe("colon");
    });

    it("mounts a zero-parameter component with no arguments", async () => {
      // Passing an argument to a zero-parameter Sema function is an arity
      // error, so an omitted `props` must mean "call with none".
      const screen = await renderSema('(defcomponent view () [:p "bare"])', { mount: "view" });
      expect(screen.text()).toBe("bare");
      expect(screen.errors).toEqual([]);
    });

    it("remounts with different props", async () => {
      const screen = await renderSema(VIEW, { mount: "view", props: { title: "first" } });
      screen.mount("view", { title: "second" });
      expect(screen.text()).toBe("second");
    });
  });

  describe("evaluating", () => {
    it("run returns the printed value", async () => {
      const screen = await renderSema("(def n 41)");
      expect(screen.run("(+ n 1)")).toBe("42");
    });

    it("run raises the interpreter's message", async () => {
      const screen = await renderSema("");
      expect(() => screen.run("(nope)")).toThrow(/Unbound variable: nope/);
    });

    it("eval hands back the failure instead of raising", async () => {
      const screen = await renderSema("");
      const result = screen.eval("(nope)");
      expect(result.error).toMatch(/Unbound variable: nope/);
      expect(result.value).toBeNull();
    });

    it("output accumulates across the source and every later evaluation", async () => {
      const screen = await renderSema('(println "from source")');
      screen.eval('(println "from eval")');
      screen.run('(println "from run")');
      expect(screen.output).toEqual(["from source", "from eval", "from run"]);
    });
  });

  describe("errors", () => {
    it("captures a render failure with the component's own context", async () => {
      const screen = await renderSema('(defcomponent view () (error "render boom"))', {
        mount: "view",
      });
      expect(screen.errors).toHaveLength(1);
      expect(screen.errors[0].message).toContain("render boom");
      expect(screen.errorContexts()).toEqual(["component:view"]);
    });

    it("captures a throwing event handler", async () => {
      const screen = await renderSema(
        '(defcomponent view () [:button {:on-click "boom"} "go"])' +
          '(define (boom ev) (error "handler boom"))',
        { mount: "view" },
      );
      screen.click("button");
      expect(screen.errorContexts()).toEqual(["event:click:boom"]);
    });

    it("does not log to console.error", async () => {
      // The harness replaces the runtime's console-logging handler. A suite
      // that exercises failure paths would otherwise bury real output.
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const screen = await renderSema('(defcomponent view () (error "quiet"))', { mount: "view" });
      expect(screen.errors).toHaveLength(1);
      expect(spy).not.toHaveBeenCalled();
    });

    it("forwards to an onerror option when one is given", async () => {
      const seen: string[] = [];
      const screen = await renderSema('(defcomponent view () (error "forwarded"))', {
        mount: "view",
        onerror: (_e, context) => seen.push(context),
      });
      expect(seen).toEqual(["component:view"]);
      expect(screen.errors).toHaveLength(1);
    });
  });

  describe("querying", () => {
    const FIXTURE = {
      html: '<div id="app"></div><button id="outside">outside</button>',
      mount: "view",
    };
    const SOURCE = '(defcomponent view () [:ul [:li {:class "row"} "a"] [:li {:class "row"} "b"]])';

    it("scopes queries to the container", async () => {
      const screen = await renderSema(SOURCE, FIXTURE);
      // `#outside` is in the document but not in the component: a harness that
      // queried the document would let a test assert against fixture chrome.
      expect(screen.query("#outside")).toBeNull();
      expect(document.getElementById("outside")).not.toBeNull();
    });

    it("finds all matches", async () => {
      const screen = await renderSema(SOURCE, FIXTURE);
      expect(screen.findAll("li").map((el) => el.textContent)).toEqual(["a", "b"]);
    });

    it("text and html can target a descendant", async () => {
      const screen = await renderSema(SOURCE, FIXTURE);
      expect(screen.text("ul")).toBe("ab");
      expect(screen.html("li")).toBe("a");
    });

    it("find raises with the current markup, not a bare null", async () => {
      const screen = await renderSema(SOURCE, FIXTURE);
      expect(() => screen.find("table")).toThrow(/no element matches "table".*<ul>/s);
    });
  });

  describe("firing events", () => {
    it("click runs the handler and the component re-renders", async () => {
      const screen = await renderSema(COUNTER, { mount: "view" });
      screen.click("button");
      screen.click("button");
      expect(screen.text("button")).toBe("2");
      expect(screen.errors).toEqual([]);
    });

    it("fill fires input, so the handler reads the typed value", async () => {
      const screen = await renderSema(
        `(def typed (state ""))
         (defcomponent view ()
           [:div [:input {:on-input "save"}] [:p (str @typed)]])
         (define (save ev) (put! typed (dom/event-value ev)))`,
        { mount: "view" },
      );
      screen.fill("input", "hello");
      expect(screen.text("p")).toBe("hello");
    });

    it("check toggles a checkbox and the handler sees the new state", async () => {
      const screen = await renderSema(
        `(def on (state false))
         (defcomponent view ()
           [:div [:input {:type "checkbox" :on-change "flip"}] [:p (str @on)]])
         (define (flip ev) (put! on (dom/event-checked ev)))`,
        { mount: "view" },
      );
      screen.check("input");
      // `#t` is how Sema prints a boolean; `signal` reads the JS value instead.
      expect(screen.text("p")).toBe("#t");
      expect(screen.signal("on")).toBe(true);
    });

    it("check is a no-op when the box is already in the wanted state", async () => {
      const screen = await renderSema(
        `(def hits (state 0))
         (defcomponent view () [:input {:type "checkbox" :on-change "count-it"}])
         (define (count-it ev) (update! hits (fn (n) (+ n 1))))`,
        { mount: "view" },
      );
      screen.check("input", true);
      screen.check("input", true);
      expect(screen.signal("hits")).toBe(1);
    });

    it("select fires change with the chosen value", async () => {
      const screen = await renderSema(
        `(def picked (state "none"))
         (defcomponent view ()
           [:div
             [:select {:on-change "choose"} [:option {:value "a"} "A"] [:option {:value "b"} "B"]]
             [:p (str @picked)]])
         (define (choose ev) (put! picked (dom/event-value ev)))`,
        { mount: "view" },
      );
      screen.select("select", "b");
      expect(screen.text("p")).toBe("b");
    });

    it("submit fires a submit event on the form", async () => {
      const screen = await renderSema(
        `(def saved (state "no"))
         (defcomponent view ()
           [:form {:on-submit.prevent "save"} [:input {:name "q" :value "hi"}]])
         (define (save ev) (put! saved (:q (dom/event-form-data ev))))`,
        { mount: "view" },
      );
      screen.submit();
      expect(screen.signal("saved")).toBe("hi");
    });

    it("press fires a keyboard event carrying the key", async () => {
      const screen = await renderSema(
        `(def pressed (state "none"))
         (defcomponent view () [:input {:on-keydown "note"}])
         (define (note ev) (put! pressed (dom/event-key ev)))`,
        { mount: "view" },
      );
      screen.press("input", "Enter");
      expect(screen.signal("pressed")).toBe("Enter");
    });

    it("fire dispatches an arbitrary bubbling event", async () => {
      const screen = await renderSema(
        `(def focused (state false))
         (defcomponent view () [:input {:on-focusin "mark"}])
         (define (mark ev) (put! focused true))`,
        { mount: "view" },
      );
      screen.fire("input", "focusin");
      expect(screen.signal("focused")).toBe(true);
    });

    it("focus moves the active element, so focus preservation can be exercised", async () => {
      const screen = await renderSema('(defcomponent view () [:input {:id "field"}])', {
        mount: "view",
      });
      screen.focus("#field");
      expect(document.activeElement).toBe(screen.find("#field"));
    });
  });

  describe("reading and writing state", () => {
    it("signal returns the JS value, not its printed form", async () => {
      const screen = await renderSema('(def items (state (list 1 2)))');
      expect(screen.signal("items")).toEqual([1, 2]);
    });

    it("signal explains itself when the name is not reactive state", async () => {
      const screen = await renderSema("(def plain 7)");
      expect(() => screen.signal("plain")).toThrow(/"plain" is not reactive state/);
    });

    it("setSignal drives a re-render", async () => {
      const screen = await renderSema(COUNTER, { mount: "view" });
      screen.setSignal("count", 99);
      expect(screen.text("button")).toBe("99");
    });
  });

  describe("teardown", () => {
    it("unmount runs on-unmount hooks", async () => {
      const screen = await renderSema(
        `(def log (state (list)))
         (defcomponent view ()
           (on-unmount (fn () (put! log (cons "bye" @log))))
           [:p "hi"])`,
        { mount: "view" },
      );
      expect(screen.signal("log")).toEqual([]);
      screen.unmount();
      expect(screen.signal("log")).toEqual(["bye"]);
    });

    it("reports nothing leaked after a component with local state and an effect unmounts", async () => {
      const screen = await renderSema(
        `(defcomponent view ()
           (def n (local "n" 0))
           (effect (list) (fn () (js/set-interval (fn () nil) 1000)))
           [:p (str @n)])`,
        { mount: "view" },
      );
      screen.unmount();
      expect(screen.leaks()).toEqual({});
    });

    it("reports the interval a live component still owns", async () => {
      // The falsifiable half: `leaks()` must be able to be non-empty, or the
      // assertion above proves nothing.
      const screen = await renderSema(
        `(defcomponent view ()
           (effect (list) (fn () (js/set-interval (fn () nil) 1000)))
           [:p "tick"])`,
        { mount: "view" },
      );
      expect(screen.leaks()).toMatchObject({ intervals: 1, mounted: 1, lifecycleSlots: 1 });
    });

    it("does not count module-level state the source created as a leak", async () => {
      // `(def total (state 0))` is the app's, not the component's. Counting it
      // would make `leaks()` fire on correct code, and it would be silenced.
      const screen = await renderSema(COUNTER, { mount: "view" });
      screen.click("button");
      screen.unmount();
      expect(screen.leaks()).toEqual({});
    });

    it("snapshot exposes the raw counts", async () => {
      const screen = await renderSema(COUNTER, { mount: "view" });
      expect(screen.snapshot().mounted).toBe(1);
      screen.unmount();
      expect(screen.snapshot().mounted).toBe(0);
    });

    it("dispose is idempotent", async () => {
      const screen = await renderSema(COUNTER, { mount: "view" });
      screen.dispose();
      expect(() => screen.dispose()).not.toThrow();
    });

    it("disposeAllScreens tears down a screen the test forgot", async () => {
      const screen = await renderSema(COUNTER, { mount: "view" });
      disposeAllScreens();
      expect(screen.context.mountedComponents.size).toBe(0);
    });
  });

  describe("starting URL", () => {
    // JSDOM shares one `window` per test file, so the URL is the one piece of
    // per-screen state `dispose()` cannot drain. Left alone, a screen that
    // navigated decides which route the *next* screen boots on — which makes a
    // router suite order-dependent in a way nothing in it can see.
    const ROUTER = `
      (router/init! {:routes {"/a" "ha" "/b" "hb"}})
      (defcomponent view () [:p (:handler (router/current-route))])
    `;

    it("boots the next screen at / even after the previous one navigated", async () => {
      const first = await renderSema(ROUTER, { mount: "view", url: "#/a" });
      first.run('(router/push! "/b")');
      expect(first.text("p")).toBe("hb");
      first.dispose();

      const second = await renderSema(ROUTER, { mount: "view" });

      expect(window.location.hash).toBe("");
      expect(second.run("(str (router/current-route))")).toBe('"nil"');
    });

    it("mounts on the route the url option names, whatever the ambient URL is", async () => {
      window.location.hash = "#/a";

      const screen = await renderSema(ROUTER, { mount: "view", url: "#/b" });

      expect(screen.text("p")).toBe("hb");
    });

    it("accepts a history-mode path as well as a fragment", async () => {
      const screen = await renderSema(
        `(router/init! {:mode :history :routes {"/todos/:id" "detail"}})
         (defcomponent view () [:p (:id (:params (router/current-route)))])`,
        { mount: "view", url: "/todos/42?tab=open" },
      );

      expect(screen.text("p")).toBe("42");
      expect(screen.run("(:tab (:query (router/current-route)))")).toBe('"open"');
    });

    it("names the harness when the requested URL is not usable", async () => {
      await expect(renderSema("", { url: "https://evil.example/x" })).rejects.toThrow(
        /renderSema: cannot start at/,
      );
    });
  });

  describe("diagnostics", () => {
    it("dev mode is on by default, so renders are timed", async () => {
      const screen = await renderSema(COUNTER, { mount: "view" });
      expect(screen.diagnostics.byKind("render").map((e) => e.context)).toEqual(["component:view"]);
    });

    it("dev mode can be turned off for a production-shaped run", async () => {
      const screen = await renderSema(COUNTER, { mount: "view", web: { dev: false } });
      expect(screen.diagnostics.all()).toEqual([]);
      // Errors are still captured — that is the harness, not dev mode.
      expect(screen.errors).toEqual([]);
    });
  });

  describe("async", () => {
    it("flush lets a resource settle", async () => {
      const fetchMock = vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ name: "ada" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const screen = await renderSema('(def user (resource "user" (fn () "/api/user")))');
      expect(screen.run("(:loading @user)")).toBe("#t");

      await screen.flush();

      expect(screen.run("(:loading @user)")).toBe("#f");
      expect(screen.run("(:name (:value @user))")).toBe('"ada"');
    });
  });

  it("tests a component end to end in under twenty lines", async () => {
    // The acceptance criterion, written out: state, a component, an event
    // handler, a click, an assertion, and a leak check.
    const screen = await renderSema(
      `(def count (state 0))
       (defcomponent view () [:button {:on-click "inc"} (str @count)])
       (define (inc ev) (update! count (fn (n) (+ n 1))))`,
      { mount: "view" },
    );

    screen.click("button");

    expect(screen.text("button")).toBe("1");
    expect(screen.errors).toEqual([]);
    screen.unmount();
    expect(screen.leaks()).toEqual({});
  });
});
