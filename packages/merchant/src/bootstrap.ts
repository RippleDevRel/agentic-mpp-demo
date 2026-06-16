import { getEnv, rwaMetadata } from '@agentic-mpp-demo-xrpl/shared'
import type { MerchantContext } from './context'

/** Convert display units (asset-scale aware) to the integer base amount MPTs use. */
export function unitsToBaseAmount(units: number, assetScale: number): string {
  return BigInt(Math.round(units * 10 ** assetScale)).toString()
}

/**
 * Bring the merchant fully online with no manual steps:
 *  - ensure the permissioned RWA MPT issuance exists (tfMPTRequireAuth),
 *  - set the merchant's trust line to the payment currency so it can be paid,
 *  - persist the account + issuance so a restart reuses them.
 *
 * The merchant is both the issuer and the MPP charge recipient. "Inventory" is
 * tracked as `remainingUnits`; each sale issues that MPT to the buyer on
 * delivery (the issuer mints to the holder), so no self-minting is needed.
 */
export async function ensureBootstrapped(ctx: MerchantContext): Promise<void> {
  const { wallet, store, net, cfg, log } = ctx

  if (!store.issuanceId) {
    log.step('creating permissioned RWA MPT issuance (tfMPTRequireAuth)')
    const maximumAmount = getEnv('RWA_MAX_AMOUNT') ?? '1000000000000'
    const { mpt, hash } = await wallet.createToken({
      assetScale: cfg.asset.assetScale,
      maximumAmount,
      requireAuthorization: true,
      allowTrade: true,
      metadata: rwaMetadata(cfg.asset, cfg.network),
      ...net,
    })
    store.issuanceId = mpt.mpt_issuance_id
    store.requireAuth = true
    ctx.persist()
    log.txn('MPTokenIssuanceCreate', hash, cfg.network.explorerTx?.(hash))
    log.info('issuance ready', {
      issuanceId: store.issuanceId,
      remainingUnits: store.remainingUnits,
    })
  } else {
    log.info('issuance already bootstrapped', { issuanceId: store.issuanceId })
  }

  // Set the merchant's trust line so it can RECEIVE the payment currency.
  if (cfg.payment.kind !== 'XRP') {
    const holding = await wallet.holdsToken(cfg.payment.sdk, net)
    if (!holding) {
      log.step(`setting merchant trust line to receive ${cfg.payment.label}`)
      const res = await wallet.acceptToken(cfg.payment.sdk, net)
      if ('hash' in res && res.hash) {
        log.txn(`TrustSet (${cfg.payment.label})`, res.hash, cfg.network.explorerTx?.(res.hash))
      }
    } else {
      log.info(`merchant already trusts ${cfg.payment.label}`)
    }
  }
}
