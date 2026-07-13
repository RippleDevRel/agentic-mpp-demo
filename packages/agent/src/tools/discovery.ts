/**
 * Discovery tool: read the seller's catalog endpoint, cross-check the issuances
 * on-ledger, and return those not yet acquired (id + the 402-protected URL to
 * buy each). The agent is given only the endpoint — never the seller's address.
 */
import { type Logger, type NetworkConfig, withClient } from '@agentic-mpp-demo-xrpl/shared'

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

/** An advertised MPP payment offer, parsed from a `/openapi.json` operation. */
export interface MppOffer {
  /** The route the offer protects (e.g. `/rwa/{issuanceId}`). */
  path: string
  method?: string
  intent?: string
  amount?: string
  currency?: string
  recipient?: string
}

/**
 * Consume the merchant's MPP discovery doc (`GET /openapi.json`) and return the
 * advertised payment offers. This is the pre-flight the MPP spec intends: an
 * agent learns the price/method/currency BEFORE hitting the resource. It is
 * advisory — the runtime 402 challenge stays authoritative — so a merchant that
 * doesn't serve discovery simply yields `[]` (non-fatal).
 */
export async function fetchMppOffers(merchantUrl: string, log: Logger): Promise<MppOffer[]> {
  const res = await fetch(`${merchantUrl}/openapi.json`).catch(() => null)
  if (!res?.ok) {
    log.info('no MPP discovery doc (advisory — will rely on the 402)', {
      status: res?.status ?? 'unreachable',
    })
    return []
  }
  const doc = (await res.json().catch(() => null)) as {
    paths?: Record<
      string,
      Record<string, { 'x-payment-info'?: { offers?: Array<Record<string, string>> } }>
    >
  } | null
  const offers: MppOffer[] = []
  for (const [path, ops] of Object.entries(doc?.paths ?? {})) {
    for (const op of Object.values(ops)) {
      for (const o of op['x-payment-info']?.offers ?? []) {
        offers.push({
          path,
          method: o.method,
          intent: o.intent,
          amount: o.amount,
          currency: o.currency,
          recipient: o.recipient,
        })
      }
    }
  }
  log.mpp('discovered MPP offers via /openapi.json (advisory; the 402 is authoritative)', {
    count: offers.length,
    offers: offers.map((o) => `${o.method}/${o.intent} ${o.amount} ${o.currency} @ ${o.path}`),
  })
  return offers
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
