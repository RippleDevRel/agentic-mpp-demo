/**
 * Phase 2 verification: prove the agent can create an OWS wallet, fund it, and
 * sign + submit an arbitrary XRPL tx with the private key never leaving OWS.
 *
 * Usage: OWS_PASSPHRASE=... NETWORK=testnet tsx packages/agent/src/verify-signer.ts
 */
import { createLogger, resolveConfig } from '@rwa/shared'
import { ensureFunded } from './tools/funding'
import { ensureAgentWallet } from './tools/wallet'

async function main(): Promise<void> {
  const { network } = resolveConfig()
  const log = createLogger('verify-signer')

  const { signer, address } = await ensureAgentWallet(network, log)
  log.info('agent address', { address, pubKey: signer.publicKey() })

  await ensureFunded(address, network, { ownerObjects: 2, swapBudgetXrp: '12' }, log)

  const res = await signer.signAndSubmit(
    { TransactionType: 'AccountSet' },
    { label: 'AccountSet (no-op)' },
  )
  log.info('signed + submitted through OWS', { hash: res.hash, engineResult: res.engineResult })
  console.log('PHASE2_OK')
}

main().catch((err) => {
  console.error(`verify-signer failed: ${err instanceof Error ? err.stack : String(err)}`)
  process.exit(1)
})
