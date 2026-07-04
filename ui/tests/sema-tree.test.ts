import { beforeEach, describe, expect, it } from 'vitest'
import '../src/lib/sema-tree.js'

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('SemaTreeItem', () => {
  it('renders with label', async () => {
    document.body.innerHTML = '<sema-tree-item label="hello.sema"></sema-tree-item>'
    const el = document.querySelector('sema-tree-item')!
    expect(el.label).toBe('hello.sema')
  })

  it('renders chevron when has-children', async () => {
    document.body.innerHTML = '<sema-tree-item label="folder" has-children></sema-tree-item>'
    const el = document.querySelector('sema-tree-item')!
    await el.updateComplete
    const chevron = el.shadowRoot!.querySelector('.chevron') as HTMLElement
    expect(chevron).toBeTruthy()
    expect(chevron.style.visibility).not.toBe('hidden')
  })

  it('hides chevron when not has-children', async () => {
    document.body.innerHTML = '<sema-tree-item label="file.sema"></sema-tree-item>'
    const el = document.querySelector('sema-tree-item')!
    await el.updateComplete
    const chevron = el.shadowRoot!.querySelector('.chevron') as HTMLElement
    expect(chevron).toBeTruthy()
  })

  it('reflects selected attribute', async () => {
    document.body.innerHTML = '<sema-tree-item label="x" selected></sema-tree-item>'
    const el = document.querySelector('sema-tree-item')!
    expect(el.selected).toBe(true)
    expect(el.hasAttribute('selected')).toBe(true)
  })

  it('expands/collapses children on click', async () => {
    document.body.innerHTML = `
      <sema-tree-item label="folder" has-children>
        <sema-tree-item label="child.sema"></sema-tree-item>
      </sema-tree-item>`
    const parent = document.querySelector('sema-tree-item[label="folder"]')!
    await parent.updateComplete

    const row = parent.shadowRoot!.querySelector('.row') as HTMLElement
    row.click()
    await parent.updateComplete
    expect(parent.expanded).toBe(true)

    row.click()
    await parent.updateComplete
    expect(parent.expanded).toBe(false)
  })

  it('has role treeitem', async () => {
    document.body.innerHTML = '<sema-tree-item label="test"></sema-tree-item>'
    const el = document.querySelector('sema-tree-item')!
    await el.updateComplete
    const row = el.shadowRoot!.querySelector('.row')!
    expect(row.getAttribute('role')).toBe('treeitem')
  })

  it('calculates depth from nesting', async () => {
    document.body.innerHTML = `
      <sema-tree>
        <sema-tree-item id="root" label="root">
          <sema-tree-item id="child" label="child">
            <sema-tree-item id="grandchild" label="grandchild"></sema-tree-item>
          </sema-tree-item>
        </sema-tree-item>
      </sema-tree>`
    const root = document.querySelector('#root') as any
    const child = document.querySelector('#child') as any
    const grandchild = document.querySelector('#grandchild') as any
    await root.updateComplete
    await child.updateComplete
    await grandchild.updateComplete
    expect(root.depth).toBe(0)
    expect(child.depth).toBe(1)
    expect(grandchild.depth).toBe(2)
  })

  it('dispatches sema-tree-select event on click', async () => {
    document.body.innerHTML = '<sema-tree-item id="x" label="test.sema"></sema-tree-item>'
    const el = document.querySelector('#x')!
    await el.updateComplete

    let selected = false
    el.addEventListener('sema-tree-select', (e: any) => {
      selected = true
      expect(e.detail.label).toBe('test.sema')
    })

    const row = el.shadowRoot!.querySelector('.row') as HTMLElement
    row.click()
    expect(selected).toBe(true)
  })

  it('reflects depth and renders top-level parents as uppercase section headers', async () => {
    document.body.innerHTML = `
      <sema-tree>
        <sema-tree-item label="Getting Started" has-children>
          <sema-tree-item label="hello.sema"></sema-tree-item>
        </sema-tree-item>
      </sema-tree>`
    const [top, leaf] = document.querySelectorAll('sema-tree-item')
    await top.updateComplete
    await leaf.updateComplete
    expect(top.getAttribute('depth')).toBe('0')
    expect(leaf.getAttribute('depth')).toBe('1')
    const row = (el: Element) => el.shadowRoot!.querySelector('.row') as HTMLElement
    expect(getComputedStyle(row(top)).textTransform).toBe('uppercase')
    expect(getComputedStyle(row(leaf)).textTransform).toBe('none')
    // The category header keeps the mono family — it must NOT inherit the
    // consumer's ambient font (regression: a serif page body, e.g. sema-page's
    // Cormorant, made top-level folders render in serif).
    const topFont = getComputedStyle(row(top)).fontFamily
    expect(topFont.toLowerCase()).toContain('mono')
    expect(topFont).toBe(getComputedStyle(row(leaf)).fontFamily)
    // parts exposed for consumer styling
    expect(top.shadowRoot!.querySelector('[part="label"]')).toBeTruthy()
  })
})
