/**
 * Phase 3 verification: drive the full acquisition pipeline deterministically
 * (no model in the loop yet). discover -> opt-in -> trust -> swap -> pay -> receive.
 *
 * Usage:
 *   OWS_PASSPHRASE=... MERCHANT_ADDRESS=r... MERCHANT_URL=http://localhost:8787 \
 *   NETWORK=testnet PAYMENT_CURRENCY=RLUSD tsx packages/agent/src/verify-pipeline.ts
 */
import {
  createLogger,
  getEnv,
  getEnvNumber,
  RunSummary,
  requireEnv,
  resolveConfig,
} from '@rwa/shared'
import { runAcquisition } from './pipeline'
import { ensureAgentWallet } from './tools/wallet'

async function main(): Promise<void> {
  const { network, payment } = resolveConfig()
  const log = createLogger('agent')
  const summary = new RunSummary()

  const { signer, store } = await ensureAgentWallet(network, log)
  summary.add('Wallet (OWS, key isolated)', signer.address())

  const results = await runAcquisition(
    {
      signer,
      network,
      payment,
      merchantUrl: getEnv('MERCHANT_URL') ?? 'http://localhost:8787',
      merchantAddress: requireEnv('MERCHANT_ADDRESS'),
      maxSpendXrp: getEnvNumber('MAX_SPEND', 50),
      slippageBps: getEnvNumber('SWAP_SLIPPAGE_BPS', 100),
      log,
      summary,
    },
    store,
  )

  console.log(summary.render('Acquisition summary'))
  console.log(results.length > 0 ? 'PHASE3_OK' : 'PHASE3_NOTHING')
}

main().catch((err) => {
  console.error(`verify-pipeline failed: ${err instanceof Error ? err.stack : String(err)}`)
  process.exit(1)
})
