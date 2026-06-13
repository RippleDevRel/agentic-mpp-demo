import { resolvePaymentCurrency, resolveRwaAsset } from './assets'
import { loadEnv } from './env'
import { createLogger } from './logger'
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

/** Print the resolved configuration (used by entrypoints and the Phase 0 check). */
export function logConfig(scope = 'config'): ResolvedConfig {
  const cfg = resolveConfig()
  const log = createLogger(scope)
  log.info('network resolved', {
    name: cfg.network.name,
    rpc: cfg.network.rpcUrl,
    sdk: cfg.network.sdkNetwork,
  })
  log.info('payment currency', { kind: cfg.payment.kind, label: cfg.payment.label })
  log.info('rwa asset', {
    scale: cfg.asset.assetScale,
    units: cfg.asset.availableUnits,
    price: cfg.asset.pricePerUnit,
  })
  return cfg
}
