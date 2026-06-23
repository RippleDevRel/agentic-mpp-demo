/**
 * OWS wallet provisioning: create (or reuse) the vault wallet whose key is
 * generated inside OWS, bind it with a policy (XRPL-only, expiry, executable
 * spend cap), and mint the policy-enforced API token the agent signs with.
 * Returns a signer (native by default, or the channel signer) plus the store.
 */
import { chmodSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  getEnv,
  getEnvNumber,
  type Logger,
  type NetworkConfig,
  requireEnv,
} from '@agentic-mpp-demo-xrpl/shared'
import {
  createApiKey,
  createPolicy,
  createWallet,
  getWallet,
  listWallets,
} from '@open-wallet-standard/core'
import type { OwsSignerOptions, XrplSubmitSigner } from '../signer/common'
import { NativeOwsSigner } from '../signer/native-ows-signer'
import { OwsXrplSigner } from '../signer/ows-xrpl-signer'
import { type AgentStore, loadAgentStore, saveAgentStore } from '../state'

/**
 * Which OWS signer to build. `native` (default) uses OWS 1.4.2 `signAndSend` for
 * every ordinary write. `channel` uses the `signHash` + pubkey-recovery signer,
 * which payment-channel mode needs (the pubkey as a value for the channel + claims).
 */
export type SignerKind = 'native' | 'channel'

function makeSigner(kind: SignerKind, options: OwsSignerOptions): XrplSubmitSigner {
  return kind === 'channel' ? new OwsXrplSigner(options) : new NativeOwsSigner(options)
}

/** OWS uses the `xrpl:mainnet` chain id for XRPL (addresses are network-agnostic). */
const XRPL_CHAIN_ID = 'xrpl:mainnet'

/** Minimum owner-passphrase length. It is the secret that encrypts the key at rest. */
const MIN_PASSPHRASE_LENGTH = 12
/** Known trivial defaults we refuse to protect a real key with. */
const WEAK_PASSPHRASES = new Set(['demo-owner-pass', 'password', 'changeme', 'passphrase'])

/**
 * Resolve the OWS owner passphrase, refusing empty/weak values. OWS itself does
 * NOT enforce passphrase strength — `createWallet` will happily "encrypt" the
 * owner key copy with an empty or trivial passphrase (scrypt over a zero-entropy
 * secret = no real protection). Since this passphrase is the at-rest encryption
 * key for the wallet, we require a non-trivial one here.
 */
function requireStrongOwnerPassphrase(): string {
  const p = requireEnv('OWS_PASSPHRASE')
  if (p.trim().length < MIN_PASSPHRASE_LENGTH || WEAK_PASSPHRASES.has(p)) {
    throw new Error(
      `OWS_PASSPHRASE is too weak — it encrypts the wallet key at rest. Use at least ${MIN_PASSPHRASE_LENGTH} non-trivial characters (e.g. a passphrase from a manager).`,
    )
  }
  return p
}

/** Absolute path to the executable spend-cap policy, made runnable for OWS. */
function maxSpendPolicyExecutable(): string {
  const path = fileURLToPath(new URL('../../policy/max-spend.mjs', import.meta.url))
  chmodSync(path, 0o755)
  return path
}

export interface AgentWallet {
  signer: XrplSubmitSigner
  address: string
  store: AgentStore
}

/**
 * Ensure the agent has an OWS-managed wallet bounded by a policy, and return a
 * signer that uses the policy-enforced API token. The private key is generated
 * inside OWS and never leaves it. The policy restricts signing to XRPL only,
 * expires, and caps per-transaction XRP spend at MAX_SPEND via an OWS executable
 * policy (enforced on-device before signing — see policy/max-spend.mjs).
 */
export async function ensureAgentWallet(
  network: NetworkConfig,
  log: Logger,
  kind: SignerKind = 'native',
): Promise<AgentWallet> {
  const vaultPath = getEnv('OWS_VAULT_PATH')
  const walletName = getEnv('OWS_WALLET_NAME') ?? 'agent-treasury'

  const existing = loadAgentStore(network.name)
  if (existing) {
    log.ows('reusing OWS agent wallet', { address: existing.address })
    // Backfill for stores written before maxSpendXrp was persisted; the active
    // enforcement is the policy created earlier, so keep the env value as a hint.
    existing.maxSpendXrp ??= getEnvNumber('MAX_SPEND', 50)
    const signer = makeSigner(kind, {
      walletName: existing.walletName,
      credential: existing.token,
      vaultPath: vaultPath ?? undefined,
      network,
      log,
    })
    return { signer, address: existing.address, store: existing }
  }

  const ownerPassphrase = requireStrongOwnerPassphrase()

  // Create (or adopt) the OWS wallet. The key is generated and stays in OWS.
  const present = listWallets(vaultPath ?? undefined).find((w) => w.name === walletName)
  const wallet = present ?? createWallet(walletName, ownerPassphrase, 12, vaultPath ?? undefined)
  const info = getWallet(wallet.id, vaultPath ?? undefined)
  const xrpl = info.accounts.find((a) => a.chainId.startsWith('xrpl'))
  if (!xrpl) throw new Error('OWS wallet has no XRPL account')
  log.ows('OWS agent wallet ready (key generated inside OWS)', { address: xrpl.address })

  // Bound the agent: XRPL-only chain allowlist + expiry (declarative), AND a
  // per-transaction XRP spend cap enforced on-device by an executable policy
  // (OWS refuses to sign any tx spending more than MAX_SPEND XRP).
  const policyId = `${walletName}-xrpl-only`
  const maxSpendXrp = getEnvNumber('MAX_SPEND', 50)
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  const policy = {
    id: policyId,
    name: 'Agent: XRPL only, time-bounded, spend-capped',
    version: 1,
    created_at: new Date().toISOString(),
    rules: [
      { type: 'allowed_chains', chain_ids: [XRPL_CHAIN_ID] },
      { type: 'expires_at', timestamp: expiresAt },
    ],
    executable: maxSpendPolicyExecutable(),
    config: { maxSpendXrp },
    action: 'deny',
  }
  try {
    createPolicy(JSON.stringify(policy), vaultPath ?? undefined)
    log.ows('registered OWS policy', { policyId, allow: XRPL_CHAIN_ID, maxSpendXrp, expiresAt })
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
  log.ows('issued OWS agent token (policy-enforced)', { keyId: key.id })

  const store: AgentStore = {
    walletId: wallet.id,
    walletName,
    address: xrpl.address,
    policyId,
    token: key.token,
    network: network.name,
    maxSpendXrp,
    acquired: [],
  }
  saveAgentStore(store)

  const signer = makeSigner(kind, {
    walletName,
    credential: key.token,
    vaultPath: vaultPath ?? undefined,
    network,
    log,
  })
  return { signer, address: xrpl.address, store }
}
