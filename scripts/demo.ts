/**
 * End-to-end demo orchestrator: boot the merchant, point the agent at it, run the
 * autonomous acquisition, and assert the RWA MPT lands in the agent wallet.
 *
 * Runs on testnet. With ANTHROPIC_API_KEY set, the agent is model-driven; otherwise
 * it runs the deterministic pipeline (same tools).
 *
 * Run: pnpm demo
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildAgentContext, runAcquisition, runAgentLoop } from '@rwa/agent'
import { startServer } from '@rwa/merchant'
import { colorLegend, getEnv } from '@rwa/shared'

function setDefault(key: string, value: string): void {
  if (!process.env[key]) process.env[key] = value
}

/**
 * Return a strong random owner passphrase for the demo, persisted (0600) inside
 * the vault dir so it stays in sync with the wallet: deleting the vault also
 * drops the passphrase (fresh wallet next run), and reruns reuse the same one.
 * Never a hardcoded/public default — it is the at-rest encryption secret.
 */
function ensureDemoPassphrase(vaultPath: string): string {
  const file = resolve(vaultPath, '.demo-passphrase')
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  mkdirSync(vaultPath, { recursive: true })
  const passphrase = randomBytes(24).toString('base64url')
  writeFileSync(file, passphrase, { mode: 0o600 })
  return passphrase
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
  setDefault('OWS_VAULT_PATH', '.ows-demo')
  setDefault('OWS_WALLET_NAME', 'agent-treasury-demo')
  // The owner passphrase encrypts the wallet key at rest — never a public default.
  // Generate a strong random one and persist it alongside the vault so reruns reuse
  // the same wallet (token minting on reuse needs the original passphrase).
  setDefault('OWS_PASSPHRASE', ensureDemoPassphrase(process.env.OWS_VAULT_PATH ?? '.ows-demo'))
  setDefault('MAX_SPEND', '50')
  setDefault('SWAP_SLIPPAGE_BPS', '1000')

  console.log(colorLegend())
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
