/* Sema Notebook — Alpine.js Component */
document.addEventListener('alpine:init', () => {
  Alpine.data('notebook', () => ({
    // ── State ──
    cells: [],
    title: 'Untitled',
    focusedCellId: null,
    canUndo: false,
    shiftEnterUsed: localStorage.getItem('sema-nb-shift-enter-used') === 'true',
    openDropdownId: null,
    saveFeedback: false,

    // ── Lifecycle ──
    init() {
      this.load();
      // Close dropdowns on outside click
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.add-cell-btn') && !e.target.closest('.add-cell-dropdown')) {
          this.openDropdownId = null;
        }
      });
    },

    // ── API helper ──
    async api(method, path, body) {
      const opts = { method, headers: { 'Content-Type': 'application/json' } };
      if (body !== undefined) opts.body = JSON.stringify(body);
      const res = await fetch(path, opts);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || res.statusText);
      }
      return res.json();
    },

    // ── Data loading ──
    async load() {
      try {
        const data = await this.api('GET', '/api/notebook');
        this.title = data.title || 'Untitled';
        this.canUndo = !!data.can_undo;
        // Markdown edit/render state now lives inside <sema-editable-markdown>.
        this.cells = data.cells || [];
      } catch (e) {
        console.error('Failed to load notebook:', e);
      }
    },

    // ── Cell evaluation ──
    async evalCell(id) {
      const cell = this.cells.find(c => c.id === id);
      if (!cell) return;
      // Sync source to server
      try { await this.api('POST', '/api/cells/' + id, { source: cell.source }); } catch (e) { /* ignore */ }
      cell._loading = true;
      try {
        await this.api('POST', '/api/cells/' + id + '/eval');
        const idx = this.cells.findIndex(c => c.id === id);
        if (idx < this.cells.length - 1) this.focusedCellId = this.cells[idx + 1].id;
        this.shiftEnterUsed = true;
        localStorage.setItem('sema-nb-shift-enter-used', 'true');
        await this.load();
      } catch (e) {
        cell._loading = false;
        console.error('Eval failed:', e);
      }
    },

    async evalCellStay(id) {
      const cell = this.cells.find(c => c.id === id);
      if (!cell) return;
      try { await this.api('POST', '/api/cells/' + id, { source: cell.source }); } catch (e) { /* ignore */ }
      cell._loading = true;
      try {
        await this.api('POST', '/api/cells/' + id + '/eval');
        this.focusedCellId = id;
        await this.load();
      } catch (e) {
        cell._loading = false;
        console.error('Eval failed:', e);
      }
    },

    async evalAll() {
      const sources = this.cells
        .filter(c => c.cell_type === 'code')
        .map(c => [c.id, c.source]);
      try {
        await this.api('POST', '/api/eval-all', { sources });
        await this.load();
      } catch (e) {
        console.error('Eval all failed:', e);
      }
    },

    // ── Cell management ──
    async addCell(type, afterId) {
      try {
        const body = { type, source: '' };
        if (afterId) body.after = afterId;
        const data = await this.api('POST', '/api/cells', body);
        await this.load();
        this.focusedCellId = data.id;
        this.$nextTick(() => {
          // The editable control lives in the component's shadow root; the host
          // element's focus() delegates into it.
          const el = document.querySelector(
            '#cell-' + data.id + ' sema-code-editor, #cell-' + data.id + ' sema-editable-markdown'
          );
          if (el) el.focus();
        });
      } catch (e) {
        console.error('Failed to create cell:', e);
      }
    },

    async insertCell(type, afterId) {
      this.openDropdownId = null;
      const body = { type, source: '' };
      if (afterId && afterId !== 'top') body.after = afterId;
      try {
        const data = await this.api('POST', '/api/cells', body);
        await this.load();
        this.focusedCellId = data.id;
        this.$nextTick(() => {
          // The editable control lives in the component's shadow root; the host
          // element's focus() delegates into it.
          const el = document.querySelector(
            '#cell-' + data.id + ' sema-code-editor, #cell-' + data.id + ' sema-editable-markdown'
          );
          if (el) el.focus();
        });
      } catch (e) {
        console.error('Failed to insert cell:', e);
      }
    },

    async deleteCell(id) {
      try {
        await this.api('DELETE', '/api/cells/' + id);
        if (this.focusedCellId === id) this.focusedCellId = null;
        await this.load();
      } catch (e) {
        console.error('Delete failed:', e);
      }
    },

    async moveCell(id, dir) {
      const idx = this.cells.findIndex(c => c.id === id);
      const newIdx = idx + dir;
      if (newIdx < 0 || newIdx >= this.cells.length) return;
      const ids = this.cells.map(c => c.id);
      [ids[idx], ids[newIdx]] = [ids[newIdx], ids[idx]];
      try {
        await this.api('POST', '/api/cells/reorder', { cell_ids: ids });
        await this.load();
      } catch (e) {
        console.error('Move failed:', e);
      }
    },

    // ── Save / Undo / Reset ──
    async save() {
      try {
        // Flush every cell's current source to the server first. Edits that were
        // never evaluated (markdown, un-run code) live only in the browser, and
        // the server serializes its own copy — so without this, save writes
        // stale content and the edits appear lost.
        await Promise.all([this.persistTitle(), ...this.cells.map(c => this.persistSource(c))]);
        await this.api('POST', '/api/save');
        this.saveFeedback = true;
        setTimeout(() => { this.saveFeedback = false; }, 600);
      } catch (e) {
        alert('Save failed: ' + e.message);
      }
    },

    async undo() {
      try {
        const data = await this.api('POST', '/api/undo');
        this.canUndo = !!data.can_undo;
        await this.load();
      } catch (e) {
        console.error('Undo failed:', e);
      }
    },

    async reset() {
      if (!confirm('Reset the environment? All cell outputs will be cleared.')) return;
      try {
        await this.api('POST', '/api/reset');
        this.canUndo = false;
        await this.load();
      } catch (e) {
        console.error('Reset failed:', e);
      }
    },

    // ── Editing / persistence ──
    // Push a cell's current source to the server. Source edits otherwise reach
    // the server only when a code cell is evaluated, so markdown edits and
    // un-run code edits would be dropped on save/reload.
    persistSource(cell) {
      return this.api('POST', '/api/cells/' + cell.id, { source: cell.source }).catch(() => {});
    },

    // Push the notebook title to the server. Like cell source, the title is
    // client-only state (x-model) until synced, so without this a renamed
    // notebook would save under its old title.
    persistTitle() {
      return this.api('POST', '/api/title', { title: this.title }).catch(() => {});
    },

    // ── Markdown ──
    // Edit-in-place (rendered <-> source, click/blur/Shift+Enter) is owned by
    // <sema-editable-markdown>. It emits `change` with the committed source when
    // the user renders; we mirror that into the cell and persist it.
    onMarkdownChange(cell, e) {
      cell.source = e.detail.value;
      this.persistSource(cell);
    },

    // ── Keyboard / Input ──
    // Shift+Enter in a code cell evaluates it. (Markdown cells handle their own
    // Shift+Enter internally, rendering the source.)
    handleShiftEnter(cell) {
      this.evalCell(cell.id);
    },

    formatMeta(output) {
      const parts = [];
      if (output.meta) {
        if (output.meta.duration_ms != null) parts.push(output.meta.duration_ms + 'ms');
        if (output.meta.cost_usd != null) parts.push('$' + output.meta.cost_usd.toFixed(4));
      }
      return parts.join(' \u00b7 ');
    },

    toggleOutput(header) {
      const chevron = header.querySelector('.output-chevron');
      const content = header.nextElementSibling;
      if (chevron) chevron.classList.toggle('collapsed');
      if (content) content.classList.toggle('collapsed');
    },
  }));
});
