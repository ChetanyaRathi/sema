import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../src/lib/sema-code-editor.js'
import type { SemaCodeEditor } from '../src/lib/sema-code-editor.js'

async function mount(attrs = ''): Promise<SemaCodeEditor> {
  document.body.innerHTML = `<sema-code-editor ${attrs}></sema-code-editor>`
  const el = document.body.querySelector('sema-code-editor') as SemaCodeEditor
  await el.updateComplete
  return el
}
const ta = (el: SemaCodeEditor) => el.shadowRoot!.querySelector('textarea') as HTMLTextAreaElement
const hl = (el: SemaCodeEditor) => el.shadowRoot!.querySelector('.hl') as HTMLElement

describe('sema-code-editor', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('renders the value into the textarea and highlights it in the overlay', async () => {
    const el = await mount()
    el.value = '(define x 1)'
    await el.updateComplete
    expect(ta(el).value).toBe('(define x 1)')
    expect(hl(el).innerHTML).toContain('tok-keyword')
  })

  it('emits input with the new value on typing', async () => {
    const el = await mount()
    const spy = vi.fn()
    el.addEventListener('input', (e) => spy((e as CustomEvent).detail.value))
    ta(el).value = '42'
    ta(el).dispatchEvent(new InputEvent('input', { bubbles: true }))
    expect(spy).toHaveBeenCalledWith('42')
    expect(el.value).toBe('42')
  })

  it('Tab inserts tab-size spaces instead of moving focus', async () => {
    const el = await mount('tab-size="2"')
    const t = ta(el)
    t.focus()
    t.selectionStart = t.selectionEnd = 0
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(t.value.startsWith('  ')).toBe(true)
    expect(el.value.startsWith('  ')).toBe(true)
  })

  it('forwards the testid onto the inner textarea (for e2e .fill through shadow DOM)', async () => {
    const el = await mount('testid="cell-textarea"')
    expect(ta(el).getAttribute('data-testid')).toBe('cell-textarea')
  })

  it('lets native keydown reach the host (composed) so hosts can bind Shift+Enter', async () => {
    const el = await mount()
    const spy = vi.fn()
    el.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).shiftKey) spy()
    })
    ta(el).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, composed: true }),
    )
    expect(spy).toHaveBeenCalled()
  })
})
