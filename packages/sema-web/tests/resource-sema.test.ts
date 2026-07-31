/**
 * Drive the resource bindings from real Sema, through the real WASM bridge.
 *
 * Everything in `resource.test.ts` runs against the mock interpreter, which is
 * a function registry and knows nothing about marshalling. Four things this
 * feature depends on live entirely on the other side of that boundary and are
 * invisible to the mock:
 *
 * - `resource/refresh!` and `resource/cancel!` being callable names at all
 *   (slash and bang in a host-registered identifier);
 * - arity dispatch between `(resource f)` and `(resource "name" f)`, which
 *   works because a missing trailing argument arrives as `undefined`;
 * - a Sema map spec crossing into JS with usable keys, and keyword values such
 *   as `:as :json`;
 * - the state object crossing back as a keyword-keyed map, so `(:loading @r)`
 *   reads a boolean rather than nil.
 *
 * Uses `renderSema` from `src/testing.ts` for the setup, which is the same real
 * interpreter with the same bindings — plus the rest of the runtime, so a
 * resource is exercised in the environment an app actually gives it.
 *
 * Skipped when the WASM package has not been built, matching
 * `component-sema.test.ts`: a JS-only contributor should be told to build, not
 * told the feature is broken.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { renderSema, disposeAllScreens, semaWasmAvailable } from "../src/testing.js";
import type { SemaScreen } from "../src/testing.js";

const describeWithWasm = semaWasmAvailable() ? describe : describe.skip;

interface DeferredCall {
  url: string;
  init: RequestInit;
  resolve: (response: Response) => void;
}

function deferredFetch() {
  const calls: DeferredCall[] = [];
  const fetchMock = vi.fn(
    (url: string, init: RequestInit = {}) =>
      new Promise<Response>((resolve) => {
        calls.push({ url, init, resolve });
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describeWithWasm("resource bindings under a real interpreter", () => {
  afterEach(() => {
    disposeAllScreens();
    vi.restoreAllMocks();
  });

  /**
   * Boot a runtime with `source` already evaluated.
   *
   * The fetch stub has to be installed before this, not after: the source
   * creates the resource, and a resource starts fetching immediately.
   */
  const boot = (source: string): Promise<SemaScreen> => renderSema(source);

  const stateOf = (screen: SemaScreen, name: string) => screen.signal(name) as Record<string, any>;

  it("creates a named resource and reports loading through keyword access", async () => {
    const { calls } = deferredFetch();
    const screen = await boot('(def user (resource "user" (fn () "/api/user")))');
    const id = Number(screen.run("user"));

    expect(screen.context.signals.has(id)).toBe(true);
    expect(screen.run("(:loading @user)")).toBe("#t");
    expect(screen.run("(:value @user)")).toBeNull();

    await screen.flush();
    calls[0].resolve(jsonResponse({ name: "bob" }));
    await screen.flush();

    expect(screen.run("(:loading @user)")).toBe("#f");
    expect(screen.run("(:name (:value @user))")).toBe('"bob"');
    expect(screen.run("(:status @user)")).toBe("200");
    expect(screen.run("(:error @user)")).toBeNull();
    expect(stateOf(screen, "user").status).toBe(200);
  });

  it("marshals a Sema options map, including keyword values and a map body", async () => {
    const { fetchMock } = deferredFetch();
    const screen = await boot(`(def search
           (resource "search"
             (fn () {:url "/api/search"
                     :method :post
                     :headers {"x-token" "secret"}
                     :body {:q "sema"}
                     :with-credentials #t
                     :as :json})))`);
    await screen.flush();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/search",
      expect.objectContaining({
        method: "POST",
        headers: { "x-token": "secret", "content-type": "application/json" },
        body: '{"q":"sema"}',
        credentials: "include",
      }),
    );
    expect(screen.errors).toEqual([]);
  });

  it("supports the unnamed form outside a component render", async () => {
    const { fetchMock } = deferredFetch();
    const screen = await boot('(def cfg (resource (fn () "/api/config")))');
    await screen.flush();

    expect(fetchMock).toHaveBeenCalledWith("/api/config", expect.anything());
    expect(screen.context.resources.size).toBe(1);
  });

  it("accepts a global spec function passed by symbol", async () => {
    const { fetchMock } = deferredFetch();
    const screen = await boot('(define (user-spec) "/api/user") (def user (resource "user" user-spec))');
    await screen.flush();

    expect(fetchMock).toHaveBeenCalledWith("/api/user", expect.anything());
  });

  it("refreshes by name and by handle from Sema", async () => {
    const { fetchMock, calls } = deferredFetch();
    const screen = await boot('(def user (resource "user" (fn () "/api/user")))');
    await screen.flush();
    calls[0].resolve(jsonResponse({ n: 1 }));
    await screen.flush();

    screen.run('(resource/refresh! "user")');
    await screen.flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.run("(:loading @user)")).toBe("#t");
    // The previous value survives the revalidation.
    expect(screen.run("(:n (:value @user))")).toBe("1");

    calls[1].resolve(jsonResponse({ n: 2 }));
    await screen.flush();
    screen.run("(resource/refresh! user)");
    await screen.flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("cancels by handle from Sema without reporting an error", async () => {
    const { calls } = deferredFetch();
    const screen = await boot('(def user (resource "user" (fn () "/api/user")))');
    await screen.flush();

    screen.run("(resource/cancel! user)");
    expect(calls[0].init.signal!.aborted).toBe(true);
    expect(screen.run("(:loading @user)")).toBe("#f");
    expect(screen.errors).toEqual([]);
  });

  it("routes a Sema-side spec failure into the signal and onerror", async () => {
    deferredFetch();
    const screen = await boot('(def user (resource "user" (fn () (error "props not ready"))))');
    await screen.flush();

    expect(screen.run("(:error @user)")).toMatch(/props not ready/);
    expect(screen.errors).toHaveLength(1);
    expect(screen.errors[0].context).toBe("resource:user");
  });

  it("refetches when the state its spec reads changes", async () => {
    const { fetchMock, calls } = deferredFetch();
    // The shape the framework-gaps plan proposes for this feature: a spec whose
    // URL is built from the component's inputs. Adopting the new closure is not
    // enough — nothing scheduled an attempt, so the view kept rendering the
    // first response with `:loading` false and `:error` nil, i.e. wrong data
    // with nothing anywhere saying so.
    const screen = await renderSema(
      `(def uid (state "1"))
       (defcomponent view ()
         (def u (resource "user" (fn () (string-append "/api/user/" @uid))))
         [:p [:span {:data-testid "uid"} @uid]
             [:span {:data-testid "name"} (if (:loading @u) "..." (:name (:value @u)))]])`,
      { mount: "view" },
    );
    await screen.flush();
    calls[0].resolve(jsonResponse({ name: "one" }));
    await screen.flush();
    expect(screen.text('[data-testid="name"]')).toBe("one");

    screen.run('(put! uid "2")');
    await screen.flush();

    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/user/1", "/api/user/2"]);
    // Revalidating: `:loading` is true again, which is what the view renders
    // as "...", so the staleness is visible rather than silent.
    expect(screen.text('[data-testid="name"]')).toBe("...");
    calls[1].resolve(jsonResponse({ name: "two" }));
    await screen.flush();

    expect(screen.text('[data-testid="uid"]')).toBe("2");
    expect(screen.text('[data-testid="name"]')).toBe("two");
    expect(screen.errors).toEqual([]);
  });

  it("refuses an unnamed resource created from an effect body", async () => {
    deferredFetch();
    // The guard used to test the render stack only, and an effect body runs
    // with that stack empty — so the one form it exists to prevent was legal
    // from the place a React-shaped user reaches for first.
    const screen = await renderSema(
      `(defcomponent view ()
         (effect (list) (fn () (resource (fn () "/api/tick"))))
         [:p "hi"])`,
      { mount: "view" },
    );
    await screen.flush();

    expect(screen.errors).toHaveLength(1);
    expect(screen.errors[0].message).toMatch(/inside a component needs a name/);
    expect(screen.context.resources.size).toBe(0);
  });

  it("calls the spec function with no arguments", async () => {
    deferredFetch();
    // A one-parameter spec is an arity error precisely because nothing is
    // passed. If the implementation ever starts handing the previous value to
    // the spec, this goes green and the zero-arg contract has silently changed.
    const screen = await boot('(def user (resource "user" (fn (previous) "/api/user")))');
    await screen.flush();

    expect(screen.run("(:error @user)")).toMatch(/expects 1 argument, got 0/);
  });
});
