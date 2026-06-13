import { RLUSD_TESTNET } from 'xrpl-mpp-sdk'
import { getEnv, getEnvNumber } from './env'
import { createLogger } from './logger'
import type { NetworkConfig, PaymentCurrency, PaymentCurrencyKind, RwaAssetDef } from './types'

const log = createLogger('assets')

/** Pad a currency code to the 40-char hex form when it exceeds 3 ASCII chars. */
export function toCurrencyHex(code: string): string {
  if (code.length <= 3) return code
  if (/^[0-9A-Fa-f]{40}$/.test(code)) return code.toUpperCase()
  const hex = Buffer.from(code, 'ascii').toString('hex').toUpperCase()
  return hex.padEnd(40, '0')
}

/**
 * Resolve the payment currency the merchant charges in, in the exact SDK shape.
 * Imports the RLUSD issuer/currency from the SDK constant so they stay in sync,
 * and fires the issuer-discrepancy warning if the env issuer disagrees.
 */
export function resolvePaymentCurrency(network: NetworkConfig): PaymentCurrency {
  const kind = (getEnv('PAYMENT_CURRENCY') ?? 'RLUSD').toUpperCase() as PaymentCurrencyKind

  if (kind === 'XRP') {
    return { kind: 'XRP', label: 'XRP', sdk: 'XRP' }
  }

  if (kind === 'RLUSD') {
    if (network.name === 'local') {
      throw new Error(
        'PAYMENT_CURRENCY=RLUSD is not available on the local sandbox. Use IOU or XRP locally.',
      )
    }
    const envIssuer = getEnv('RLUSD_TESTNET_ISSUER')
    if (envIssuer && envIssuer !== RLUSD_TESTNET.issuer) {
      log.warn('RLUSD issuer discrepancy: env value differs from the SDK RLUSD_TESTNET constant', {
        env: envIssuer,
        sdk: RLUSD_TESTNET.issuer,
        using: RLUSD_TESTNET.issuer,
      })
    }
    return {
      kind: 'RLUSD',
      label: 'RLUSD',
      // Always trust the SDK constant so currency + issuer stay in sync.
      sdk: { currency: RLUSD_TESTNET.currency, issuer: RLUSD_TESTNET.issuer },
    }
  }

  // Custom stable IOU (used on the local sandbox; issuer is created by setup-local).
  const code = getEnv('LOCAL_STABLE_CURRENCY') ?? 'USD'
  const issuer = getEnv('LOCAL_STABLE_ISSUER')
  if (!issuer) {
    throw new Error('PAYMENT_CURRENCY=IOU requires LOCAL_STABLE_ISSUER (set by setup-local).')
  }
  return {
    kind: 'IOU',
    label: code,
    sdk: { currency: toCurrencyHex(code), issuer },
  }
}

/** The RWA MPT definition the merchant issues, read from env with sane defaults. */
export function resolveRwaAsset(): RwaAssetDef {
  return {
    assetScale: getEnvNumber('RWA_ASSET_SCALE', 2),
    metadata: getEnv('RWA_METADATA') ?? 'Tokenized RWA demo',
    availableUnits: getEnvNumber('RWA_AVAILABLE_UNITS', 10),
    pricePerUnit: getEnv('RWA_PRICE') ?? '10',
  }
}

/**
 * XLS-89 compliant MPT metadata so the issuance is discoverable by explorers
 * (avoids the rippled "not properly formatted" warning). Field names follow the
 * standard's short keys; the SDK hex-encodes the object.
 */
export function rwaMetadata(asset: RwaAssetDef, network: NetworkConfig): Record<string, unknown> {
  return {
    ticker: 'RWADMO',
    name: asset.metadata,
    desc: `${asset.metadata} — autonomous RWA demo on XRPL ${network.name}`,
    icon: 'https://raw.githubusercontent.com/XRPLF/xrpl.org/master/static/img/logo.png',
    asset_class: 'rwa',
    asset_subclass: 'other',
    issuer_name: 'Autonomous RWA Merchant',
  }
}
