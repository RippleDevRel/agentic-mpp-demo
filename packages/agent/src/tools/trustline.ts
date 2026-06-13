import {
  type Logger,
  listMptHoldings,
  type NetworkConfig,
  type PaymentCurrency,
  withClient,
} from '@rwa/shared'
import type { OwsXrplSigner } from '../signer/ows-xrpl-signer'

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
 * Set the agent's trust line to the payment-currency issuer so it can hold and
 * pay in that currency. No-op for XRP. Signed through OWS (key isolated).
 */
export async function ensurePaymentTrustline(
  signer: OwsXrplSigner,
  network: NetworkConfig,
  payment: PaymentCurrency,
  log: Logger,
): Promise<void> {
  if (payment.kind === 'XRP') return
  const exists = await hasTrustline(network, signer.address(), payment.sdk)
  if (exists) {
    log.info(`trust line to ${payment.label} already set`)
    return
  }
  log.step(`setting trust line to ${payment.label}`)
  await signer.signAndSubmit(
    {
      TransactionType: 'TrustSet',
      LimitAmount: {
        currency: payment.sdk.currency,
        issuer: payment.sdk.issuer,
        value: '1000000000',
      },
    },
    { label: `TrustSet (${payment.label})` },
  )
}

/**
 * Holder-side opt-in to a permissioned RWA MPT (MPTokenAuthorize without a Holder
 * field). Must run BEFORE paying so the issuer can authorize this holder. The
 * MPToken object is created in `pending_authorization` state. Signed via OWS.
 */
export async function optInToMpt(
  signer: OwsXrplSigner,
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
