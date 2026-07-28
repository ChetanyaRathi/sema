/**
 * SPA router for Sema Web — built on signals.
 *
 * Provides `router/*` namespace functions for declaring routes, navigating,
 * rendering links, and reading the current route as reactive state.
 *
 * ## Usage
 *
 * ```sema
 * ;; Bare route table — hash mode, no fallback.
 * (router/init! {"/todos" "todo-page"
 *                "/todos/:id" "todo-detail"
 *                "/settings" "settings-page"})
 *
 * ;; Options map — mode, fallback route, and navigation side effects.
 * (router/init!
 *   {:mode :hash
 *    :not-found "not-found-page"
 *    :scroll-to-top true
 *    :focus "#main"
 *    :routes {"/" "home-page"
 *             "/todos/:id" "todo-detail"}})
 *
 * (router/push! "/todos/42?tab=open")
 * (router/current-route)
 * ;; => {:path "/todos/42" :params {:id "42"} :query {:tab "open"} :handler "todo-detail"}
 *
 * ;; An accessible anchor that navigates without a page load.
 * (router/link "/todos/42" "Open todo" {:class "nav-link"})
 * ```
 *
 * @module
 */

import { signal } from "@preact/signals-core";
import type { SemaWebContext } from "./context.js";

interface SemaInterpreterLike {
  registerFunction(name: string, fn: (...args: any[]) => any): void;
  evalStr(code: string): { value: string | null; output: string[]; error: string | null };
}

/**
 * How the router reads and writes the URL.
 *
 * `"hash"` is the default because it needs nothing from the host: every path
 * lives after the `#`, so any static file server can serve the app. `"history"`
 * uses real paths via `pushState` and requires the server to serve the app
 * shell for every route (a deep link is a real request).
 */
export type RouterMode = "hash" | "history";

/**
 * A parsed query string.
 *
 * A key that appears once holds its string value; a repeated key collects its
 * values into a list, the same shape `dom/form-data` uses for repeated field
 * names.
 */
export type RouteQuery = Record<string, string | string[]>;

/** The current route, as `router/current-route` returns it. */
export interface RouteMatch {
  /** Path portion only, with the query string removed and a leading `/`. */
  path: string;
  /** Named pattern segments (`/todos/:id` -> `{id: "42"}`), percent-decoded. */
  params: Record<string, string>;
  /** Parsed query string; empty when the URL had none. */
  query: RouteQuery;
  /** Name of the Sema handler registered for the match, or the fallback. */
  handler: string;
}

/**
 * Attribute marking an anchor as router-owned, holding its target path.
 *
 * The path is carried here rather than read back out of `href` so one click
 * listener serves both modes: `href` is `#/todos/42` in hash mode and
 * `/todos/42` in history mode, but this attribute is the bare path in both.
 * Only marked anchors are intercepted — an app's ordinary `<a href="/docs">`
 * must keep doing a real navigation.
 */
export const ROUTER_LINK_ATTR = "data-sema-router-link";

/**
 * Paths the router refuses to link to: anything with a scheme (`https:`,
 * `javascript:`) or a protocol-relative prefix.
 *
 * Without this, a path built from user data could leave the app entirely — in
 * history mode `<a href="//evil.example">` is a cross-origin navigation, and
 * the router would have rendered it as if it were an internal route.
 *
 * A backslash counts as a slash here because the WHATWG URL parser treats the
 * two interchangeably for special schemes: `/\evil.example`, `\\evil.example`
 * and `\/evil.example` all resolve to `http://evil.example/`, byte-identical to
 * `//evil.example`. A single leading backslash is refused for the same reason —
 * {@link normalizeRoutePath} would turn `\evil.example` into `/\evil.example`,
 * which is the two-slash form again.
 */
const EXTERNAL_PATH_RE = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|[/\\]{2}|\\)/;

interface Route {
  pattern: string;
  regex: RegExp;
  paramNames: string[];
  handler: string;
}

interface RouterOptions {
  mode: RouterMode;
  routes: Record<string, unknown>;
  notFound: string | null;
  scrollToTop: boolean;
  /** `true` blurs the focused element; a string focuses that selector. */
  focus: true | string | null;
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Regex source for a literal stretch of a route pattern, matching it both as
 * the author wrote it and as a browser percent-encodes it.
 *
 * The URL a route is compared against is never the string the app handed the
 * browser: `location.hash = "#/søk"` reads back as `"#/s%C3%B8k"`, `"#/a b"` as
 * `"#/a%20b"`, and `pathname` does the same in history mode. Patterns are
 * written raw, so a raw-against-encoded comparison makes every route with a
 * non-ASCII or reserved character unreachable — by `router/push!`, by
 * `router/link`, and by a user typing the URL.
 *
 * Encoding the *pattern* rather than decoding the *location* is what keeps this
 * additive: params are still captured from the raw path and decoded exactly
 * once, so nothing that matched before can stop matching, and a pattern already
 * spelled in encoded form keeps working too.
 *
 * `/` is exempt — it separates segments, and letting it also match `%2F` would
 * make the one-segment path `/a%2Fb` collide with the route `/a/b`.
 */
function literalRoutePattern(literal: string): string {
  let out = "";
  // Iterate code points, so a surrogate pair is encoded as the one character
  // it is rather than as two unpaired halves.
  for (const ch of literal) {
    const raw = escapeRegexLiteral(ch);
    if (ch === "/") {
      out += raw;
      continue;
    }
    let encoded: string;
    try {
      encoded = encodeURIComponent(ch);
    } catch {
      // A lone surrogate has no UTF-8 encoding; it can only match literally.
      out += raw;
      continue;
    }
    if (encoded === ch) {
      out += raw;
      continue;
    }
    // Percent escapes are hex-case-insensitive. Browsers emit uppercase, but a
    // hand-typed or hand-built URL may not.
    const anyCase = encoded.replace(/[A-F]/g, (hex) => `[${hex}${hex.toLowerCase()}]`);
    out += `(?:${raw}|${anyCase})`;
  }
  return out;
}

/**
 * Whether two paths name the same route, ignoring percent-encoding.
 *
 * `router/link` holds the path the app wrote (`/søk`) while the live route
 * holds the path the browser reported (`/s%C3%B8k`); comparing them raw would
 * drop `aria-current` from exactly the links {@link literalRoutePattern} just
 * made reachable.
 */
function samePath(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  if (a === b) return true;
  return decodeUriComponentSafe(a) === decodeUriComponentSafe(b);
}

/** Sema keywords cross the boundary as `":name"` in some shapes; strip that. */
function stripKeywordColon(value: string): string {
  return value.startsWith(":") ? value.slice(1) : value;
}

function decodeUriComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed escape ("%E0%A4%A", a bare "%") throws URIError. Keeping the
    // raw text is strictly better than losing the whole route or query to it.
    return value;
  }
}

/** Query strings encode a space as `+`, unlike path segments. */
function decodeQueryPart(part: string): string {
  return decodeUriComponentSafe(part.replace(/\+/g, " "));
}

/**
 * Give a path a leading slash.
 *
 * Applied to both registered patterns and the live URL, so `"todos"` and
 * `"/todos"` are the same route however each side spelled it.
 */
export function normalizeRoutePath(path: string): string {
  if (!path) return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * Split a raw location into its path and query-string halves at the first `?`.
 *
 * Consequence worth knowing: a literal `?` can no longer appear in a route
 * pattern — it starts the query string, exactly as it does in a URL. Routes
 * match on the path alone; the query never participates in matching.
 */
export function splitPathQuery(raw: string): { path: string; query: string } {
  const mark = raw.indexOf("?");
  if (mark === -1) return { path: normalizeRoutePath(raw), query: "" };
  return { path: normalizeRoutePath(raw.slice(0, mark)), query: raw.slice(mark + 1) };
}

/**
 * Parse a query string into a map.
 *
 * Follows `application/x-www-form-urlencoded` reading rules, which is what
 * browsers and servers agree on: `&` separates pairs, the *first* `=`
 * separates key from value (so a value may contain `=`), `+` decodes to a
 * space, and a key with no `=` gets the empty string — `?draft` is present
 * with an empty value, not absent.
 *
 * Three deliberate robustness choices, because a query string is the most
 * attacker-reachable input a router has:
 *
 * - **A malformed percent escape keeps its raw text** rather than throwing, so
 *   one bad character in a shared URL cannot take down the whole render.
 * - **An empty key is dropped.** Keys become Sema keywords, and a keyword with
 *   no name is unreadable from Sema — `?=x` is nothing anyone meant.
 * - **The result has a null prototype**, so `?__proto__=x` lands as an
 *   ordinary key instead of being swallowed by the prototype setter.
 *
 * @param queryString - the part after `?`, without the `?` itself.
 */
export function parseQuery(queryString: string): RouteQuery {
  const out: RouteQuery = Object.create(null);
  if (!queryString) return out;

  for (const pair of queryString.split("&")) {
    if (!pair) continue;
    const mark = pair.indexOf("=");
    const key = decodeQueryPart(mark === -1 ? pair : pair.slice(0, mark));
    if (!key) continue;
    const value = decodeQueryPart(mark === -1 ? "" : pair.slice(mark + 1));

    const existing = out[key];
    if (existing === undefined) {
      out[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      out[key] = [existing, value];
    }
  }

  return out;
}

/** The `href` an anchor needs to reach `path` in the given mode. */
export function routeHref(mode: RouterMode, path: string): string {
  const normalized = normalizeRoutePath(path);
  return mode === "history" ? normalized : `#${normalized}`;
}

/**
 * Compile a route pattern (e.g. "/todos/:id") into a regex and param name list.
 *
 * Everything from a `?` onward is dropped: patterns describe paths, and a
 * query string is parsed rather than matched. Literal stretches compile through
 * {@link literalRoutePattern} so the pattern matches the percent-encoded form
 * the browser reports as well as the form the developer wrote.
 */
function compileRoute(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  let regexStr = "^";
  let lastIndex = 0;

  pattern.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, name, offset) => {
    regexStr += literalRoutePattern(pattern.slice(lastIndex, offset));
    paramNames.push(name);
    regexStr += "([^/]+)";
    lastIndex = offset + match.length;
    return match;
  });

  regexStr += literalRoutePattern(pattern.slice(lastIndex));
  regexStr += "$";

  return { regex: new RegExp(regexStr), paramNames };
}

/** Read an option by its Sema name, tolerating a `":name"` key. */
function readOption(map: Record<string, unknown>, name: string): unknown {
  if (Object.prototype.hasOwnProperty.call(map, name)) return map[name];
  const keyword = `:${name}`;
  if (Object.prototype.hasOwnProperty.call(map, keyword)) return map[keyword];
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A handler name, or `null` when absent. Throws on a non-string. */
function readHandlerName(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`router/init!: ${what} must be a handler name string, got ${typeof value}`);
  }
  const name = stripKeywordColon(value);
  if (!name) throw new Error(`router/init!: ${what} must not be empty`);
  return name;
}

/**
 * Normalize either accepted shape of `router/init!` into concrete options.
 *
 * The two forms are told apart by what the `routes` entry *holds*, not by the
 * key's name: a `routes` key carrying a handler name string is a route, and
 * anything else under that key is the options form.
 *
 * The name alone is not enough. A bare table's keys are route patterns and the
 * leading `/` is optional in one (`{"todos" "todo-page"}` and `{"/todos"
 * "todo-page"}` are the same route), so `{"routes" "routes-page"}` is the
 * perfectly ordinary route `/routes` — and the keyword spelling cannot be used
 * to tell them apart either, because a Sema map reaches a registered function
 * with its keyword colons already stripped (`{:routes {…}}` arrives as
 * `{routes: {…}}`). Reading the value is what keeps a legal route reachable:
 * the options form always carries a map there, a bare table always a string.
 *
 * Bad options throw. This runs once at setup with developer-authored input, so
 * a typo should stop the app immediately rather than silently route nowhere —
 * the same reasoning as an unknown SIP event modifier.
 */
export function parseInitArg(arg: unknown): RouterOptions {
  if (!isPlainObject(arg)) {
    throw new Error(
      "router/init!: expected a map of pattern -> handler, or an options map with :routes",
    );
  }

  const routes = readOption(arg, "routes");
  if (routes === undefined || typeof routes === "string") {
    return { mode: "hash", routes: arg, notFound: null, scrollToTop: false, focus: null };
  }

  if (!isPlainObject(routes)) {
    throw new Error("router/init!: :routes must be a map of pattern -> handler");
  }

  const rawMode = readOption(arg, "mode");
  let mode: RouterMode = "hash";
  if (rawMode !== null && rawMode !== undefined) {
    if (typeof rawMode !== "string") {
      throw new Error(`router/init!: :mode must be :hash or :history, got ${typeof rawMode}`);
    }
    const name = stripKeywordColon(rawMode);
    if (name !== "hash" && name !== "history") {
      throw new Error(`router/init!: unknown :mode ${JSON.stringify(name)} (:hash or :history)`);
    }
    mode = name;
  }

  const rawFocus = readOption(arg, "focus");
  let focus: true | string | null = null;
  if (rawFocus === true) {
    focus = true;
  } else if (typeof rawFocus === "string") {
    // An empty selector can only ever match nothing, so read it as the plain
    // "reset focus" request rather than reporting a missing target every time.
    const selector = stripKeywordColon(rawFocus);
    focus = selector || true;
  } else if (rawFocus !== null && rawFocus !== undefined && rawFocus !== false) {
    throw new Error("router/init!: :focus must be true or a CSS selector string");
  }

  return {
    mode,
    routes,
    notFound: readHandlerName(readOption(arg, "not-found"), ":not-found"),
    scrollToTop: readOption(arg, "scroll-to-top") === true,
    focus,
  };
}

/**
 * Register `router/*` namespace functions.
 *
 * Functions registered:
 * - `router/init!` — register routes, either as a bare `pattern -> handler`
 *   map or as an options map (`:routes`, `:mode`, `:not-found`,
 *   `:scroll-to-top`, `:focus`)
 * - `router/push!` — navigate to a path, adding a history entry
 * - `router/replace!` — navigate without adding a history entry
 * - `router/back!` — go back in history
 * - `router/current` — the signal ID of the current route (for `deref`)
 * - `router/href` — the `href` a link to a path needs in the active mode
 * - `router/link` — SIP data for an accessible, intercepted anchor
 *
 * Sema wrapper:
 * - `(router/current-route)` — convenience: dereferences the route signal
 */
export function registerRouterBindings(interp: SemaInterpreterLike, ctx: SemaWebContext): void {
  const routes: Route[] = [];
  let mode: RouterMode = "hash";
  let notFound: string | null = null;
  let scrollToTop = false;
  let focusTarget: true | string | null = null;
  let teardownListeners: (() => void) | null = null;
  /**
   * Raw location the signal was last updated for, or `null` after `init!`.
   *
   * Navigation in hash mode both writes the hash and updates synchronously, so
   * the browser's later `hashchange` would otherwise re-record and re-apply the
   * focus/scroll effects for a route change that already happened.
   */
  let lastRaw: string | null = null;

  const routeSignalId = ctx.nextSignalId++;
  const routeSignal = signal<RouteMatch | null>(null);
  ctx.signals.set(routeSignalId, routeSignal as any);

  function readLocation(): string {
    if (mode === "history") {
      return `${window.location.pathname}${window.location.search}`;
    }
    return window.location.hash.slice(1);
  }

  function matchRoute(path: string, query: RouteQuery): RouteMatch | null {
    for (const route of routes) {
      const match = path.match(route.regex);
      if (match) {
        const params: Record<string, string> = {};
        route.paramNames.forEach((name, i) => {
          params[name] = decodeUriComponentSafe(match[i + 1]);
        });
        return { path, params, query, handler: route.handler };
      }
    }
    return null;
  }

  /**
   * Move focus and scroll position after a route change.
   *
   * Both are opt-in and both are best-effort: an app that navigates should not
   * fail because a focus target was removed from the DOM by the render that
   * the navigation triggered.
   */
  function applyNavigationEffects(): void {
    if (scrollToTop) {
      try {
        window.scrollTo(0, 0);
      } catch (e) {
        ctx.onerror(e instanceof Error ? e : new Error(String(e)), "router:scroll");
      }
    }

    if (!focusTarget) return;
    try {
      if (focusTarget === true) {
        // Blurring returns focus to the document, so the next Tab starts from
        // the top of the freshly rendered page — what a keyboard or screen
        // reader user expects after a navigation.
        const active = document.activeElement as HTMLElement | null;
        if (active && typeof active.blur === "function" && active !== document.body) {
          active.blur();
        }
        return;
      }

      const el = document.querySelector(focusTarget) as HTMLElement | null;
      if (!el) {
        ctx.onerror(
          new Error(`router: focus target ${JSON.stringify(focusTarget)} not found after navigation`),
          "router:focus",
        );
        return;
      }
      // A landmark like <main> is not focusable by default; tabindex="-1"
      // makes it programmatically focusable without adding it to the tab order.
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
      el.focus();
    } catch (e) {
      ctx.onerror(e instanceof Error ? e : new Error(String(e)), "router:focus");
    }
  }

  function updateRoute(initial: boolean): void {
    const { path, query: queryString } = splitPathQuery(readLocation());
    const raw = queryString ? `${path}?${queryString}` : path;
    if (raw === lastRaw) return;
    lastRaw = raw;

    const query = parseQuery(queryString);
    const matched = matchRoute(path, query);
    const match: RouteMatch | null =
      matched ?? (notFound ? { path, params: {}, query, handler: notFound } : null);
    routeSignal.value = match;

    ctx.diagnostics.record(() => ({
      kind: "route",
      at: Date.now(),
      context: "route",
      // An unmatched path is the single most common routing complaint, so say
      // so explicitly rather than recording a bare path and leaving the reader
      // to infer it from a missing handler. A configured fallback still says
      // "(no match)" first — that the URL matched nothing is the fact you are
      // looking for; which view covered for it is the follow-up.
      detail: matched
        ? `${raw} -> ${matched.handler}`
        : notFound
          ? `${raw} -> (no match) -> ${notFound}`
          : `${raw} -> (no match)`,
    }));

    if (!initial) applyNavigationEffects();
  }

  const onRouteEvent = () => updateRoute(false);

  function navigate(path: unknown, replace: boolean, what: string): void {
    // Same admission rule as a rendered link: an off-site or non-path argument
    // is reported and ignored rather than sending the app somewhere it cannot
    // route back from.
    const target = linkPath(path);
    if (target === null) {
      ctx.onerror(
        new Error(`${what}: expected an internal path string, got ${describeLinkPath(path)}`),
        "router:navigate",
      );
      return;
    }
    const href = routeHref(mode, target);

    // The history API rejects URLs of its own accord — a cross-origin one with
    // SecurityError, and browsers throttle rapid `pushState` calls — and this
    // runs inside a delegated click handler, where an escaping throw becomes an
    // uncaught window-level error attributed to nothing. Report it and leave
    // the app on the route it is already showing.
    try {
      if (replace) window.history.replaceState(null, "", href);
      else if (mode === "history") window.history.pushState(null, "", href);
      else window.location.hash = href;
    } catch (e) {
      ctx.onerror(e instanceof Error ? e : new Error(String(e)), "router:navigate");
      return;
    }

    // Resolved synchronously rather than left to `hashchange`: `replaceState`
    // never fires it at all, and even for a hash write a caller that navigates
    // and then reads `router/current-route` must not see the previous route.
    // The `hashchange` that does follow is a no-op — `lastRaw` already matches.
    updateRoute(false);
  }

  /**
   * Intercept clicks on router-owned anchors.
   *
   * Delegated from the document so links rendered by any later re-render are
   * covered without re-registration. Every case the browser would handle
   * *better* than the router is left alone: a modified or non-primary click
   * (open in a new tab/window), an explicit `target`, a `download`, and an
   * event another handler already prevented.
   */
  function handleLinkClick(ev: MouseEvent): void {
    if (ev.defaultPrevented) return;
    // A synthesized plain Event has no `button`; treat that as a primary click
    // rather than ignoring the navigation.
    if ((ev.button ?? 0) !== 0) return;
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;

    const target = ev.target;
    if (!target || typeof (target as Element).closest !== "function") return;
    const el = (target as Element).closest(`[${ROUTER_LINK_ATTR}]`);
    if (!el) return;

    if (el.hasAttribute("download")) return;
    const linkTarget = el.getAttribute("target");
    if (linkTarget && linkTarget !== "_self") return;

    const path = el.getAttribute(ROUTER_LINK_ATTR);
    if (path === null) return;

    ev.preventDefault();
    navigate(path, false, "router/link");
  }

  /**
   * SIP data for an accessible anchor to an internal route.
   *
   * Never throws: it runs inside component renders, where a raised error would
   * take down the whole view. Hostile input degrades to a `<span>` — it keeps
   * the caller's attributes and label, so the app still shows something where
   * it expected a link, but without an `href` or the marker attribute there is
   * nowhere for a click to go. The failure is reported through `ctx.onerror`.
   */
  function buildLink(rawPath: unknown, label: unknown, rawAttrs: unknown): unknown[] {
    const attrs = linkAttrs(rawAttrs);
    const path = linkPath(rawPath);
    if (path === null) {
      ctx.onerror(
        new Error(
          `router/link: expected an internal path string, got ${describeLinkPath(rawPath)}`,
        ),
        "router:link",
      );
      return ["span", attrs, ...linkChildren(label, "")];
    }

    attrs.href = routeHref(mode, path);
    attrs[ROUTER_LINK_ATTR] = path;
    // Reading the route signal here makes a rendered link's active state
    // reactive: a component that renders links re-renders on navigation, which
    // is exactly what keeps aria-current correct.
    if (!("aria-current" in attrs) && samePath(routeSignal.value?.path, path)) {
      attrs["aria-current"] = "page";
    }

    return ["a", attrs, ...linkChildren(label, path)];
  }

  /**
   * The caller's attributes, colon-stripped and stripped of anything the router
   * owns.
   *
   * Honoring a caller's `href` would let a link render one destination and
   * navigate to another, so it is refused — loudly, because silently dropping
   * it would look like the router simply ignored the attribute.
   */
  function linkAttrs(rawAttrs: unknown): Record<string, unknown> {
    const attrs: Record<string, unknown> = {};
    if (isPlainObject(rawAttrs)) {
      for (const rawKey of Object.keys(rawAttrs)) {
        const key = stripKeywordColon(rawKey);
        if (key === "href" || key === ROUTER_LINK_ATTR) {
          ctx.onerror(
            new Error(`router/link: ${key} is set by the router and cannot be overridden`),
            "router:link",
          );
          continue;
        }
        attrs[key] = rawAttrs[rawKey];
      }
    } else if (rawAttrs !== null && rawAttrs !== undefined) {
      ctx.onerror(
        new Error(`router/link: attrs must be a map, got ${typeof rawAttrs}`),
        "router:link",
      );
    }
    return attrs;
  }

  /** The path a link should point at, or `null` if it is not linkable. */
  function linkPath(rawPath: unknown): string | null {
    if (typeof rawPath === "number" && Number.isFinite(rawPath)) {
      return normalizeRoutePath(String(rawPath));
    }
    if (typeof rawPath !== "string") return null;
    if (EXTERNAL_PATH_RE.test(rawPath)) return null;
    return normalizeRoutePath(rawPath);
  }

  function describeLinkPath(rawPath: unknown): string {
    if (typeof rawPath === "string") return `${JSON.stringify(rawPath)} (not an internal path)`;
    if (rawPath === null || rawPath === undefined) return "nil";
    return Array.isArray(rawPath) ? "a list" : typeof rawPath;
  }

  /**
   * Children of a rendered link.
   *
   * An absent or empty label falls back to the path: an anchor with no text has
   * no accessible name at all, which is worse than an ugly one. SIP data passes
   * through so a link can hold markup (`[:span "Open"]`).
   */
  function linkChildren(label: unknown, fallback: string): unknown[] {
    if (label === null || label === undefined || label === "") return fallback ? [fallback] : [];
    if (typeof label === "string" || typeof label === "number" || typeof label === "boolean") {
      return [label];
    }
    if (Array.isArray(label)) return [label];
    ctx.onerror(
      new Error(`router/link: label must be text or SIP data, got ${typeof label}`),
      "router:link",
    );
    return fallback ? [fallback] : [];
  }

  interp.registerFunction("router/init!", (arg: unknown) => {
    const options = parseInitArg(arg);

    // Compiled into a scratch list and committed only once every pattern is
    // valid: a re-init that throws half way through must leave the routes that
    // were already working alone, not strand the app with a partial table.
    const compiled: Route[] = [];
    for (const rawPattern of Object.keys(options.routes)) {
      const handler = readHandlerName(options.routes[rawPattern], `handler for ${rawPattern}`);
      if (handler === null) {
        throw new Error(`router/init!: route ${JSON.stringify(rawPattern)} has no handler`);
      }
      // Everything after a "?" is the query string, never part of the match.
      const pattern = normalizeRoutePath(
        splitPathQuery(stripKeywordColon(rawPattern)).path,
      );
      const { regex, paramNames } = compileRoute(pattern);
      compiled.push({ pattern, regex, paramNames, handler });
    }
    routes.length = 0;
    routes.push(...compiled);

    mode = options.mode;
    notFound = options.notFound;
    scrollToTop = options.scrollToTop;
    focusTarget = options.focus;

    if (teardownListeners) {
      teardownListeners();
      ctx.cleanupHooks.delete(teardownListeners);
    }
    const routeEvent = mode === "history" ? "popstate" : "hashchange";
    window.addEventListener(routeEvent, onRouteEvent);
    document.addEventListener("click", handleLinkClick);
    teardownListeners = () => {
      window.removeEventListener(routeEvent, onRouteEvent);
      document.removeEventListener("click", handleLinkClick);
    };
    ctx.cleanupHooks.add(teardownListeners);

    // Re-registering routes must re-resolve the current URL even though it did
    // not change — the handler it maps to may have.
    lastRaw = null;
    updateRoute(true);
    return null;
  });

  interp.registerFunction("router/push!", (path: unknown) => {
    navigate(path, false, "router/push!");
    return null;
  });

  interp.registerFunction("router/replace!", (path: unknown) => {
    navigate(path, true, "router/replace!");
    return null;
  });

  interp.registerFunction("router/back!", () => {
    window.history.back();
    return null;
  });

  interp.registerFunction("router/current", () => routeSignalId);

  interp.registerFunction("router/href", (path: unknown) => {
    const target = linkPath(path);
    if (target === null) {
      ctx.onerror(
        new Error(`router/href: expected an internal path string, got ${describeLinkPath(path)}`),
        "router:href",
      );
      return null;
    }
    return routeHref(mode, target);
  });

  interp.registerFunction("router/link", (path: unknown, label: unknown, attrs: unknown) =>
    buildLink(path, label, attrs),
  );

  // --- Sema-side convenience wrapper ---
  const semaResult = interp.evalStr(`
    (define (router/current-route) (deref (router/current)))
  `);

  if (semaResult.error) {
    throw new Error(`[sema-web] Failed to register router wrappers: ${semaResult.error}`);
  }
}
