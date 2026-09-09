/**
 * Shared signer surface. Two OWS-backed signers implement `XrplSubmitSigner`:
 *  - NativeOwsSigner   — OWS `signAndSend` (the default for every non-channel
 *    flow; OWS injects `SigningPubKey` and broadcasts, so no pubkey recovery).
 *  - OwsXrplSigner     — `signHash` + ECDSA pubkey recovery (CHANNEL ONLY, where the
 *    pubkey is needed as a VALUE for `PaymentChannelCreate.PublicKey` + claims).
 * Agent tools depend on this interface, so they work with either signer.
 */
import type { Logger, NetworkConfig } from '@agentic-mpp-demo-xrpl/shared'
import type { Client, SubmittableTransaction } from 'xrpl'

/**
 * MPP on-chain attribution `SourceTag`, applied by default to every tx these OWS
 * signers submit so the agent's activity is trackable on-ledger as MPP traffic —
 * the same tag the SDK stamps on everything IT submits (`MPP_SOURCE_TAG`). We
 * mirror it here because the agent hand-rolls its transactions through OWS (the
 * key stays in the vault), so they never pass through the SDK's own defaulting.
 * A tx that already carries a `SourceTag` (e.g. one a 402 challenge requires)
 * keeps it. NOTE: the SDK does not re-export its `MPP_SOURCE_TAG` constant, so
 * the value (593184257) is duplicated here; keep it in sync until it is exported.
 */
export const MPP_SOURCE_TAG = 593184257

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
  /**
   * Autofill + OWS-sign a tx into a submittable blob WITHOUT broadcasting — the
   * counterparty submits it. Present ONLY on the recovery signer (OwsXrplSigner),
   * which sets the recovered `SigningPubKey` as a VALUE. The native signer relies
   * on OWS injecting that key during `signAndSend`, so it cannot hand back a blob
   * (this stays `undefined` there). Needed for the channel `open` blob and for MPP
   * charge PULL mode (the merchant submits the agent's signed Payment).
   */
  signToBlob?(tx: SignableTx): Promise<{ blob: string; hash: string }>
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
