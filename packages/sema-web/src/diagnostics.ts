/**
 * Bounded diagnostics recorder for Sema Web dev mode.
 *
 * Every interesting runtime event — errors, component renders, route changes,
 * stream lifecycle, script loads — can be recorded here and read back through
 * `web.context.diagnostics`. This is what turns "something broke somewhere in
 * my app" into a timeline you can actually look at.
 *
 * Two properties matter more than features:
 *
 * 1. **Off by default, and genuinely free when off.** `record()` returns on its
 *    first line when `enabled` is false, and callers pass a builder rather than
 *    a built object so the entry is never even constructed in production. A
 *    diagnostics system that costs something when disabled gets disabled
 *    permanently, which defeats the point.
 * 2. **Bounded, always.** The ring holds `limit` entries and counts what it
 *    dropped. An unbounded "recent events" buffer is a memory leak with a
 *    friendly name — a component re-rendering in a loop would grow it without
 *    limit, and the very bug you are trying to observe would take the tab down
 *    before you could read the timeline.
 *
 * @module
 */

/** Category of a recorded diagnostic event. */
export type DiagnosticKind = "error" | "render" | "route" | "stream" | "script";

/** A single recorded event. */
export interface DiagnosticEntry {
  /** What kind of event this is. */
  kind: DiagnosticKind;
  /** Wall-clock timestamp (`Date.now()`) when the event was recorded. */
  at: number;
  /**
   * Where the event came from, in the same vocabulary `ctx.onerror` uses:
   * `component:todo-list`, `listener-cleanup:click`, `route`, `inline-script:2`.
   */
  context: string;
  /** Human-readable detail — an error message, a route path, a script URL. */
  detail?: string;
  /** Wall-clock duration, for events that measure one (renders). */
  durationMs?: number;
}

/** Dev-mode configuration. `dev: true` is shorthand for all defaults. */
export interface DevOptions {
  /**
   * Maximum number of entries retained. Older entries are dropped first.
   * Default: {@link DEFAULT_DEV_LIMIT}.
   */
  limit?: number;
  /**
   * Mount the on-page dev overlay. Default: `false` — the overlay module is
   * dynamically imported, so leaving this off keeps it out of the initial
   * bundle entirely, not merely inactive.
   */
  overlay?: boolean;
  /**
   * A render at or above this many milliseconds is reported by
   * {@link Diagnostics.slowRenders}. Default: {@link DEFAULT_SLOW_RENDER_MS}
   * (one 60fps frame).
   */
  slowRenderMs?: number;
}

/** Default ring size. */
export const DEFAULT_DEV_LIMIT = 100;

/**
 * Longest `detail` retained, in characters.
 *
 * The ring bounds how many entries it keeps, which bounds nothing at all if one
 * entry can be arbitrarily large: a route diagnostic holds the raw URL, and a
 * 200 KB query value produced a single 200,010-character entry. A hundred of
 * those is 20 MB retained by the tool whose whole premise is that leaving it on
 * costs nothing. Anything past the bound is not diagnosis, it is payload.
 */
export const MAX_DETAIL_CHARS = 1024;

/** Keep a detail readable and bounded, saying so when it had to be cut. */
function boundDetail(detail: string): string {
  if (detail.length <= MAX_DETAIL_CHARS) return detail;
  const dropped = detail.length - MAX_DETAIL_CHARS;
  return `${detail.slice(0, MAX_DETAIL_CHARS)}… (+${dropped} chars)`;
}

/** Default slow-render threshold: one frame at 60fps. */
export const DEFAULT_SLOW_RENDER_MS = 16;

/** Monotonic clock for durations, falling back where `performance` is absent. */
export function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/**
 * A bounded, subscribable ring of {@link DiagnosticEntry}.
 *
 * Disabled instances accept `record()` calls and do nothing, so call sites
 * never need to branch on dev mode themselves.
 */
export class Diagnostics {
  /** Whether events are being recorded. */
  enabled: boolean;

  /** Maximum retained entries. */
  limit: number;

  /** Threshold used by {@link slowRenders}. */
  slowRenderMs: number;

  private entries: DiagnosticEntry[] = [];
  private listeners = new Set<(entry: DiagnosticEntry) => void>();
  private droppedCount = 0;

  constructor(opts?: { enabled?: boolean; limit?: number; slowRenderMs?: number }) {
    this.enabled = opts?.enabled ?? false;
    // A non-positive limit would make the ring drop everything it is handed and
    // silently report an empty timeline. Treat it as "use the default" rather
    // than honoring a value that can only produce a confusing result.
    const limit = opts?.limit;
    this.limit = typeof limit === "number" && limit > 0 ? Math.floor(limit) : DEFAULT_DEV_LIMIT;
    this.slowRenderMs = opts?.slowRenderMs ?? DEFAULT_SLOW_RENDER_MS;
  }

  /**
   * Record an event.
   *
   * The entry is passed as a thunk so that nothing is allocated — no object,
   * no string interpolation for `detail` — when recording is disabled, which
   * is the production default.
   */
  record(build: () => DiagnosticEntry): void {
    if (!this.enabled) return;

    let entry: DiagnosticEntry;
    try {
      entry = build();
    } catch {
      // Building a diagnostic must never be able to break the thing it is
      // observing. A `detail` getter that throws is a bug in the caller, not a
      // reason to take down a render.
      return;
    }

    if (typeof entry.detail === "string") entry.detail = boundDetail(entry.detail);

    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries.shift();
      this.droppedCount++;
    }

    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // Same reasoning: a broken subscriber (a dev overlay mid-teardown)
        // must not propagate into application code.
      }
    }
  }

  /** All retained entries, oldest first. */
  all(): readonly DiagnosticEntry[] {
    return this.entries.slice();
  }

  /** Retained entries of one kind, oldest first. */
  byKind(kind: DiagnosticKind): DiagnosticEntry[] {
    return this.entries.filter((e) => e.kind === kind);
  }

  /** Retained render entries at or over {@link slowRenderMs}. */
  slowRenders(): DiagnosticEntry[] {
    return this.entries.filter(
      (e) => e.kind === "render" && (e.durationMs ?? 0) >= this.slowRenderMs,
    );
  }

  /** How many entries have been evicted by the size bound so far. */
  get dropped(): number {
    return this.droppedCount;
  }

  /** Drop all retained entries. Does not reset {@link dropped}. */
  clear(): void {
    this.entries.length = 0;
  }

  /**
   * Observe entries as they are recorded. Returns an unsubscribe function.
   *
   * Subscribing does not replay history — read {@link all} for that.
   */
  subscribe(listener: (entry: DiagnosticEntry) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Drop every subscriber. Called on context teardown. */
  clearListeners(): void {
    this.listeners.clear();
  }
}

/** Normalize the `dev` option into concrete settings. */
export function resolveDevOptions(dev: boolean | DevOptions | undefined): {
  enabled: boolean;
  limit: number;
  overlay: boolean;
  slowRenderMs: number;
} {
  if (!dev) {
    return {
      enabled: false,
      limit: DEFAULT_DEV_LIMIT,
      overlay: false,
      slowRenderMs: DEFAULT_SLOW_RENDER_MS,
    };
  }
  const opts = dev === true ? {} : dev;
  const limit = opts.limit;
  return {
    enabled: true,
    limit: typeof limit === "number" && limit > 0 ? Math.floor(limit) : DEFAULT_DEV_LIMIT,
    overlay: opts.overlay === true,
    slowRenderMs: opts.slowRenderMs ?? DEFAULT_SLOW_RENDER_MS,
  };
}
