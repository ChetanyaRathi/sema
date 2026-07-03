import { beforeEach, describe, expect, it } from 'vitest'
import '../src/lib/sema-markdown.js'
import type { SemaMarkdown } from '../src/lib/sema-markdown.js'

/** Poll until `fn()` is truthy (markdown render + async Shiki fence pass). */
async function waitFor(fn: () => unknown, timeout = 4000): Promise<void> {
  const start = performance.now()
  while (performance.now() - start < timeout) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('waitFor timed out')
}

const content = (el: SemaMarkdown) => el.shadowRoot!.querySelector('[part="content"]') as HTMLElement

async function mount(value: string): Promise<SemaMarkdown> {
  document.body.innerHTML = '<sema-markdown></sema-markdown>'
  const el = document.body.querySelector('sema-markdown') as SemaMarkdown
  el.value = value
  await el.updateComplete
  // Wait on textContent (not innerHTML): Lit's `<!--?lit-->` marker makes innerHTML
  // non-empty on the first (pre-async-render) pass, but real content fills textContent.
  await waitFor(() => (content(el).textContent ?? '').trim().length > 0)
  return el
}

describe('sema-markdown', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('renders headings, emphasis, lists, and links', async () => {
    const el = await mount('# Title\n\n- **bold** item\n\n[x](https://a.b)')
    const h = content(el)
    expect(h.querySelector('h1')?.textContent).toBe('Title')
    expect(h.querySelector('li strong')?.textContent).toBe('bold')
    const a = h.querySelector('a') as HTMLAnchorElement
    expect(a.getAttribute('href')).toBe('https://a.b')
    expect(a.getAttribute('rel')).toContain('noopener')
  })

  it('strips <script> and inline event handlers (sanitization)', async () => {
    const el = await mount('text\n\n<img src=x onerror="alert(1)">\n\n<script>window.x=1</script>')
    const h = content(el).innerHTML
    expect(h).not.toContain('<script')
    expect(h).not.toContain('onerror')
  })

  it('renders fenced code as a highlighted block', async () => {
    const el = await mount('```sema\n(define x 1)\n```')
    await waitFor(() => content(el).querySelector('pre code'))
    expect(content(el).querySelector('pre code')).toBeTruthy()
  })
})
