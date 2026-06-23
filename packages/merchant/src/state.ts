import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { NetworkName } from '@agentic-mpp-demo-xrpl/shared'

/**
 * Persisted merchant state so a restart reuses the same on-chain account and
 * issuance instead of creating new ones. Stored per-network under `.data/`.
 */
export interface MerchantStore {
  address: string
  seed: string
  issuanceId: string
  requireAuth: boolean
  assetScale: number
  network: NetworkName
  /** Display units still available to sell (decremented on each delivery). */
  remainingUnits: number
  /** Additional issuances created by the optional ongoing release loop. */
  extraIssuances: Array<{ issuanceId: string; remainingUnits: number; assetScale: number }>
  /** Idempotency: payment reference (tx hash) -> delivery result. */
  deliveries: Record<
    string,
    {
      authorizeHash?: string
      issueHash: string
      to: string
      issuanceId: string
      baseAmount: string
    }
  >
}

function storePath(network: NetworkName): string {
  return resolve('.data', `merchant.${network}.json`)
}

export function loadStore(network: NetworkName): MerchantStore | undefined {
  const path = storePath(network)
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8')) as MerchantStore
}

export function saveStore(store: MerchantStore): void {
  const path = storePath(store.network)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}
