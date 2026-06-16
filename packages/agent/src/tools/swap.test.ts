import { toIouValue } from '@agentic-mpp-demo-xrpl/shared'
import { describe, expect, it } from 'vitest'
import { ammQuoteDrops, computeMaxXrpDrops } from './swap'

describe('computeMaxXrpDrops', () => {
  it('multiplies need by drops-per-unit and applies slippage', () => {
    // 10 units at 1_000_000 drops/unit = 10 XRP, +10% slippage = 11 XRP.
    expect(computeMaxXrpDrops('10', 1_000_000, 1000)).toBe(11_000_000n)
  })

  it('rounds up to whole drops', () => {
    expect(computeMaxXrpDrops('1', 1_709_387, 0)).toBe(1_709_387n)
    expect(computeMaxXrpDrops('1', 1.5, 0)).toBe(2n)
  })

  it('rejects a non-positive or invalid quote', () => {
    expect(() => computeMaxXrpDrops('10', 0, 100)).toThrow()
    expect(() => computeMaxXrpDrops('10', Number.NaN, 100)).toThrow()
  })
})

describe('toIouValue (15-significant-digit clamp)', () => {
  it('trims a float subtraction below XRPL precision limit', () => {
    // 11 - 9.7963116174 in float = 1.2036883825999993 (17 sig digits) → rejected on-ledger.
    const v = toIouValue(11 - 9.7963116174)
    expect(v).toBe('1.2036883826')
    expect(v.replace(/[-.]/g, '').replace(/^0+/, '').length).toBeLessThanOrEqual(15)
  })

  it('passes clean values through and handles zero', () => {
    expect(toIouValue(10)).toBe('10')
    expect(toIouValue('0.5')).toBe('0.5')
    expect(toIouValue(0)).toBe('0')
  })

  it('rejects invalid input', () => {
    expect(() => toIouValue(Number.NaN)).toThrow()
    expect(() => toIouValue(-1)).toThrow()
  })
})

describe('ammQuoteDrops (constant-product pricing)', () => {
  // Pool: 1,000,000 XRP and 1,000,000 IOU, 0.5% fee.
  const X = 1_000_000_000_000 // drops
  const Y = 1_000_000

  it('prices a swap above the fee-free spot and applies slippage', () => {
    const feeFree = ammQuoteDrops(X, Y, 10, 0, 0)
    const withFee = ammQuoteDrops(X, Y, 10, 500, 0)
    const withSlip = ammQuoteDrops(X, Y, 10, 500, 100)
    expect(withFee).toBeGreaterThan(feeFree) // fee raises the input
    expect(withSlip).toBeGreaterThan(withFee) // slippage raises it further
    // ~10 XRP for 10 IOU on a balanced pool, within a sane band.
    expect(Number(withSlip)).toBeGreaterThan(10_000_000)
    expect(Number(withSlip)).toBeLessThan(11_000_000)
  })

  it('rejects an empty pool or draining the reserve', () => {
    expect(() => ammQuoteDrops(0, Y, 10, 0, 0)).toThrow()
    expect(() => ammQuoteDrops(X, Y, Y, 0, 0)).toThrow() // needValue >= reserve
  })
})
