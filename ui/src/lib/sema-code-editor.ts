import { html, css, unsafeCSS } from 'lit';
import { property } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { live } from 'lit/directives/live.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { SemaElement } from '../internal/sema-element.js';
import { highlightSemaSync } from '../internal/sema-tokenize.js';
import { TextareaUndo } from '../internal/textarea-undo.js';
import syntaxStyles from '../styles/syntax.css?inline';
import scrollbarStyles from '../styles/scrollbar.css?inline';

/**
 * `<sema-code-editor>` — an editable, syntax-highlighting code editor.
 *
 * A transparent `<textarea>` (real caret / selection / IME) sits over an
 * `aria-hidden` overlay painted by a synchronous highlighter (default: Sema).
 * Both share identical text metrics so glyphs line up; the overlay scroll-syncs
 * to the textarea. `autosize` grows the control to fit content (for notebook
 * cells). Extracted from the sema.run playground editor.
 *
 * Events: `input` and `change` as `CustomEvent<{ value }>`; native `keydown`
 * bubbles composed so hosts can bind Shift+Enter etc.
 */
export class SemaCodeEditor extends SemaElement {
  static styles = [
    SemaElement.base,
    unsafeCSS(syntaxStyles),
    unsafeCSS(scrollbarStyles),
    css`
      :host {
        display: block;
      }
      .wrap {
        position: relative;
        display: flex;
        background: var(--bg-editor, #0a0a0a);
        border: 1px solid var(--border, #1e1e1e);
        border-radius: var(--radius-sm, 4px);
      }
      .gutter {
        flex: 0 0 auto;
        padding: var(--space-sm, 8px) 0;
        text-align: right;
        color: var(--text-tertiary, #5a5448);
        user-select: none;
        overflow: hidden;
        font-family: var(--mono, 'JetBrains Mono', monospace);
        font-size: 0.82rem;
        line-height: 1.7;
      }
      .gutter div {
        padding: 0 0.6em 0 0.9em;
      }
      .stack {
        position: relative;
        flex: 1 1 auto;
      }
      .hl,
      textarea {
        margin: 0;
        padding: var(--space-sm, 8px) var(--space-md, 12px);
        font-family: var(--mono, 'JetBrains Mono', monospace);
        font-size: 0.82rem;
        line-height: 1.7;
        tab-size: 2;
        white-space: pre-wrap;
        word-break: break-word;
        overflow-wrap: break-word;
        border: 0;
        box-sizing: border-box;
        letter-spacing: normal;
      }
      .hl {
        position: absolute;
        inset: 0;
        pointer-events: none;
        overflow: hidden;
        color: var(--text-primary, #d8d0c0);
      }
      textarea {
        position: relative;
        display: block;
        width: 100%;
        height: auto;
        min-height: 1.7em;
        resize: none;
        background: transparent;
        color: transparent;
        caret-color: var(--text-primary, #d8d0c0);
        outline: none;
        overflow: auto;
      }
      :host([autosize]) textarea {
        overflow: hidden;
      }
      textarea::selection {
        background: var(--gold-dim, #3a3320);
        color: transparent;
      }
    `,
  ];

  @property() value = '';
  @property({ reflect: true }) lang = 'sema';
  @property() placeholder = '';
  @property({ type: Boolean, reflect: true }) readonly = false;
  @property({ type: Boolean, reflect: true }) gutter = false;
  @property({ type: Boolean, reflect: true }) autosize = false;
  @property({ type: Number, attribute: 'tab-size' }) tabSize = 2;
  @property() testid = '';

  /** Swappable synchronous highlighter: (code, lang) → overlay inner HTML. */
  static highlighter: (code: string, lang: string) => string = highlightSemaSync;

  private _undo?: TextareaUndo;

  private get _ta(): HTMLTextAreaElement | null {
    return this.shadowRoot?.querySelector('textarea') ?? null;
  }

  firstUpdated() {
    const t = this._ta;
    if (t) this._undo = new TextareaUndo(t, { onChange: () => this._onInput() });
    if (this.autosize) this._grow();
  }

  /** Clear the undo/redo history — call after loading unrelated content. */
  resetHistory() {
    this._undo?.reset();
  }

  /** Focus delegates to the inner textarea (the host itself isn't focusable). */
  focus() {
    this._ta?.focus();
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has('value') && this.autosize) this._grow();
  }

  private _grow() {
    const t = this._ta;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = `${t.scrollHeight}px`;
  }

  private _onInput = (e?: Event) => {
    // Stop the inner textarea's native `input` at the boundary — we re-emit a
    // typed CustomEvent below, so consumers never see the value-less native one.
    e?.stopPropagation();
    const t = this._ta;
    if (!t) return;
    this.value = t.value;
    if (this.autosize) this._grow();
    this.dispatchEvent(
      new CustomEvent('input', { detail: { value: this.value }, bubbles: true, composed: true }),
    );
  };

  private _onChange = (e?: Event) => {
    e?.stopPropagation();
    this.dispatchEvent(
      new CustomEvent('change', { detail: { value: this.value }, bubbles: true, composed: true }),
    );
  };

  private _onScroll = () => {
    const t = this._ta;
    const overlay = this.shadowRoot?.querySelector('.hl') as HTMLElement | null;
    const gut = this.shadowRoot?.querySelector('.gutter') as HTMLElement | null;
    if (t && overlay) {
      overlay.scrollTop = t.scrollTop;
      overlay.scrollLeft = t.scrollLeft;
    }
    if (t && gut) gut.scrollTop = t.scrollTop;
  };

  private _onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const t = this._ta;
      if (!t) return;
      const s = t.selectionStart;
      const en = t.selectionEnd;
      const pad = ' '.repeat(this.tabSize);
      t.value = t.value.slice(0, s) + pad + t.value.slice(en);
      t.selectionStart = t.selectionEnd = s + pad.length;
      // Native input drives both _onInput (value/repaint) and the undo stack.
      t.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // All other keydowns bubble (composed) so the host can bind Shift+Enter etc.
  };

  private _lineNumbers() {
    const n = (this.value.match(/\n/g)?.length ?? 0) + 1;
    return Array.from({ length: n }, (_, i) => html`<div>${i + 1}</div>`);
  }

  render() {
    const painted = SemaCodeEditor.highlighter(this.value, this.lang);
    return html`
      <div class="wrap">
        ${this.gutter ? html`<div class="gutter" part="gutter">${this._lineNumbers()}</div>` : ''}
        <div class="stack">
          <div class="hl sema-scroll" part="highlight" aria-hidden="true">${unsafeHTML(painted || '\n')}</div>
          <textarea
            class="sema-scroll"
            part="textarea"
            data-testid=${ifDefined(this.testid || undefined)}
            .value=${live(this.value)}
            ?readonly=${this.readonly}
            placeholder=${this.placeholder}
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
            @input=${this._onInput}
            @change=${this._onChange}
            @scroll=${this._onScroll}
            @keydown=${this._onKeydown}
          ></textarea>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sema-code-editor': SemaCodeEditor;
  }
}
customElements.define('sema-code-editor', SemaCodeEditor);
