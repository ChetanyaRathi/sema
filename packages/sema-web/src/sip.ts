/**
 * SIP (Sema Interface Protocol) — declarative DOM rendering for Sema.
 *
 * Renders Sema vectors as DOM elements using the hiccup convention:
 *
 * ```sema
 * [:div {:class "container"}
 *   [:h1 "Hello"]
 *   [:p {:style "color: blue"} "World"]]
 * ```
 *
 * After WASM serialization, the JS side receives:
 *   [":div", {":class": "container"}, [":h1", "Hello"], ...]
 *
 * The renderer strips keyword colon prefixes and handles special
 * attributes like `on-*` (event handlers) and `style` (object or string).
 *
 * @module
 */

import { storeHandle, SEMA_IDENT_RE } from "./handles.js";
import type { SemaWebContext } from "./context.js";

interface SemaInterpreterLike {
  registerFunction(name: string, fn: (...args: any[]) => any): void;
  evalStr(code: string): { value: string | null; output: string[]; error: string | null };
}

const SVG_NS = "http://www.w3.org/2000/svg";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

/**
 * Namespace URIs for the reserved XML attribute prefixes SIP recognizes.
 * `setAttribute("xlink:href", ...)` sets an attribute literally *named*
 * "xlink:href" without registering it in the XLink namespace — most
 * browsers resolve it anyway for rendering, but `getAttributeNS` (and
 * strict SVG processors) will not see it. `setAttributeNS` is the correct,
 * spec-compliant way to set these.
 */
const NS_ATTR_PREFIXES: Record<string, string> = {
  xlink: "http://www.w3.org/1999/xlink",
  xml: "http://www.w3.org/XML/1998/namespace",
  xmlns: "http://www.w3.org/2000/xmlns/",
};

const EVENT_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * DOM events the delegator listens for on a mount root.
 *
 * The single source of truth: `EventDelegator.setup` registers exactly these
 * (plus the synthetic pair below), and {@link delegationError} refuses any
 * `on-*` attribute naming something else. Two lists that could drift would
 * reintroduce the defect this exists to prevent — an `on-*` attribute that
 * renders, looks right in devtools, and can never fire.
 *
 * Everything here bubbles, because delegation from the mount root is only
 * possible for events that reach it. `focus`/`blur`/`scroll` do not bubble and
 * are therefore absent; `focusin`/`focusout` are their delegable equivalents.
 */
export const DELEGATED_EVENTS: readonly string[] = [
  // Mouse
  "click", "dblclick", "auxclick", "contextmenu", "mousedown", "mouseup",
  "mousemove", "mouseover", "mouseout", "wheel",
  // Pointer
  "pointerdown", "pointerup", "pointermove", "pointerover", "pointerout",
  "pointercancel",
  // Touch
  "touchstart", "touchend", "touchmove", "touchcancel",
  // Keyboard
  "keydown", "keyup", "keypress",
  // Form
  "input", "change", "submit", "reset", "select",
  // Focus (the bubbling pair)
  "focusin", "focusout",
  // Clipboard
  "copy", "cut", "paste",
  // Drag and drop
  "drag", "dragstart", "dragend", "dragenter", "dragleave", "dragover", "drop",
  // Animation and transition
  "animationstart", "animationend", "transitionend",
];

/**
 * Events synthesized by the delegator from `mouseover`/`mouseout`.
 *
 * Routable like the rest, but with no listener of their own — see
 * `EventDelegator.setup`.
 */
export const SYNTHETIC_EVENTS: readonly string[] = ["mouseenter", "mouseleave"];

/** Every event name an `on-*` attribute may name. */
export const ROUTABLE_EVENTS: ReadonlySet<string> = new Set([
  ...DELEGATED_EVENTS,
  ...SYNTHETIC_EVENTS,
]);

/**
 * Delegable stand-ins for events that cannot be delegated from the mount root.
 *
 * `focus` and `blur` are the two a form is actually likely to want, and the
 * bubbling pair is a drop-in replacement, so the diagnostic names it rather
 * than sending the reader to `dom/on!` for no reason.
 */
const NON_BUBBLING_ALTERNATIVES: Readonly<Record<string, string>> = {
  focus: "focusin",
  blur: "focusout",
};

/** Levenshtein distance. Only ever reached on the error path. */
function editDistance(a: string, b: string): number {
  const previous = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const candidate = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = previous[j];
      previous[j] = candidate;
    }
  }
  return previous[b.length];
}

/** The routable event name closest to `name`, if one is close enough to name. */
function nearestRoutableEvent(name: string): string | null {
  const lower = name.toLowerCase();
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of ROUTABLE_EVENTS) {
    const distance = editDistance(lower, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  // Two edits over a short name is already most of the word; beyond that the
  // "did you mean" is noise that would send a reader after the wrong fix.
  return best !== null && bestDistance <= 2 && bestDistance < lower.length ? best : null;
}

/**
 * Why an `on-*` event name cannot be routed, or `null` if it can.
 *
 * The event name gets the same treatment as a modifier: a name the delegator
 * does not listen for is refused loudly. Silence here is the worst failure a
 * typo can have — `{:on-sumbit.prevent "save"}` renders happily, prevents
 * nothing, and the form navigates the page away.
 */
export function delegationError(event: string, key: string): string | null {
  if (ROUTABLE_EVENTS.has(event)) return null;
  const alternative = NON_BUBBLING_ALTERNATIVES[event];
  if (alternative) {
    return (
      `Event "${event}" in attribute: ${key} is not delegated because it does not bubble ` +
      `to the mount root. Use "${alternative}", which does, or attach it directly with ` +
      "(dom/on! …) from an on-mount callback."
    );
  }
  const suggestion = nearestRoutableEvent(event);
  return (
    `Unknown event "${event}" in attribute: ${key}. ` +
    (suggestion ? `Did you mean "${suggestion}"? ` : "") +
    "SIP delegates a fixed set of bubbling DOM events; for anything else " +
    "(a custom element's event, or a non-bubbling one like scroll) attach the " +
    "listener directly with (dom/on! …) from an on-mount callback."
  );
}

/**
 * Modifiers a SIP `on-*` attribute may carry: `{:on-submit.prevent "save"}`.
 *
 * Declaration order is the canonical encoding order, so `.stop.prevent` and
 * `.prevent.stop` write a byte-identical attribute and a re-render never
 * churns it. It is deliberately NOT the order they are *applied* in — see
 * `tryRun` in `component.ts`, where `.self` filters, then `.prevent` runs, then
 * `.once` gates, then the handler, then `.stop`.
 */
export const EVENT_MODIFIERS = ["prevent", "stop", "once", "capture", "self"] as const;

/** One of {@link EVENT_MODIFIERS}. */
export type EventModifierName = (typeof EVENT_MODIFIERS)[number];

/** Decoded modifier flags for one `on-*` handler. */
export type EventModifiers = Readonly<Record<EventModifierName, boolean>>;

/**
 * The all-false result, shared.
 *
 * Returned by {@link readEventModifiers} for the overwhelmingly common
 * unmodified handler, so delegated dispatch — which runs on every click of
 * every app — allocates nothing on that path.
 */
export const NO_EVENT_MODIFIERS: EventModifiers = Object.freeze({
  prevent: false,
  stop: false,
  once: false,
  capture: false,
  self: false,
});

/**
 * Prefix of the attribute carrying a handler's modifiers.
 *
 * A sibling attribute rather than a suffix on `data-sema-on-<event>`, and
 * rather than an encoding inside the handler value, for two reasons. The
 * delegator's upward walk matches on the exact handler attribute name, so the
 * value must stay exactly the handler name. And a suffix form
 * (`data-sema-on-<event>-mods`) would collide: event names may contain `-`, so
 * `{:on-foo-mods "h"}` would be indistinguishable from the modifier set of
 * event `foo`.
 */
export const SIP_EVENT_MODS_PREFIX = "data-sema-mods-";

/** Name of the modifier attribute for an event. */
export function eventModsAttr(event: string): string {
  return `${SIP_EVENT_MODS_PREFIX}${event}`;
}

/** Result of {@link parseEventAttrKey}. */
export type ParsedEventAttr =
  | { ok: true; event: string; modifiers: EventModifierName[] }
  | { ok: false; error: string };

/**
 * Split a colon-stripped `on-*` attribute key into event name and modifiers.
 *
 * @param key - e.g. `"on-submit.prevent"`. The `on-` prefix is assumed; the
 *   caller has already matched it.
 *
 * An unknown or empty modifier is an error rather than something to ignore:
 * a silently dropped `.prevnt` lets a form navigate away with no signal
 * anywhere, which is the worst possible failure for a typo to have.
 *
 * Syntax only — whether the *event* can actually be routed is
 * {@link delegationError}'s question, kept separate so the parser stays usable
 * for reading back an attribute the delegator already accepted.
 */
export function parseEventAttrKey(key: string): ParsedEventAttr {
  const body = key.slice(3);
  const dot = body.indexOf(".");
  const event = dot === -1 ? body : body.slice(0, dot);
  if (!EVENT_NAME_RE.test(event)) {
    return { ok: false, error: `Invalid event handler attribute: ${key}` };
  }
  if (dot === -1) {
    return { ok: true, event, modifiers: [] };
  }

  const seen = new Set<EventModifierName>();
  for (const name of body.slice(dot + 1).split(".")) {
    if (!(EVENT_MODIFIERS as readonly string[]).includes(name)) {
      return {
        ok: false,
        error:
          `Invalid event modifier ${JSON.stringify(name)} in attribute: ${key} ` +
          `(supported: ${EVENT_MODIFIERS.join(", ")})`,
      };
    }
    seen.add(name as EventModifierName);
  }
  return { ok: true, event, modifiers: EVENT_MODIFIERS.filter((name) => seen.has(name)) };
}

/**
 * Read the modifiers a rendered element declared for an event.
 *
 * The delegator calls this only after a handler attribute has already matched,
 * so an app that uses no modifiers pays one `getAttribute` per dispatched
 * handler and nothing else.
 */
export function readEventModifiers(el: Element, event: string): EventModifiers {
  const encoded = el.getAttribute(eventModsAttr(event));
  if (!encoded) return NO_EVENT_MODIFIERS;
  const mods: Record<EventModifierName, boolean> = {
    prevent: false,
    stop: false,
    once: false,
    capture: false,
    self: false,
  };
  for (const name of encoded.split(" ")) {
    if (Object.prototype.hasOwnProperty.call(mods, name)) {
      mods[name as EventModifierName] = true;
    }
  }
  return mods;
}

/**
 * DOM attribute carrying a SIP `:key`.
 *
 * A data attribute rather than a side table: morphdom's `getNodeKey` runs
 * against nodes from *both* trees — the freshly rendered clone and the live
 * DOM that has persisted across renders — and only an attribute survives on
 * both without extra bookkeeping. It is namespaced and invisible to users, and
 * being inspectable makes "why did this row lose focus" answerable in devtools.
 */
export const SIP_KEY_ATTR = "data-sema-key";

/**
 * Read the stable identity of a node for morphdom's diffing.
 *
 * Falls back to `id`, which is morphdom's own default — overriding
 * `getNodeKey` replaces that behaviour entirely, so an app relying on `id` for
 * stability would silently lose it.
 */
export function sipNodeKey(node: Node): string | undefined {
  if (node.nodeType !== 1) return undefined;
  const el = node as Element;
  return el.getAttribute(SIP_KEY_ATTR) || (el as HTMLElement).id || undefined;
}

/**
 * Report sibling elements that claim the same `:key`.
 *
 * Duplicate keys are the failure mode that looks like a framework bug: morphdom
 * matches the first node for both, so one row's DOM state (focus, cursor,
 * scroll, an open `<details>`) silently migrates onto another. Detection is
 * dev-only — it costs a Set per element with keyed children — and never blocks
 * the render, matching the acceptance criterion "still render".
 */
function reportDuplicateKeys(el: Element, ctx: SemaWebContext, tagName: string): void {
  const seen = new Set<string>();
  for (const child of Array.from(el.children)) {
    const key = child.getAttribute(SIP_KEY_ATTR);
    if (key == null) continue;
    if (seen.has(key)) {
      ctx.onerror(
        new Error(
          `Duplicate SIP :key ${JSON.stringify(key)} among the children of <${tagName}>. ` +
            "Keyed siblings must be unique or DOM state will move between them.",
        ),
        `sip-render:duplicate-key:${tagName}`,
      );
      continue;
    }
    seen.add(key);
  }
}

/** Does this element declare a `.once` handler for any event? */
function declaresOnce(el: Element): boolean {
  for (const attr of Array.from(el.attributes)) {
    if (!attr.name.startsWith(SIP_EVENT_MODS_PREFIX)) continue;
    if (attr.value.split(" ").includes("once")) return true;
  }
  return false;
}

/**
 * Report a `.once` handler on an unkeyed element that has an unkeyed twin.
 *
 * `.once` is spent per DOM element, and morphdom matches unkeyed children by
 * position and tag name — so a list that reorders hands one row's element to a
 * different item, carrying the spent mark with it: the row the user clicked
 * fires again and the row they never touched is permanently dead. The
 * framework cannot recover item identity here; only a `:key` can supply it,
 * which is why this is a dev diagnostic and not a fix.
 *
 * Deliberately narrow — same tag, both unkeyed — because that is exactly the
 * condition under which morphdom reuses one element for another item. One
 * report per parent: a hundred-row list has one bug, not a hundred.
 */
function reportKeylessOnce(el: Element, ctx: SemaWebContext, tagName: string): void {
  const children = Array.from(el.children);
  if (children.length < 2) return;
  const unkeyedTags = new Map<string, number>();
  for (const child of children) {
    if (child.hasAttribute(SIP_KEY_ATTR) || child.id) continue;
    unkeyedTags.set(child.tagName, (unkeyedTags.get(child.tagName) ?? 0) + 1);
  }
  for (const child of children) {
    if (child.hasAttribute(SIP_KEY_ATTR) || child.id) continue;
    if ((unkeyedTags.get(child.tagName) ?? 0) < 2) continue;
    if (!declaresOnce(child)) continue;
    ctx.onerror(
      new Error(
        `A .once handler on an unkeyed <${child.tagName.toLowerCase()}> with unkeyed siblings of ` +
          `the same tag, among the children of <${tagName}>. .once is spent per DOM element and ` +
          "morphdom matches unkeyed siblings by position, so reordering moves the spent handler " +
          "onto a different item. Give each sibling a :key.",
      ),
      `sip-render:once-without-key:${tagName}`,
    );
    return;
  }
}

function classListToString(values: unknown[]): string {
  let joined = "";
  let hasToken = false;

  for (const value of values) {
    if (value === null || value === undefined || value === false || value === "") {
      continue;
    }

    if (hasToken) joined += " ";
    joined += String(value);
    hasToken = true;
  }

  return joined;
}

/**
 * HTML boolean content attributes (WHATWG list, minus `checked`, which is
 * handled separately as a live DOM property rather than an attribute — see
 * `applyAttributes`). For these, presence (not attribute *value*) means
 * true, so `{:required false}` must remove the attribute rather than set it
 * to the string `"false"` (which HTML still treats as present/true).
 */
const BOOLEAN_ATTRS = new Set([
  "allowfullscreen", "async", "autofocus", "autoplay", "controls", "default",
  "defer", "disabled", "formnovalidate", "hidden", "inert", "ismap",
  "itemscope", "loop", "multiple", "muted", "nomodule", "novalidate", "open",
  "playsinline", "readonly", "required", "reversed", "selected",
]);

/**
 * Render a SIP data structure to a DOM Node.
 *
 * SIP format: [tag, attrs?, ...children]
 * - tag: keyword or string (e.g., `:div` serialized as `":div"`)
 * - attrs: optional map of attributes (object with keyword keys)
 * - children: strings, numbers, booleans, or nested SIP vectors
 *
 * Special attribute handling:
 * - `on-*` attributes are event handlers (value = Sema function name string),
 *   optionally carrying dotted modifiers (`:on-submit.prevent`) — see
 *   {@link EVENT_MODIFIERS}
 * - `style` can be a string or a map of CSS properties
 * - `class` sets the class attribute (accepts a string or an array of
 *   strings, space-joined; falsy/nil entries are dropped)
 * - `value`, `checked` set corresponding DOM properties
 * - Recognized HTML boolean attributes (`disabled`, `required`, `selected`,
 *   etc.) toggle attribute presence based on truthiness
 * - `nil`/`undefined` attribute values omit the attribute entirely, rather
 *   than stringifying to the literal text `"null"`/`"undefined"`
 *
 * `<svg>` (and `<math>`) switch the element namespace for themselves and
 * their descendants, as real HTML parsing does; a nested `<foreignObject>`
 * switches back to the HTML namespace for its own children. Attribute names
 * prefixed `xlink:`, `xml:`, or `xmlns:` are set via `setAttributeNS` in
 * their proper namespace (needed for `<use xlink:href="...">` and similar).
 *
 * A malformed tag name or attribute name (e.g. built from bad dynamic
 * input) is isolated rather than allowed to crash the whole render: the
 * offending node renders as empty / the offending attribute is skipped,
 * and the failure is reported through `ctx.onerror` — never a raw
 * `console.error` — so host apps can route SIP render failures through
 * whatever error-reporting hook they've configured.
 */
export function renderSip(node: any, interp: SemaInterpreterLike, ctx: SemaWebContext): Node {
  return renderSipNode(node, interp, ctx, null);
}

function renderSipNode(
  node: any,
  interp: SemaInterpreterLike,
  ctx: SemaWebContext,
  namespaceURI: string | null,
): Node {
  // null/nil -> empty text
  if (node === null || node === undefined) {
    return document.createTextNode("");
  }

  // Primitives -> text node
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    return document.createTextNode(String(node));
  }

  // Array -> SIP element or fragment
  if (Array.isArray(node)) {
    if (node.length === 0) {
      return document.createTextNode("");
    }

    const tag = node[0];

    // If first element is not a string, treat as fragment (list of elements)
    if (typeof tag !== "string") {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < node.length; i++) {
        frag.appendChild(renderSipNode(node[i], interp, ctx, namespaceURI));
      }
      return frag;
    }

    // Strip keyword colon prefix: ":div" -> "div"
    const tagName = tag.startsWith(":") ? tag.slice(1) : tag;
    const lowerTag = tagName.toLowerCase();

    // Determine the namespace for this element (inherited from the parent
    // by default) and its descendants.
    let elNamespace = namespaceURI;
    if (lowerTag === "svg") {
      elNamespace = SVG_NS;
    } else if (lowerTag === "math") {
      elNamespace = MATHML_NS;
    }
    let el: Element;
    try {
      el = elNamespace
        ? document.createElementNS(elNamespace, tagName)
        : document.createElement(tagName);
    } catch (e) {
      // An invalid tag name (e.g. one built from bad user input) would
      // otherwise throw and abort the ENTIRE render, including unrelated
      // siblings. Render this node as empty instead — one malformed node
      // shouldn't take down everything around it.
      ctx.onerror(e instanceof Error ? e : new Error(String(e)), `sip-render:invalid-tag:${tagName}`);
      return document.createTextNode("");
    }
    // <foreignObject> stays in the SVG namespace itself, but re-enters HTML
    // content for its children, matching real HTML/SVG parsing.
    const childNamespace = lowerTag === "foreignobject" ? null : elNamespace;

    let childStart = 1;

    // Check for attributes map (second element is a plain object, not array)
    if (
      node.length > 1 &&
      node[1] !== null &&
      typeof node[1] === "object" &&
      !Array.isArray(node[1])
    ) {
      applyAttributes(el, node[1], interp, ctx);
      childStart = 2;
    }

    // Render children
    for (let i = childStart; i < node.length; i++) {
      el.appendChild(renderSipNode(node[i], interp, ctx, childNamespace));
    }

    if (ctx.diagnostics.enabled) {
      reportDuplicateKeys(el, ctx, tagName);
      reportKeylessOnce(el, ctx, tagName);
    }

    return el;
  }

  // Fallback: convert to string
  try {
    return document.createTextNode(String(node));
  } catch (e) {
    ctx.onerror(e instanceof Error ? e : new Error(String(e)), "sip-render:text");
    return document.createTextNode("");
  }
}

/**
 * Apply attributes from a SIP attrs map to an Element.
 *
 * Handles:
 * - `on-*` -> event listeners (value is a Sema function name); dotted
 *   modifiers on the key (`:on-click.stop.once`) are validated here and
 *   encoded into a sibling `data-sema-mods-<event>` attribute for the
 *   delegator to read
 * - `style` -> CSS (string, or a map of properties -> values)
 * - `class` -> the `class` attribute (string, or an array of strings —
 *   space-joined, dropping falsy/nil entries)
 * - `value`, `checked` -> DOM properties (not attributes — these reflect
 *   live/user-editable state, not just the initial render)
 * - Recognized HTML boolean attributes (`disabled`, `required`, `selected`,
 *   etc. — see `BOOLEAN_ATTRS`) -> attribute presence toggled by truthiness
 * - Everything else -> setAttribute
 *
 * `nil`/`undefined` attribute values are always skipped entirely (the
 * attribute is simply not set), rather than stringified to the literal
 * text `"null"`/`"undefined"`.
 */
function applyAttributes(
  el: Element,
  attrs: Record<string, any>,
  interp: SemaInterpreterLike,
  ctx: SemaWebContext,
): void {
  try {
    for (const rawKey in attrs) {
      // Each attribute is applied independently: a bad value or an
      // unexpected DOM exception (e.g. an invalid attribute name) shouldn't
      // prevent the rest of the attributes — or the element's children —
      // from rendering.
      let key = rawKey;
      let value: any;
      try {
        if (!Object.prototype.hasOwnProperty.call(attrs, rawKey)) {
          continue;
        }
        value = attrs[rawKey];
      } catch (e) {
        ctx.onerror(e instanceof Error ? e : new Error(String(e)), `sip-render:attribute:${rawKey}`);
        continue;
      }

      // Strip keyword colon prefix from keys
      if (key.startsWith(":")) {
        key = key.slice(1);
      }

      if (value === null || value === undefined) {
        continue;
      }

      try {
        if (key.startsWith("on-")) {
          // Event handler: set data attribute for delegated event handling
          const parsed = parseEventAttrKey(key);
          if (!parsed.ok) {
            ctx.onerror(new Error(parsed.error), "sip-render:on-handler");
            continue;
          }
          const eventName = parsed.event;
          const unroutable = delegationError(eventName, key);
          if (unroutable) {
            ctx.onerror(new Error(unroutable), "sip-render:on-handler");
            continue;
          }
          if (typeof value === "string") {
            if (!SEMA_IDENT_RE.test(value)) {
              ctx.onerror(new Error(`Invalid event handler name: ${value}`), "sip-render:on-handler");
              continue;
            }
            el.setAttribute(`data-sema-on-${eventName}`, value);
            // Written only when there are modifiers, so the delegator can treat
            // "attribute absent" as the zero-allocation fast path, and a
            // rejected handler never leaves an orphan modifier attribute.
            if (parsed.modifiers.length > 0) {
              el.setAttribute(eventModsAttr(eventName), parsed.modifiers.join(" "));
              if (parsed.modifiers.includes("capture")) ctx.captureEvents.add(eventName);
            }
          } else {
            ctx.onerror(
              new Error(`Event handler value for "${key}" must be a string function name, got: ${typeof value}`),
              "sip-render:on-handler",
            );
          }
        } else if (key === "key") {
          // Stable identity for diffing. Stringified because Sema keys are
          // commonly numeric ids, and morphdom compares keys as strings — a
          // number and its string form must name the same node.
          el.setAttribute(SIP_KEY_ATTR, String(value));
        } else if (key === "style") {
          if (typeof value === "string") {
            el.setAttribute("style", value);
          } else if (typeof value === "object") {
            // Style map: {":color": "red", ":font-size": "14px"}
            for (let [prop, val] of Object.entries(value)) {
              if (prop.startsWith(":")) prop = prop.slice(1);
              if (val === null || val === undefined) continue;
              (el as HTMLElement).style.setProperty(prop, String(val));
            }
          }
        } else if (key === "class") {
          if (value === false) {
            // no-op: a conditional class idiom like {:class (if active "on" false)}
          } else if (Array.isArray(value)) {
            const joined = classListToString(value);
            if (joined) el.setAttribute("class", joined);
          } else {
            el.setAttribute("class", String(value));
          }
        } else if (key === "value") {
          (el as HTMLInputElement).value = String(value);
        } else if (key === "checked") {
          (el as HTMLInputElement).checked = Boolean(value);
        } else if (key === "muted") {
          if (value) {
            el.setAttribute(key, "");
          } else {
            el.removeAttribute(key);
          }
          if ("defaultMuted" in el) {
            (el as HTMLMediaElement).defaultMuted = Boolean(value);
          }
          if ("muted" in el) {
            (el as HTMLMediaElement).muted = Boolean(value);
          }
        } else if (BOOLEAN_ATTRS.has(key)) {
          if (value) {
            el.setAttribute(key, "");
          } else {
            el.removeAttribute(key);
          }
        } else {
          if (key === "xmlns") {
            el.setAttributeNS(NS_ATTR_PREFIXES.xmlns, key, String(value));
            continue;
          }

          const colonIdx = key.indexOf(":");
          const prefix = colonIdx > 0 ? key.slice(0, colonIdx) : null;
          const ns = prefix ? NS_ATTR_PREFIXES[prefix] : undefined;
          if (ns) {
            el.setAttributeNS(ns, key, String(value));
          } else {
            el.setAttribute(key, String(value));
          }
        }
      } catch (e) {
        ctx.onerror(e instanceof Error ? e : new Error(String(e)), `sip-render:attribute:${key}`);
      }
    }
  } catch (e) {
    ctx.onerror(e instanceof Error ? e : new Error(String(e)), "sip-render:attributes");
  }
}

/**
 * Register `sip/*` namespace functions.
 *
 * Functions registered:
 * - `sip/render` — render SIP data, return element handle
 * - `sip/render-into!` — render SIP into a target element (by CSS selector)
 */
export function registerSipBindings(interp: SemaInterpreterLike, ctx: SemaWebContext): void {
  // sip/render — render SIP data and return an element handle
  interp.registerFunction("sip/render", (sipData: any) => {
    const node = renderSip(sipData, interp, ctx);
    if (node instanceof Element) {
      return storeHandle(node, ctx);
    }
    // Wrap non-element nodes in a span for handle compatibility
    const wrapper = document.createElement("span");
    wrapper.appendChild(node);
    return storeHandle(wrapper, ctx);
  });

  // sip/render-into! — render SIP into a target element by CSS selector
  interp.registerFunction("sip/render-into!", (selector: string, sipData: any) => {
    const target = document.querySelector(selector);
    if (!target) throw new Error(`sip/render-into!: target not found: ${selector}`);
    target.innerHTML = "";
    const node = renderSip(sipData, interp, ctx);
    target.appendChild(node);
    return null;
  });

  // Backward-compatible aliases for the old hiccup/* names
  interp.registerFunction("hiccup/render", (sipData: any) => {
    const node = renderSip(sipData, interp, ctx);
    if (node instanceof Element) {
      return storeHandle(node, ctx);
    }
    const wrapper = document.createElement("span");
    wrapper.appendChild(node);
    return storeHandle(wrapper, ctx);
  });

  interp.registerFunction("hiccup/render-into!", (selector: string, sipData: any) => {
    const target = document.querySelector(selector);
    if (!target) throw new Error(`hiccup/render-into!: target not found: ${selector}`);
    target.innerHTML = "";
    const node = renderSip(sipData, interp, ctx);
    target.appendChild(node);
    return null;
  });
}
