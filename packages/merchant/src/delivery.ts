import { withClient } from '@agentic-mpp-demo-xrpl/shared'
import { unitsToBaseAmount } from './bootstrap'
import type { MerchantContext } from './context'

export interface DeliveryResult {
  to: string
  issuanceId: string
  authorizeHash?: string
  issueHash: string
  baseAmount: string
  reused: boolean
}

/** Resolve the payer (XRPL Account) from a validated payment tx hash. */
async function payerFromTx(rpcUrl: string, txHash: string): Promise<string> {
  return withClient(rpcUrl, async (client) => {
    const res = await client.request({ command: 'tx', transaction: txHash })
    const r = res.result as unknown as { Account?: string; tx_json?: { Account?: string } }
    const account = r.Account ?? r.tx_json?.Account
    if (!account) throw new Error(`Could not resolve payer Account from tx ${txHash}`)
    return account
  })
}

/**
 * Deliver the RWA MPT after a paid 402. The permissioned issuance requires the
 * issuer to authorize the specific holder first (the holder must already have
 * opted in), then the issuer sends the MPT with an on-chain Payment.
 * Idempotent on the payment reference: a retried delivery never double-issues.
 */
export async function deliver(
  ctx: MerchantContext,
  params: { reference: string; issuanceId: string; units: number; payer?: string },
): Promise<DeliveryResult> {
  const { wallet, store, net, cfg, log } = ctx
  const { reference, issuanceId, units } = params

  const prior = store.deliveries[reference]
  if (prior) {
    log.info('delivery already completed for this payment (idempotent)', { reference })
    return { ...prior, reused: true }
  }

  const payer = params.payer ?? (await payerFromTx(cfg.network.rpcUrl, reference))
  const mpt = { mpt_issuance_id: issuanceId }
  const baseAmount = unitsToBaseAmount(units, store.assetScale)

  log.step('authorizing holder for the permissioned RWA MPT', { holder: payer })
  const auth = await wallet.authorize(payer, mpt, net)
  if (auth.hash)
    log.txn('MPTokenAuthorize (issuer-side)', auth.hash, cfg.network.explorerTx?.(auth.hash))

  log.step('issuing RWA MPT to buyer', { amount: baseAmount, issuanceId })
  const issued = await wallet.issue(payer, baseAmount, mpt, net)
  log.txn('MPT delivery Payment', issued.hash, cfg.network.explorerTx?.(issued.hash))

  const result: DeliveryResult = {
    to: payer,
    issuanceId,
    authorizeHash: auth.hash,
    issueHash: issued.hash,
    baseAmount,
    reused: false,
  }
  store.deliveries[reference] = {
    authorizeHash: auth.hash,
    issueHash: issued.hash,
    to: payer,
    issuanceId,
    baseAmount,
  }
  // Decrement inventory for the primary issuance.
  if (issuanceId === store.issuanceId) {
    store.remainingUnits = Math.max(0, store.remainingUnits - units)
  } else {
    const extra = store.extraIssuances.find((e) => e.issuanceId === issuanceId)
    if (extra) extra.remainingUnits = Math.max(0, extra.remainingUnits - units)
  }
  ctx.persist()
  return result
}
