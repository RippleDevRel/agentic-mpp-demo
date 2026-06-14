/**
 * Phase 3 verification: drive the full acquisition pipeline deterministically
 * (no model in the loop). discover -> opt-in -> trust -> swap -> pay -> receive.
 *
 * The agent is given ONLY the seller endpoint (MERCHANT_URL); it learns the
 * payment recipient from each resource's 402 challenge.
 *
 * Usage:
 *   OWS_PASSPHRASE=... MERCHANT_URL=http://localhost:8787 \
 *   NETWORK=testnet PAYMENT_CURRENCY=RLUSD tsx packages/agent/src/verify-pipeline.ts
 */
import { buildAgentContext } from './context'
import { runAcquisition } from './pipeline'

async function main(): Promise<void> {
  const { deps, store } = await buildAgentContext()
  const results = await runAcquisition(deps, store)

  console.log(deps.summary.render('Acquisition summary'))
  console.log(results.length > 0 ? 'PHASE3_OK' : 'PHASE3_NOTHING')
}

main().catch((err) => {
  console.error(`verify-pipeline failed: ${err instanceof Error ? err.stack : String(err)}`)
  process.exit(1)
})
