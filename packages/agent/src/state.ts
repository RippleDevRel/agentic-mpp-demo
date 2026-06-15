/**
 * Persisted agent wallet capability, stored under `.data/` (gitignored). Holds
 * the OWS API token (a policy-bound capability, NOT the private key), the
 * address / policy id, the per-tx spend cap, and the acquired-issuance set.
 * Load/save helpers below.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { NetworkName } from '@rwa/shared'

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

function storePath(network: NetworkName): string {
  return resolve('.data', `agent.${network}.json`)
}

export function loadAgentStore(network: NetworkName): AgentStore | undefined {
  const path = storePath(network)
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8')) as AgentStore
}

export function saveAgentStore(store: AgentStore): void {
  const path = storePath(store.network)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}
