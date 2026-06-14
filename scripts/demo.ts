/**
 * End-to-end demo orchestrator: boot the merchant, point the agent at it, run the
 * autonomous acquisition, and assert the RWA MPT lands in the agent wallet.
 *
 * Defaults to testnet (no Docker needed). With ANTHROPIC_API_KEY set, the agent is
 * model-driven; otherwise it runs the deterministic pipeline (same tools).
 *
 * Run: pnpm demo:local   (NETWORK=local needs Docker + setup-local first)
 *      NETWORK=testnet pnpm exec tsx scripts/demo.ts
 */

import { buildAgentContext, runAcquisition, runAgentLoop } from '@rwa/agent'
import { startServer } from '@rwa/merchant'
import { getEnv } from '@rwa/shared'

function setDefault(key: string, value: string): void {
  if (!process.env[key]) process.env[key] = value
}

async function main(): Promise<void> {
  // One-command demo defaults (override via real env / .env).
  setDefault('NETWORK', 'testnet')
  setDefault('PAYMENT_CURRENCY', 'RLUSD')
  setDefault('MPP_SECRET_KEY', 'demo-mpp-secret')
  setDefault('RWA_PRICE', '10')
  setDefault('RWA_AVAILABLE_UNITS', '3')
  setDefault('ISSUANCE_INTERVAL_MS', '0')
  setDefault('MERCHANT_PORT', '8787')
  setDefault('OWS_PASSPHRASE', 'demo-owner-pass')
  setDefault('OWS_VAULT_PATH', '.ows-demo')
  setDefault('OWS_WALLET_NAME', 'agent-treasury-demo')
  setDefault('MAX_SPEND', '50')
  setDefault('SWAP_SLIPPAGE_BPS', '1000')

  console.log('=== booting merchant ===')
  const merchant = await startServer()
  // Hand the agent ONLY the seller's service endpoint — not its ledger address.
  // The agent learns the payment recipient from each resource's 402 challenge.
  process.env.MERCHANT_URL = merchant.url

  try {
    console.log('=== launching autonomous agent ===')
    const { deps, store, goal } = await buildAgentContext()
    deps.log.info('agent goal', { goal })

    if (getEnv('ANTHROPIC_API_KEY')) {
      await runAgentLoop(deps, store, goal)
    } else {
      deps.log.warn('ANTHROPIC_API_KEY not set — deterministic pipeline (no model in the loop)')
      const results = await runAcquisition(deps, store)
      if (results.length === 0) throw new Error('demo failed: agent acquired nothing')
      for (const r of results) {
        if (!r.mptBalance || r.mptBalance === '0') {
          throw new Error(`demo failed: no MPT balance for ${r.issuanceId}`)
        }
      }
    }

    console.log(deps.summary.render('Demo summary'))
    console.log('✅ DEMO_OK — RWA MPT acquired autonomously, key never left OWS')
  } finally {
    await merchant.close()
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`demo failed: ${err instanceof Error ? err.stack : String(err)}`)
    process.exit(1)
  })
