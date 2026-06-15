/**
 * Agent bootstrap. The single setup entry (`buildAgentContext`): load env,
 * resolve the network, ensure the OWS wallet/policy/token, and assemble the
 * shared `deps` bundle + goal consumed by both the model loop (loop.ts) and the
 * deterministic pipeline (pipeline.ts).
 */
import {
  createLogger,
  getEnv,
  getEnvNumber,
  loadEnv,
  RunSummary,
  resolveNetwork,
} from '@rwa/shared'
import type { AcquireDeps } from './pipeline'
import type { AgentStore } from './state'
import { ensureAgentWallet } from './tools/wallet'

export interface AgentContext {
  deps: AcquireDeps
  store: AgentStore
  goal: string
}

/**
 * Resolve config, ensure the OWS wallet, and assemble the shared dependency
 * bundle used by both the model-driven loop and the deterministic pipeline.
 * The single runtime input is the seller's service endpoint (MERCHANT_URL) — the
 * agent is NOT given the merchant's ledger address; it learns the payment
 * recipient from each resource's 402 challenge.
 */
export async function buildAgentContext(): Promise<AgentContext> {
  // The agent resolves only the network. It deliberately does NOT resolve a
  // payment currency — it learns currency + issuer from each resource's 402.
  loadEnv()
  const network = resolveNetwork()
  const log = createLogger('agent')
  const summary = new RunSummary()

  const { signer, store } = await ensureAgentWallet(network, log)
  summary.add('Wallet (OWS, key isolated)', signer.address())

  const merchantUrl = getEnv('MERCHANT_URL') ?? 'http://localhost:8787'

  // MAX_SPEND is NOT carried in deps: it is enforced solely by the OWS policy and
  // persisted on the store (read for provisioning / reporting, never to gate a tx).
  const deps: AcquireDeps = {
    signer,
    network,
    merchantUrl,
    slippageBps: getEnvNumber('SWAP_SLIPPAGE_BPS', 100),
    log,
    summary,
  }

  const goal = `Acquire every RWA token available from the merchant whose service endpoint is ${merchantUrl}.`
  return { deps, store, goal }
}
