import { RLUSD_TESTNET } from '@rwa/shared'
import { describe, expect, it } from 'vitest'
import { Client } from 'xrpl'

// Network integration smoke, opt-in via RUN_INTEGRATION=1 (skipped in normal CI).
// The full end-to-end pipeline is exercised by `pnpm demo:testnet`.
const enabled = process.env.RUN_INTEGRATION === '1'

describe.skipIf(!enabled)('testnet integration', () => {
  it('the XRP/RLUSD swap route the agent depends on is reachable', async () => {
    const client = new Client('wss://s.altnet.rippletest.net:51233')
    await client.connect()
    try {
      const book = await client.request({
        command: 'book_offers',
        taker_gets: { currency: RLUSD_TESTNET.currency, issuer: RLUSD_TESTNET.issuer },
        taker_pays: { currency: 'XRP' },
        ledger_index: 'validated',
        limit: 5,
      })
      expect((book.result.offers ?? []).length).toBeGreaterThan(0)
    } finally {
      await client.disconnect()
    }
  }, 30_000)
})
