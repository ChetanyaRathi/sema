import { SEMA_IDENT_RE } from "./handles.js";

export interface SemaCallback {
  (...args: any[]): any;
  __semaCallbackHandle?: number;
  __semaRelease?: () => void;
}

interface GlobalInvoker {
  invokeGlobal(name: string, ...args: any[]): any;
}

/**
 * How many owners hold each marshalled Sema callback.
 *
 * The boundary dedupes twice over: `allocate_callback_handle` (crates/sema-wasm)
 * hands out ONE handle per identical Sema value, and `@sema-lang/sema` memoizes
 * ONE JS wrapper per handle. So two independent owners — two components
 * registering the same named `on-unmount`, two intervals over the same global,
 * `dom/on!` for one function on two elements — receive the *same* object, while
 * `__semaRelease` invalidates the handle unconditionally. Whoever tore down
 * first therefore killed a handle the other was still holding, and the survivor's
 * callback failed with `Unknown callback handle: N` instead of running.
 *
 * Counting owners keeps the rule where ownership is actually decided:
 * {@link toInvokableCallback} takes a reference, {@link releaseCallback} hands
 * one back, and only the last owner out releases the handle. A callback that was
 * never retained counts as singly owned, so a value stored without being
 * converted behaves exactly as it did before.
 */
const owners = new WeakMap<SemaCallback, number>();

/**
 * Take a reference to a marshalled Sema callback that is about to be stored.
 *
 * Pair every call with exactly one {@link releaseCallback}. Values carrying no
 * `__semaRelease` (a plain JS function, or the invoker this module synthesizes
 * for a global's name) own no handle, so they are not counted.
 */
export function retainCallback(value: unknown): void {
  if (typeof value !== "function") return;
  const callback = value as SemaCallback;
  if (!callback.__semaRelease) return;
  owners.set(callback, (owners.get(callback) ?? 0) + 1);
}

export function toInvokableCallback(
  value: unknown,
  interp: GlobalInvoker,
  label: string,
): SemaCallback {
  if (typeof value === "function") {
    // Converting is how every caller in this package takes ownership of a
    // callback it is about to store, so it is where the reference is counted.
    retainCallback(value);
    return value as SemaCallback;
  }

  if (typeof value === "string" && SEMA_IDENT_RE.test(value)) {
    return ((...args: any[]) => interp.invokeGlobal(value, ...args)) as SemaCallback;
  }

  throw new Error(`Invalid ${label}: expected function value or callback name`);
}

/**
 * Hand back one reference to a callback, releasing its handle at the last one.
 *
 * An untracked callback releases immediately: it is either singly owned or owns
 * no handle at all.
 */
export function releaseCallback(value: unknown): void {
  if (typeof value !== "function") return;
  const callback = value as SemaCallback;
  const held = owners.get(callback) ?? 0;
  if (held > 1) {
    owners.set(callback, held - 1);
    return;
  }
  owners.delete(callback);
  callback.__semaRelease?.();
}
