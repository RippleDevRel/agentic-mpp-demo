/**
 * Trust + opt-in tools: set an IOU trust line (`TrustSet`) so the agent can hold
 * the payment currency, and opt into a permissioned RWA MPT (holder-side
 * `MPTokenAuthorize`) so the issuer can authorize this holder. Both OWS-signed.
 */
import {
  currencyLabel,
  type Logger,
  listMptHoldings,
  type NetworkConfig,
  withClient,
} from '@agentic-mpp-demo-xrpl/shared'
import type { XrplSubmitSigner } from '../signer/common'

/** An IOU currency as learned from a 402 challenge. */
export interface IouCurrency {
  currency: string
  issuer: string
}

/** True if the account already trusts the given IOU issuer/currency. */
async function hasTrustline(
  network: NetworkConfig,
  address: string,
  currency: { currency: string; issuer: string },
): Promise<boolean> {
  return withClient(network.rpcUrl, async (client) => {
    const res = await client
      .request({
        command: 'account_lines',
        account: address,
        peer: currency.issuer,
        ledger_index: 'validated',
      })
      .catch(() => null)
    if (!res) return false
    return (res.result.lines ?? []).some((l) => l.currency === currency.currency)
  })
}

/**
 * Set the agent's trust line to the IOU issuer (LEARNED from the 402) so it can
 * hold and pay in that currency. Signed through OWS (key isolated).
 */
export async function ensureIouTrustline(
  signer: XrplSubmitSigner,
  network: NetworkConfig,
  iou: IouCurrency,
  log: Logger,
): Promise<void> {
  const label = currencyLabel(iou.currency)
  const exists = await hasTrustline(network, signer.address(), iou)
  if (exists) {
    log.info(`trust line to ${label} already set`, { issuer: iou.issuer })
    return
  }
  log.step(`setting trust line to ${label}`, { issuer: iou.issuer })
  await signer.signAndSubmit(
    {
      TransactionType: 'TrustSet',
      LimitAmount: { currency: iou.currency, issuer: iou.issuer, value: '1000000000' },
    },
    { label: `TrustSet (${label})` },
  )
}

/**
 * Holder-side opt-in to a permissioned RWA MPT (MPTokenAuthorize without a Holder
 * field). Must run BEFORE paying so the issuer can authorize this holder. The
 * MPToken object is created in `pending_authorization` state. Signed via OWS.
 */
export async function optInToMpt(
  signer: XrplSubmitSigner,
  network: NetworkConfig,
  issuanceId: string,
  log: Logger,
): Promise<void> {
  const holdings = await withClient(network.rpcUrl, (c) => listMptHoldings(c, signer.address()))
  if (holdings.some((h) => h.issuanceId === issuanceId)) {
    log.info('already opted into MPT', { issuanceId })
    return
  }
  log.step('opting into the permissioned RWA MPT (holder-side authorize)', { issuanceId })
  await signer.signAndSubmit(
    { TransactionType: 'MPTokenAuthorize', MPTokenIssuanceID: issuanceId },
    { label: 'MPTokenAuthorize (opt-in)' },
  )
}
