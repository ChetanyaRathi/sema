# Notebook UI refactor — `sema-markdown` + `sema-editable-markdown` (first slice of #69)

**Status:** design / awaiting approval
**Branch:** `feature/notebook-ui-refactor`
**Tracks:** issue #69 (Migrate notebook UI primitives to `@sema/ui`)
**Date:** 2026-07-03

## 1. Context

The notebook browser UI (`crates/sema-notebook/src/ui/`) is Alpine.js + hand-rolled
primitives: a raw `<textarea>` editor and a ~12-line **regex** markdown renderer
(`renderMarkdown` in `notebook.js`). Markdown cells toggle between a rendered
`<div x-html="renderMarkdown(...)">` and the textarea via a `_rendered` flag —
`@click` on the rendered div enters edit mode; `@blur` and Shift+Enter re-render.

The repo ships a first-party Lit web-component library, **`@sema/ui`** (`ui/`), with
design-token-driven components. Issue #69 wants the notebook to consume `@sema/ui`
instead of re-implementing (and re-bugging) primitives by hand, on an **incremental**
path (leaf primitives → editor → menus/dialogs).

**This spec covers the first vertical slice:** build the two components the markdown
cell needs, resolve the bundling prerequisite, and wire *only* the notebook's markdown
cell to them. Everything else in #69 (buttons, tooltip, menu, dialog, toast, the code
editor) is deferred to follow-up slices.

### What already exists in `@sema/ui`

- `sema-textarea` — themed, form-associated multi-line input (plain; no live highlight).
- `sema-code` — **display-only** syntax-highlighted `<pre>` from slotted text (not an editor).
- Shiki highlighter (`internal/syntax-highlight.ts`) with the bundled `sema` grammar +
  lazy-loaded language chunks.
- **No markdown renderer exists.** (There is a Shiki `markdown` *grammar* for highlighting
  markdown *source*, but nothing that renders markdown → HTML.)

## 2. Prerequisites (must be resolved for this slice)

1. **Bundling / single-binary.** `@sema/ui` builds via Vite to `ui/dist/sema-ui.js`
   (~424 KB) + lazy language chunks. The notebook embeds assets with `include_str!`
   from *inside its own crate dir*. → A `make` target builds `ui/` and vendors the built
   bundle (+ the `sema` grammar chunk) into `crates/sema-notebook/src/ui/vendor/`, served
   and `include_str!`-embedded exactly like the offline fonts. Single-binary/offline holds.
2. **e2e coupling.** `notebook.spec.ts` drives `[data-testid="cell-textarea"]` and
   `[data-testid="markdown-rendered"]`. This slice keeps **code** cells on the current
   `<textarea>`, so those selectors are untouched; the markdown-rendered testid is
   preserved on the new component's rendered surface.
3. **Alpine ↔ web-component binding.** `x-model` relies on `input` on the bound element.
   The compound component owns its edit state and emits a `change` event carrying the
   current source; Alpine binds `.value` and persists on `@change` (no `x-model` on a
   shadow-DOM control).

## 3. Scope

**In scope (this slice):**
- `sema-markdown` — pure markdown → styled-HTML renderer.
- `sema-editable-markdown` — compound edit-in-place (textarea ↔ rendered), the reusable
  foundation the notebook markdown cell needs.
- Vendor/build wiring so the notebook can embed `@sema/ui` offline.
- Rewire the notebook markdown cell to `sema-editable-markdown`; delete the regex
  renderer and the markdown branches of the Alpine helpers.

**Non-goals (deferred):**
- Migrating code-cell editor, toolbar buttons, tooltips, menus, dialogs, toasts.
- A true live-syntax-highlighting **code editor** (neither `sema-code` nor `sema-textarea`
  edits with highlighting today — separate effort).
- Removing Alpine.js (state/reactivity stays on Alpine during incremental migration).
- Sanitization hardening beyond a light allowlist (local, single-user authoring context).

## 4. Design

### 4.1 `sema-markdown` (renderer)

A Lit component that renders a markdown string as token-styled HTML in its shadow root.

- **Input:** `value` property (string) **or** slotted text (slot → `value`, like `sema-code`).
- **Parse:** [`marked`](https://marked.js.org) (no deps). Fenced code blocks are routed to
  `@sema/ui`'s existing `highlightToHtml(code, lang)` so notebook code fences match
  `sema-code`. Unknown/unloaded fence languages fall back to escaped plain text.
- **Sanitize:** render via `unsafeHTML`, but pass parser output through a small tag/attr
  allowlist first (strip `<script>`, event-handler attrs, `javascript:` URLs). Local
  authoring → light touch, but never inject raw event handlers.
- **Styling:** shadow-DOM styles built from design tokens (`--text-primary`, `--mono`,
  headings, lists, `code`, `pre`, tables, links). Exposes `part`s (`h1`…`h4`, `p`, `code`,
  `pre`, `a`, `ul`, `table`) for consumer theming.
- **Testids/parts:** root surface carries `part="content"` and forwards a `data-testid`
  so the notebook can keep `markdown-rendered`.
- **A11y:** rendered region is a normal document flow; links get `rel="noopener"`.

### 4.2 `sema-editable-markdown` (compound edit-in-place)

Composes `sema-textarea` (edit) + `sema-markdown` (view) and owns the view↔edit toggle.

- **Props:** `value` (string, two-way via events), `placeholder`, `readonly`.
- **State:** internal `editing` boolean. **Not** `editing` → render `sema-markdown`;
  `editing` → render `sema-textarea` (autosize).
- **Interactions (mirror the notebook today):**
  - Click the rendered view → enter edit mode, focus the textarea.
  - Blur the textarea → if source non-empty, return to rendered view.
  - Shift+Enter → commit to rendered view.
  - Empty content in view mode → show a muted "Empty markdown — click to edit" affordance
    (so an empty cell is still clickable), matching current empty-cell behavior.
- **Events:** emits `change` (bubbles, composed) with `detail: { value }` on every commit
  (blur / Shift+Enter) and an `input` event on keystroke for live persistence parity.
- **Parts/testids:** forwards `markdown-rendered` (view) and `cell-textarea` (edit) testids
  so e2e can drive it; exposes `part="editor"` / `part="viewer"`.

### 4.3 Bundling

- New `make` target (e.g. `notebook-ui-vendor`): `cd ui && npm run build`, then copy
  `dist/sema-ui.js` + required grammar chunk(s) into
  `crates/sema-notebook/src/ui/vendor/`.
- `crates/sema-notebook/src/ui.rs`: add a `vendor/sema-ui.js` asset route + `include_str!`.
- `index.html`: `<script type="module" src="vendor/sema-ui.js">` and use `<sema-editable-markdown>`
  in the markdown-cell branch.
- Document that `@sema/ui` changes require re-running the vendor target (like fonts).
- **Follow-up optimization (out of scope):** a slim notebook-only entry that tree-shakes to
  just the components the notebook uses, shrinking the embedded bundle below the full 424 KB.

### 4.4 Notebook wiring (`notebook.js` / `index.html`)

- Replace the markdown-cell `x-if` pair (rendered div + textarea) with a single
  `<sema-editable-markdown :value="cell.source" @change="onMarkdownChange(cell, $event)">`.
- Delete `renderMarkdown`, `editMarkdown`, and the markdown branches of `onBlur` /
  `handleShiftEnter` (the component owns them now).
- `onMarkdownChange(cell, e)` sets `cell.source = e.detail.value` and calls
  `persistSource(cell)` — same persistence path as today.
- Code cells are untouched this slice.

## 5. Data flow

```
Alpine cell.source ──(:value)──▶ sema-editable-markdown
                                     │  edit/blur/shift-enter (internal state)
                                     ▼
                          sema-textarea ⇄ sema-markdown ──▶ marked + Shiki fences
                                     │
        onMarkdownChange ◀─(@change detail.value)─┘ ──▶ persistSource → POST /api/cells/:id
```

## 6. Error handling / edge cases

- **Malformed markdown:** `marked` is tolerant; on any parser throw, fall back to escaped
  raw text (never render broken/unsafe HTML).
- **Empty source:** view mode shows the clickable empty affordance; `change` with empty
  value persists an empty cell (current behavior).
- **Fence language not loaded:** render the fence as escaped plain text (no dynamic-import
  failure in the offline binary).
- **Focus race:** entering edit mode focuses the textarea on the next frame (mirrors the
  current `$nextTick` focus).

## 7. Testing

- **`@sema/ui` vitest (browser):** `sema-markdown` (headings/lists/links/tables/fences,
  sanitization strips `<script>`/handlers, slot vs `value`); `sema-editable-markdown`
  (click→edit, blur→render, Shift+Enter→render, empty affordance, `change`/`input` events,
  two-way `value`).
- **Notebook e2e (`notebook.spec.ts`):** markdown add → type → blur renders → click re-edits;
  assert `markdown-rendered` still resolves and code-cell selectors are unaffected. Add a
  round-trip (edit → save → reload → still rendered) guarding the persistence path.
- **Rust:** `cargo test -p sema-notebook` for the new asset route.
- **Full local gate before PR:** `make lint`, notebook e2e, and a manual
  `make example-notebook` smoke.

## 8. Open questions

- **Renderer dep:** confirm `marked` (recommended) vs `markdown-it`+DOMPurify vs
  hand-rolled. Spec assumes `marked` + light allowlist.
- **Bundle size:** accept the full `sema-ui.js` embed for the slice, or build the slim
  notebook entry now? Spec defers slim entry to a follow-up.
- **Component names:** `sema-markdown` / `sema-editable-markdown` — open to `sema-md` /
  `sema-markdown-editor` if preferred.
```
