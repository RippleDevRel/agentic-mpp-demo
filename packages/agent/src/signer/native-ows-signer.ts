/**
 * Native OWS signer — the default path for every NON-channel agent write
 * (opt-in, trustline, swap, MPP payment). Uses OWS 1.4.2 `signAndSend`: OWS
 * accepts the policy-bound API token, injects `SigningPubKey` itself, signs, and
 * broadcasts — so this never needs the account public key (no ECDSA recovery).
 * The private key never leaves the vault.
 *
 * Flow per tx: autofill via xrpl.js (Account/Sequence/Fee/LastLedgerSequence,
 * WITHOUT SigningPubKey — OWS rejects a SigningPubKey on an unsigned tx and does
 * NOT autofill those fields itself), encode to hex, hand the hex to OWS
 * `signAndSend` over the HTTP JSON-RPC endpoint (it does not speak wss), then wait
 * for validation via the WebSocket client. Channel mode uses OwsXrplSigner instead.
 */
import { withClient } from '@agentic-mpp-demo-xrpl/shared'
import { getWallet, signAndSend } from '@open-wallet-standard/core'
import { type Client, encode } from 'xrpl'
import {
  type OwsSignerOptions,
  type SignableTx,
  type SubmitResult,
  waitValidated,
  type XrplSubmitSigner,
} from './common'

export class NativeOwsSigner implements XrplSubmitSigner {
  private readonly o: OwsSignerOptions
  private cachedAddress?: string
  /** Serializes signing: OWS signing + the per-account sequence are not safe under
   * concurrent calls (the model may invoke signing tools in parallel). */
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
   * Autofill, OWS-sign + broadcast via `signAndSend`, and wait for validation.
   * `Account` defaults to this signer's address. `SigningPubKey` is NOT set (OWS
   * injects it); `NetworkID` is stripped (testnet/local ids must omit it). Throws
   * if the tx is denied by the policy or does not reach `tesSUCCESS`.
   */
  async signAndSubmit(tx: SignableTx, opts: { label?: string } = {}): Promise<SubmitResult> {
    const label = opts.label ?? tx.TransactionType
    return this.runExclusive(async () => {
      return withClient(this.o.network.rpcUrl, async (client: Client) => {
        this.o.log.ows(`signing via OWS native (key isolated): ${label}`)
        const prepared = (await client.autofill({
          Account: this.address(),
          ...tx,
        } as never)) as Record<string, unknown>
        // OWS injects SigningPubKey and signs; an unsigned tx must carry neither it
        // nor a signature, and testnet rejects a NetworkID for its small network id.
        delete prepared.SigningPubKey
        delete prepared.TxnSignature
        delete prepared.NetworkID
        const txHex = encode(prepared as never)
        // OWS signs (token => policy-enforced) and broadcasts over HTTP JSON-RPC.
        const { txHash } = signAndSend(
          this.o.walletName,
          'xrpl',
          txHex,
          this.o.credential,
          0,
          this.o.network.httpRpcUrl,
          this.o.vaultPath ?? undefined,
        )
        const result = await waitValidated(client, txHash)
        this.o.log.txn(label, txHash, this.o.network.explorerTx?.(txHash))
        if (result.engineResult !== 'tesSUCCESS') {
          throw new Error(`${label} failed on-chain: ${result.engineResult} (${txHash})`)
        }
        return result
      })
    })
  }
}
