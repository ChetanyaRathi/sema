import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../src/lib/sema-editable-markdown.js'
import type { SemaEditableMarkdown } from '../src/lib/sema-editable-markdown.js'

async function mount(value = ''): Promise<SemaEditableMarkdown> {
  document.body.innerHTML = '<sema-editable-markdown></sema-editable-markdown>'
  const el = document.body.querySelector('sema-editable-markdown') as SemaEditableMarkdown
  el.value = value
  await el.updateComplete
  return el
}
const view = (el: SemaEditableMarkdown) => el.shadowRoot!.querySelector('sema-markdown')
const editor = (el: SemaEditableMarkdown) => el.shadowRoot!.querySelector('sema-code-editor')

describe('sema-editable-markdown', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('starts in rendered view when it has content', async () => {
    const el = await mount('# Hi')
    expect(view(el)).toBeTruthy()
    expect(editor(el)).toBeFalsy()
  })

  it('starts in edit mode when empty', async () => {
    const el = await mount('')
    expect(editor(el)).toBeTruthy()
  })

  it('click on the rendered view enters edit mode', async () => {
    const el = await mount('# Hi')
    ;(view(el) as HTMLElement).click()
    await el.updateComplete
    expect(editor(el)).toBeTruthy()
  })

  it('emits change with the source when committed (Shift+Enter) and returns to view', async () => {
    const el = await mount('')
    const spy = vi.fn()
    el.addEventListener('change', (e) => spy((e as CustomEvent).detail.value))
    const ed = editor(el) as HTMLElement
    ed.dispatchEvent(
      new CustomEvent('input', { detail: { value: '# New' }, bubbles: true, composed: true }),
    )
    ed.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, composed: true }),
    )
    await el.updateComplete
    expect(spy).toHaveBeenCalledWith('# New')
    expect(el.value).toBe('# New')
    expect(view(el)).toBeTruthy()
  })
})
