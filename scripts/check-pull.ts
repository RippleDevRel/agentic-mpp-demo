/**
 * End-to-end MPP charge PULL-mode check (XRP pricing).
 *
 * Complements `pnpm demo` (which exercises PUSH mode): boot the merchant, then
 * buy one freshly-issued RWA MPT where the agent OWS-signs the Payment into a
 * blob but does NOT broadcast it — it hands the blob to the merchant via an mppx
 * credential (`type: 'transaction'`), and the merchant submits it on-chain before
 * delivering. The private key never leaves OWS.
 *
 * Pull needs a signer that can return an unbroadcast-but-submittable blob (it sets
 * the recovered `SigningPubKey` as a VALUE), so this runs the OWS recovery signer
 * (`signerKind: 'channel'`) — the same one channel mode uses. Note: that path
 * signs via `signHash`, so — like channel vouchers — the pull Payment is NOT seen
 * by the per-tx executable spend policy (push, via `signAndSend`, is).
 *
 * Uses the ambient OWS wallet / vault from `.env` (like `pnpm check:channel`);
 * only the merchant-side + XRP-pricing knobs are defaulted here.
 *
 * Run: pnpm check:pull
 */
import { colorLegend, listMptHoldings, withClient } from '@agentic-mpp-demo-xrpl/shared'
import { buildAgentContext } from '../packages/agent/src/context'
import { OwsXrplSigner } from '../packages/agent/src/signer/ows-xrpl-signer'
import { ensureFunded } from '../packages/agent/src/tools/funding'
import { payViaMpp } from '../packages/agent/src/tools/mpp'
import { optInToMpt } from '../packages/agent/src/tools/trustline'
import { startServer } from '../packages/merchant/src/server'

// Node's env-file loader never overrides an already-set var, so these are
// defaults `.env` can still override for everything except what we force here.
function setDefault(key: string, value: string): void {
  if (!process.env[key]) process.env[key] = value
}

interface CatalogItem {
  issuanceId: string
  endpoint: string
  remainingUnits: number
}

async function main(): Promise<void> {
  setDefault('NETWORK', 'testnet')
  // Pull check runs XRP-only: a straight Payment blob, no swap/trustline leg.
  process.env.PAYMENT_CURRENCY = 'XRP'
  setDefault('MPP_SECRET_KEY', 'demo-mpp-secret-key-for-local-testnet-only-0123456789')
  setDefault('RWA_PRICE', '10')
  setDefault('RWA_AVAILABLE_UNITS', '1')
  setDefault('ISSUANCE_INTERVAL_MS', '0')
  // A separate port so this can run alongside a `pnpm demo` merchant.
  process.env.MERCHANT_PORT = '8788'
  setDefault('MAX_SPEND', '50')

  console.log(colorLegend())
  console.log('=== booting merchant (XRP charge) ===')
  const merchant = await startServer()
  // The agent gets only the seller endpoint; it learns the recipient from the 402.
  process.env.MERCHANT_URL = merchant.url

  try {
    // Pull mode needs the OWS recovery signer (native OWS can't hand back a blob).
    const { deps } = await buildAgentContext({ signerKind: 'channel' })
    const { signer, network, merchantUrl, log } = deps
    if (!(signer instanceof OwsXrplSigner)) {
      throw new Error('pull check requires the OWS recovery signer (signerKind: "channel")')
    }

    // Base reserve + one owner object (the MPT opt-in) + the XRP price + fees.
    await ensureFunded(signer.address(), network, { ownerObjects: 2, swapBudgetXrp: '50' }, log)

    // Wait for the merchant to publish its first issuance, then take the first one.
    let item: CatalogItem | undefined
    for (let i = 0; i < 20 && !item; i++) {
      const catalog = (await (await fetch(`${merchantUrl}/catalog`)).json()) as {
        items?: CatalogItem[]
      }
      item = (catalog.items ?? []).find((c) => c.remainingUnits > 0)
      if (!item) await new Promise((r) => setTimeout(r, 1500))
    }
    if (!item) throw new Error('merchant published no issuance to buy')
    const url = `${merchantUrl}${item.endpoint}`
    log.mpp('buying via PULL mode', { issuanceId: item.issuanceId, url })

    // Holder opt-in must precede payment so the issuer can authorize this holder.
    await optInToMpt(signer, network, item.issuanceId, log)

    // PULL: OWS-sign the Payment into a blob, hand it to the merchant to submit.
    const outcome = await payViaMpp(signer, network, url, log, 'pull')
    log.mpp('merchant submitted the pull-mode Payment', { paymentHash: outcome.paymentHash })

    // Confirm the RWA MPT actually landed in the agent wallet.
    let balance = '0'
    for (let i = 0; i < 20 && balance === '0'; i++) {
      const holdings = await withClient(network.rpcUrl, (c) => listMptHoldings(c, signer.address()))
      balance = holdings.find((h) => h.issuanceId === item?.issuanceId)?.amount ?? '0'
      if (balance === '0') await new Promise((r) => setTimeout(r, 3000))
    }
    if (balance === '0') throw new Error(`MPT ${item.issuanceId} not received within timeout`)

    log.info('RWA MPT received via pull mode', { issuanceId: item.issuanceId, amount: balance })
    console.log(
      '✅ PULL_DEMO_OK — RWA MPT acquired in pull mode (agent signed, merchant submitted), key never left OWS',
    )
  } finally {
    await merchant.close()
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`pull check failed: ${err instanceof Error ? err.stack : String(err)}`)
    process.exit(1)
  })
