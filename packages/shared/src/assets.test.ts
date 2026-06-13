import { describe, expect, it } from 'vitest'
import { toCurrencyHex } from './assets'

describe('toCurrencyHex', () => {
  it('keeps standard 3-char codes as-is', () => {
    expect(toCurrencyHex('USD')).toBe('USD')
    expect(toCurrencyHex('XRP')).toBe('XRP')
  })

  it('encodes >3-char codes to 40-char uppercase hex, right-padded', () => {
    const hex = toCurrencyHex('RLUSD')
    expect(hex).toHaveLength(40)
    expect(hex).toBe('524C555344000000000000000000000000000000')
  })

  it('passes through an already-40-char hex code (uppercased)', () => {
    const code = '524c555344000000000000000000000000000000'
    expect(toCurrencyHex(code)).toBe(code.toUpperCase())
  })
})
