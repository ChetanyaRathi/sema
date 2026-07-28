/**
 * Reactive state system for Sema Web — powered by @preact/signals-core.
 *
 * Sema API:
 *   (def count (state 0))     ;; create reactive state
 *   @count                     ;; read (auto-tracked in components/computed)
 *   (put! count 42)            ;; set value
 *   (update! count inc)        ;; apply function
 *   (def doubled (computed (* @count 2)))  ;; derived state
 *   (batch (put! a 1) (put! b 2))         ;; coalesce updates
 *   (watch count (fn [old new] ...))       ;; side effects
 *
 * @module
 */

import { signal, computed, effect, batch, untracked } from "@preact/signals-core";
import type { Signal, ReadonlySignal } from "@preact/signals-core";
import type { MountedComponent, SemaWebContext } from "./context.js";
import {
  currentScopePath,
  disposeSignal,
  getCurrentOwnerId,
  registerSignalFinalizer,
  withOwnerContext,
} from "./context.js";
import { toInvokableCallback, releaseCallback } from "./callbacks.js";

interface SemaInterpreterLike {
  registerFunction(name: string, fn: (...args: any[]) => any): void;
  invokeGlobal(name: string, ...args: any[]): any;
  evalStr(code: string): { value: string | null; output: string[]; error: string | null };
}

/**
 * Register all reactive state functions.
 *
 * JS-level functions (__state/* namespace — internal):
 * - `__state/create` — create a new signal, returns numeric ID
 * - `__state/deref` — read signal value (auto-tracked by signals-core)
 * - `__state/put!` — set signal value
 * - `__state/computed-create` — create a computed signal from a callback
 * - `__state/batch-run` — run a callback inside batch()
 * - `__state/watch` — watch a signal, call Sema fn on change
 *
 * Sema-level wrappers (convenience):
 * - `(state val)` — create reactive state
 * - `(deref ref)` — read state value
 * - `(put! ref val)` — set state value
 * - `(update! ref f . args)` — update state by applying function
 * - `(computed expr)` — macro: derived reactive state
 * - `(batch . body)` — macro: coalesce multiple updates
 * - `(watch ref fn)` — watch state for changes
 */
export function registerReactiveBindings(interp: SemaInterpreterLike, ctx: SemaWebContext): void {
  const getActiveComponent = () => {
    const componentId = getCurrentOwnerId(ctx);
    return componentId != null ? ctx.mountedComponentsById.get(componentId) ?? null : null;
  };

  /**
   * Is `component`'s own render body what is running right now?
   *
   * The render stack carries the component whose body is executing; an effect
   * body, an `on-mount` callback and an event handler all run with it empty and
   * only the owner stack set. That distinction is the whole rule: a render
   * allocates a replacement on every pass, so its registrations are recycled,
   * while a registration made anywhere else was allocated deliberately, once,
   * and lives until the component is destroyed.
   */
  const inRenderBodyOf = (component: MountedComponent) =>
    ctx.renderContextStack[ctx.renderContextStack.length - 1] === component.instanceId;

  /**
   * Hand a registration allocated during a render to that render pass, so the
   * next pass releases it.
   */
  const ownedByRender = (component: MountedComponent, dispose: () => void) => {
    component.renderReactive.computeds.push(dispose);
  };

  /**
   * Say once — not once per render — that a render body is registering a watch.
   *
   * Memoization keeps the count at one, so this is guidance rather than a
   * failure: a subscription that should exist once belongs where it is created
   * once, and a reader who does not know it is being memoized will read the
   * single live registration as a bug.
   */
  const reportRenderAllocation = (component: MountedComponent) => {
    if (component.renderReactive.reported.has("watch")) return;
    component.renderReactive.reported.add("watch");
    ctx.onerror(
      new Error(
        "(watch …) called from a render body is memoized per render — one live "
        + "registration is kept and each render swaps its callback, rather than "
        + "adding another subscription. Move it into an (on-mount …) or an "
        + "(effect …) if it should be created once.",
      ),
      `watch:${component.componentFn}`,
    );
  };

  /** Stop a watch, release its callback, and forget it. Safe to call twice. */
  const disposeWatch = (watchId: number) => {
    const registration = ctx.watchDisposers.get(watchId);
    if (!registration) return;
    registration.dispose();
    ctx.watchDisposers.delete(watchId);
    releaseCallback(registration.callback);
    for (const component of ctx.mountedComponents.values()) {
      component.ownedWatchIds.delete(watchId);
    }
  };

  /**
   * Subscribe to a signal and invoke a Sema callback on every change.
   *
   * Returns the watch handle plus an `adopt` that swaps in a later render's
   * callback: the subscription and its "previous value" baseline survive, and
   * the superseded callback handle goes back. Swapping rather than
   * re-subscribing is what makes a watch registered from a render body behave
   * like one registration instead of one per render.
   */
  const createWatch = (signalId: number, callbackValue: unknown, owner: MountedComponent | null) => {
    const s = ctx.signals.get(signalId);
    if (!s) throw new Error(`Unknown state: ${signalId}`);
    let invoke = toInvokableCallback(callbackValue, interp, "watch callback");

    // Untracked: taking the baseline is bookkeeping, not a dependency. A
    // tracked read would subscribe whatever is running — a render body — to the
    // watched signal, which contradicts the documented rule that only signals
    // read with `@` during a render are tracked.
    let prev = untracked(() => s.value);

    const watchId = ctx.nextWatchId++;
    const dispose = effect(() => {
      const current = s.value; // track dependency
      if (prev !== current) {
        const oldVal = prev;
        prev = current;
        try {
          withOwnerContext(ctx, owner?.instanceId ?? null, () => invoke(oldVal, current));
        } catch (e) {
          ctx.onerror(e instanceof Error ? e : new Error(String(e)), "watch");
        }
      }
    });
    ctx.watchDisposers.set(watchId, { dispose, callback: invoke });
    if (owner) owner.ownedWatchIds.add(watchId);

    const adopt = (nextValue: unknown) => {
      // Retain before releasing: the boundary hands out one wrapper per Sema
      // value, so re-registering the *same* function must not drop to zero
      // owners in between.
      const next = toInvokableCallback(nextValue, interp, "watch callback");
      const registration = ctx.watchDisposers.get(watchId);
      if (!registration) {
        releaseCallback(next);
        return;
      }
      releaseCallback(registration.callback);
      registration.callback = next;
      invoke = next;
    };
    return { watchId, adopt };
  };

  /**
   * The watch a render body means by "watch this signal here".
   *
   * Identity is by render scope, watched signal, and position among repeated
   * watches on that signal in the same body — the same reasoning `(local name)`
   * uses, applied to the only stable identity a nameless primitive has. A
   * render that stops registering one leaves its key unclaimed, and the
   * post-render sweep disposes it.
   */
  const claimRenderScopedWatch = (
    component: MountedComponent,
    signalId: number,
    callbackValue: unknown,
  ): number => {
    const owned = component.renderReactive;
    // NUL joins the parts because it is the one byte a scope path, a
    // signal id, and an occurrence count can never contain. Written as
    // an escape rather than a literal so the file stays text to git.
    const base = `${currentScopePath(ctx)}\u0000${signalId}`;
    const occurrence = owned.occurrences.get(base) ?? 0;
    owned.occurrences.set(base, occurrence + 1);
    const key = `${base}\u0000${occurrence}`;
    owned.claimed.add(key);

    const existing = owned.watches.get(key);
    if (existing) {
      existing.adopt(callbackValue);
      return existing.watchId;
    }
    const { watchId, adopt } = createWatch(signalId, callbackValue, component);
    owned.watches.set(key, { watchId, adopt, dispose: () => disposeWatch(watchId) });
    reportRenderAllocation(component);
    return watchId;
  };

  // __state/create — create a new signal, returns numeric ID
  interp.registerFunction("__state/create", (initialValue: any) => {
    const id = ctx.nextSignalId++;
    ctx.signals.set(id, signal(initialValue));
    return id;
  });

  // __state/deref — read signal value (auto-tracked by signals-core if inside effect/computed)
  interp.registerFunction("__state/deref", (signalId: number) => {
    const s = ctx.signals.get(signalId);
    if (!s) throw new Error(`Unknown state: ${signalId}`);
    return s.value; // Must read .value directly for dependency tracking
  });

  // __state/put! — set signal value
  interp.registerFunction("__state/put!", (signalId: number, newValue: any) => {
    const s = ctx.signals.get(signalId);
    if (!s) throw new Error(`Unknown state: ${signalId}`);
    s.value = newValue;
    return newValue;
  });

  // __state/computed-create — create a computed signal from a zero-arg callback.
  interp.registerFunction("__state/computed-create", (callbackValue: any) => {
    const callback = toInvokableCallback(callbackValue, interp, "computed callback");
    const id = ctx.nextSignalId++;
    const owner = getActiveComponent();

    const c = computed(() => {
      try {
        return withOwnerContext(ctx, owner?.instanceId ?? null, () => callback());
      } catch (e) {
        ctx.onerror(e instanceof Error ? e : new Error(String(e)), "computed");
        return undefined;
      }
    });
    ctx.signals.set(id, c as unknown as Signal<any>);
    registerSignalFinalizer(ctx, id, () => {
      releaseCallback(callbackValue);
    });
    if (owner) {
      owner.ownedSignalIds.add(id);
      // Not reported: a per-render computed is a derivation the render reads
      // back immediately, so recycling it is invisible — unlike a watch, which
      // is a subscription that outlives the render that made it.
      if (inRenderBodyOf(owner)) {
        ownedByRender(owner, () => {
          owner.ownedSignalIds.delete(id);
          disposeSignal(ctx, id);
        });
      }
    }
    return id;
  });

  // __state/batch-run — run a callback inside batch()
  interp.registerFunction("__state/batch-run", (callbackValue: any) => {
    const callback = toInvokableCallback(callbackValue, interp, "batch callback");
    let captured: any = undefined;
    try {
      batch(() => {
        try {
          captured = callback();
        } catch (e) {
          ctx.onerror(e instanceof Error ? e : new Error(String(e)), "batch");
        }
      });
    } finally {
      releaseCallback(callbackValue);
    }
    return captured;
  });

  // __state/watch — watch a signal for changes, call Sema fn with old + new values.
  // Returns a numeric watch handle that can be disposed with __state/unwatch.
  interp.registerFunction("__state/watch", (signalId: number, callbackValue: any) => {
    const owner = getActiveComponent();
    if (owner && inRenderBodyOf(owner)) {
      return claimRenderScopedWatch(owner, signalId, callbackValue);
    }
    return createWatch(signalId, callbackValue, owner).watchId;
  });

  interp.registerFunction("__state/unwatch", (watchId: number) => {
    disposeWatch(watchId);
    return null;
  });

  // --- Sema-side convenience wrappers ---
  // These define user-facing functions and macros that call the __state/* internals.
  const semaResult = interp.evalStr(`
    (define (state val) (__state/create val))
    (define (deref ref) (__state/deref ref))
    (define (put! ref val) (__state/put! ref val))
    (define (update! ref f . args) (put! ref (apply f (cons (deref ref) args))))

    (defmacro computed (expr)
      \`(__state/computed-create (fn () ,expr)))

    (defmacro batch (. body)
      \`(__state/batch-run (fn () ,@body)))

    (define (watch ref fn) (__state/watch ref fn))
    (define (unwatch! watch-id) (__state/unwatch watch-id))
  `);

  if (semaResult.error) {
    throw new Error(`[sema-web] Failed to register reactive wrappers: ${semaResult.error}`);
  }
}
