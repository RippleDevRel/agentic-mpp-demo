/**
 * Manual Phase 1 verification (NOT the autonomous agent): a buyer opts into the
 * MPT, pays the 402 via the SDK client charge, and we assert the RWA MPT lands.
 * The buyer uses a seed-backed SDK Wallet for simplicity — the autonomous agent
 * (Phase 2/3) keeps its key in OWS instead.
 *
 * Usage: tsx packages/merchant/src/manual-buy.ts [serverUrl]
 */
import { loadEnv, resolveNetwork, sdkNet } from '@rwa/shared'
import { Mppx } from 'mppx/client'
import { Wallet } from 'xrpl-mpp-sdk'
import { charge } from 'xrpl-mpp-sdk/client'

async function main(): Promise<void> {
  loadEnv()
  const network = resolveNetwork()
  const net = sdkNet(network)
  const serverUrl = process.argv[2] ?? `http://localhost:${process.env.MERCHANT_PORT ?? 8787}`

  const catalog = (await (await fetch(`${serverUrl}/catalog`)).json()) as {
    items: Array<{ issuanceId: string; price: string; currency: string; remainingUnits: number }>
  }
  const offer = catalog.items[0]
  if (!offer) throw new Error('Catalog is empty — merchant has nothing to sell')
  console.log(
    `offer: issuance ${offer.issuanceId} @ ${offer.price} ${offer.currency} (${offer.remainingUnits} units)`,
  )

  console.log('funding buyer from faucet...')
  const buyer = await Wallet.fromFaucet({ network: net.network, rpcUrl: net.rpcUrl })
  console.log(`buyer: ${buyer.address}`)

  const mpt = { mpt_issuance_id: offer.issuanceId }
  console.log('buyer opts into the permissioned MPT (holder-side)...')
  const accept = await buyer.acceptToken(mpt, net)
  console.log(`opt-in: ${accept.status}`)

  // Install the mppx client middleware so fetch() pays the 402 automatically.
  Mppx.create({
    methods: [charge({ wallet: buyer, mode: 'pull', network: net.network, rpcUrl: net.rpcUrl })],
  })

  console.log(`paying GET ${serverUrl}/rwa/${offer.issuanceId} ...`)
  const res = await fetch(`${serverUrl}/rwa/${offer.issuanceId}`)
  const body = await res.json()
  console.log(`response ${res.status}:`, JSON.stringify(body, null, 2))
  if (!res.ok) throw new Error(`purchase failed: ${res.status}`)

  console.log('polling buyer MPT holdings for delivery...')
  for (let i = 0; i < 20; i++) {
    const holding = await buyer.holdsToken(mpt, net)
    const balance =
      holding && 'balance' in holding ? (holding as { balance?: string }).balance : undefined
    if (balance && balance !== '0') {
      console.log(`\n✅ RWA MPT received: ${balance} base units of ${offer.issuanceId}`)
      process.exit(0)
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
  throw new Error('Timed out waiting for MPT delivery')
}

main().catch((err) => {
  console.error(`manual-buy failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
