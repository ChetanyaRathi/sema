interface UndoState {
  value: string;
  start: number;
  end: number;
}
interface UndoOpts {
  max?: number;
  mergeDelay?: number;
  onChange?: (() => void) | null;
}

/**
 * Undo/redo history for a textarea. Overlay editors set `.value` programmatically
 * (highlight repaint, undo apply), which erases the browser's native undo stack —
 * this restores Cmd/Ctrl+Z (and Cmd+Shift+Z / Ctrl+Y for redo). Ported from
 * `playground/src/undo.js`. Consecutive same-kind keystrokes within `mergeDelay`
 * coalesce into one history entry so undo steps by edit, not by character.
 */
export class TextareaUndo {
  private ta: HTMLTextAreaElement;
  private max: number;
  private mergeDelay: number;
  private onChange: (() => void) | null;
  private stack: UndoState[];
  private index: number;
  private _applying = false;
  private _inTransaction = 0;
  private _suppress = false;
  private _lastInputType: string | null = null;
  private _lastPushAt = 0;
  private _lastKind: string | null = null;
  private _composing = false;
  private _forceNew = false;

  constructor(ta: HTMLTextAreaElement, { max = 200, mergeDelay = 600, onChange = null }: UndoOpts = {}) {
    this.ta = ta;
    this.max = max;
    this.mergeDelay = mergeDelay;
    this.onChange = onChange;
    this.stack = [this._read()];
    this.index = 0;

    ta.addEventListener('beforeinput', (e) => {
      this._lastInputType = (e as InputEvent).inputType || null;
    });
    ta.addEventListener('compositionstart', () => {
      this._composing = true;
    });
    ta.addEventListener('compositionend', () => {
      this._composing = false;
      this._forceNew = true;
    });
    ta.addEventListener('input', () => {
      if (this._applying || this._suppress || this._inTransaction || this._composing) return;
      this._record();
    });
    ta.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if (mod && !e.altKey && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.redo();
      }
    });
  }

  private _read(): UndoState {
    return { value: this.ta.value, start: this.ta.selectionStart ?? 0, end: this.ta.selectionEnd ?? 0 };
  }

  undo() {
    if (this.index > 0) {
      this.index--;
      this._apply(this.stack[this.index]);
    }
  }

  redo() {
    if (this.index < this.stack.length - 1) {
      this.index++;
      this._apply(this.stack[this.index]);
    }
  }

  transact(fn: () => void) {
    this._inTransaction++;
    try {
      fn();
    } finally {
      this._inTransaction--;
      if (this._inTransaction === 0) this._record(true);
    }
  }

  reset() {
    this.stack = [this._read()];
    this.index = 0;
    this._lastPushAt = 0;
    this._lastKind = null;
  }

  private _record(forceNew = false) {
    const next = this._read();
    const cur = this.stack[this.index];
    if (cur.value === next.value && cur.start === next.start && cur.end === next.end) return;

    const now = performance.now();
    const it = this._lastInputType;
    const kind = it?.startsWith('insert') ? 'insert' : it?.startsWith('delete') ? 'delete' : 'other';
    const forcedByType = it === 'insertFromPaste' || it === 'insertFromDrop' || it === 'deleteByCut';

    let merge = false;
    if (!forceNew && !this._forceNew && !forcedByType) {
      merge =
        now - this._lastPushAt <= this.mergeDelay &&
        kind === this._lastKind &&
        cur.start === cur.end &&
        next.start === next.end &&
        (kind === 'insert' || kind === 'delete');
    }
    this._forceNew = false;

    if (merge) {
      this.stack[this.index] = next;
    } else {
      this.stack.splice(this.index + 1);
      this.stack.push(next);
      this.index++;
      if (this.stack.length > this.max) {
        const overflow = this.stack.length - this.max;
        this.stack.splice(0, overflow);
        this.index = Math.max(0, this.index - overflow);
      }
    }
    this._lastPushAt = now;
    this._lastKind = kind;
  }

  private _apply(state: UndoState) {
    this._applying = true;
    this.ta.value = state.value;
    this.ta.setSelectionRange(state.start, state.end);
    if (this.onChange) {
      this.onChange();
    } else {
      this._suppress = true;
      this.ta.dispatchEvent(new Event('input', { bubbles: true }));
      this._suppress = false;
    }
    this._applying = false;
  }
}
