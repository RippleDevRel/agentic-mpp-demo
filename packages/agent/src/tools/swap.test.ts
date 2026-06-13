import { describe, expect, it } from 'vitest'
import { computeMaxXrpDrops } from './swap'

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
