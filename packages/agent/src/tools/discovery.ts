import { type Logger, type NetworkConfig, withClient } from '@rwa/shared'

export interface DiscoveredIssuance {
  issuanceId: string
  /** Asking price in payment-currency display units (from the merchant 402/catalog). */
  price: string
  /** Payment currency label (e.g. RLUSD, XRP). */
  currency: string
  remainingUnits: number
  /** Absolute MPP-protected URL to acquire this issuance. */
  url: string
}

export interface CatalogResponse {
  merchant: string
  paymentCurrency: string
  items: Array<{
    issuanceId: string
    price: string
    currency: string
    remainingUnits: number
    endpoint: string
  }>
}

/** Enumerate the merchant's MPT issuances on-ledger (autonomy: discovery from chain). */
async function ledgerIssuances(merchant: string, network: NetworkConfig): Promise<string[]> {
  return withClient(network.rpcUrl, async (client) => {
    const res = await client
      .request({
        command: 'account_objects',
        account: merchant,
        type: 'mpt_issuance',
        ledger_index: 'validated',
      })
      .catch(() => null)
    if (!res) return []
    return (res.result.account_objects ?? []).map((o) => {
      const obj = o as unknown as {
        mpt_issuance_id?: string
        MPTokenIssuanceID?: string
        index?: string
      }
      return obj.mpt_issuance_id ?? obj.MPTokenIssuanceID ?? obj.index ?? ''
    })
  })
}

/**
 * Discover the merchant's RWA issuances the agent has not yet acquired. Cross-checks
 * the on-ledger issuances against the merchant catalog (which carries price + the
 * MPP endpoint). `acquired` dedupes so each issuance is acted on once.
 */
export async function discover(
  params: {
    merchantUrl: string
    merchantAddress: string
    network: NetworkConfig
    acquired: Set<string>
  },
  log: Logger,
): Promise<DiscoveredIssuance[]> {
  const { merchantUrl, merchantAddress, network, acquired } = params

  const onLedger = await ledgerIssuances(merchantAddress, network)
  log.step('on-ledger issuances discovered', { merchant: merchantAddress, count: onLedger.length })

  const res = await fetch(`${merchantUrl}/catalog`)
  if (!res.ok) throw new Error(`catalog fetch failed: ${res.status}`)
  const catalog = (await res.json()) as CatalogResponse
  if (catalog.merchant !== merchantAddress) {
    log.warn('catalog merchant differs from goal address', {
      catalog: catalog.merchant,
      goal: merchantAddress,
    })
  }

  const fresh = filterAcquirable(catalog.items, acquired, merchantUrl)
  log.step('acquirable issuances', { count: fresh.length, ids: fresh.map((f) => f.issuanceId) })
  return fresh
}

/** Pure: keep in-stock, not-yet-acquired issuances and resolve their absolute URL. */
export function filterAcquirable(
  items: CatalogResponse['items'],
  acquired: Set<string>,
  merchantUrl: string,
): DiscoveredIssuance[] {
  return items
    .filter((it) => it.remainingUnits > 0 && !acquired.has(it.issuanceId))
    .map((it) => ({
      issuanceId: it.issuanceId,
      price: it.price,
      currency: it.currency,
      remainingUnits: it.remainingUnits,
      url: new URL(it.endpoint, merchantUrl).toString(),
    }))
}
