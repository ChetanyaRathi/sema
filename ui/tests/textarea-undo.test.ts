import { beforeEach, describe, expect, it } from 'vitest'
import { TextareaUndo } from '../src/internal/textarea-undo.js'

function type(ta: HTMLTextAreaElement, value: string, inputType = 'insertText') {
  ta.value = value
  ta.selectionStart = ta.selectionEnd = value.length
  ta.dispatchEvent(new InputEvent('beforeinput', { inputType, bubbles: true }))
  ta.dispatchEvent(new InputEvent('input', { inputType, bubbles: true }))
}

describe('TextareaUndo', () => {
  let ta: HTMLTextAreaElement
  beforeEach(() => {
    document.body.innerHTML = '<textarea></textarea>'
    ta = document.body.querySelector('textarea')!
  })

  it('undo restores the previous committed value; redo re-applies it', () => {
    const undo = new TextareaUndo(ta, { mergeDelay: 0 })
    type(ta, 'a')
    type(ta, 'ab', 'deleteContentBackward') // distinct kind → forces a new entry
    undo.undo()
    expect(ta.value).toBe('a')
    undo.redo()
    expect(ta.value).toBe('ab')
  })

  it('reset drops history to the current value', () => {
    const undo = new TextareaUndo(ta, { mergeDelay: 0 })
    type(ta, 'x')
    undo.reset()
    undo.undo()
    expect(ta.value).toBe('x')
  })

  it('coalesces consecutive inserts within mergeDelay into one undo step', () => {
    const undo = new TextareaUndo(ta, { mergeDelay: 10_000 })
    type(ta, 'a')
    type(ta, 'ab')
    type(ta, 'abc')
    undo.undo()
    expect(ta.value).toBe('') // all three merged back to the initial state
  })
})
