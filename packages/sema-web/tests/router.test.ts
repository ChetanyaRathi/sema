import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseInitArg,
  parseQuery,
  registerRouterBindings,
  normalizeRoutePath,
  routeHref,
  splitPathQuery,
  ROUTER_LINK_ATTR,
  type RouteMatch,
} from "../src/router.js";
import { renderSip } from "../src/sip.js";
import { SemaWebContext } from "../src/context.js";
import { createMockInterpreter } from "./helpers.js";

describe("registerRouterBindings", () => {
  let interp: ReturnType<typeof createMockInterpreter>;
  let ctx: SemaWebContext;

  /** The current route as Sema would read it through `router/current-route`. */
  const route = (): RouteMatch | null =>
    (ctx.signals.get(interp.getFunction("router/current")!())?.value ?? null) as RouteMatch | null;

  /**
   * Install an error handler that can be asserted on.
   *
   * `ctx.onerror` cannot be spied by reading it back: its getter returns a
   * fresh diagnostics-recording wrapper on every access, so the spy has to be
   * held onto separately.
   */
  function captureErrors(): ReturnType<typeof vi.fn> {
    const spy = vi.fn();
    ctx.onerror = spy;
    return spy;
  }

  beforeEach(() => {
    interp = createMockInterpreter();
    ctx = new SemaWebContext();
    window.history.replaceState(null, "", "/");
    window.location.hash = "#/";
    registerRouterBindings(interp, ctx);
  });

  afterEach(() => {
    // jsdom shares one window across the file, so a router left listening would
    // keep handling hashchanges and delegated clicks in later tests. Tearing
    // down here is also the only way spy call counts mean anything.
    for (const cleanup of ctx.cleanupHooks) cleanup();
    ctx.cleanupHooks.clear();
    document.body.innerHTML = "";
    // Spies on shared browser globals (window.scrollTo, history.pushState)
    // otherwise keep accumulating calls from earlier tests, which turns every
    // call-count assertion into a lie.
    vi.restoreAllMocks();
  });

  it("matches literal route patterns with regex metacharacters", () => {
    interp.getFunction("router/init!")!({
      "/notes/v1.0+draft": "notes-page",
    });

    interp.getFunction("router/replace!")!("/notes/v1.0+draft");

    expect(route()).toEqual({
      path: "/notes/v1.0+draft",
      params: {},
      query: {},
      handler: "notes-page",
    });
  });

  it("decodes route params from the URL hash", () => {
    interp.getFunction("router/init!")!({
      "/todos/:id": "todo-detail",
    });

    interp.getFunction("router/replace!")!("/todos/hello%20world%2F42");

    expect(route()).toEqual({
      path: "/todos/hello%20world%2F42",
      params: { id: "hello world/42" },
      query: {},
      handler: "todo-detail",
    });
  });

  it("keeps malformed percent escapes as the original route parameter", () => {
    interp.getFunction("router/init!")!({
      "/search/:term": "search-page",
    });

    interp.getFunction("router/replace!")!("/search/%E0%A4%A");

    expect(route()).toEqual({
      path: "/search/%E0%A4%A",
      params: { term: "%E0%A4%A" },
      query: {},
      handler: "search-page",
    });
  });

  it("strips keyword-style route patterns and handlers from Sema maps", () => {
    interp.getFunction("router/init!")!({
      ":/settings": ":settings-page",
    });

    interp.getFunction("router/replace!")!("/settings");

    expect(route()).toMatchObject({
      path: "/settings",
      params: {},
      handler: "settings-page",
    });
  });

  it("updates current route on hashchange and returns null when no route matches", () => {
    interp.getFunction("router/init!")!({
      "/known": "known-page",
    });

    window.location.hash = "#/known";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(route()).toMatchObject({ handler: "known-page" });

    window.location.hash = "#/unknown";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(route()).toBeNull();
  });

  it("reinitializing routes removes the previous hashchange listener from cleanup hooks", () => {
    interp.getFunction("router/init!")!({ "/a": "a-page" });
    const firstCleanup = [...ctx.cleanupHooks][0];
    const removeSpy = vi.spyOn(window, "removeEventListener");

    interp.getFunction("router/init!")!({ "/b": "b-page" });

    expect(removeSpy).toHaveBeenCalledWith("hashchange", expect.any(Function));
    expect(ctx.cleanupHooks.has(firstCleanup!)).toBe(false);
    expect(ctx.cleanupHooks.size).toBe(1);
  });

  it("router/push! and router/back! delegate to browser history APIs", () => {
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});

    interp.getFunction("router/push!")!("/next");
    expect(window.location.hash).toBe("#/next");

    interp.getFunction("router/back!")!();
    expect(backSpy).toHaveBeenCalledOnce();
  });

  it("throws a clear setup error when Sema wrapper registration fails", () => {
    const badInterp = createMockInterpreter();
    badInterp.evalStr = () => ({ value: null, output: [], error: "wrapper boom" });

    expect(() => registerRouterBindings(badInterp, new SemaWebContext())).toThrow(/wrapper boom/);
  });

  it("normalizes a pattern and a path that omit the leading slash", () => {
    interp.getFunction("router/init!")!({ todos: "todo-page" });

    interp.getFunction("router/replace!")!("todos");

    expect(route()).toMatchObject({ path: "/todos", handler: "todo-page" });
  });

  describe("percent-encoded literal segments", () => {
    // A browser rewrites the URL it is handed: `location.hash = "#/søk"` reads
    // back as "#/s%C3%B8k". Patterns are written raw, so matching raw against
    // encoded made every route with a non-ASCII or reserved character
    // permanently unreachable — by push!, by a link, and by a typed URL.

    it("matches a non-ASCII pattern against the encoded hash the browser stores", () => {
      interp.getFunction("router/init!")!({ "/søk": "search-page" });

      interp.getFunction("router/replace!")!("/søk");

      expect(window.location.hash).toBe("#/s%C3%B8k");
      expect(route()).toMatchObject({ path: "/s%C3%B8k", handler: "search-page" });
    });

    it("matches patterns holding a space or a quote", () => {
      interp.getFunction("router/init!")!({ "/a b": "spaced-page", '/x"y': "quoted-page" });

      interp.getFunction("router/replace!")!("/a b");
      expect(route()).toMatchObject({ handler: "spaced-page" });

      interp.getFunction("router/replace!")!('/x"y');
      expect(route()).toMatchObject({ handler: "quoted-page" });
    });

    it("matches an astral-plane pattern, encoded as its four UTF-8 bytes", () => {
      interp.getFunction("router/init!")!({ "/🎈": "balloon-page" });

      interp.getFunction("router/replace!")!("/🎈");

      expect(window.location.hash).toBe("#/%F0%9F%8E%88");
      expect(route()).toMatchObject({ handler: "balloon-page" });
    });

    it("accepts a hand-typed URL whose escapes are lower case", () => {
      interp.getFunction("router/init!")!({ "/søk": "search-page" });

      window.location.hash = "#/s%c3%b8k";
      window.dispatchEvent(new HashChangeEvent("hashchange"));

      expect(route()).toMatchObject({ handler: "search-page" });
    });

    it("still matches a pattern the developer wrote already encoded", () => {
      interp.getFunction("router/init!")!({ "/s%C3%B8k": "search-page" });

      interp.getFunction("router/replace!")!("/søk");

      expect(route()).toMatchObject({ handler: "search-page" });
    });

    it("matches the encoded form in history mode too", () => {
      interp.getFunction("router/init!")!({ mode: "history", routes: { "/søk": "search-page" } });

      interp.getFunction("router/push!")!("/søk");

      expect(window.location.pathname).toBe("/s%C3%B8k");
      expect(route()).toMatchObject({ handler: "search-page" });
    });

    it("keeps an encoded slash inside a param out of the segment separator", () => {
      // `%2F` must not satisfy the literal "/" of a two-segment pattern, or
      // one-segment paths would collide with two-segment routes.
      interp.getFunction("router/init!")!({ "/a/b": "two-segment-page" });

      interp.getFunction("router/replace!")!("/a%2Fb");

      expect(route()).toBeNull();
    });

    it("marks a non-ASCII link as current even though the URL is encoded", () => {
      interp.getFunction("router/init!")!({ "/søk": "search-page" });
      interp.getFunction("router/replace!")!("/søk");

      const [, attrs] = interp.getFunction("router/link")!("/søk", "Søk", null) as [
        string,
        Record<string, unknown>,
      ];

      expect(attrs["aria-current"]).toBe("page");
    });
  });

  describe("bare route table", () => {
    it("registers a route whose pattern happens to be spelled 'routes'", () => {
      // A bare table's keys are patterns, and the leading slash is optional in
      // one — so `{"routes" "routes-page"}` is the ordinary route `/routes`.
      interp.getFunction("router/init!")!({ routes: "routes-page" });

      interp.getFunction("router/replace!")!("/routes");

      expect(route()).toMatchObject({ path: "/routes", handler: "routes-page" });
    });

    it("still reads a map under 'routes' as the options form", () => {
      // A Sema map reaches a registered function with its keyword colons
      // stripped, so `{:routes {…}}` and `{"routes" {…}}` are the same object
      // here: the value's shape is the only thing that can tell them apart.
      interp.getFunction("router/init!")!({
        routes: { "/known": "known-page" },
        "not-found": "missing-page",
      });

      interp.getFunction("router/replace!")!("/nowhere");

      expect(route()).toMatchObject({ handler: "missing-page" });
    });
  });

  describe("query strings", () => {
    it("parses the query into :query and keeps it out of :path", () => {
      interp.getFunction("router/init!")!({ "/todos/:id": "todo-detail" });

      interp.getFunction("router/replace!")!("/todos/42?tab=open&tag=a&tag=b");

      expect(route()).toEqual({
        path: "/todos/42",
        params: { id: "42" },
        query: { tab: "open", tag: ["a", "b"] },
        handler: "todo-detail",
      });
    });

    it("treats a question mark in a route pattern as the query delimiter", () => {
      // Routes match paths; a pattern cannot reserve a literal "?", exactly as
      // in a URL. The suffix is dropped rather than compiled into the regex.
      interp.getFunction("router/init!")!({ "/search?q=x": "search-page" });

      interp.getFunction("router/replace!")!("/search?q=anything");

      expect(route()).toMatchObject({
        path: "/search",
        query: { q: "anything" },
        handler: "search-page",
      });
    });

    it("reports an empty query map for a URL with a bare question mark", () => {
      interp.getFunction("router/init!")!({ "/todos": "todo-page" });

      interp.getFunction("router/replace!")!("/todos?");

      expect(route()).toEqual({ path: "/todos", params: {}, query: {}, handler: "todo-page" });
    });
  });

  describe("not-found route", () => {
    it("falls back to the registered handler for an unmatched path", () => {
      interp.getFunction("router/init!")!({
        "not-found": "missing-page",
        routes: { "/known": "known-page" },
      });

      interp.getFunction("router/replace!")!("/nowhere?ref=email");

      expect(route()).toEqual({
        path: "/nowhere",
        params: {},
        query: { ref: "email" },
        handler: "missing-page",
      });
    });

    it("prefers a matching route over the fallback", () => {
      interp.getFunction("router/init!")!({
        "not-found": "missing-page",
        routes: { "/known": "known-page" },
      });

      interp.getFunction("router/replace!")!("/known");

      expect(route()).toMatchObject({ handler: "known-page" });
    });

    it("names the fallback in the timeline while still reporting no match", () => {
      ctx.diagnostics.enabled = true;
      interp.getFunction("router/init!")!({
        "not-found": "missing-page",
        routes: { "/known": "known-page" },
      });

      interp.getFunction("router/replace!")!("/nowhere");

      expect(ctx.diagnostics.byKind("route").at(-1)!.detail).toBe(
        "/nowhere -> (no match) -> missing-page",
      );
    });
  });

  describe("options map", () => {
    it("accepts keyword-prefixed option keys", () => {
      interp.getFunction("router/init!")!({
        ":mode": ":hash",
        ":not-found": ":missing-page",
        ":routes": { "/known": "known-page" },
      });

      interp.getFunction("router/replace!")!("/nowhere");

      expect(route()).toMatchObject({ handler: "missing-page" });
    });

    it("rejects an unknown mode instead of silently using hash", () => {
      expect(() =>
        interp.getFunction("router/init!")!({ mode: "hysterical", routes: {} }),
      ).toThrow(/unknown :mode "hysterical"/);
    });

    it("rejects a :routes value that is neither a map nor a handler name", () => {
      // A *string* under `routes` is the bare route `/routes` (see the
      // "bare route table" block below); everything else is a malformed
      // options map and still stops setup.
      expect(() => interp.getFunction("router/init!")!({ routes: 42 })).toThrow(
        /:routes must be a map/,
      );
      expect(() => interp.getFunction("router/init!")!({ routes: ["/home"] })).toThrow(
        /:routes must be a map/,
      );
    });

    it("rejects a non-string handler", () => {
      expect(() => interp.getFunction("router/init!")!({ "/a": 42 })).toThrow(
        /handler for \/a must be a handler name string/,
      );
    });

    it("keeps the previous routes when a re-init is rejected", () => {
      interp.getFunction("router/init!")!({ "/known": "known-page" });

      expect(() => interp.getFunction("router/init!")!({ "/known": "ok", "/bad": 42 })).toThrow();

      interp.getFunction("router/replace!")!("/known");
      expect(route()).toMatchObject({ handler: "known-page" });
    });

    it("rejects a non-map argument", () => {
      expect(() => interp.getFunction("router/init!")!("routes")).toThrow(
        /expected a map of pattern -> handler/,
      );
    });

    it("rejects a :focus value that is neither true nor a selector", () => {
      expect(() => interp.getFunction("router/init!")!({ focus: 3, routes: {} })).toThrow(
        /:focus must be true or a CSS selector/,
      );
    });
  });

  describe("history mode", () => {
    beforeEach(() => {
      interp.getFunction("router/init!")!({
        mode: "history",
        routes: { "/": "home-page", "/todos/:id": "todo-detail" },
      });
    });

    it("reads the path and query from the location, not the hash", () => {
      interp.getFunction("router/push!")!("/todos/7?tab=done");

      expect(window.location.pathname).toBe("/todos/7");
      expect(window.location.hash).toBe("");
      expect(route()).toEqual({
        path: "/todos/7",
        params: { id: "7" },
        query: { tab: "done" },
        handler: "todo-detail",
      });
    });

    it("resolves the route again on popstate", () => {
      interp.getFunction("router/push!")!("/todos/7");
      window.history.replaceState(null, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));

      expect(route()).toMatchObject({ path: "/", handler: "home-page" });
    });

    it("replaces without adding a history entry", () => {
      const pushSpy = vi.spyOn(window.history, "pushState");
      const replaceSpy = vi.spyOn(window.history, "replaceState");

      interp.getFunction("router/replace!")!("/todos/9");

      expect(pushSpy).not.toHaveBeenCalled();
      expect(replaceSpy).toHaveBeenCalledWith(null, "", "/todos/9");
    });
  });

  describe("router/href", () => {
    it("builds a hash href by default and a path href in history mode", () => {
      interp.getFunction("router/init!")!({ "/todos": "todo-page" });
      expect(interp.getFunction("router/href")!("/todos")).toBe("#/todos");
      expect(interp.getFunction("router/href")!("todos")).toBe("#/todos");

      interp.getFunction("router/init!")!({ mode: "history", routes: { "/todos": "todo-page" } });
      expect(interp.getFunction("router/href")!("/todos")).toBe("/todos");
    });

    it("refuses an off-site path and reports it", () => {
      const onerror = captureErrors();
      interp.getFunction("router/init!")!({ "/todos": "todo-page" });

      expect(interp.getFunction("router/href")!("//evil.example/x")).toBeNull();
      expect(onerror).toHaveBeenCalledWith(expect.any(Error), "router:href");
    });

    it("refuses the backslash spellings of a protocol-relative path", () => {
      // The WHATWG URL parser treats `\` as `/` for special schemes, so all of
      // these resolve to http://evil.example/ exactly as `//evil.example` does.
      const onerror = captureErrors();
      interp.getFunction("router/init!")!({ mode: "history", routes: { "/": "home-page" } });

      for (const hostile of ["/\\evil.example", "\\\\evil.example", "\\/evil.example"]) {
        expect(interp.getFunction("router/href")!(hostile)).toBeNull();
      }
      // A single leading backslash normalizes into the two-slash form.
      expect(interp.getFunction("router/href")!("\\evil.example")).toBeNull();
      expect(onerror).toHaveBeenCalledTimes(4);
    });
  });

  describe("router/link", () => {
    beforeEach(() => {
      interp.getFunction("router/init!")!({
        "/": "home-page",
        "/todos/:id": "todo-detail",
      });
    });

    const link = (path: unknown, label?: unknown, attrs?: unknown) =>
      interp.getFunction("router/link")!(path, label, attrs) as unknown[];

    it("returns SIP data for an anchor carrying href and the router marker", () => {
      expect(link("/todos/42", "Open todo", { class: "nav-link" })).toEqual([
        "a",
        {
          class: "nav-link",
          href: "#/todos/42",
          [ROUTER_LINK_ATTR]: "/todos/42",
        },
        "Open todo",
      ]);
    });

    it("renders to a real anchor with an accessible name", () => {
      const node = renderSip(link("/todos/42", "Open todo", null), interp, ctx) as HTMLElement;

      expect(node.tagName).toBe("A");
      expect(node.getAttribute("href")).toBe("#/todos/42");
      expect(node.textContent).toBe("Open todo");
    });

    it("strips keyword-prefixed attribute keys", () => {
      const [, attrs] = link("/todos/42", "Open", { ":class": "nav", ":aria-label": "Open 42" });
      expect(attrs).toEqual({
        class: "nav",
        "aria-label": "Open 42",
        href: "#/todos/42",
        [ROUTER_LINK_ATTR]: "/todos/42",
      });
    });

    it("marks the link for the current route with aria-current", () => {
      interp.getFunction("router/replace!")!("/todos/42");

      expect(link("/todos/42", "Open")[1]).toMatchObject({ "aria-current": "page" });
      expect(link("/todos/43", "Other")[1]).not.toHaveProperty("aria-current");
    });

    it("lets the caller override aria-current", () => {
      interp.getFunction("router/replace!")!("/todos/42");

      expect(link("/todos/42", "Open", { "aria-current": "location" })[1]).toMatchObject({
        "aria-current": "location",
      });
    });

    it("refuses a caller-supplied href and reports the conflict", () => {
      const onerror = captureErrors();

      const [, attrs] = link("/todos/42", "Open", { href: "https://evil.example" });

      expect(attrs).toMatchObject({ href: "#/todos/42" });
      expect(onerror).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("cannot be overridden") }),
        "router:link",
      );
    });

    it("falls back to the path when the label is missing, never an empty name", () => {
      expect(link("/todos/42")).toEqual([
        "a",
        { href: "#/todos/42", [ROUTER_LINK_ATTR]: "/todos/42" },
        "/todos/42",
      ]);
      expect(link("/todos/42", "")[2]).toBe("/todos/42");
    });

    it("passes SIP data through as link content", () => {
      const node = renderSip(
        link("/todos/42", ["span", { class: "label" }, "Open"], null),
        interp,
        ctx,
      ) as HTMLElement;

      expect(node.querySelector("span.label")?.textContent).toBe("Open");
    });

    it("renders a non-navigating span for a path that is not a path", () => {
      const onerror = captureErrors();

      for (const hostile of [null, undefined, true, { toString: () => "/x" }, ["/x"]]) {
        const result = link(hostile, "Label");
        expect(result[0]).toBe("span");
        expect(JSON.stringify(result)).not.toContain(ROUTER_LINK_ATTR);
      }
      expect(onerror).toHaveBeenCalledWith(expect.any(Error), "router:link");
    });

    it("keeps the caller's attributes on a degraded link but gives it no href", () => {
      captureErrors();

      const [tag, attrs, child] = link(null, "Label", { class: "nav", "data-testid": "broken" });

      expect(tag).toBe("span");
      expect(attrs).toEqual({ class: "nav", "data-testid": "broken" });
      expect(child).toBe("Label");
    });

    it("refuses an off-site path", () => {
      const onerror = captureErrors();

      for (const hostile of ["//evil.example/x", "https://evil.example", "javascript:alert(1)"]) {
        expect(link(hostile, "Label")[0]).toBe("span");
      }
      expect(onerror).toHaveBeenCalledTimes(3);
    });

    it("renders no anchor a browser would resolve off-origin from a backslash", () => {
      captureErrors();

      for (const hostile of [
        "/\\evil.example",
        "\\evil.example",
        "\\\\evil.example",
        "\\/evil.example",
      ]) {
        const [tag, attrs] = link(hostile, "Label") as [string, Record<string, unknown>];
        expect(tag).toBe("span");
        expect(attrs).not.toHaveProperty("href");
        expect(attrs).not.toHaveProperty(ROUTER_LINK_ATTR);
      }
    });

    it("keeps a backslash inside a path from being read as a host separator", () => {
      // The refusal is about the *leading* slash-ish pair, not the character:
      // a backslash further in is an ordinary path character.
      const [tag, attrs] = link("/notes/a\\b", "Label") as [string, Record<string, unknown>];

      expect(tag).toBe("a");
      expect(attrs.href).toBe("#/notes/a\\b");
    });

    it("still renders a usable link when attrs are not a map", () => {
      const onerror = captureErrors();

      const [tag, attrs] = link("/todos/42", "Open", "class=nav");

      expect(tag).toBe("a");
      expect(attrs).toMatchObject({ href: "#/todos/42" });
      expect(onerror).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("attrs must be a map") }),
        "router:link",
      );
    });

    it("reports a label that is neither text nor SIP data", () => {
      const onerror = captureErrors();

      const result = link("/todos/42", { title: "Open" });

      expect(result[2]).toBe("/todos/42");
      expect(onerror).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("label must be text") }),
        "router:link",
      );
    });

    it("coerces a numeric path rather than rendering a broken href", () => {
      expect(link(42, "Answer")[1]).toMatchObject({ href: "#/42" });
    });
  });

  describe("link clicks", () => {
    /** Render a link into the document so document-level delegation sees it. */
    function mountLink(path: unknown, attrs?: unknown): HTMLElement {
      const node = renderSip(
        interp.getFunction("router/link")!(path, "Open", attrs),
        interp,
        ctx,
      ) as HTMLElement;
      document.body.appendChild(node);
      return node;
    }

    function click(el: Element, init: MouseEventInit = {}): MouseEvent {
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
      el.dispatchEvent(ev);
      return ev;
    }

    beforeEach(() => {
      interp.getFunction("router/init!")!({
        "/": "home-page",
        "/todos/:id": "todo-detail",
      });
    });

    it("navigates without letting the browser follow the link", () => {
      const el = mountLink("/todos/42");

      const ev = click(el);

      expect(ev.defaultPrevented).toBe(true);
      expect(window.location.hash).toBe("#/todos/42");
      expect(route()).toMatchObject({ path: "/todos/42", params: { id: "42" } });
    });

    it("navigates from a click on content inside the link", () => {
      const el = mountLink("/todos/7");
      el.innerHTML = "<span id='inner'>Open</span>";

      click(document.getElementById("inner")!);

      expect(route()).toMatchObject({ path: "/todos/7" });
    });

    it("leaves modified and non-primary clicks to the browser", () => {
      const el = mountLink("/todos/42");

      for (const init of [
        { metaKey: true },
        { ctrlKey: true },
        { shiftKey: true },
        { altKey: true },
        { button: 1 },
      ]) {
        const ev = click(el, init);
        expect(ev.defaultPrevented).toBe(false);
      }
      expect(route()).toMatchObject({ path: "/" });
    });

    it("leaves a link that opens elsewhere or downloads to the browser", () => {
      const targeted = mountLink("/todos/42", { target: "_blank" });
      const download = mountLink("/todos/43", { download: "todo.txt" });

      expect(click(targeted).defaultPrevented).toBe(false);
      expect(click(download).defaultPrevented).toBe(false);
      expect(route()).toMatchObject({ path: "/" });
    });

    it("ignores an anchor the router did not render", () => {
      document.body.innerHTML = '<a id="plain" href="#/todos/42">Open</a>';

      const ev = click(document.getElementById("plain")!);

      expect(ev.defaultPrevented).toBe(false);
      expect(route()).toMatchObject({ path: "/" });
    });

    it("ignores a click another handler already prevented", () => {
      const el = mountLink("/todos/42");
      document.addEventListener("click", (ev) => ev.preventDefault(), { once: true, capture: true });

      click(el);

      expect(route()).toMatchObject({ path: "/" });
    });

    it("handles a click once after re-initializing the router", () => {
      interp.getFunction("router/init!")!({
        mode: "history",
        routes: { "/": "home-page", "/todos/:id": "todo-detail" },
      });
      const el = mountLink("/todos/42");
      const pushSpy = vi.spyOn(window.history, "pushState");

      click(el);

      expect(pushSpy).toHaveBeenCalledTimes(1);
    });

    it("stops intercepting clicks once the runtime is torn down", () => {
      const el = mountLink("/todos/42");
      for (const cleanup of ctx.cleanupHooks) cleanup();
      ctx.cleanupHooks.clear();

      const ev = click(el);

      expect(ev.defaultPrevented).toBe(false);
      expect(route()).toMatchObject({ path: "/" });
    });
  });

  describe("navigation side effects", () => {
    it("scrolls to the top on navigation but not on init", () => {
      const scrollSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      interp.getFunction("router/init!")!({
        "scroll-to-top": true,
        routes: { "/": "home-page", "/next": "next-page" },
      });

      expect(scrollSpy).not.toHaveBeenCalled();

      interp.getFunction("router/push!")!("/next");
      expect(scrollSpy).toHaveBeenCalledWith(0, 0);
      expect(scrollSpy).toHaveBeenCalledTimes(1);
    });

    it("does nothing for a navigation to the path already showing", () => {
      const scrollSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      interp.getFunction("router/init!")!({
        "scroll-to-top": true,
        routes: { "/next": "next-page" },
      });
      interp.getFunction("router/push!")!("/next");

      interp.getFunction("router/push!")!("/next");

      expect(scrollSpy).toHaveBeenCalledTimes(1);
    });

    it("leaves scroll position alone unless asked", () => {
      const scrollSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      interp.getFunction("router/init!")!({ "/": "home-page", "/next": "next-page" });

      interp.getFunction("router/push!")!("/next");

      expect(scrollSpy).not.toHaveBeenCalled();
    });

    it("focuses the configured landmark, making it focusable if it is not", () => {
      document.body.innerHTML = '<main id="main">content</main>';
      interp.getFunction("router/init!")!({
        focus: "#main",
        routes: { "/": "home-page", "/next": "next-page" },
      });

      interp.getFunction("router/push!")!("/next");

      const main = document.getElementById("main")!;
      expect(main.getAttribute("tabindex")).toBe("-1");
      expect(document.activeElement).toBe(main);
    });

    it("keeps an author-supplied tabindex on the focus target", () => {
      document.body.innerHTML = '<main id="main" tabindex="0">content</main>';
      interp.getFunction("router/init!")!({
        focus: "#main",
        routes: { "/": "home-page", "/next": "next-page" },
      });

      interp.getFunction("router/push!")!("/next");

      expect(document.getElementById("main")!.getAttribute("tabindex")).toBe("0");
    });

    it("reports a focus target that is not in the document", () => {
      const onerror = captureErrors();
      interp.getFunction("router/init!")!({
        focus: "#gone",
        routes: { "/": "home-page", "/next": "next-page" },
      });

      interp.getFunction("router/push!")!("/next");

      expect(onerror).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("focus target") }),
        "router:focus",
      );
    });

    it("returns focus to the document when :focus is true", () => {
      document.body.innerHTML = '<button id="btn">go</button>';
      const btn = document.getElementById("btn") as HTMLButtonElement;
      btn.focus();
      expect(document.activeElement).toBe(btn);

      interp.getFunction("router/init!")!({
        focus: true,
        routes: { "/": "home-page", "/next": "next-page" },
      });
      interp.getFunction("router/push!")!("/next");

      expect(document.activeElement).toBe(document.body);
    });

    it("reports a scroll failure instead of breaking the navigation", () => {
      const onerror = captureErrors();
      vi.spyOn(window, "scrollTo").mockImplementation(() => {
        throw new Error("scroll denied");
      });
      interp.getFunction("router/init!")!({
        "scroll-to-top": true,
        routes: { "/": "home-page", "/next": "next-page" },
      });

      interp.getFunction("router/push!")!("/next");

      expect(onerror).toHaveBeenCalledWith(
        expect.objectContaining({ message: "scroll denied" }),
        "router:scroll",
      );
      expect(route()).toMatchObject({ path: "/next" });
    });
  });

  describe("navigation input", () => {
    beforeEach(() => {
      interp.getFunction("router/init!")!({ "/": "home-page", "/next": "next-page" });
    });

    it("refuses to navigate off-site and reports it", () => {
      const onerror = captureErrors();

      interp.getFunction("router/push!")!("https://evil.example");

      expect(window.location.hash).toBe("#/");
      expect(onerror).toHaveBeenCalledWith(expect.any(Error), "router:navigate");
    });

    it("refuses a non-string path rather than navigating home", () => {
      const onerror = captureErrors();

      interp.getFunction("router/push!")!(null);

      expect(route()).toMatchObject({ path: "/" });
      expect(onerror).toHaveBeenCalledWith(expect.any(Error), "router:navigate");
    });

    it("refuses a backslash path instead of leaving the origin", () => {
      const onerror = captureErrors();

      interp.getFunction("router/push!")!("/\\evil.example");

      expect(window.location.hash).toBe("#/");
      expect(route()).toMatchObject({ path: "/" });
      expect(onerror).toHaveBeenCalledWith(expect.any(Error), "router:navigate");
    });

    it("reports a rejected history write instead of letting it escape", () => {
      // pushState throws SecurityError for a URL the browser will not accept,
      // and browsers throttle rapid calls. navigate() runs inside a delegated
      // click handler, where a throw would surface as an uncaught error
      // attributed to nothing.
      const onerror = captureErrors();
      interp.getFunction("router/init!")!({
        mode: "history",
        routes: { "/": "home-page", "/next": "next-page" },
      });
      vi.spyOn(window.history, "pushState").mockImplementation(() => {
        throw new Error("SecurityError: pushState() cannot update history");
      });

      expect(() => interp.getFunction("router/push!")!("/next")).not.toThrow();

      expect(onerror).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("SecurityError") }),
        "router:navigate",
      );
      // The URL never changed, so the app must still be showing the old route.
      expect(route()).toMatchObject({ path: "/" });
    });

    it("reports a rejected history write from a link click rather than throwing at the listener", () => {
      // The delegated click listener is the dangerous caller: a throw there is
      // an uncaught window-level error with nothing naming the router.
      const onerror = captureErrors();
      interp.getFunction("router/init!")!({
        mode: "history",
        routes: { "/": "home-page", "/next": "next-page" },
      });
      const node = renderSip(
        interp.getFunction("router/link")!("/next", "Next", null),
        interp,
        ctx,
      ) as HTMLElement;
      document.body.appendChild(node);
      vi.spyOn(window.history, "pushState").mockImplementation(() => {
        throw new Error("SecurityError: pushState() cannot update history");
      });

      const dispatched = node.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );

      expect(dispatched).toBe(false); // the router still cancelled the navigation
      expect(onerror).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("SecurityError") }),
        "router:navigate",
      );
    });
  });
});

describe("parseQuery", () => {
  it("returns an empty map for an absent or empty query", () => {
    expect(parseQuery("")).toEqual({});
  });

  it("decodes percent escapes and plus-encoded spaces", () => {
    expect(parseQuery("q=hello+world&city=S%C3%A3o%20Paulo")).toEqual({
      q: "hello world",
      city: "São Paulo",
    });
  });

  it("collects repeated keys into a list, in URL order", () => {
    expect(parseQuery("tag=a&tag=b&tag=c")).toEqual({ tag: ["a", "b", "c"] });
  });

  it("gives a key with no value the empty string", () => {
    expect(parseQuery("draft&tab=")).toEqual({ draft: "", tab: "" });
  });

  it("splits only on the first equals sign", () => {
    expect(parseQuery("filter=a=b=c")).toEqual({ filter: "a=b=c" });
  });

  it("reads an encoded ampersand as part of the value", () => {
    expect(parseQuery("q=fish%26chips")).toEqual({ q: "fish&chips" });
  });

  it("keeps a malformed percent escape as raw text", () => {
    expect(parseQuery("q=%E0%A4%A&%ZZ=v")).toEqual({ q: "%E0%A4%A", "%ZZ": "v" });
  });

  it("skips empty pairs from stray separators", () => {
    expect(parseQuery("&&a=1&&&b=2&")).toEqual({ a: "1", b: "2" });
  });

  it("drops a pair with an empty key, which Sema could not read", () => {
    expect(parseQuery("=orphan&a=1")).toEqual({ a: "1" });
  });

  it("treats __proto__ as an ordinary key", () => {
    const query = parseQuery("__proto__=polluted");

    expect(query["__proto__"]).toBe("polluted");
    expect(Object.prototype.hasOwnProperty.call(query, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("decodes a key as well as its value", () => {
    expect(parseQuery("a%20b=c")).toEqual({ "a b": "c" });
  });
});

describe("path helpers", () => {
  it("normalizeRoutePath gives every path a leading slash", () => {
    expect(normalizeRoutePath("")).toBe("/");
    expect(normalizeRoutePath("todos")).toBe("/todos");
    expect(normalizeRoutePath("/todos")).toBe("/todos");
  });

  it("splitPathQuery splits at the first question mark", () => {
    expect(splitPathQuery("/todos?a=1?b=2")).toEqual({ path: "/todos", query: "a=1?b=2" });
    expect(splitPathQuery("/todos")).toEqual({ path: "/todos", query: "" });
    expect(splitPathQuery("")).toEqual({ path: "/", query: "" });
  });

  it("routeHref keeps hash mode behind the fragment and history mode on the path", () => {
    expect(routeHref("hash", "/todos")).toBe("#/todos");
    expect(routeHref("history", "/todos")).toBe("/todos");
    expect(routeHref("hash", "todos")).toBe("#/todos");
  });
});

describe("parseInitArg", () => {
  it("treats a map without :routes as a bare route table", () => {
    expect(parseInitArg({ "/a": "a-page" })).toEqual({
      mode: "hash",
      routes: { "/a": "a-page" },
      notFound: null,
      scrollToTop: false,
      focus: null,
    });
  });

  it("reads every option from the options form", () => {
    expect(
      parseInitArg({
        mode: ":history",
        "not-found": ":missing",
        "scroll-to-top": true,
        focus: "#main",
        routes: { "/a": "a-page" },
      }),
    ).toEqual({
      mode: "history",
      routes: { "/a": "a-page" },
      notFound: "missing",
      scrollToTop: true,
      focus: "#main",
    });
  });

  it("treats an explicitly nil :routes as an error, not a bare table", () => {
    expect(() => parseInitArg({ routes: null })).toThrow(/:routes must be a map/);
  });
});
