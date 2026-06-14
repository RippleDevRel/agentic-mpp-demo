import { type Logger, type NetworkConfig, withClient } from '@rwa/shared'

export interface DiscoveredIssuance {
  issuanceId: string
  remainingUnits: number
  /** Absolute MPP-protected URL to request this resource (its 402 carries the price). */
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

/** Cross-check, on-ledger, the issuances of a merchant address LEARNED from the catalog. */
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
 * Discover what a seller offers from its SERVICE ENDPOINT alone — the agent is
 * never handed the merchant's XRPL address. It reads the endpoint's catalog (the
 * list of available resources); the merchant address is learned there and only
 * used for an optional on-ledger cross-check. The binding payment recipient comes
 * later, from each resource's 402 challenge (see tools/mpp.ts). `acquired` dedupes.
 */
export async function discover(
  params: { merchantUrl: string; network: NetworkConfig; acquired: Set<string> },
  log: Logger,
): Promise<DiscoveredIssuance[]> {
  const { merchantUrl, network, acquired } = params

  const res = await fetch(`${merchantUrl}/catalog`)
  if (!res.ok) throw new Error(`catalog fetch failed: ${res.status}`)
  const catalog = (await res.json()) as CatalogResponse
  log.step('read seller catalog from endpoint', { endpoint: merchantUrl, seller: catalog.merchant })

  // Optional autonomy touch: verify the catalog's issuances exist on-ledger, using
  // the address we just LEARNED from the catalog (not one we were given).
  const onLedger = await ledgerIssuances(catalog.merchant, network)
  log.info('on-ledger cross-check of seller issuances', { count: onLedger.length })

  const fresh = filterAcquirable(catalog.items, acquired, merchantUrl)
  log.step('acquirable resources', { count: fresh.length, ids: fresh.map((f) => f.issuanceId) })
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
      remainingUnits: it.remainingUnits,
      url: new URL(it.endpoint, merchantUrl).toString(),
    }))
}
