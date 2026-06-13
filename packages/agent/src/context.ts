import {
  createLogger,
  getEnv,
  getEnvNumber,
  RunSummary,
  requireEnv,
  resolveConfig,
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
 * The single runtime instruction is the goal sentence built from MERCHANT_ADDRESS.
 */
export async function buildAgentContext(): Promise<AgentContext> {
  const { network, payment } = resolveConfig()
  const log = createLogger('agent')
  const summary = new RunSummary()

  const { signer, store } = await ensureAgentWallet(network, log)
  summary.add('Wallet (OWS, key isolated)', signer.address())

  const merchantAddress = requireEnv('MERCHANT_ADDRESS')
  const merchantUrl = getEnv('MERCHANT_URL') ?? 'http://localhost:8787'

  const deps: AcquireDeps = {
    signer,
    network,
    payment,
    merchantUrl,
    merchantAddress,
    maxSpendXrp: getEnvNumber('MAX_SPEND', 50),
    slippageBps: getEnvNumber('SWAP_SLIPPAGE_BPS', 100),
    log,
    summary,
  }

  const goal = `Acquire every RWA token issued by merchant ${merchantAddress} on the XRP Ledger.`
  return { deps, store, goal }
}
