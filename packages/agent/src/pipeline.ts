import {
  currencyLabel,
  type Logger,
  listMptHoldings,
  type NetworkConfig,
  type RunSummary,
  withClient,
} from '@rwa/shared'
import type { OwsXrplSigner } from './signer/ows-xrpl-signer'
import { type AgentStore, saveAgentStore } from './state'
import { type DiscoveredIssuance, discover } from './tools/discovery'
import { ensureFunded } from './tools/funding'
import { payViaMpp, quoteResource } from './tools/mpp'
import { ensureIouBalance } from './tools/swap'
import { ensureIouTrustline, optInToMpt } from './tools/trustline'

export interface AcquireDeps {
  signer: OwsXrplSigner
  network: NetworkConfig
  /** The seller's service endpoint — the ONLY merchant locator the agent is given. */
  merchantUrl: string
  slippageBps: number
  log: Logger
  summary: RunSummary
}

export interface AcquireResult {
  issuanceId: string
  paymentHash: string
  mptBalance: string
}

/** quote (402) -> opt-in -> trust+swap (if IOU) -> pay -> receive, for one issuance. */
async function acquireOne(deps: AcquireDeps, issuance: DiscoveredIssuance): Promise<AcquireResult> {
  const { signer, network, log } = deps
  log.step('acquiring issuance', { issuanceId: issuance.issuanceId })

  // Learn the payment terms (recipient, amount, currency) from the resource's 402.
  const quote = await quoteResource(issuance.url, log)

  // Holder opt-in must precede payment so the issuer can authorize this holder.
  await optInToMpt(signer, network, issuance.issuanceId, log)

  // Trust + acquire the payment currency the 402 actually asked for.
  if (quote.currency.kind === 'IOU') {
    await ensureIouTrustline(signer, network, quote.currency, log)
    await ensureIouBalance(
      signer,
      network,
      quote.currency,
      { requiredValue: quote.amount, slippageBps: deps.slippageBps },
      log,
    )
  }

  // Pay through MPP (push mode, OWS-signed) and take delivery.
  const outcome = await payViaMpp(signer, network, issuance.url, log)

  const balance = await confirmDelivery(deps, issuance.issuanceId)
  const paidLabel = quote.currency.kind === 'IOU' ? currencyLabel(quote.currency.currency) : 'XRP'
  deps.summary.add(
    `Acquired ${issuance.issuanceId}`,
    `${balance} base units, paid ${quote.amount} ${paidLabel}`,
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
    { ownerObjects: 2, swapBudgetXrp: String(store.maxSpendXrp) },
    deps.log,
  )

  const issuances = await discover(
    { merchantUrl: deps.merchantUrl, network: deps.network, acquired },
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
