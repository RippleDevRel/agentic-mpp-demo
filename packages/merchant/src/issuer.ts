import { getEnvNumber, rwaMetadata } from '@rwa/shared'
import type { MerchantContext } from './context'

/**
 * Optional ongoing release loop (plan 1.1). Beyond the launch inventory, this
 * periodically creates a NEW permissioned issuance (tfMPTRequireAuth) so the
 * agent's watch-and-buy behaviour can be exercised. Disabled when
 * ISSUANCE_INTERVAL_MS <= 0. Returns a stop function.
 */
export function startIssuerLoop(ctx: MerchantContext): () => void {
  const intervalMs = getEnvNumber('ISSUANCE_INTERVAL_MS', 0)
  if (intervalMs <= 0) {
    ctx.log.info('ongoing issuance loop disabled (ISSUANCE_INTERVAL_MS=0)')
    return () => {}
  }

  ctx.log.info('ongoing issuance loop enabled', { intervalMs })
  let releasing = false
  const timer = setInterval(async () => {
    if (releasing) return
    releasing = true
    try {
      await releaseOne(ctx)
    } catch (err) {
      ctx.log.error('ongoing issuance failed', {
        msg: err instanceof Error ? err.message : String(err),
      })
    } finally {
      releasing = false
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

async function releaseOne(ctx: MerchantContext): Promise<void> {
  const { wallet, store, net, cfg, log } = ctx
  log.step('releasing a new RWA issuance (ongoing)')
  const { mpt, hash } = await wallet.createToken({
    assetScale: cfg.asset.assetScale,
    maximumAmount: '1000000000000',
    requireAuthorization: true,
    allowTrade: true,
    metadata: rwaMetadata(cfg.asset, cfg.network),
    ...net,
  })
  store.extraIssuances.push({
    issuanceId: mpt.mpt_issuance_id,
    remainingUnits: cfg.asset.availableUnits,
    assetScale: cfg.asset.assetScale,
  })
  ctx.persist()
  log.txn('MPTokenIssuanceCreate (ongoing)', hash, cfg.network.explorerTx?.(hash))
}
