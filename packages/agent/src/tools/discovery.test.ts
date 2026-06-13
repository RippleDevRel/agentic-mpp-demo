import { describe, expect, it } from 'vitest'
import { type CatalogResponse, filterAcquirable } from './discovery'

const items: CatalogResponse['items'] = [
  { issuanceId: 'A', price: '10', currency: 'RLUSD', remainingUnits: 3, endpoint: '/rwa/A' },
  { issuanceId: 'B', price: '5', currency: 'RLUSD', remainingUnits: 0, endpoint: '/rwa/B' },
  { issuanceId: 'C', price: '7', currency: 'RLUSD', remainingUnits: 2, endpoint: '/rwa/C' },
]

describe('filterAcquirable', () => {
  it('drops sold-out and already-acquired issuances, resolves absolute URLs', () => {
    const out = filterAcquirable(items, new Set(['C']), 'http://localhost:8787')
    expect(out.map((o) => o.issuanceId)).toEqual(['A'])
    expect(out[0]?.url).toBe('http://localhost:8787/rwa/A')
  })

  it('returns everything in stock when nothing acquired yet', () => {
    const out = filterAcquirable(items, new Set(), 'http://localhost:8787')
    expect(out.map((o) => o.issuanceId)).toEqual(['A', 'C'])
  })

  it('dedupes so an issuance is acted on once', () => {
    const out = filterAcquirable(items, new Set(['A', 'C']), 'http://localhost:8787')
    expect(out).toHaveLength(0)
  })
})
