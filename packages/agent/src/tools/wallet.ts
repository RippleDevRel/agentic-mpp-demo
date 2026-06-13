import {
  createApiKey,
  createPolicy,
  createWallet,
  getWallet,
  listWallets,
} from '@open-wallet-standard/core'
import { getEnv, type Logger, type NetworkConfig, requireEnv } from '@rwa/shared'
import { OwsXrplSigner } from '../signer/ows-xrpl-signer'
import { type AgentStore, loadAgentStore, saveAgentStore } from '../state'

/** OWS uses the `xrpl:mainnet` chain id for XRPL (addresses are network-agnostic). */
const XRPL_CHAIN_ID = 'xrpl:mainnet'

export interface AgentWallet {
  signer: OwsXrplSigner
  address: string
  store: AgentStore
}

/**
 * Ensure the agent has an OWS-managed wallet bounded by a policy, and return a
 * signer that uses the policy-enforced API token. The private key is generated
 * inside OWS and never leaves it. The policy restricts signing to XRPL only and
 * expires; spend is additionally capped in-app by MAX_SPEND (OWS declarative
 * policies have no native amount rule — see FINDINGS.md).
 */
export async function ensureAgentWallet(network: NetworkConfig, log: Logger): Promise<AgentWallet> {
  const vaultPath = getEnv('OWS_VAULT_PATH')
  const walletName = getEnv('OWS_WALLET_NAME') ?? 'agent-treasury'

  const existing = loadAgentStore(network.name)
  if (existing) {
    log.info('reusing OWS agent wallet', { address: existing.address })
    const signer = new OwsXrplSigner({
      walletName: existing.walletName,
      credential: existing.token,
      vaultPath,
      network,
      log,
    })
    return { signer, address: existing.address, store: existing }
  }

  const ownerPassphrase = requireEnv('OWS_PASSPHRASE')

  // Create (or adopt) the OWS wallet. The key is generated and stays in OWS.
  const present = listWallets(vaultPath ?? undefined).find((w) => w.name === walletName)
  const wallet = present ?? createWallet(walletName, ownerPassphrase, 12, vaultPath ?? undefined)
  const info = getWallet(wallet.id, vaultPath ?? undefined)
  const xrpl = info.accounts.find((a) => a.chainId.startsWith('xrpl'))
  if (!xrpl) throw new Error('OWS wallet has no XRPL account')
  log.step('OWS agent wallet ready (key generated inside OWS)', { address: xrpl.address })

  // Bound the agent: XRPL-only chain allowlist + expiry.
  const policyId = `${walletName}-xrpl-only`
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  const policy = {
    id: policyId,
    name: 'Agent: XRPL only, time-bounded',
    version: 1,
    created_at: new Date().toISOString(),
    rules: [
      { type: 'allowed_chains', chain_ids: [XRPL_CHAIN_ID] },
      { type: 'expires_at', timestamp: expiresAt },
    ],
    action: 'deny',
  }
  try {
    createPolicy(JSON.stringify(policy), vaultPath ?? undefined)
    log.step('registered OWS policy', { policyId, allow: XRPL_CHAIN_ID, expiresAt })
  } catch (err) {
    log.warn('policy creation skipped (may already exist)', {
      msg: err instanceof Error ? err.message : String(err),
    })
  }

  // Mint a policy-enforced agent token. Signing with this token (not the owner
  // passphrase) is what makes the policy bind at signing time.
  const key = createApiKey(
    `${walletName}-agent`,
    [wallet.id],
    [policyId],
    ownerPassphrase,
    expiresAt,
    vaultPath ?? undefined,
  )
  log.step('issued OWS agent token (policy-enforced)', { keyId: key.id })

  const store: AgentStore = {
    walletId: wallet.id,
    walletName,
    address: xrpl.address,
    policyId,
    token: key.token,
    network: network.name,
    acquired: [],
  }
  saveAgentStore(store)

  const signer = new OwsXrplSigner({ walletName, credential: key.token, vaultPath, network, log })
  return { signer, address: xrpl.address, store }
}
