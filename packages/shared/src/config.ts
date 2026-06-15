import { resolvePaymentCurrency, resolveRwaAsset } from './assets'
import { loadEnv } from './env'
import { resolveNetwork } from './networks'
import type { NetworkConfig, PaymentCurrency, RwaAssetDef } from './types'

export interface ResolvedConfig {
  network: NetworkConfig
  payment: PaymentCurrency
  asset: RwaAssetDef
}

/** Load env and resolve the full network/currency/asset config in one place. */
export function resolveConfig(): ResolvedConfig {
  loadEnv()
  const network = resolveNetwork()
  const payment = resolvePaymentCurrency(network)
  const asset = resolveRwaAsset()
  return { network, payment, asset }
}
