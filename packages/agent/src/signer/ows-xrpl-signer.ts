/**
 * OWS signing bridge for XRPL — every agent write goes through here. OWS does
 * not expose the account public key and its signer assumes `SigningPubKey` is
 * already present, so this recovers the pubkey (ECDSA recovery), autofills/encodes
 * the tx, and hands it to OWS `signAndSend`; the private key never leaves the vault.
 * See the OwsXrplSigner class doc for the step-by-step.
 */
import { createHash } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1'
import { getWallet, signAndSend, signHash, signTransaction } from '@open-wallet-standard/core'
import type { Logger, NetworkConfig } from '@rwa/shared'
import { withClient } from '@rwa/shared'
import { type Client, encode, hashes, type SubmittableTransaction } from 'xrpl'

const XRPL_ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz'

/** XRPL classic address (Base58Check, version 0x00) from a compressed pubkey hex. */
function addressFromPubKey(pubHex: string): string {
  const pub = Buffer.from(pubHex, 'hex')
  const acctId = createHash('ripemd160').update(createHash('sha256').update(pub).digest()).digest()
  const payload = Buffer.concat([Buffer.from([0x00]), acctId])
  const checksum = createHash('sha256')
    .update(createHash('sha256').update(payload).digest())
    .digest()
    .subarray(0, 4)
  const full = Buffer.concat([payload, checksum])
  let num = BigInt(`0x${full.toString('hex')}`)
  let out = ''
  while (num > 0n) {
    out = XRPL_ALPHABET[Number(num % 58n)] + out
    num /= 58n
  }
  for (const b of full) {
    if (b === 0) out = XRPL_ALPHABET[0] + out
    else break
  }
  return out
}

export interface OwsXrplSignerOptions {
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

/**
 * Signs and submits arbitrary XRPL transactions through OWS so the private key
 * never enters this process. OWS does not expose the public key and its signer
 * expects `SigningPubKey` to be present in the tx blob, so we recover the
 * secp256k1 public key from a `signHash` signature (matching the OWS address),
 * set it as `SigningPubKey`, then hand the encoded tx to OWS `signAndSend` —
 * which injects `TxnSignature` and broadcasts over HTTP JSON-RPC.
 */
export class OwsXrplSigner {
  private readonly o: OwsXrplSignerOptions
  private cachedAddress?: string
  private cachedPubKey?: string
  /** Serializes OWS signing: the native signer + per-account sequence are not
   * safe under concurrent calls (a model may invoke signing tools in parallel),
   * so all signing/submitting runs one at a time. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: OwsXrplSignerOptions) {
    this.o = options
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** The agent's XRPL classic address (from the OWS vault). */
  address(): string {
    if (this.cachedAddress) return this.cachedAddress
    const info = getWallet(this.o.walletName, this.o.vaultPath ?? undefined)
    const acct = info.accounts.find((a) => a.chainId.startsWith('xrpl'))
    if (!acct) throw new Error('OWS wallet has no XRPL account')
    this.cachedAddress = acct.address
    return acct.address
  }

  /**
   * Recover the secp256k1 public key for the OWS XRPL account without the
   * private key leaving OWS: sign a known hash, then brute-force the ECDSA
   * recovery bit and keep the candidate whose address matches the vault address.
   */
  publicKey(): string {
    if (this.cachedPubKey) return this.cachedPubKey
    const address = this.address()
    const hashHex = createHash('sha256').update(`ows-signing-pubkey:${address}`).digest('hex')
    const sig = signHash(
      this.o.walletName,
      'xrpl',
      hashHex,
      this.o.credential,
      0,
      this.o.vaultPath ?? undefined,
    )
    const parsed = secp256k1.Signature.fromDER(Buffer.from(sig.signature, 'hex'))
    const msg = Buffer.from(hashHex, 'hex')
    for (const bit of [0, 1] as const) {
      const candidate = parsed.addRecoveryBit(bit).recoverPublicKey(msg).toHex(true).toUpperCase()
      if (addressFromPubKey(candidate) === address) {
        this.cachedPubKey = candidate
        return candidate
      }
    }
    throw new Error('failed to recover the OWS XRPL public key')
  }

  /**
   * Sign an arbitrary 32-byte digest (hex) via OWS and return the DER signature
   * hex. Used for off-ledger PayChannel claims (the key never leaves OWS). No
   * account sequence is involved, so this does not go through the signing mutex.
   */
  signDigest(hashHex: string): string {
    const sig = signHash(
      this.o.walletName,
      'xrpl',
      hashHex,
      this.o.credential,
      0,
      this.o.vaultPath ?? undefined,
    )
    return sig.signature.toUpperCase()
  }

  /**
   * Autofill and OWS-sign a transaction WITHOUT broadcasting, returning the
   * signed tx blob (hex) + its hash. Used for the MPP channel `open` credential,
   * which carries the signed `PaymentChannelCreate` blob for the merchant to
   * submit. Same SigningPubKey-injection trick as signAndSubmit; OWS signs the
   * tx and returns only the signature, which we assemble into the blob.
   */
  async signToBlob(
    tx: Partial<SubmittableTransaction> & { TransactionType: string },
  ): Promise<{ blob: string; hash: string }> {
    return this.runExclusive(async () => {
      const address = this.address()
      const pubKey = this.publicKey()
      return withClient(this.o.network.rpcUrl, async (client: Client) => {
        const prepared = (await client.autofill({
          Account: address,
          ...tx,
          SigningPubKey: pubKey,
        } as never)) as Record<string, unknown>
        delete prepared.TxnSignature
        delete prepared.NetworkID
        const { signature } = signTransaction(
          this.o.walletName,
          'xrpl',
          encode(prepared as never),
          this.o.credential,
          0,
          this.o.vaultPath ?? undefined,
        )
        const signed = { ...prepared, TxnSignature: signature.toUpperCase() }
        const blob = encode(signed as never)
        return { blob, hash: hashes.hashSignedTx(blob) }
      })
    })
  }

  /**
   * Autofill, sign through OWS, broadcast, and wait for validation. The tx's
   * `Account` defaults to this signer's address; `SigningPubKey` is set to the
   * recovered key; `NetworkID` is stripped (testnet/local network id <= 1024
   * must omit it). Throws if the tx does not reach `tesSUCCESS`.
   */
  async signAndSubmit(
    tx: Partial<SubmittableTransaction> & { TransactionType: string },
    opts: { label?: string } = {},
  ): Promise<SubmitResult> {
    const label = opts.label ?? tx.TransactionType
    // Serialize: even if the model invokes signing tools concurrently, OWS signing
    // and the account sequence are handled one tx at a time.
    return this.runExclusive(async () => {
      const address = this.address()
      const pubKey = this.publicKey()

      return withClient(this.o.network.rpcUrl, async (client: Client) => {
        const prepared = (await client.autofill({
          Account: address,
          ...tx,
          SigningPubKey: pubKey,
        } as never)) as Record<string, unknown>
        delete prepared.TxnSignature
        delete prepared.NetworkID

        const txHex = encode(prepared as never)
        this.o.log.ows(`signing via OWS (key isolated): ${label}`)
        const { txHash } = signAndSend(
          this.o.walletName,
          'xrpl',
          txHex,
          this.o.credential,
          0,
          this.o.network.httpRpcUrl,
          this.o.vaultPath ?? undefined,
        )

        const result = await this.waitValidated(client, txHash)
        this.o.log.txn(label, txHash, this.o.network.explorerTx?.(txHash))
        if (result.engineResult !== 'tesSUCCESS') {
          throw new Error(`${label} failed on-chain: ${result.engineResult} (${txHash})`)
        }
        return result
      })
    })
  }

  private async waitValidated(client: Client, hash: string, attempts = 25): Promise<SubmitResult> {
    for (let i = 0; i < attempts; i++) {
      const r = await client.request({ command: 'tx', transaction: hash }).catch(() => null)
      const res = r?.result as
        | { validated?: boolean; meta?: { TransactionResult?: string } }
        | undefined
      if (res?.validated) {
        return {
          hash,
          engineResult: res.meta?.TransactionResult ?? 'unknown',
          validated: true,
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    throw new Error(`tx ${hash} not validated within timeout`)
  }
}
