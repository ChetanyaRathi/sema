import { describe, expect, it } from 'vitest'
import { preloadLanguage, highlightToHtmlSync } from '../src/internal/syntax-highlight.js'

describe('highlightToHtmlSync', () => {
  it('escapes and returns plain text before warmup (no throw)', () => {
    const out = highlightToHtmlSync('<x> & "y"', 'sema')
    expect(out).not.toContain('<x>')
    expect(out).toContain('&lt;x&gt;')
  })

  it('highlights sema synchronously once the grammar is preloaded', async () => {
    await preloadLanguage('sema')
    const out = highlightToHtmlSync('(define x 1)', 'sema')
    expect(out).toContain('tok-')
    expect(out).toContain('define')
    // same shared tokenizer as the async path — the keyword is classed
    expect(out).toMatch(/<span class="tok-\w+">define<\/span>/)
  })

  it('supports non-sema languages too (json), unlike the old sema-only tokenizer', async () => {
    await preloadLanguage('json')
    const out = highlightToHtmlSync('{"a": 1}', 'json')
    expect(out).toContain('tok-')
  })
})
