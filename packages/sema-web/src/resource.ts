/**
 * Component-owned async data resources for Sema Web.
 *
 * A resource wraps one HTTP request in a reactive signal whose value is
 * `{loading, value, error, status}`, so a component can render all three states
 * from a single `@handle` read and never touch a promise.
 *
 * ## Why the spec function returns a request, not a response
 *
 * The obvious API — `(resource (fn () (http/get "/api/users")))` — cannot work
 * in the browser. Every `http/*` native rejects outside an `evalAsync` root
 * ("synchronous WebAssembly evaluation cannot perform HTTP requests"), and a
 * Sema callback invoked from JS is always the synchronous path: there is no
 * async callback entry point on the interpreter. So the callback describes the
 * request and this module performs it, exactly as `http/event-source` does.
 *
 * ## Identity is by name
 *
 * `(resource "user" spec-fn)` is memoized per component instance. This is
 * mandatory, not cosmetic: `resource` is called from a component body, i.e.
 * from inside the render effect. Without memoization the response would write
 * the signal, the write would re-render, the re-render would create a second
 * resource, and the component would refetch forever. `(local …)` solved the
 * same problem the same way, so this is the established idiom rather than a new
 * rule.
 *
 * ## Refetching is decided by the request, not by the closure
 *
 * The documented shape of a spec closes over props or state —
 * `(fn () (string-append "/api/users/" (:id props)))` — so the URL moves when
 * the component's inputs move. A re-render hands the memoized resource a brand
 * new closure every time, which says nothing at all about whether anything
 * changed; refetching on every adopted closure would loop forever, because the
 * response writes the signal and the write re-renders. So each adopted spec is
 * re-resolved once on a clean stack and its *request* is compared with the one
 * the current data came from ({@link ResourceRequest} + method, headers, body).
 * A moved request refetches; an identical one costs one spec call and stops.
 *
 * The consequence worth knowing: the check is driven by re-renders, so a spec
 * reading state the view never reads has nothing to trigger it. Read the input
 * in the view, or refresh explicitly:
 * `(effect (list @uid) (fn () (resource/refresh! "user")))`.
 *
 * ## WASM re-entrancy
 *
 * The spec function is never called during a render — not the one that created
 * the resource, and not the one that adopted a replacement. Creation seeds the
 * signal and queues a microtask, and so does the spec-change check; every call
 * back into Sema therefore happens from a clean JS stack, the same shape as
 * `on-mount`'s deferred callback and `js/set-interval`'s timer. Re-entrant
 * calls are legal again since the section-38 VM fix, but a clean stack is still
 * the right shape: it keeps a slow spec function off the render path.
 *
 * @module
 */

import { signal } from "@preact/signals-core";
import type { SemaWebContext } from "./context.js";
import {
  getCurrentOwnerId,
  currentScopePath,
  registerSignalFinalizer,
  registerStream,
  unregisterStream,
} from "./context.js";
import { releaseCallback, toInvokableCallback, type SemaCallback } from "./callbacks.js";
import { normalizeProps } from "./component.js";

interface SemaInterpreterLike {
  registerFunction(name: string, fn: (...args: any[]) => any): void;
  invokeGlobal(name: string, ...args: any[]): any;
}

/**
 * The reactive value of a resource, as Sema sees it.
 *
 * Plain lowercase JS keys on purpose: an object handed back to Sema has its
 * keys turned into keywords, so `(:loading @user)` and `(:value @user)` read
 * these directly. A colon prefix here would produce `::loading`.
 */
export interface ResourceState<T = unknown> {
  /** True from creation (and from each refresh) until the attempt settles. */
  loading: boolean;
  /**
   * The most recent successful response body. Retained across a refresh and
   * across a failure, so revalidating never blanks the UI.
   */
  value: T | null;
  /** Failure message of the most recent attempt, or `null`. */
  error: string | null;
  /** HTTP status of the most recent attempt, or `null` before one completed. */
  status: number | null;
}

/** A fully-resolved request, ready to hand to `fetch`. */
export interface ResourceRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  credentials: RequestCredentials;
  /** How to decode the response body. `"auto"` follows the content type. */
  as: "auto" | "json" | "text";
}

const ALLOWED_AS = new Set(["auto", "json", "text"]);

/** Sema keyword *values* keep their colon when they cross alone; keys do not. */
function stripColon(value: string): string {
  return value.startsWith(":") ? value.slice(1) : value;
}

function callbackHandle(value: unknown): number | null {
  if (value == null || (typeof value !== "object" && typeof value !== "function")) return null;
  const handle = (value as SemaCallback).__semaCallbackHandle;
  return typeof handle === "number" ? handle : null;
}

/** Bound the failure text that reaches `onerror` — a 404 page can be a whole document. */
function snippet(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;
}

/**
 * Report through the app's error handler without letting a throwing handler
 * escape.
 *
 * Every other `ctx.onerror` call site in this package sits on a synchronous
 * stack, where a handler that throws surfaces at its origin. A resource settles
 * inside a detached microtask, so an unguarded call there turns one reported
 * failure into a window-level unhandled rejection with no attribution — and the
 * failure that was being reported is lost with it.
 */
function reportContained(ctx: SemaWebContext, error: unknown, context: string): void {
  const err = error instanceof Error ? error : new Error(String(error));
  try {
    ctx.onerror(err, context);
  } catch (e) {
    // Re-entering the handler that just threw would only produce a second
    // throw, so the console is the last stop.
    console.error(`[sema-web] error handler threw while reporting ${context}:`, e, err);
  }
}

/**
 * Identity of a resolved request: what the data on screen was fetched with.
 *
 * Everything `fetch` is actually given takes part, so a spec that changes only
 * its method, headers, or body is as much of a change as one that moves the
 * URL. Header order is normalized because a spec builds its map fresh on every
 * render and key order is an artifact of that, not a difference in the request.
 */
function requestFingerprint(request: ResourceRequest): string {
  const headers = request.headers
    ? Object.entries(request.headers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    : null;
  return JSON.stringify([
    request.url,
    request.method,
    headers,
    request.body ?? null,
    request.credentials,
    request.as,
  ]);
}

/**
 * Fingerprint for a spec that could not produce a request at all.
 *
 * Kept in the same comparison as a real request so a spec that keeps failing
 * the same way is reported once rather than on every render.
 */
function failureFingerprint(error: unknown): string {
  return `!${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Turn whatever the spec function returned into a concrete request.
 *
 * Accepts a bare URL string or an options map with `:url` plus optional
 * `:method`, `:headers`, `:body`, `:with-credentials`, and `:as`.
 *
 * The map is run through {@link normalizeProps} rather than read directly, so a
 * key that arrives as `":url"` behaves the same as one that arrives as `"url"`.
 * That normalization is recursive and therefore also applies to `:body`: a JSON
 * payload with a key that genuinely starts with a colon would lose it. Every
 * other Sema-to-JS map in this package makes the same trade.
 *
 * @param spec - the spec function's return value
 * @param label - resource name or id, used in error messages
 */
export function normalizeResourceRequest(spec: unknown, label: string): ResourceRequest {
  if (typeof spec === "string") {
    if (spec.length === 0) {
      throw new Error(`resource:${label} spec function returned an empty URL`);
    }
    return { url: spec, method: "GET", credentials: "same-origin", as: "auto" };
  }

  if (spec == null || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error(
      `resource:${label} spec function must return a URL string or an options map with :url`,
    );
  }

  const opts = normalizeProps(spec as Record<string, unknown>);
  const url = opts.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(
      `resource:${label} spec function must return a URL string or an options map with :url`,
    );
  }

  const rawBody = opts.body;
  let body: string | undefined;
  let bodyWasEncoded = false;
  if (rawBody != null) {
    if (typeof rawBody === "string") {
      body = rawBody;
    } else {
      body = JSON.stringify(rawBody);
      bodyWasEncoded = true;
    }
  }

  const headers = normalizeHeaders(opts.headers, bodyWasEncoded);

  const rawMethod = opts.method;
  const method =
    typeof rawMethod === "string" && rawMethod.length > 0
      ? stripColon(rawMethod).toUpperCase()
      : body != null
        ? "POST"
        : "GET";

  const rawAs = opts.as;
  const as = typeof rawAs === "string" ? stripColon(rawAs) : "auto";
  if (!ALLOWED_AS.has(as)) {
    throw new Error(
      `resource:${label} spec :as must be "auto", "json", or "text", got "${as}"`,
    );
  }

  const withCredentials = opts.withCredentials ?? opts["with-credentials"];

  return {
    url,
    method,
    headers,
    body,
    credentials: withCredentials ? "include" : "same-origin",
    as: as as ResourceRequest["as"],
  };
}

/**
 * Coerce header values to strings and supply a content type for an encoded body.
 *
 * A number or boolean header value would otherwise reach `fetch` unconverted;
 * `String()` here keeps the request identical to the one a Sema map describes.
 */
function normalizeHeaders(
  raw: unknown,
  bodyWasEncoded: boolean,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value == null) continue;
      out[key] = String(value);
    }
  }
  if (bodyWasEncoded && !Object.keys(out).some((k) => k.toLowerCase() === "content-type")) {
    out["content-type"] = "application/json";
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Decode a response body according to the resource's `:as` setting.
 *
 * An empty body decodes to `null` rather than failing: a 200 or 204 with no
 * content is a normal outcome, and reporting it as invalid JSON would send a
 * successful request down the error path.
 */
export async function decodeResourceBody(
  response: Response,
  as: ResourceRequest["as"],
): Promise<unknown> {
  const text = await response.text();
  if (as === "text") return text;
  if (text.length === 0) return null;
  if (as === "json") return parseJson(text);
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.toLowerCase().includes("json") ? parseJson(text) : text;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("resource: response was not valid JSON");
  }
}

/**
 * Register the `resource`, `resource/refresh!`, and `resource/cancel!` natives.
 *
 * All three are host functions with no Sema wrapper: arity dispatch between the
 * named and unnamed forms happens in JS, so this feature adds no Sema source
 * embedded in a TypeScript string and no macro.
 *
 * Sema API:
 * - `(resource "name" spec-fn)` — create (or reuse) a named resource, returns a signal id
 * - `(resource spec-fn)` — unnamed; allowed only where no component owns the call
 * - `(resource/refresh! handle-or-name)` — start a fresh attempt, keeping the current value
 * - `(resource/cancel! handle-or-name)` — abort the in-flight attempt without reporting an error
 */
export function registerResourceBindings(interp: SemaInterpreterLike, ctx: SemaWebContext): void {
  function createResource(name: string | null, specValue: unknown): number {
    const ownerId = getCurrentOwnerId(ctx);
    // Scoped by composed-child path as well as by owner. Keyed on the owner
    // alone, every `component/render` of the same child collapsed onto one
    // resource: the last child's spec won, one request went out, and every
    // instance rendered that one child's data.
    const key = name == null ? null : `${ownerId ?? "global"}:${currentScopePath(ctx)}:${name}`;

    if (key != null) {
      const existingId = ctx.resourcesByKey.get(key);
      const existing = existingId != null ? ctx.resources.get(existingId) : undefined;
      if (existingId != null && existing) {
        existing.replaceSpec(specValue);
        return existingId;
      }
      if (existingId != null) ctx.resourcesByKey.delete(key);
    } else if (ownerId != null) {
      // Every context that owns a resource is one the framework runs again: a
      // render, an effect body, an event handler, an interval callback. Testing
      // the *render* stack alone left the guard bypassable from exactly those
      // places, and an unnamed resource created there allocates a fresh signal,
      // stream registration, and callback handle per run — one request per
      // keystroke, none of it reclaimed before unmount.
      throw new Error(
        '(resource) inside a component needs a name: (resource "user" (fn () ...)) — '
        + "an unnamed resource is recreated on every call, and a component's "
        + "render, effects, handlers and timers all run again. A named resource "
        + "is memoized per component instance and refetches when its request changes.",
      );
    }

    // Converted before anything is allocated, so a bad spec value cannot leave
    // a half-registered resource behind.
    let spec: SemaCallback = toInvokableCallback(specValue, interp, "resource spec");
    let currentSpecValue = specValue;

    const id = ctx.nextSignalId++;
    const label = name ?? String(id);
    // The initial state is the signal's constructor argument, never a write: a
    // write during the render that reads it is the re-render loop hazard.
    const state = signal<ResourceState>({ loading: true, value: null, error: null, status: null });
    ctx.signals.set(id, state);

    let seq = 0;
    let controller: AbortController | null = null;
    let disposed = false;
    let specCheckQueued = false;
    /**
     * Fingerprint of the request the most recent attempt was dispatched with,
     * or of the failure the spec raised instead of one. `null` means no attempt
     * has resolved the spec yet.
     */
    let lastFingerprint: string | null = null;

    const currentValue = () => state.value.value;

    /** Keep the value on screen while a new attempt runs, and clear the error. */
    function markLoading(): void {
      // `:status` describes the response `:value` came from, so the two move
      // together; blanking either would flash an empty UI on every revalidation.
      state.value = {
        loading: true,
        value: currentValue(),
        error: null,
        status: state.value.status,
      };
    }

    function fail(mySeq: number, err: unknown, status: number | null): void {
      // Sequence number only. Every path that ends this resource — refresh,
      // cancel, dispose — bumps `seq`, so one comparison covers "superseded",
      // "cancelled", and "torn down" alike.
      if (mySeq !== seq) return;
      const error = err instanceof Error ? err : new Error(String(err));
      state.value = { loading: false, value: currentValue(), error: error.message, status };
      // The label, never the URL: this string reaches whatever error reporter
      // the app installed, and a URL routinely carries ids and tokens.
      reportContained(ctx, error, `resource:${label}`);
    }

    async function runAttempt(
      mySeq: number,
      myController: AbortController,
      prepared: ResourceRequest | null,
    ): Promise<void> {
      // Checked before the spec is called, not just before the write: after an
      // unmount the spec's callback handle has been released, and invoking it
      // would throw "Unknown callback handle" from a detached microtask.
      if (mySeq !== seq) return;

      let request: ResourceRequest;
      if (prepared != null) {
        // The spec-change check already resolved this one; calling the spec a
        // second time would double any work it does and could resolve to a
        // different request than the one that was compared.
        request = prepared;
      } else {
        try {
          request = normalizeResourceRequest(spec(), label);
        } catch (e) {
          lastFingerprint = failureFingerprint(e);
          fail(mySeq, e, null);
          return;
        }
        lastFingerprint = requestFingerprint(request);
      }

      // Bound at the fetch and read by the catch below: a body that fails to
      // decode still arrived with a status, and discarding it made "the server
      // answered 200 with garbage" indistinguishable from "the transport never
      // produced a response at all".
      let status: number | null = null;
      try {
        const response = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          credentials: request.credentials,
          signal: myController.signal,
        });
        if (mySeq !== seq) return;
        status = response.status;

        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          const suffix = detail ? ` - ${snippet(detail)}` : "";
          fail(mySeq, new Error(`HTTP ${response.status}${suffix}`), response.status);
          return;
        }

        const value = await decodeResourceBody(response, request.as);
        // Re-checked after EVERY await, not just after the fetch: reading and
        // decoding the body is itself asynchronous, so a newer attempt can
        // complete in full while this one is still parsing.
        if (mySeq !== seq) return;
        state.value = { loading: false, value, error: null, status: response.status };
      } catch (e) {
        // A deliberate cancel is not a failure and must not reach onerror.
        if (myController.signal.aborted) return;
        fail(mySeq, e, status);
      }
    }

    function scheduleAttempt(prepared: ResourceRequest | null = null): void {
      if (disposed) return;
      // Bumped synchronously so a response already in flight is stale the
      // instant a newer attempt is requested, whether or not the transport
      // honours the abort.
      const mySeq = ++seq;
      controller?.abort();
      const myController = new AbortController();
      controller = myController;
      queueMicrotask(() => {
        // Nothing is awaiting this promise, so an escaping rejection would land
        // as an unattributed unhandled rejection: a throwing error reporter or
        // a throwing signal subscriber must not degrade into one.
        void runAttempt(mySeq, myController, prepared).catch((e) => {
          reportContained(ctx, e, `resource:${label}`);
        });
      });
    }

    /**
     * Re-resolve the adopted spec on a clean stack and refetch if it moved.
     *
     * Runs in a microtask, never during the render that adopted the spec: the
     * spec is user code that may be slow, and a render is the one place this
     * module never calls it from. Coalesced, so several renders in one tick
     * resolve the spec once.
     */
    function scheduleSpecCheck(): void {
      if (disposed || specCheckQueued) return;
      specCheckQueued = true;
      queueMicrotask(() => {
        // Same containment as a queued attempt: this runs on a detached stack,
        // and the loading write it may perform re-renders the component
        // synchronously, so a subscriber that throws would escape as an
        // unattributed error rather than one named after this resource.
        try {
          runSpecCheck();
        } catch (e) {
          reportContained(ctx, e, `resource:${label}`);
        }
      });
    }

    function runSpecCheck(): void {
      specCheckQueued = false;
      if (disposed) return;

      let request: ResourceRequest;
      try {
        request = normalizeResourceRequest(spec(), label);
      } catch (e) {
        // A spec that cannot describe a request any more is a real failure —
        // but only the first time, or the app would be told again on every
        // render for as long as the inputs stay broken.
        const fingerprint = failureFingerprint(e);
        if (fingerprint === lastFingerprint) return;
        lastFingerprint = fingerprint;
        const mySeq = ++seq;
        controller?.abort();
        controller = null;
        fail(mySeq, e, null);
        return;
      }

      const fingerprint = requestFingerprint(request);
      if (fingerprint === lastFingerprint) return;
      // No attempt has resolved a request yet, so there is nothing to compare
      // against: the first one was cancelled or torn down before it ran. Adopt
      // the fingerprint so a *later* change is still seen, but do not start the
      // request the cancel just stopped.
      const seeding = lastFingerprint === null;
      lastFingerprint = fingerprint;
      if (seeding) return;

      ctx.diagnostics.record(() => ({
        kind: "stream",
        at: Date.now(),
        context: `resource:${id}`,
        detail: "refetch",
      }));
      markLoading();
      scheduleAttempt(request);
    }

    function refresh(): void {
      if (disposed) return;
      markLoading();
      scheduleAttempt();
    }

    function cancel(): void {
      if (disposed) return;
      seq += 1;
      controller?.abort();
      controller = null;
      state.value = {
        loading: false,
        value: currentValue(),
        error: null,
        status: state.value.status,
      };
    }

    /**
     * Adopt the spec function from the latest render and re-check its request.
     *
     * A component body allocates a fresh closure every render, so without this
     * the resource would keep the first render's captured props forever and a
     * later `resource/refresh!` would refetch a stale URL. The superseded
     * handle is released here; `runAttempt` reads `spec` at call time, so a
     * queued attempt picks up the replacement rather than the released one.
     *
     * The check is scheduled even when the closure is unchanged: a spec passed
     * by symbol is literally the same value on every render, and still reads
     * whatever its body reads, so identity is no evidence that the request it
     * describes stayed put.
     */
    function replaceSpec(nextValue: unknown): void {
      if (disposed) return;
      adoptSpec(nextValue);
      scheduleSpecCheck();
    }

    function adoptSpec(nextValue: unknown): void {
      if (nextValue === currentSpecValue) return;
      const nextHandle = callbackHandle(nextValue);
      // A global function passed by symbol dedups to the SAME handle on the
      // wasm side; releasing it would invalidate the spec we are still using.
      if (nextHandle != null && nextHandle === callbackHandle(currentSpecValue)) return;
      const next = toInvokableCallback(nextValue, interp, "resource spec");
      const superseded = currentSpecValue;
      spec = next;
      currentSpecValue = nextValue;
      releaseCallback(superseded);
    }

    function dispose(): void {
      if (disposed) return;
      disposed = true;
      seq += 1;
      controller?.abort();
      controller = null;
      releaseCallback(currentSpecValue);
      unregisterStream(ctx, id);
      ctx.resources.delete(id);
      if (key != null) ctx.resourcesByKey.delete(key);
    }

    // Registered as a stream so the dev timeline sees its lifecycle and the
    // existing teardown paths reap it: `destroyMountedComponent` closes every
    // owned stream and disposes its signal, and `disposeContextResources`
    // closes every registered stream.
    registerStream(ctx, id, { kind: "resource", close: cancel });
    ctx.resources.set(id, { key, refresh, cancel, replaceSpec });
    if (key != null) ctx.resourcesByKey.set(key, id);
    registerSignalFinalizer(ctx, id, dispose);

    const owner = ownerId != null ? ctx.mountedComponentsById.get(ownerId) : undefined;
    if (owner) {
      owner.ownedStreamIds.add(id);
      const scope = currentScopePath(ctx);
      let scoped = owner.ownedScopeResources.get(scope);
      if (!scoped) {
        scoped = new Set();
        owner.ownedScopeResources.set(scope, scoped);
      }
      scoped.add(id);
    }

    scheduleAttempt();
    return id;
  }

  interp.registerFunction("resource", (first: unknown, second?: unknown) =>
    second === undefined
      ? createResource(null, first)
      : createResource(String(first), second),
  );

  interp.registerFunction("resource/refresh!", (handle: unknown) => {
    resolveResource(ctx, handle, "resource/refresh!")?.refresh();
    return null;
  });

  interp.registerFunction("resource/cancel!", (handle: unknown) => {
    resolveResource(ctx, handle, "resource/cancel!")?.cancel();
    return null;
  });
}

/**
 * Resolve a resource from a numeric handle or a name.
 *
 * A name is resolved against the current owner, which is why
 * `(resource/refresh! "user")` works from a delegated event handler where the
 * handle the component body allocated is out of scope. An unknown *name* throws
 * — it can only be a typo — while an unknown *handle* is a no-op, because a
 * handle legitimately outlives the component that owned it.
 */
function resolveResource(ctx: SemaWebContext, handle: unknown, fnName: string) {
  if (typeof handle === "number") {
    return ctx.resources.get(handle) ?? null;
  }
  if (typeof handle === "string") {
    const id = ctx.resourcesByKey.get(
      `${getCurrentOwnerId(ctx) ?? "global"}:${currentScopePath(ctx)}:${handle}`,
    );
    const found = id != null ? ctx.resources.get(id) ?? null : null;
    if (!found) {
      throw new Error(`(${fnName} "${handle}") — no resource named "${handle}" is registered here`);
    }
    return found;
  }
  throw new Error(`(${fnName}) expects a resource handle or name, got ${typeof handle}`);
}
