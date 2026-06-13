import type { IssuedCurrency, MPToken, NetworkId } from 'xrpl-mpp-sdk'

/** Networks this project supports. `local` maps onto an xrpl-up sandbox (needs Docker). */
export type NetworkName = 'local' | 'testnet'

/** SDK networks this project actually uses (never mainnet; faucet-capable). */
export type SdkNetwork = Exclude<NetworkId, 'mainnet'>

export interface NetworkConfig {
  /** Project-level network name. */
  name: NetworkName
  /** What to pass to the SDK's `network` param (drives its defaults). */
  sdkNetwork: SdkNetwork
  /** WebSocket RPC endpoint (xrpl.js). */
  rpcUrl: string
  /** HTTP JSON-RPC endpoint (OWS broadcasts via curl, which does not speak wss). */
  httpRpcUrl: string
  /** How funding is obtained: SDK/testnet faucet vs the local sandbox faucet. */
  faucetMode: 'sdk-testnet' | 'local'
  /** Build an explorer link for a tx hash, when one exists. */
  explorerTx?: (hash: string) => string
}

/** The kind of currency the merchant charges in. */
export type PaymentCurrencyKind = 'RLUSD' | 'XRP' | 'IOU'

/**
 * A resolved payment currency, in the exact shape the SDK's `charge`/`Wallet`
 * APIs expect. Discriminated on `kind` so `kind !== 'XRP'` narrows `sdk` to an
 * IssuedCurrency for trustline/accept calls.
 */
export type PaymentCurrency =
  | { kind: 'XRP'; label: string; sdk: 'XRP' }
  | { kind: Exclude<PaymentCurrencyKind, 'XRP'>; label: string; sdk: IssuedCurrency }

/** Description of the Real World Asset MPT the merchant issues. */
export interface RwaAssetDef {
  assetScale: number
  metadata: string
  /** Units minted to the merchant as sellable inventory at launch. */
  availableUnits: number
  /** Asking price per unit, expressed in `PaymentCurrency` units. */
  pricePerUnit: string
}

/** Persisted merchant identity + issuance, so restarts reuse the same on-chain state. */
export interface MerchantState {
  address: string
  seed: string
  issuanceId: string
  requireAuth: boolean
  network: NetworkName
  /** issuance_ids that have been sold (catalog stops offering them). */
  sold: string[]
}

export type { IssuedCurrency, MPToken, NetworkId }
