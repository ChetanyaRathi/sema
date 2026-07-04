import { afterEach, describe, expect, it } from 'vitest'
import '../src/lib/sema-page.js'

afterEach(() => {
  // Unmount the page so it restores the body styles it took over.
  document.body.innerHTML = ''
})

describe('SemaPage', () => {
  it('applies the sans body font via a fallback', async () => {
    document.body.innerHTML = '<sema-page></sema-page>'
    const page = document.querySelector('sema-page')!
    await page.updateComplete
    // Body/prose is sans (Inter) — Cormorant is reserved for headings. The token
    // vars (--sans, …) live on the page's :host, which is a CHILD of <body>, so
    // body can't see them; body's font-family therefore needs a literal fallback.
    // Without it the property went invalid and resolved to the UA default serif
    // (Times) instead of Inter.
    const bodyFont = getComputedStyle(document.body).fontFamily.toLowerCase()
    expect(bodyFont).toContain('inter')
    expect(bodyFont).not.toContain('cormorant')
    expect(bodyFont).not.toContain('times')
  })
})
