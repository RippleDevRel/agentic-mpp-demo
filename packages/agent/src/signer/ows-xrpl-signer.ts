/**
 * OWS signing bridge for XRPL — CHANNEL MODE ONLY. Every NON-channel write uses
 * NativeOwsSigner (OWS 1.4.2 `signAndSend`, no pubkey needed). This signer exists
 * because payment channels need the account public key as a VALUE — for
 * `PaymentChannelCreate.PublicKey` and to verify off-ledger claims — and OWS does
 * not expose it. So this recovers the secp256k1 pubkey (ECDSA recovery from a
 * `signHash` signature), sets it as `SigningPubKey`, signs the tx's signing hash
 * via `signHash`, and broadcasts the assembled blob itself via xrpl.js. The same
 * path also yields the channel `open` blob WITHOUT broadcasting (the merchant
 * submits it), and `signDigest` signs off-ledger claims. The private key never
 * leaves the vault. (Exposing the pubkey upstream would let channel mode drop
 * the recovery and use the native signer like everything else.)
 */
import { createHash } from 'node:crypto'
import { withClient } from '@agentic-mpp-demo-xrpl/shared'
import { secp256k1 } from '@noble/curves/secp256k1'
import { getWallet, signHash } from '@open-wallet-standard/core'
import { type Client, encode, encodeForSigning, hashes } from 'xrpl'
import {
  type OwsSignerOptions,
  type SignableTx,
  type SubmitResult,
  waitValidated,
  type XrplSubmitSigner,
} from './common'

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

/**
 * Channel-mode signer: signs + submits XRPL transactions through OWS so the
 * private key never enters this process, AND exposes the recovered public key
 * (`publicKey()`), an unbroadcast blob builder (`signToBlob`), and a raw digest
 * signer (`signDigest`) that channel mode needs. OWS does not expose the public
 * key, so we recover the secp256k1 key from a `signHash` signature (matching the
 * OWS address), set it as `SigningPubKey`, sign the tx's signing hash via
 * `signHash`, and broadcast the assembled blob ourselves via xrpl.js.
 */
export class OwsXrplSigner implements XrplSubmitSigner {
  private readonly o: OwsSignerOptions
  private cachedAddress?: string
  private cachedPubKey?: string
  /** Serializes OWS signing: the native signer + per-account sequence are not
   * safe under concurrent calls (a model may invoke signing tools in parallel),
   * so all signing/submitting runs one at a time. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: OwsSignerOptions) {
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
   * Autofill + OWS-sign a tx into a signed blob, via `signHash`. This is the
   * shared signing core for both signToBlob and signAndSubmit. The XRPL single-sign
   * hash is `sha512half(encodeForSigning(tx))` with `SigningPubKey` (the recovered
   * key) set; we sign that digest via `signHash` and assemble the blob. Using
   * `signHash` (not `signAndSend`) keeps one path that also yields the unbroadcast
   * channel `open` blob and reuses the recovered pubkey OWS won't expose.
   */
  private async buildSignedBlob(
    client: Client,
    tx: SignableTx,
  ): Promise<{ blob: string; hash: string }> {
    const prepared = (await client.autofill({
      Account: this.address(),
      ...tx,
      SigningPubKey: this.publicKey(),
    } as never)) as Record<string, unknown>
    delete prepared.TxnSignature
    delete prepared.NetworkID
    const digest = createHash('sha512')
      .update(Buffer.from(encodeForSigning(prepared as never), 'hex'))
      .digest()
      .subarray(0, 32)
      .toString('hex')
    const blob = encode({ ...prepared, TxnSignature: this.signDigest(digest) } as never)
    return { blob, hash: hashes.hashSignedTx(blob) }
  }

  /** Sign a tx into a blob WITHOUT broadcasting — for the MPP channel `open`
   * credential, whose `PaymentChannelCreate` blob the merchant submits. */
  async signToBlob(tx: SignableTx): Promise<{ blob: string; hash: string }> {
    return this.runExclusive(() =>
      withClient(this.o.network.rpcUrl, (client: Client) => this.buildSignedBlob(client, tx)),
    )
  }

  /**
   * Autofill, sign through OWS, broadcast, and wait for validation. The tx's
   * `Account` defaults to this signer's address; `SigningPubKey` is set to the
   * recovered key; `NetworkID` is stripped (testnet/local network id <= 1024
   * must omit it). Throws if the tx does not reach `tesSUCCESS`.
   */
  async signAndSubmit(tx: SignableTx, opts: { label?: string } = {}): Promise<SubmitResult> {
    const label = opts.label ?? tx.TransactionType
    // Serialize: even if the model invokes signing tools concurrently, OWS signing
    // and the account sequence are handled one tx at a time.
    return this.runExclusive(async () => {
      return withClient(this.o.network.rpcUrl, async (client: Client) => {
        this.o.log.ows(`signing via OWS (key isolated): ${label}`)
        const { blob, hash } = await this.buildSignedBlob(client, tx)
        // Broadcast the OWS-signed blob ourselves via xrpl.js (WebSocket).
        const submit = (await client.submit(blob)) as { result?: { engine_result?: string } }
        const prelim = submit.result?.engine_result ?? ''
        // tem/tef/tel never make it into a ledger → fail fast (tec is included, so let it validate).
        if (prelim && !/^(tes|ter|tec)/.test(prelim)) {
          throw new Error(`${label} rejected on submit: ${prelim} (${hash})`)
        }
        const result = await waitValidated(client, hash)
        this.o.log.txn(label, hash, this.o.network.explorerTx?.(hash))
        if (result.engineResult !== 'tesSUCCESS') {
          throw new Error(`${label} failed on-chain: ${result.engineResult} (${hash})`)
        }
        return result
      })
    })
  }
}
