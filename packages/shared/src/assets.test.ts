import { describe, expect, it } from 'vitest'
import { currencyLabel } from './assets'

describe('currencyLabel', () => {
  it('decodes a 40-char hex currency to its ASCII ticker', () => {
    // RLUSD's 40-char hex code.
    expect(currencyLabel('524C555344000000000000000000000000000000')).toBe('RLUSD')
  })

  it('passes through a standard 3-char code unchanged', () => {
    expect(currencyLabel('USD')).toBe('USD')
  })

  it('keeps the raw hex when it does not decode to printable ASCII', () => {
    const nonAscii = '01020300000000000000000000000000000000FF'
    expect(currencyLabel(nonAscii)).toBe(nonAscii)
  })
})
