/**
 * Sanity-check that the existing XRP/RLUSD testnet route (AMM/order book) is
 * reachable and returns a usable quote, so a run fails fast if testnet liquidity
 * is ever unavailable. No liquidity seeding is needed — the pool already exists.
 *
 * Usage: NETWORK=testnet tsx scripts/check-testnet.ts
 */
import { RLUSD_TESTNET } from '@agentic-mpp-demo-xrpl/shared'
import { Client } from 'xrpl'

async function main(): Promise<void> {
  const rpc = process.env.XRPL_RPC_URL ?? 'wss://s.altnet.rippletest.net:51233'
  const client = new Client(rpc)
  await client.connect()
  try {
    const book = await client.request({
      command: 'book_offers',
      taker_gets: { currency: RLUSD_TESTNET.currency, issuer: RLUSD_TESTNET.issuer },
      taker_pays: { currency: 'XRP' },
      ledger_index: 'validated',
      limit: 5,
    })
    const offers = book.result.offers ?? []
    if (offers.length === 0) {
      console.error('✖ No XRP->RLUSD route on testnet (empty book / no AMM). Swap leg will fail.')
      process.exit(1)
    }
    const best = offers[0] as { quality?: string }
    const dropsPerRlusd = Number(best.quality ?? '0')
    console.log(
      `✅ XRP/RLUSD route reachable: ${offers.length} offer(s), best ~${(dropsPerRlusd / 1e6).toFixed(6)} XRP/RLUSD`,
    )
  } finally {
    await client.disconnect()
  }
}

main().catch((err) => {
  console.error(`check-testnet failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
