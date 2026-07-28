/**
 * Async data resources: `(resource …)`, `resource/refresh!`, `resource/cancel!`.
 *
 * Mocks nothing except `fetch`. The real `@preact/signals-core` and the real
 * `morphdom` are used because the two properties that matter most cannot be
 * observed against a stub:
 *
 * - the memoization guard exists to stop "response writes signal → re-render →
 *   new resource → new fetch" from looping, which needs signals that really
 *   re-run an effect;
 * - unmount teardown is asserted through a genuine `component/mount!`.
 *
 * The fake transport deliberately **ignores** the abort signal in the staleness
 * tests. That is the point: it proves the sequence-number guard drops a stale
 * response on its own, rather than leaning on `AbortController` to make the
 * response never arrive.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SemaWebContext, disposeContextResources } from "../src/context.js";
import {
  registerResourceBindings,
  normalizeResourceRequest,
  decodeResourceBody,
} from "../src/resource.js";
import { registerComponentBindings, disposeAllComponents } from "../src/component.js";
import { registerReactiveBindings } from "../src/reactive.js";
import type { SemaCallback } from "../src/callbacks.js";
import { createMockInterpreter } from "./helpers.js";

/**
 * A Sema callback as it actually arrives from WASM: a fresh JS wrapper carrying
 * a handle id and a release hook. Two wrappers with the same handle stand for
 * the same Sema value (a global passed by symbol); distinct handles stand for a
 * freshly allocated closure.
 */
function marshalled(
  impl: (...args: any[]) => any,
  opts?: { handle?: number; release?: () => void },
): SemaCallback {
  const fn = ((...args: any[]) => impl(...args)) as SemaCallback;
  if (opts?.handle != null) fn.__semaCallbackHandle = opts.handle;
  fn.__semaRelease = opts?.release ?? (() => {});
  return fn;
}

interface DeferredCall {
  url: string;
  init: RequestInit;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
}

/** A fetch whose responses are completed by the test, in any order. */
function deferredFetch() {
  const calls: DeferredCall[] = [];
  const fetchMock = vi.fn(
    (url: string, init: RequestInit = {}) =>
      new Promise<Response>((resolve, reject) => {
        calls.push({ url, init, resolve, reject });
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

/** A fetch that rejects on abort, the way the platform's does. */
function abortingFetch() {
  const calls: DeferredCall[] = [];
  const fetchMock = vi.fn(
    (url: string, init: RequestInit = {}) =>
      new Promise<Response>((resolve, reject) => {
        calls.push({ url, init, resolve, reject });
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

/**
 * A response whose body arrives only when the test releases it.
 *
 * Reading and decoding a body is asynchronous on its own, so an attempt can be
 * superseded *after* its fetch resolved. Nothing built from a real `Response`
 * can hold that window open.
 */
function slowResponse(body: string, opts: { status?: number; contentType?: string } = {}) {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const status = opts.status ?? 200;
  const response = {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? opts.contentType ?? "application/json" : null,
    },
    text: async () => {
      await gate;
      return body;
    },
  } as unknown as Response;
  return { response, release };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status = 200, contentType = "text/plain"): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("async resources", () => {
  let interp: ReturnType<typeof createMockInterpreter>;
  let ctx: SemaWebContext;
  let errors: Array<{ message: string; context: string }>;

  beforeEach(() => {
    interp = createMockInterpreter();
    ctx = new SemaWebContext();
    errors = [];
    document.body.innerHTML = '<div id="app"></div><div id="other"></div>';
    registerComponentBindings(interp, ctx);
    registerReactiveBindings(interp, ctx);
    registerResourceBindings(interp, ctx);
    ctx.onerror = (e, context) => errors.push({ message: e.message, context });
  });

  afterEach(() => {
    disposeAllComponents(ctx);
    vi.restoreAllMocks();
  });

  const create = (...args: unknown[]) => interp.getFunction("resource")!(...args) as number;
  const refresh = (handle: unknown) => interp.getFunction("resource/refresh!")!(handle);
  const cancel = (handle: unknown) => interp.getFunction("resource/cancel!")!(handle);
  const stateOf = (id: number) => ctx.signals.get(id)!.value;
  const mountView = (name: string, view: () => any, selector = "#app") => {
    interp.registerFunction(name, view);
    interp.getFunction("component/mount!")!(selector, name);
  };
  const unmount = (selector = "#app") => interp.getFunction("component/unmount!")!(selector);

  // --- surface -------------------------------------------------------------

  it("registers resource, resource/refresh! and resource/cancel!", () => {
    expect(typeof interp.getFunction("resource")).toBe("function");
    expect(typeof interp.getFunction("resource/refresh!")).toBe("function");
    expect(typeof interp.getFunction("resource/cancel!")).toBe("function");
  });

  it("returns a numeric handle and is loading before anything is flushed", () => {
    deferredFetch();
    const id = create(marshalled(() => "/api/user"));

    expect(typeof id).toBe("number");
    expect(stateOf(id)).toEqual({ loading: true, value: null, error: null, status: null });
  });

  it("does not call the spec function during creation", () => {
    deferredFetch();
    const spec = vi.fn(() => "/api/user");
    create(marshalled(spec));

    expect(spec).not.toHaveBeenCalled();
  });

  // --- request building ----------------------------------------------------

  it("treats a bare URL string as a GET", async () => {
    const { fetchMock } = deferredFetch();
    create(marshalled(() => "/api/user"));
    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/user",
      expect.objectContaining({ method: "GET", credentials: "same-origin", body: undefined }),
    );
  });

  it("builds the request an options map describes", async () => {
    const { fetchMock } = deferredFetch();
    create(
      marshalled(() => ({
        url: "/api/search",
        method: "post",
        headers: { "x-token": "secret", "x-retries": 2 },
        body: "raw-payload",
        "with-credentials": true,
      })),
    );
    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/search",
      expect.objectContaining({
        method: "POST",
        headers: { "x-token": "secret", "x-retries": "2" },
        body: "raw-payload",
        credentials: "include",
      }),
    );
  });

  it("accepts colon-prefixed keys and keyword values identically", async () => {
    const { fetchMock } = deferredFetch();
    create(
      marshalled(() => ({
        ":url": "/api/search",
        ":method": ":post",
        ":headers": { ":x-token": "secret" },
        ":body": "raw-payload",
        ":with-credentials": true,
        ":as": ":text",
      })),
    );
    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/search",
      expect.objectContaining({
        method: "POST",
        headers: { "x-token": "secret" },
        body: "raw-payload",
        credentials: "include",
      }),
    );
  });

  it("JSON-encodes a non-string body and defaults its content type", async () => {
    const { fetchMock } = deferredFetch();
    create(marshalled(() => ({ url: "/api/search", body: { q: "sema" } })));
    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/search",
      expect.objectContaining({
        method: "POST",
        body: '{"q":"sema"}',
        headers: { "content-type": "application/json" },
      }),
    );
  });

  it("does not override a content type the spec already set", async () => {
    const { fetchMock } = deferredFetch();
    create(
      marshalled(() => ({
        url: "/api/search",
        body: { q: "sema" },
        headers: { "Content-Type": "application/vnd.api+json" },
      })),
    );
    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/search",
      expect.objectContaining({ headers: { "Content-Type": "application/vnd.api+json" } }),
    );
  });

  it("reports a spec that returns nothing usable and never fetches", async () => {
    const { fetchMock } = deferredFetch();
    const id = create("user", marshalled(() => null));
    await flushAsyncWork();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(stateOf(id)).toMatchObject({ loading: false, value: null, status: null });
    expect(stateOf(id).error).toMatch(/must return a URL string or an options map with :url/);
    expect(errors).toEqual([
      { message: stateOf(id).error, context: "resource:user" },
    ]);
  });

  it("reports a spec that throws, preserving its message", async () => {
    const { fetchMock } = deferredFetch();
    const id = create("user", marshalled(() => {
      throw new Error("props not ready");
    }));
    await flushAsyncWork();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(stateOf(id).error).toBe("props not ready");
    expect(errors).toEqual([{ message: "props not ready", context: "resource:user" }]);
  });

  it("rejects an unknown :as value", async () => {
    deferredFetch();
    const id = create("user", marshalled(() => ({ url: "/api", as: "xml" })));
    await flushAsyncWork();

    expect(stateOf(id).error).toMatch(/:as must be "auto", "json", or "text", got "xml"/);
  });

  it("normalizeResourceRequest is the production normalizer the native uses", () => {
    expect(normalizeResourceRequest("/api/x", "user")).toEqual({
      url: "/api/x",
      method: "GET",
      headers: undefined,
      body: undefined,
      credentials: "same-origin",
      as: "auto",
    });
    expect(() => normalizeResourceRequest(["/api/x"], "user")).toThrow(/options map with :url/);
    expect(() => normalizeResourceRequest("", "user")).toThrow(/empty URL/);
  });

  // --- decoding ------------------------------------------------------------

  it("decodes a JSON content type into a value", async () => {
    const { calls } = deferredFetch();
    const id = create("user", marshalled(() => "/api/user"));
    await flushAsyncWork();
    calls[0].resolve(jsonResponse({ name: "bob" }));
    await flushAsyncWork();

    expect(stateOf(id)).toEqual({
      loading: false,
      value: { name: "bob" },
      error: null,
      status: 200,
    });
  });

  it("keeps a text content type as text", async () => {
    const { calls } = deferredFetch();
    const id = create("user", marshalled(() => "/api/user"));
    await flushAsyncWork();
    calls[0].resolve(textResponse("plain words"));
    await flushAsyncWork();

    expect(stateOf(id).value).toBe("plain words");
  });

  it(':as "text" wins over a JSON content type', async () => {
    const { calls } = deferredFetch();
    const id = create("user", marshalled(() => ({ url: "/api/user", as: "text" })));
    await flushAsyncWork();
    calls[0].resolve(jsonResponse({ name: "bob" }));
    await flushAsyncWork();

    expect(stateOf(id).value).toBe('{"name":"bob"}');
  });

  it("reports a malformed JSON body without clobbering the previous value", async () => {
    const { calls } = deferredFetch();
    const id = create("user", marshalled(() => "/api/user"));
    await flushAsyncWork();
    calls[0].resolve(textResponse("{not json", 200, "application/json"));
    await flushAsyncWork();

    // The status is the response's, not null: a component branching on
    // `(:status @r)` has to be able to tell "the server answered 200 with
    // garbage" from "the transport never produced a response".
    expect(stateOf(id)).toMatchObject({ loading: false, value: null, status: 200 });
    expect(stateOf(id).error).toMatch(/JSON/);
    expect(errors).toHaveLength(1);
    expect(errors[0].context).toBe("resource:user");
  });

  it("decodes an empty body as nil rather than a JSON failure", async () => {
    const { calls } = deferredFetch();
    const id = create("user", marshalled(() => "/api/user"));
    await flushAsyncWork();
    calls[0].resolve(new Response(null, { status: 204, headers: { "content-type": "application/json" } }));
    await flushAsyncWork();

    expect(stateOf(id)).toEqual({ loading: false, value: null, error: null, status: 204 });
    expect(errors).toEqual([]);
  });

  it("decodeResourceBody is the production decoder the native uses", async () => {
    await expect(decodeResourceBody(jsonResponse({ a: 1 }), "auto")).resolves.toEqual({ a: 1 });
    await expect(decodeResourceBody(jsonResponse({ a: 1 }), "text")).resolves.toBe('{"a":1}');
    await expect(decodeResourceBody(textResponse("hi"), "auto")).resolves.toBe("hi");
    await expect(decodeResourceBody(textResponse("nope"), "json")).rejects.toThrow(/JSON/);
  });

  it("reports an error status with the response body and keeps the previous value", async () => {
    const { calls } = deferredFetch();
    const id = create("user", marshalled(() => "/api/user"));
    await flushAsyncWork();
    calls[0].resolve(jsonResponse({ name: "bob" }));
    await flushAsyncWork();
    expect(stateOf(id).value).toEqual({ name: "bob" });

    refresh(id);
    await flushAsyncWork();
    calls[1].resolve(textResponse("not found", 404));
    await flushAsyncWork();

    expect(stateOf(id)).toEqual({
      loading: false,
      value: { name: "bob" },
      error: "HTTP 404 - not found",
      status: 404,
    });
    expect(errors).toEqual([{ message: "HTTP 404 - not found", context: "resource:user" }]);
  });

  it("reports a transport failure through the signal and onerror", async () => {
    const { calls } = deferredFetch();
    const id = create("user", marshalled(() => "/api/user"));
    await flushAsyncWork();
    calls[0].reject(new Error("network down"));
    await flushAsyncWork();

    expect(stateOf(id)).toMatchObject({ loading: false, error: "network down", status: null });
    expect(errors).toEqual([{ message: "network down", context: "resource:user" }]);
  });

  // --- staleness -----------------------------------------------------------

  it("keeps the newest response when three attempts settle out of order", async () => {
    const { calls } = deferredFetch();
    const id = create("user", marshalled(() => "/api/user"));
    await flushAsyncWork();
    refresh(id);
    await flushAsyncWork();
    refresh(id);
    await flushAsyncWork();
    expect(calls).toHaveLength(3);

    calls[2].resolve(jsonResponse({ n: 3 }));
    await flushAsyncWork();
    calls[0].resolve(jsonResponse({ n: 1 }));
    calls[1].resolve(jsonResponse({ n: 2 }));
    await flushAsyncWork();

    expect(stateOf(id)).toEqual({ loading: false, value: { n: 3 }, error: null, status: 200 });
  });

  it("refreshing twice in a row issues one request and keeps its response", async () => {
    const { calls } = deferredFetch();
    const id = create("user", marshalled(() => "/api/user"));
    await flushAsyncWork();
    refresh(id);
    refresh(id);
    await flushAsyncWork();

    // The superseded refresh never reaches the network: it is already stale by
    // the time its attempt runs.
    expect(calls).toHaveLength(2);

    calls[1].resolve(jsonResponse({ n: "latest" }));
    await flushAsyncWork();
    expect(stateOf(id)).toMatchObject({ loading: false, value: { n: "latest" } });

    // The original attempt is still pending; landing now must change nothing.
    calls[0].resolve(jsonResponse({ n: "first" }));
    await flushAsyncWork();
    expect(stateOf(id).value).toEqual({ n: "latest" });
  });

  it("a superseded attempt that fails does not clear the newer attempt's loading state", async () => {
    const { calls } = deferredFetch();
    const id = create("user", marshalled(() => "/api/user"));
    await flushAsyncWork();
    refresh(id);
    await flushAsyncWork();

    calls[0].reject(new Error("stale failure"));
    await flushAsyncWork();

    expect(stateOf(id)).toMatchObject({ loading: true, error: null });
    expect(errors).toEqual([]);
  });

  it("refresh marks loading synchronously, keeps the value, and clears the error", async () => {
    const { calls } = deferredFetch();
    const id = create("user", marshalled(() => "/api/user"));
    await flushAsyncWork();
    calls[0].resolve(textResponse("first", 200));
    await flushAsyncWork();

    refresh(id);
    expect(stateOf(id)).toEqual({
      loading: true,
      value: "first",
      error: null,
      status: 200,
    });
  });

  it("a response still decoding when a newer one lands is discarded", async () => {
    const { calls } = deferredFetch();
    const id = create("user", marshalled(() => "/api/user"));
    await flushAsyncWork();

    // Attempt 1's fetch resolves, so it is past the post-fetch staleness
    // check, and then parks inside the body read.
    const slow = slowResponse('{"n":1}');
    calls[0].resolve(slow.response);
    await flushAsyncWork();

    refresh(id);
    await flushAsyncWork();
    calls[1].resolve(jsonResponse({ n: 2 }));
    await flushAsyncWork();
    expect(stateOf(id).value).toEqual({ n: 2 });

    slow.release();
    await flushAsyncWork();
    expect(stateOf(id)).toEqual({ loading: false, value: { n: 2 }, error: null, status: 200 });
  });

  it("an error body still being read when a newer response lands is discarded", async () => {
    const { calls } = deferredFetch();
    const id = create("user", marshalled(() => "/api/user"));
    await flushAsyncWork();

    const slow = slowResponse("server exploded", { status: 500 });
    calls[0].resolve(slow.response);
    await flushAsyncWork();

    refresh(id);
    await flushAsyncWork();
    calls[1].resolve(jsonResponse({ n: 2 }));
    await flushAsyncWork();

    slow.release();
    await flushAsyncWork();

    expect(stateOf(id)).toEqual({ loading: false, value: { n: 2 }, error: null, status: 200 });
    expect(errors).toEqual([]);
  });

  it("a predecessor rejected by its own abort is silent", async () => {
    const { calls } = abortingFetch();
    const id = create("user", marshalled(() => "/api/user"));
    await flushAsyncWork();

    refresh(id);
    await flushAsyncWork();

    expect(calls[0].init.signal!.aborted).toBe(true);
    expect(stateOf(id)).toMatchObject({ loading: true, error: null });
    expect(errors).toEqual([]);
  });

  it("each attempt aborts its predecessor", async () => {
    const { calls } = deferredFetch();
    const id = create("user", marshalled(() => "/api/user"));
    await flushAsyncWork();
    expect(calls[0].init.signal!.aborted).toBe(false);

    refresh(id);
    expect(calls[0].init.signal!.aborted).toBe(true);
  });

  // --- cancel --------------------------------------------------------------

  it("cancel aborts the in-flight request", async () => {
    const { calls } = deferredFetch();
    const id = create("user", marshalled(() => "/api/user"));
    await flushAsyncWork();

    cancel(id);
    expect(calls[0].init.signal!.aborted).toBe(true);
  });

  it("cancel leaves the previous value in place and reports nothing", async () => {
    const { calls } = deferredFetch();
    const id = create("user", marshalled(() => "/api/user"));
    await flushAsyncWork();
    calls[0].resolve(textResponse("cached", 200));
    await flushAsyncWork();

    refresh(id);
    cancel(id);
    await flushAsyncWork();

    expect(stateOf(id)).toEqual({ loading: false, value: "cached", error: null, status: 200 });
    expect(errors).toEqual([]);
  });

  it("a cancelled request that rejects with AbortError is not a failure", async () => {
    const { calls } = abortingFetch();
    const id = create("user", marshalled(() => "/api/user"));
    await flushAsyncWork();

    cancel(id);
    await flushAsyncWork();

    expect(calls[0].init.signal!.aborted).toBe(true);
    expect(stateOf(id)).toEqual({ loading: false, value: null, error: null, status: null });
    expect(errors).toEqual([]);
  });

  it("an unmount that rejects the in-flight request reports nothing", async () => {
    abortingFetch();
    mountView("v", () => {
      create("user", marshalled(() => "/api/user"));
      return [":p", {}, "hi"];
    });
    await flushAsyncWork();

    unmount();
    await flushAsyncWork();

    expect(errors).toEqual([]);
  });

  it("ignores a response that lands after a cancel", async () => {
    const { calls } = deferredFetch();
    const id = create("user", marshalled(() => "/api/user"));
    await flushAsyncWork();

    cancel(id);
    calls[0].resolve(jsonResponse({ late: true }));
    await flushAsyncWork();

    expect(stateOf(id)).toEqual({ loading: false, value: null, error: null, status: null });
    expect(errors).toEqual([]);
  });

  it("an unknown numeric handle is a no-op for refresh and cancel", () => {
    deferredFetch();
    expect(refresh(9999)).toBeNull();
    expect(cancel(9999)).toBeNull();
    expect(errors).toEqual([]);
  });

  it("an unknown name throws and names the resource asked for", () => {
    deferredFetch();
    create("user", marshalled(() => "/api/user"));

    expect(() => refresh("usr")).toThrow(/no resource named "usr"/);
    expect(() => cancel("usr")).toThrow(/no resource named "usr"/);
  });

  it("rejects a handle that is neither a number nor a name", () => {
    expect(() => refresh(null)).toThrow(/expects a resource handle or name/);
  });

  it("resolves a name against the current owner, as an event handler would", async () => {
    const { calls, fetchMock } = deferredFetch();
    const component = {
      instanceId: 42,
      target: document.createElement("div"),
      componentFn: "view",
      props: null,
      dispose: null,
      eventCleanup: null,
      localState: new Map(),
      mountCleanup: null,
      pendingMount: null,
      ownedSignalIds: new Set<number>(),
      ownedWatchIds: new Set<number>(),
      ownedIntervalIds: new Set<number>(),
      ownedStreamIds: new Set<number>(),
      ownedListenerKeys: new Set<string>(),
      pendingLifecycle: new Map(),
      ownedLifecycleSlots: new Map(),
      visitedScopes: new Set<string>(),
      ownedScopeResources: new Map(),
    };
    ctx.mountedComponentsById.set(component.instanceId, component as any);

    ctx.ownerStack.push(component.instanceId);
    const id = create("user", marshalled(() => "/api/user"));
    ctx.ownerStack.pop();
    await flushAsyncWork();
    calls[0].resolve(textResponse("v1"));
    await flushAsyncWork();

    // Outside the owner the name is not visible…
    expect(() => refresh("user")).toThrow(/no resource named "user"/);

    // …and inside it (an event handler runs under withOwnerContext) it is.
    ctx.ownerStack.push(component.instanceId);
    refresh("user");
    ctx.ownerStack.pop();
    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stateOf(id).loading).toBe(true);
  });

  // --- ownership, memoization, teardown ------------------------------------

  it("registers as a stream owned by the component that created it", () => {
    deferredFetch();
    let id = -1;
    mountView("v", () => {
      id = create("user", marshalled(() => "/api/user"));
      return [":p", {}, "hi"];
    });

    expect(ctx.streams.get(id)).toMatchObject({ kind: "resource" });
    expect(ctx.resources.has(id)).toBe(true);
    expect(ctx.mountedComponents.get("#app")!.ownedStreamIds.has(id)).toBe(true);
  });

  it("memoizes by name so a resolving response cannot loop the render", async () => {
    const { calls, fetchMock } = deferredFetch();
    const ids: number[] = [];
    let renders = 0;
    mountView("v", () => {
      renders += 1;
      const id = create("user", marshalled(() => "/api/user"));
      ids.push(id);
      const s = ctx.signals.get(id)!.value;
      return [":p", {}, s.loading ? "loading" : String(s.value)];
    });

    expect(document.getElementById("app")!.textContent).toBe("loading");
    await flushAsyncWork();
    calls[0].resolve(textResponse("bob"));
    await flushAsyncWork();

    expect(document.getElementById("app")!.textContent).toBe("bob");
    expect(renders).toBe(2);
    expect(new Set(ids).size).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("adopts the latest render's spec and releases the superseded handle", async () => {
    const { calls, fetchMock } = deferredFetch();
    const releaseFirst = vi.fn();
    const releaseSecond = vi.fn();
    let url = "/api/user/1";
    let id = -1;
    const bump = interp.getFunction("__state/create")!(0) as number;

    mountView("v", () => {
      const captured = url;
      const release = captured === "/api/user/1" ? releaseFirst : releaseSecond;
      id = create(
        "user",
        marshalled(() => captured, { handle: captured === "/api/user/1" ? 1 : 2, release }),
      );
      interp.getFunction("__state/deref")!(bump);
      return [":p", {}, "hi"];
    });
    await flushAsyncWork();
    expect(calls[0].url).toBe("/api/user/1");
    expect(releaseFirst).not.toHaveBeenCalled();

    url = "/api/user/2";
    interp.getFunction("__state/put!")!(bump, 1);
    expect(releaseFirst).toHaveBeenCalledTimes(1);
    expect(releaseSecond).not.toHaveBeenCalled();

    // The point of this test is the handle accounting above. The refetch is
    // covered on its own further down — since the adopted spec is re-checked,
    // this explicit refresh coalesces with the check rather than adding a
    // request of its own.
    refresh(id);
    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls[1].url).toBe("/api/user/2");
  });

  it("re-registering the same callback handle releases nothing and stays usable", async () => {
    const { calls, fetchMock } = deferredFetch();
    const release = vi.fn();
    let id = -1;
    const bump = interp.getFunction("__state/create")!(0) as number;

    mountView("v", () => {
      // Same handle on every render: a global function passed by symbol.
      id = create("user", marshalled(() => "/api/user", { handle: 7, release }));
      interp.getFunction("__state/deref")!(bump);
      return [":p", {}, "hi"];
    });
    await flushAsyncWork();
    interp.getFunction("__state/put!")!(bump, 1);

    expect(release).not.toHaveBeenCalled();

    refresh(id);
    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls[1].url).toBe("/api/user");
  });

  // --- refetching when the spec's request moves ----------------------------

  /**
   * A component whose resource URL is built from a value the test controls,
   * plus a signal the render reads so the test can force a re-render.
   *
   * Mirrors the documented shape — `(fn () (string-append "/api/users/" (:id
   * props)))` — where the URL is a function of the component's inputs and the
   * closure is allocated fresh by every render.
   */
  function mountResourceView(spec: () => unknown, opts: { handle?: number } = {}) {
    const rerender = interp.getFunction("__state/create")!(0) as number;
    let renders = 0;
    let id = -1;
    mountView("v", () => {
      renders += 1;
      id = create("user", marshalled(spec, opts.handle != null ? { handle: opts.handle } : undefined));
      interp.getFunction("__state/deref")!(rerender);
      const s = ctx.signals.get(id)!.value;
      return [":p", {}, s.loading ? "loading" : String(s.value)];
    });
    return {
      get id() {
        return id;
      },
      get renders() {
        return renders;
      },
      text: () => document.getElementById("app")!.textContent,
      rerender: () => interp.getFunction("__state/put!")!(rerender, renders),
    };
  }

  it("refetches when a re-render resolves the spec to a different URL", async () => {
    const { calls, fetchMock } = deferredFetch();
    let uid = "1";
    const view = mountResourceView(() => `/api/user/${uid}`);
    await flushAsyncWork();
    calls[0].resolve(textResponse("one"));
    await flushAsyncWork();
    expect(view.text()).toBe("one");

    uid = "2";
    view.rerender();
    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls[1].url).toBe("/api/user/2");
    // Revalidation, not a blank slate: the old value stays on screen and the
    // state says loading, which is what makes the staleness visible at all.
    expect(stateOf(view.id)).toMatchObject({ loading: true, value: "one", error: null });

    calls[1].resolve(textResponse("two"));
    await flushAsyncWork();
    expect(view.text()).toBe("two");
    expect(errors).toEqual([]);
  });

  it("does not refetch when re-renders resolve the same request", async () => {
    const { calls, fetchMock } = deferredFetch();
    const view = mountResourceView(() => "/api/user");
    await flushAsyncWork();
    calls[0].resolve(textResponse("one"));
    await flushAsyncWork();

    for (let i = 0; i < 10; i++) {
      view.rerender();
      await flushAsyncWork();
    }

    // The whole reason the check compares the resolved request rather than the
    // closure: every render allocates a new closure, and refetching on that
    // would be a request per render forever.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stateOf(view.id)).toMatchObject({ loading: false, value: "one" });
  });

  it("re-checks a spec whose closure identity never changes", async () => {
    const { calls, fetchMock } = deferredFetch();
    let uid = "1";
    // Handle 7 on every render: a global spec function passed by symbol, which
    // dedups to one wasm handle, so identity can never signal a change.
    const view = mountResourceView(() => `/api/user/${uid}`, { handle: 7 });
    await flushAsyncWork();
    calls[0].resolve(textResponse("one"));
    await flushAsyncWork();

    uid = "2";
    view.rerender();
    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls[1].url).toBe("/api/user/2");
  });

  it("refetches when only the method, headers, or body move", async () => {
    const { calls, fetchMock } = deferredFetch();
    let token = "a";
    const view = mountResourceView(() => ({
      url: "/api/search",
      method: "post",
      headers: { "x-token": token },
      body: { q: "sema" },
    }));
    await flushAsyncWork();
    calls[0].resolve(textResponse("one"));
    await flushAsyncWork();

    // Same URL, different credentials: the response on screen was fetched with
    // the old token and is exactly as stale as one from another path.
    token = "b";
    view.rerender();
    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls[1].init.headers).toMatchObject({ "x-token": "b" });
  });

  it("supersedes an in-flight attempt when the spec moves", async () => {
    const { calls, fetchMock } = deferredFetch();
    let uid = "1";
    const view = mountResourceView(() => `/api/user/${uid}`);
    await flushAsyncWork();

    // Nothing has settled yet — the first request is still open.
    uid = "2";
    view.rerender();
    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls[0].init.signal!.aborted).toBe(true);

    // The abandoned response for uid 1 must never reach the signal.
    calls[0].resolve(textResponse("one"));
    calls[1].resolve(textResponse("two"));
    await flushAsyncWork();
    expect(stateOf(view.id)).toMatchObject({ loading: false, value: "two" });
  });

  it("reports a spec that starts failing once, not on every render", async () => {
    deferredFetch();
    let broken = false;
    const view = mountResourceView(() => {
      if (broken) throw new Error("props not ready");
      return "/api/user";
    });
    await flushAsyncWork();

    broken = true;
    view.rerender();
    await flushAsyncWork();
    expect(stateOf(view.id)).toMatchObject({ loading: false, error: "props not ready" });
    expect(errors).toEqual([{ message: "props not ready", context: "resource:user" }]);

    for (let i = 0; i < 3; i++) {
      view.rerender();
      await flushAsyncWork();
    }
    expect(errors).toHaveLength(1);
  });

  it("records a spec-driven refetch in the dev timeline", async () => {
    deferredFetch();
    ctx.diagnostics.enabled = true;
    let uid = "1";
    const view = mountResourceView(() => `/api/user/${uid}`);
    await flushAsyncWork();

    uid = "2";
    view.rerender();
    await flushAsyncWork();

    const entries = ctx.diagnostics.byKind("stream");
    expect(entries.map((e) => `${e.context} ${e.detail}`)).toEqual([
      `resource:${view.id} open`,
      `resource:${view.id} refetch`,
    ]);
  });

  // --- containment ---------------------------------------------------------

  it("contains a throwing error reporter instead of leaking an unhandled rejection", async () => {
    deferredFetch();
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    ctx.onerror = () => {
      throw new Error("reporter exploded");
    };

    try {
      // A spec that cannot produce a request fails inside the queued attempt —
      // a detached microtask with nobody to catch what the reporter throws.
      const id = create("user", marshalled(() => 42));
      await flushAsyncWork();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(rejections).toEqual([]);
      // The failure still reached the signal, which is the part a throwing
      // reporter used to take down with it.
      expect(stateOf(id)).toMatchObject({ loading: false, error: expect.stringContaining(":url") });
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("error handler threw while reporting resource:user"),
        expect.anything(),
        expect.anything(),
      );
    } finally {
      process.off("unhandledRejection", onRejection);
      consoleError.mockRestore();
    }
  });

  it("gives two components using the same name independent resources", () => {
    const { fetchMock } = deferredFetch();
    let a = -1;
    let b = -1;
    mountView("va", () => {
      a = create("user", marshalled(() => "/api/a"));
      return [":p", {}, "a"];
    }, "#app");
    mountView("vb", () => {
      b = create("user", marshalled(() => "/api/b"));
      return [":p", {}, "b"];
    }, "#other");

    expect(a).not.toBe(b);
    expect(ctx.resources.size).toBe(2);
    expect(ctx.resourcesByKey.size).toBe(2);

    return flushAsyncWork().then(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it("unmount aborts the request, releases the spec, and drops every owned entry", async () => {
    const { calls } = deferredFetch();
    const release = vi.fn();
    let id = -1;
    mountView("v", () => {
      id = create("user", marshalled(() => "/api/user", { release }));
      return [":p", {}, "hi"];
    });
    await flushAsyncWork();
    expect(calls).toHaveLength(1);

    unmount();

    expect(calls[0].init.signal!.aborted).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(ctx.signals.has(id)).toBe(false);
    expect(ctx.streams.has(id)).toBe(false);
    expect(ctx.resources.size).toBe(0);
    expect(ctx.resourcesByKey.size).toBe(0);

    // A response that lands after teardown is silent, not a crash.
    calls[0].resolve(jsonResponse({ late: true }));
    await flushAsyncWork();
    expect(errors).toEqual([]);
  });

  it("unmounting before the first attempt runs never calls the spec or fetch", async () => {
    const { fetchMock } = deferredFetch();
    const spec = vi.fn(() => "/api/user");
    mountView("v", () => {
      create("user", marshalled(spec));
      return [":p", {}, "hi"];
    });

    unmount();
    await flushAsyncWork();

    expect(spec).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it("disposing the context aborts in-flight requests and drains the registries", async () => {
    const { calls } = deferredFetch();
    const release = vi.fn();
    create("user", marshalled(() => "/api/user", { release }));
    create(marshalled(() => "/api/other"));
    await flushAsyncWork();

    disposeContextResources(ctx);

    expect(calls.every((c) => c.init.signal!.aborted)).toBe(true);
    expect(ctx.resources.size).toBe(0);
    expect(ctx.resourcesByKey.size).toBe(0);
    expect(ctx.streams.size).toBe(0);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("refuses an unnamed resource anywhere a component owns the call", async () => {
    const { fetchMock } = deferredFetch();
    mountView("v", () => {
      expect(() => create(marshalled(() => "/api/user"))).toThrow(
        /inside a component needs a name/,
      );
      return [":p", {}, "hi"];
    });

    // An effect body, an event handler, and an interval callback all run under
    // the owner stack with an empty render stack — the framework re-runs every
    // one of them, so an unnamed resource there is the same per-run allocation
    // the guard exists to stop, and testing the render stack alone missed it.
    const instanceId = ctx.mountedComponents.get("#app")!.instanceId;
    ctx.ownerStack.push(instanceId);
    expect(() => create(marshalled(() => "/api/other"))).toThrow(
      /inside a component needs a name/,
    );
    ctx.ownerStack.pop();

    // With no owner at all — module top level, a plain JS caller — the unnamed
    // form is still the documented shape.
    const id = create(marshalled(() => "/api/global"));
    expect(ctx.resources.get(id)!.key).toBeNull();
    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/global", expect.anything());
  });

  // --- diagnostics ---------------------------------------------------------

  it("records open and close in the dev timeline, and nothing when dev is off", () => {
    deferredFetch();
    mountView("quiet", () => {
      create("user", marshalled(() => "/api/user"));
      return [":p", {}, "hi"];
    });
    unmount();
    expect(ctx.diagnostics.byKind("stream")).toEqual([]);

    ctx.diagnostics.enabled = true;
    let id = -1;
    mountView("loud", () => {
      id = create("user", marshalled(() => "/api/user"));
      return [":p", {}, "hi"];
    });
    unmount();

    const entries = ctx.diagnostics.byKind("stream");
    expect(entries.map((e) => `${e.context} ${e.detail}`)).toEqual([
      `resource:${id} open`,
      `resource:${id} close`,
    ]);
  });
});
