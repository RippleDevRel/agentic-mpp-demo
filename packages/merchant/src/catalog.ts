import type { MerchantContext } from './context'

export interface CatalogItem {
  issuanceId: string
  price: string
  currency: string
  remainingUnits: number
  assetScale: number
  metadata: string
  /** MPP-protected endpoint to acquire this issuance. */
  endpoint: string
}

export interface Catalog {
  network: string
  merchant: string
  paymentCurrency: string
  items: CatalogItem[]
}

/** Build the public catalog: every issuance with units still available to sell. */
export function buildCatalog(ctx: MerchantContext): Catalog {
  const { store, cfg } = ctx
  const price = cfg.asset.pricePerUnit
  const items: CatalogItem[] = []

  const push = (issuanceId: string, remainingUnits: number, assetScale: number) => {
    if (remainingUnits <= 0) return
    items.push({
      issuanceId,
      price,
      currency: cfg.payment.label,
      remainingUnits,
      assetScale,
      metadata: cfg.asset.metadata,
      endpoint: `/rwa/${issuanceId}`,
    })
  }

  if (store.issuanceId) push(store.issuanceId, store.remainingUnits, store.assetScale)
  for (const e of store.extraIssuances) push(e.issuanceId, e.remainingUnits, e.assetScale)

  return {
    network: cfg.network.name,
    merchant: store.address,
    paymentCurrency: cfg.payment.label,
    items,
  }
}

/** Look up an offered issuance and the units a single purchase delivers. */
export function findOffer(
  ctx: MerchantContext,
  issuanceId: string,
): { issuanceId: string; units: number } | undefined {
  const { store } = ctx
  if (issuanceId === store.issuanceId && store.remainingUnits > 0) {
    return { issuanceId, units: store.remainingUnits }
  }
  const extra = store.extraIssuances.find(
    (e) => e.issuanceId === issuanceId && e.remainingUnits > 0,
  )
  return extra ? { issuanceId, units: extra.remainingUnits } : undefined
}
