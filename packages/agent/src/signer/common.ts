/**
 * Shared signer surface. Two OWS-backed signers implement `XrplSubmitSigner`:
 *  - NativeOwsSigner   — OWS 1.4.2 `signAndSend` (the default for every non-channel
 *    flow; OWS injects `SigningPubKey` and broadcasts, so no pubkey recovery).
 *  - OwsXrplSigner     — `signHash` + ECDSA pubkey recovery (CHANNEL ONLY, where the
 *    pubkey is needed as a VALUE for `PaymentChannelCreate.PublicKey` + claims).
 * Agent tools depend on this interface, so they work with either signer.
 */
import type { Logger, NetworkConfig } from '@agentic-mpp-demo-xrpl/shared'
import type { Client, SubmittableTransaction } from 'xrpl'

/** Construction options shared by both OWS signers. */
export interface OwsSignerOptions {
  /** OWS wallet name or id. */
  walletName: string
  /** Owner passphrase OR an `ows_key_...` agent token (token = policy-enforced). */
  credential: string
  /** OWS vault root (default ~/.ows). */
  vaultPath?: string
  network: NetworkConfig
  log: Logger
}

export interface SubmitResult {
  hash: string
  engineResult: string
  validated: boolean
}

/** A partial XRPL transaction with at least its type (Account etc. are autofilled). */
export type SignableTx = Partial<SubmittableTransaction> & { TransactionType: string }

/**
 * What every agent tool needs from a signer: the wallet address, and a way to
 * sign + submit + await validation of an XRPL transaction through OWS (the
 * private key never leaves the vault).
 */
export interface XrplSubmitSigner {
  /** The agent's XRPL classic address (from the OWS vault). */
  address(): string
  /** Autofill, OWS-sign, broadcast, and wait for validation. Throws unless tesSUCCESS. */
  signAndSubmit(tx: SignableTx, opts?: { label?: string }): Promise<SubmitResult>
}

/** Poll `tx` until the ledger validates `hash`, returning its on-chain result. */
export async function waitValidated(
  client: Client,
  hash: string,
  attempts = 25,
): Promise<SubmitResult> {
  for (let i = 0; i < attempts; i++) {
    const r = await client.request({ command: 'tx', transaction: hash }).catch(() => null)
    const res = r?.result as
      | { validated?: boolean; meta?: { TransactionResult?: string } }
      | undefined
    if (res?.validated) {
      return { hash, engineResult: res.meta?.TransactionResult ?? 'unknown', validated: true }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  throw new Error(`tx ${hash} not validated within timeout`)
}
