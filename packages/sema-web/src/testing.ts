/**
 * Testing utilities for Sema Web — mount a component and poke at it.
 *
 * `renderSema` boots a **real** interpreter (the WASM build, not a stub) with
 * the full set of browser bindings registered, evaluates your Sema source into
 * it, mounts a component into the JSDOM document, and hands back a small
 * surface for driving and inspecting it:
 *
 * ```ts
 * import { renderSema } from "@sema-lang/sema-web/testing";
 *
 * const screen = await renderSema(
 *   '(def count (state 0))' +
 *   '(defcomponent view () [:button {:on-click "inc"} (str @count)])' +
 *   '(define (inc ev) (update! count (fn (n) (+ n 1))))',
 *   { mount: "view" },
 * );
 *
 * screen.click("button");
 * expect(screen.text("button")).toBe("1");
 * expect(screen.errors).toEqual([]);
 * screen.unmount();
 * expect(screen.leaks()).toEqual({});
 * ```
 *
 * ## Why a real interpreter
 *
 * The rest of this package's suite drives a mock interpreter, which is the
 * right tool for testing marshalling and registry bookkeeping in isolation. It
 * is the wrong tool for testing *an app*: a mock knows nothing about macro
 * expansion, arity, keyword keys, or the WASM value boundary, so a component
 * that works against it can still be broken in a browser. Everything here runs
 * the same code path `SemaWeb.create()` does.
 *
 * ## Not shipped with the runtime
 *
 * This module is a separate entry point (`@sema-lang/sema-web/testing`) and is
 * never imported by `src/index.ts`. It reads the WASM binary off disk with
 * `node:fs`, so it targets a Node test runner (Vitest/Jest with the `jsdom`
 * environment) — keeping it out of the main entry is what keeps Node builtins
 * out of the browser bundle.
 *
 * @module
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import type { EvalResult, SemaWeb, SemaWebOptions } from "./index.js";
import type { SemaWebContext } from "./context.js";
import type { Diagnostics } from "./diagnostics.js";

/**
 * Load the runtime on first use.
 *
 * Deliberately a dynamic import: the runtime reaches `@sema-lang/sema-wasm`, and
 * with no WASM build present a *static* import fails while the module graph is
 * being resolved — before any test body runs, so `semaWasmAvailable()` never
 * gets the chance to skip the suite and a fresh checkout reads as broken rather
 * than as unbuilt.
 */
let runtimeModule: typeof import("./index.js") | null = null;

async function loadRuntime(): Promise<typeof import("./index.js")> {
  if (!runtimeModule) runtimeModule = await import("./index.js");
  return runtimeModule;
}

/** Default markup installed into `document.body` before the runtime boots. */
export const DEFAULT_TEST_HTML = '<div id="app"></div>';

/** Default mount target selector. */
export const DEFAULT_TEST_TARGET = "#app";

/** A failure the runtime routed through `ctx.onerror`, as captured by the harness. */
export interface CapturedError {
  /** The error object the runtime reported. */
  error: Error;
  /**
   * Where it came from, in the runtime's own vocabulary: `component:todo-list`,
   * `event:click:save`, `effect:view#0`, `resource:user`.
   */
  context: string;
  /** `error.message`, lifted out because that is what assertions read. */
  message: string;
}

/**
 * Counts of everything the runtime context owns.
 *
 * Deliberately raw counts rather than pass/fail: a leak assertion wants to name
 * *what* leaked, and "intervals: 1" does that where a boolean does not.
 *
 * Covers the context registries only. Sema callback handles live in the WASM
 * callback table, which exposes no live count, so a released-too-late callback
 * is not visible here — the registry that *held* it is.
 */
export interface LeakCounts {
  /** Live DOM/event handles held for Sema. */
  handles: number;
  /** Live reactive signals (including resource and stream signals). */
  signals: number;
  /** `dom/listen!` registrations. */
  listeners: number;
  /** `watch` registrations. */
  watches: number;
  /** `js/set-interval` timers. */
  intervals: number;
  /** Open SSE / LLM / resource streams. */
  streams: number;
  /** Live async resources. */
  resources: number;
  /** Open WebSockets. */
  sockets: number;
  /** Runtime-level cleanup hooks (router teardown, etc.). */
  cleanupHooks: number;
  /** Mounted components. */
  mounted: number;
  /** Live `effect` / `on-unmount` slots across all mounted components. */
  lifecycleSlots: number;
}

/** Options for {@link renderSema}. */
export interface RenderSemaOptions {
  /**
   * Name of the component to mount once `source` has been evaluated. Omit to
   * boot the runtime and evaluate source without mounting anything.
   */
  mount?: string;

  /**
   * Props for the mounted component. Both `{title: "x"}` and `{":title": "x"}`
   * are accepted — the mount path normalizes keyword keys either way.
   *
   * Omitting this mounts with *no* props, which is not the same as `{}`: a
   * component declared with no parameters throws if called with an argument.
   */
  props?: Record<string, unknown>;

  /** Mount target selector. Default {@link DEFAULT_TEST_TARGET}. */
  target?: string;

  /**
   * Markup written into `document.body` before the runtime boots. Default
   * {@link DEFAULT_TEST_HTML}.
   */
  html?: string;

  /**
   * URL the screen boots on, resolved against the current origin —
   * `"/todos/42?tab=open"` for a history-mode router, `"#/todos/42"` for the
   * default hash mode.
   *
   * The location is put back to `"/"` for every screen whether this is set or
   * not. `document.body` was always reset per screen, but JSDOM shares one
   * `window` across a test file, so without this a screen that navigated
   * decides which route the *next* screen mounts on — and a router suite
   * becomes order-dependent, where reordering a test or running one with
   * `.only` changes what it asserts.
   */
  url?: string;

  /**
   * Options forwarded to `SemaWeb.create()`, merged over the harness defaults
   * (`autoLoad: false`, `dev: true`). Pass `{ dev: false }` to test the
   * production configuration, in which case dev-only checks — duplicate SIP
   * keys, the render timeline — stop reporting.
   */
  web?: SemaWebOptions;

  /**
   * Location of the `.wasm` binary. Resolved automatically from the installed
   * `@sema-lang/sema-wasm` package when omitted; set `SEMA_WASM_PATH` to
   * override without touching test code.
   */
  wasmUrl?: string | URL;

  /**
   * Also forward every captured error here. The harness always collects errors
   * into {@link SemaScreen.errors} and, unlike the runtime default, does not
   * log them — pass this when you want them printed anyway.
   */
  onerror?: (error: Error, context: string) => void;
}

/**
 * A mounted component under test.
 *
 * Every DOM query is scoped to the mount container, so `text("button")` cannot
 * accidentally match a button belonging to the fixture markup around it.
 */
export interface SemaScreen {
  /** The runtime instance. */
  readonly web: SemaWeb;
  /** The runtime's state container, for assertions the helpers do not cover. */
  readonly context: SemaWebContext;
  /** The underlying interpreter. */
  readonly interpreter: SemaWeb["interpreter"];
  /** The element the component is mounted into. */
  readonly container: Element;
  /** The dev-mode timeline. Empty unless dev mode is on (it is, by default). */
  readonly diagnostics: Diagnostics;

  /**
   * Errors the runtime caught, oldest first — render failures, throwing event
   * handlers, effect cleanup, streams. A live array: read it after the action
   * that should (or should not) have failed.
   */
  readonly errors: CapturedError[];

  /** Everything Sema printed, in order, across every evaluation. */
  readonly output: string[];

  /** The `context` field of every captured error, for a one-line assertion. */
  errorContexts(): string[];

  /**
   * Evaluate Sema. Returns the raw result — including `error` — and never
   * throws, so a test can assert on a failure.
   */
  eval(code: string): EvalResult;

  /**
   * Evaluate Sema and return the printed form of its value, raising the
   * interpreter's own message if it failed.
   *
   * The one to reach for by default: an unexpected error surfaces as that
   * error instead of as a confusing `null`.
   */
  run(code: string): string | null;

  /** `innerHTML` of the container, or of the first match for `selector`. */
  html(selector?: string): string;

  /** `textContent` of the container, or of the first match for `selector`. */
  text(selector?: string): string;

  /** First match for `selector` inside the container, or `null`. */
  query(selector: string): Element | null;

  /** First match for `selector`, raising with the current markup if absent. */
  find(selector: string): Element;

  /** Every match for `selector` inside the container. */
  findAll(selector: string): Element[];

  /** Click an element, running the browser's activation behaviour. */
  click(selector: string): void;

  /** Set an input's value and fire `input`, the way typing does. */
  fill(selector: string, value: string): void;

  /** Set a `<select>`'s value and fire `change`. */
  select(selector: string, value: string): void;

  /** Bring a checkbox or radio to `checked` by clicking it if it is not already. */
  check(selector: string, checked?: boolean): void;

  /** Submit a form (default selector `"form"`). */
  submit(selector?: string): void;

  /** Fire a keyboard event (default `keydown`). */
  press(selector: string, key: string, type?: string): void;

  /** Fire an arbitrary bubbling, cancelable event. */
  fire(selector: string, type: string, init?: EventInit): void;

  /** Focus an element, so focus-preservation behaviour can be exercised. */
  focus(selector: string): void;

  /** The JS value of a Sema reactive global (`(def count (state 0))` → `count`). */
  signal(name: string): unknown;

  /** Write a Sema reactive global from the test side, triggering a re-render. */
  setSignal(name: string, value: unknown): void;

  /** Mount (or re-mount) a component into the target. */
  mount(name: string, props?: Record<string, unknown>): void;

  /** Unmount the component, running its full teardown. */
  unmount(): void;

  /** Let queued microtasks and timers run — for resources, SSE, and `http/*`. */
  flush(): Promise<void>;

  /** Current counts of everything the context owns. */
  snapshot(): LeakCounts;

  /**
   * What the component under test still owns, as a sparse map of positive
   * deltas against the baseline taken after `source` was evaluated and before
   * anything was mounted.
   *
   * Empty means nothing leaked, so the whole assertion is
   * `expect(screen.leaks()).toEqual({})` and a failure names the registry.
   *
   * Call it after {@link unmount}: that is what proves *component* teardown.
   * After {@link dispose} the context is force-drained, so a clean report there
   * says much less.
   */
  leaks(): Partial<LeakCounts>;

  /** Tear the whole runtime down. Idempotent. */
  dispose(): void;
}

/** Screens created and not yet disposed, drained by {@link disposeAllScreens}. */
const liveScreens = new Set<SemaScreen>();

let cachedWasmBytes: Uint8Array | null = null;

/**
 * Where the `.wasm` binary lives, or `null` if it cannot be found.
 *
 * Node resolution first, so an ordinary `npm install` of this package works;
 * the repository layout only as a fallback, for a checkout whose workspace
 * links have not been created yet.
 */
export function resolveSemaWasmPath(): string | null {
  const candidates: string[] = [];
  const override = process.env.SEMA_WASM_PATH;
  if (override) candidates.push(override);

  try {
    candidates.push(
      createRequire(import.meta.url).resolve("@sema-lang/sema-wasm/pkg/sema_wasm_bg.wasm"),
    );
  } catch {
    // Not installed (or an exports map hides it) — fall through to the layout.
  }

  candidates.push(resolve(process.cwd(), "../sema-wasm/pkg/sema_wasm_bg.wasm"));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Whether {@link renderSema} can run here.
 *
 * Gate a suite on it rather than letting it fail:
 *
 * ```ts
 * const describeWithSema = semaWasmAvailable() ? describe : describe.skip;
 * ```
 *
 * A missing WASM binary means "this checkout has not been built", which should
 * not read as "your component is broken".
 */
export function semaWasmAvailable(): boolean {
  return resolveSemaWasmPath() !== null;
}

/** The `wasmUrl` value to hand the interpreter, reading the binary once. */
function wasmOption(explicit: string | URL | undefined): unknown {
  if (explicit) return explicit;
  if (!cachedWasmBytes) {
    const path = resolveSemaWasmPath();
    if (!path) {
      throw new Error(
        "renderSema: could not find the Sema WASM binary. Install @sema-lang/sema-wasm, " +
          "or set SEMA_WASM_PATH / pass { wasmUrl } to point at sema_wasm_bg.wasm.",
      );
    }
    cachedWasmBytes = readFileSync(path);
  }
  // Object form: passing bare bytes trips wasm-bindgen's deprecation warning.
  return { module_or_path: cachedWasmBytes };
}

function countLifecycleSlots(ctx: SemaWebContext): number {
  let total = 0;
  for (const component of ctx.mountedComponentsById.values()) {
    // Summed across render scopes: a composed child owns its slots under its
    // own scope path, and a leak there counts exactly as much as one in the
    // mounting component.
    for (const slots of component.ownedLifecycleSlots.values()) total += slots.length;
  }
  return total;
}

function snapshotCounts(ctx: SemaWebContext): LeakCounts {
  return {
    handles: ctx.handles.size,
    signals: ctx.signals.size,
    listeners: ctx.listeners.size,
    watches: ctx.watchDisposers.size,
    intervals: ctx.intervals.size,
    streams: ctx.streams.size,
    resources: ctx.resources.size,
    sockets: ctx.sockets.size,
    cleanupHooks: ctx.cleanupHooks.size,
    mounted: ctx.mountedComponents.size,
    lifecycleSlots: countLifecycleSlots(ctx),
  };
}

/**
 * Construct an event of the right class for its name.
 *
 * `new Event("click")` is not a `MouseEvent`, so a handler reading `button` or
 * `relatedTarget` off it sees `undefined` — the test would then be exercising a
 * shape the browser never produces.
 */
function buildEvent(type: string, init?: EventInit): Event {
  const base: EventInit = { bubbles: true, cancelable: true, ...init };
  if (/^(click|dblclick|contextmenu|mouse|pointer)/.test(type)) {
    return new MouseEvent(type, base as MouseEventInit);
  }
  if (/^key/.test(type)) {
    return new KeyboardEvent(type, base as KeyboardEventInit);
  }
  return new Event(type, base);
}

/**
 * Put the shared `window.location` back to a known state.
 *
 * The URL is the one piece of per-screen state `dispose()` cannot drain: it
 * belongs to the `window` JSDOM shares across a whole test file, not to any
 * runtime the harness owns. Resetting it here — rather than leaving each router
 * test to poke `window.location` itself, which is what leaks — is what keeps a
 * screen's starting route a property of that screen.
 *
 * `replaceState` rather than assigning `location`: it changes path, query and
 * fragment in one write without JSDOM treating it as a navigation.
 */
function resetLocation(url: string | undefined): void {
  try {
    window.history.replaceState(null, "", url ?? "/");
  } catch (e) {
    throw new Error(
      `renderSema: cannot start at ${JSON.stringify(url ?? "/")}: ` +
        `${e instanceof Error ? e.message : String(e)}. ` +
        'Pass a same-origin path or fragment, e.g. { url: "#/todos/42" }.',
    );
  }
}

/**
 * Boot a Sema Web runtime in JSDOM, evaluate `source`, and mount a component.
 *
 * @param source - Sema source: state, component definitions, event handlers.
 *   Evaluated once, before anything is mounted. A syntax or evaluation failure
 *   here raises immediately rather than producing an empty screen.
 * @param options - See {@link RenderSemaOptions}.
 *
 * @example Assert on a captured render failure
 * ```ts
 * const screen = await renderSema('(defcomponent view () (error "nope"))', { mount: "view" });
 * expect(screen.errorContexts()).toEqual(["component:view"]);
 * ```
 */
export async function renderSema(
  source: string,
  options: RenderSemaOptions = {},
): Promise<SemaScreen> {
  const target = options.target ?? DEFAULT_TEST_TARGET;
  document.body.innerHTML = options.html ?? DEFAULT_TEST_HTML;
  resetLocation(options.url);

  const runtime = await loadRuntime();
  const web = await runtime.SemaWeb.create({
    autoLoad: false,
    dev: true,
    ...options.web,
    wasmUrl: wasmOption(options.wasmUrl ?? options.web?.wasmUrl) as SemaWebOptions["wasmUrl"],
  });

  const ctx = web.context;
  const errors: CapturedError[] = [];
  // Replaces the runtime default, which logs to console.error. Diagnostics
  // still record: `ctx.onerror`'s setter swaps only the delegate.
  ctx.onerror = (error, context) => {
    errors.push({ error, context, message: error?.message ?? String(error) });
    options.onerror?.(error, context);
  };

  const container = document.querySelector(target);
  if (!container) {
    web.dispose();
    throw new Error(
      `renderSema: mount target ${JSON.stringify(target)} is not in the document. ` +
        `Pass { html } that contains it, or { target } naming an element that exists.`,
    );
  }

  const output: string[] = [];

  const evalCode = (code: string): EvalResult => {
    const result = web.eval(code);
    output.push(...result.output);
    return result;
  };

  const runCode = (code: string): string | null => {
    const result = evalCode(code);
    if (result.error) throw new Error(result.error);
    return result.value;
  };

  if (source.trim().length > 0) {
    const result = evalCode(source);
    if (result.error) {
      web.dispose();
      throw new Error(`renderSema: source failed to evaluate: ${result.error}`);
    }
  }

  // Baseline AFTER the source, BEFORE the mount. Module-level state a fixture
  // defines is the app's, not the component's, and counting it as a leak would
  // make `leaks()` fire on correct code.
  const baseline = snapshotCounts(ctx);

  const signalId = (name: string): number => {
    const value = runCode(name);
    const id = Number(value);
    if (!Number.isInteger(id) || !ctx.signals.has(id)) {
      throw new Error(
        `renderSema: ${JSON.stringify(name)} is not reactive state (evaluated to ${value}). ` +
          "Define it with (def name (state ...)).",
      );
    }
    return id;
  };

  const screen: SemaScreen = {
    web,
    context: ctx,
    interpreter: web.interpreter,
    container,
    diagnostics: web.diagnostics,
    errors,
    output,

    errorContexts: () => errors.map((entry) => entry.context),

    eval: evalCode,
    run: runCode,

    html: (selector) => (selector ? screen.find(selector).innerHTML : container.innerHTML),
    text: (selector) =>
      (selector ? screen.find(selector).textContent : container.textContent) ?? "",

    query: (selector) => container.querySelector(selector),

    find(selector) {
      const el = container.querySelector(selector);
      if (!el) {
        throw new Error(
          `renderSema: no element matches ${JSON.stringify(selector)}. ` +
            `Container currently holds: ${container.innerHTML}`,
        );
      }
      return el;
    },

    findAll: (selector) => Array.from(container.querySelectorAll(selector)),

    click(selector) {
      const el = screen.find(selector);
      // `HTMLElement.click()` rather than a synthesized event: it runs the
      // activation behaviour too, so clicking a submit button submits and
      // clicking a checkbox toggles, as in a browser.
      if (el instanceof HTMLElement) el.click();
      else el.dispatchEvent(buildEvent("click"));
    },

    fill(selector, value) {
      const el = screen.find(selector) as HTMLInputElement;
      el.value = value;
      el.dispatchEvent(buildEvent("input"));
    },

    select(selector, value) {
      const el = screen.find(selector) as HTMLSelectElement;
      el.value = value;
      el.dispatchEvent(buildEvent("change"));
    },

    check(selector, checked = true) {
      const el = screen.find(selector) as HTMLInputElement;
      if (el.checked !== checked) el.click();
    },

    submit(selector = "form") {
      screen.find(selector).dispatchEvent(buildEvent("submit"));
    },

    press(selector, key, type = "keydown") {
      screen.find(selector).dispatchEvent(buildEvent(type, { key } as EventInit));
    },

    fire(selector, type, init) {
      screen.find(selector).dispatchEvent(buildEvent(type, init));
    },

    focus(selector) {
      const el = screen.find(selector);
      if (el instanceof HTMLElement) el.focus();
    },

    signal: (name) => ctx.signals.get(signalId(name))!.peek(),

    setSignal(name, value) {
      ctx.signals.get(signalId(name))!.value = value;
    },

    mount(name, props) {
      web.interpreter.invokeGlobal("component/mount!", target, name, props ?? null);
    },

    unmount() {
      web.interpreter.invokeGlobal("component/unmount!", target);
    },

    async flush() {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    },

    snapshot: () => snapshotCounts(ctx),

    leaks() {
      const current = snapshotCounts(ctx);
      const report: Partial<LeakCounts> = {};
      for (const key of Object.keys(current) as Array<keyof LeakCounts>) {
        const delta = current[key] - baseline[key];
        // Positive only. Fewer than baseline is not a leak, and reporting it
        // would make a correct teardown look broken.
        if (delta > 0) report[key] = delta;
      }
      return report;
    },

    dispose() {
      if (!liveScreens.delete(screen)) return;
      web.dispose();
    },
  };

  liveScreens.add(screen);

  if (options.mount) screen.mount(options.mount, options.props);

  return screen;
}

/**
 * Dispose every screen {@link renderSema} created that is still live.
 *
 * Wire it into a global teardown so one forgotten `dispose()` cannot leak a
 * WASM instance, a timer, or a document listener into the next test:
 *
 * ```ts
 * afterEach(() => disposeAllScreens());
 * ```
 *
 * The URL is deliberately not drained here — it is not a resource any screen
 * owns, and a test asserting on where a navigation ended has to be able to read
 * it after `dispose()`. {@link renderSema} resets it when the next screen boots
 * instead, so the leak this would guard against cannot reach that screen.
 */
export function disposeAllScreens(): void {
  for (const screen of Array.from(liveScreens)) {
    screen.dispose();
  }
}
