/**
 * Persisted agent wallet capability, stored under `.data/` (gitignored). Holds
 * the OWS API token (a policy-bound capability, NOT the private key), the
 * address / policy id, the per-tx spend cap, and the acquired-issuance set.
 * Load/save helpers below.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { NetworkName } from '@agentic-mpp-demo-xrpl/shared'

/**
 * Persisted agent wallet capability. The `token` is an OWS API key (a
 * capability, not the private key — the key never leaves the OWS vault) used to
 * sign with policy enforcement. Stored under `.data/` (gitignored).
 */
export interface AgentStore {
  walletId: string
  walletName: string
  address: string
  policyId: string
  /** ows_key_... agent token used for policy-enforced signing. */
  token: string
  network: NetworkName
  /**
   * Per-transaction XRP spend cap baked into the OWS policy. The OWS executable
   * policy is the sole *enforcer*; this copy is read only for provisioning
   * (faucet funding) and to report the cap to the model — never to gate a
   * payment in app code.
   */
  maxSpendXrp: number
  /** issuance_ids the agent has already acquired (dedup). */
  acquired: string[]
}

/**
 * Store file path, scoped by BOTH network and wallet name. Keying by network
 * alone let two profiles that share a network collide — e.g. the `pnpm demo`
 * wallet (`agent-treasury-demo`, `.ows-demo` vault) and an ambient-`.env` run
 * (`agent-treasury`, `~/.ows`) overwrote each other's capability, so whichever
 * ran last left the other pointing at a wallet its vault doesn't hold.
 */
function storePath(network: NetworkName, walletName: string): string {
  return resolve('.data', `agent.${network}.${walletName}.json`)
}

export function loadAgentStore(network: NetworkName, walletName: string): AgentStore | undefined {
  const path = storePath(network, walletName)
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8')) as AgentStore
}

export function saveAgentStore(store: AgentStore): void {
  const path = storePath(store.network, store.walletName)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}
