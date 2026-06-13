import {
  type Logger,
  listMptHoldings,
  type NetworkConfig,
  type PaymentCurrency,
  type RunSummary,
  withClient,
} from '@rwa/shared'
import type { OwsXrplSigner } from './signer/ows-xrpl-signer'
import { type AgentStore, saveAgentStore } from './state'
import { type DiscoveredIssuance, discover } from './tools/discovery'
import { ensureFunded } from './tools/funding'
import { payViaMpp } from './tools/mpp'
import { ensurePaymentCurrency } from './tools/swap'
import { ensurePaymentTrustline, optInToMpt } from './tools/trustline'

export interface AcquireDeps {
  signer: OwsXrplSigner
  network: NetworkConfig
  payment: PaymentCurrency
  merchantUrl: string
  merchantAddress: string
  maxSpendXrp: number
  slippageBps: number
  log: Logger
  summary: RunSummary
}

export interface AcquireResult {
  issuanceId: string
  paymentHash: string
  mptBalance: string
}

/** discover -> opt-in -> trust -> swap -> pay -> receive, for one issuance. */
export async function acquireOne(
  deps: AcquireDeps,
  issuance: DiscoveredIssuance,
): Promise<AcquireResult> {
  const { signer, network, payment, log } = deps
  log.step('acquiring issuance', {
    issuanceId: issuance.issuanceId,
    price: issuance.price,
    currency: issuance.currency,
  })

  // Holder opt-in must precede payment so the issuer can authorize this holder.
  await optInToMpt(signer, network, issuance.issuanceId, log)
  // Trust + acquire the payment currency.
  await ensurePaymentTrustline(signer, network, payment, log)
  await ensurePaymentCurrency(
    signer,
    network,
    payment,
    { requiredValue: issuance.price, maxSpendXrp: deps.maxSpendXrp, slippageBps: deps.slippageBps },
    log,
  )

  // Pay through MPP (push mode, OWS-signed) and take delivery.
  const outcome = await payViaMpp(signer, network, issuance.url, log)

  const balance = await confirmDelivery(deps, issuance.issuanceId)
  deps.summary.add(
    `Acquired ${issuance.issuanceId}`,
    `${balance} base units, paid ${issuance.price} ${issuance.currency}`,
  )
  return { issuanceId: issuance.issuanceId, paymentHash: outcome.paymentHash, mptBalance: balance }
}

/** Poll the agent's MPT holdings until the issuance arrives with a non-zero balance. */
async function confirmDelivery(deps: AcquireDeps, issuanceId: string): Promise<string> {
  const { signer, network, log } = deps
  for (let i = 0; i < 20; i++) {
    const holdings = await withClient(network.rpcUrl, (c) => listMptHoldings(c, signer.address()))
    const h = holdings.find((x) => x.issuanceId === issuanceId)
    if (h && h.amount !== '0') {
      log.info('RWA MPT received', { issuanceId, amount: h.amount })
      return h.amount
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
  throw new Error(`MPT ${issuanceId} not received within timeout`)
}

/**
 * Acquire every currently-available issuance from the merchant, then stop.
 * Funds the agent once up front (sized for reserves + swap budget). Dedupes via
 * the persisted `acquired` set so each issuance is bought once.
 */
export async function runAcquisition(
  deps: AcquireDeps,
  store: AgentStore,
): Promise<AcquireResult[]> {
  const acquired = new Set(store.acquired)

  // Fund once: base reserve + owner reserves (trustline + MPT) + swap budget + fees.
  await ensureFunded(
    deps.signer.address(),
    deps.network,
    { ownerObjects: 2, swapBudgetXrp: String(deps.maxSpendXrp) },
    deps.log,
  )

  const issuances = await discover(
    {
      merchantUrl: deps.merchantUrl,
      merchantAddress: deps.merchantAddress,
      network: deps.network,
      acquired,
    },
    deps.log,
  )
  if (issuances.length === 0) {
    deps.log.info('nothing to acquire (all current issuances already owned)')
    return []
  }

  const results: AcquireResult[] = []
  for (const issuance of issuances) {
    const result = await acquireOne(deps, issuance)
    results.push(result)
    acquired.add(result.issuanceId)
    store.acquired = [...acquired]
    saveAgentStore(store)
  }
  return results
}
