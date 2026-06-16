import { BASE_RESERVE_DROPS, OWNER_RESERVE_DROPS } from '@agentic-mpp-demo-xrpl/shared'
import { describe, expect, it } from 'vitest'
import { sizeFundingDrops } from './funding'

describe('sizeFundingDrops', () => {
  it('sums base reserve + owner reserves + swap budget + fee buffer', () => {
    const drops = sizeFundingDrops({ ownerObjects: 2, swapBudgetXrp: '12' })
    const expected =
      BigInt(BASE_RESERVE_DROPS) + // base reserve
      BigInt(OWNER_RESERVE_DROPS) * 2n + // two owner objects
      12_000_000n + // 12 XRP swap budget
      2_000_000n // fee buffer
    expect(drops).toBe(expected)
  })

  it('scales with the number of owner objects', () => {
    const one = sizeFundingDrops({ ownerObjects: 1, swapBudgetXrp: '0' })
    const three = sizeFundingDrops({ ownerObjects: 3, swapBudgetXrp: '0' })
    expect(three - one).toBe(BigInt(OWNER_RESERVE_DROPS) * 2n)
  })
})
