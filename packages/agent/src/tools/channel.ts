/**
 * Channel tools (agent side): open a PayChannel to the merchant, sign cumulative
 * vouchers, and close. All on-chain txs (PaymentChannelCreate/Claim) are signed
 * via OWS; the off-ledger claims are signed via the OWS claim signer — the key
 * never leaves the vault. XRP-only (PayChannels carry XRP), so no swap/trustline.
 */
import { type Logger, type NetworkConfig, withClient } from '@rwa/shared'
import type { ChannelClaim, OwsChannelClaimSigner } from '../signer/ows-channel-signer'
import type { OwsXrplSigner } from '../signer/ows-xrpl-signer'

/** PaymentChannelClaim flag: close the channel (funder only). */
const TF_CLOSE = 0x00020000

export interface OpenedChannel {
  channelId: string
  /** The channel public key the merchant verifies claims against (OWS-recovered). */
  publicKey: string
  /** Total XRP locked in the channel, in drops. */
  capacityDrops: string
  createHash: string
}

/** Read the created PayChannel's id (its ledger object index) from the create tx metadata. */
async function channelIdFromTx(network: NetworkConfig, txHash: string): Promise<string> {
  return withClient(network.rpcUrl, async (client) => {
    const res = await client.request({ command: 'tx', transaction: txHash })
    const meta = (res.result as { meta?: { AffectedNodes?: unknown[] } }).meta
    const nodes = meta?.AffectedNodes ?? []
    for (const node of nodes as Array<
      Record<string, { LedgerEntryType?: string; LedgerIndex?: string }>
    >) {
      const created = node.CreatedNode
      if (created?.LedgerEntryType === 'PayChannel' && created.LedgerIndex) {
        return created.LedgerIndex
      }
    }
    throw new Error(`no PayChannel created in tx ${txHash}`)
  })
}

/**
 * Open a PayChannel to `destination` funded with `amountDrops`, signed via OWS.
 * The channel public key is the agent's OWS-recovered secp256k1 key, so the
 * merchant can verify every claim. Returns the channel id (from tx metadata).
 */
export async function openChannel(
  signer: OwsXrplSigner,
  channelSigner: OwsChannelClaimSigner,
  network: NetworkConfig,
  params: { destination: string; amountDrops: string; settleDelay?: number },
  log: Logger,
): Promise<OpenedChannel> {
  const publicKey = channelSigner.publicKey()
  log.step('opening payment channel', {
    destination: params.destination,
    amountXrp: (Number(params.amountDrops) / 1e6).toFixed(6),
  })
  const submitted = await signer.signAndSubmit(
    {
      TransactionType: 'PaymentChannelCreate',
      Destination: params.destination,
      Amount: params.amountDrops,
      SettleDelay: params.settleDelay ?? 86400,
      PublicKey: publicKey,
    },
    { label: 'PaymentChannelCreate' },
  )
  const channelId = await channelIdFromTx(network, submitted.hash)
  log.step('payment channel open', {
    channelId,
    capacityXrp: (Number(params.amountDrops) / 1e6).toFixed(6),
  })
  return { channelId, publicKey, capacityDrops: params.amountDrops, createHash: submitted.hash }
}

/** Sign a cumulative voucher for `cumulativeDrops` on the channel (off-ledger, via OWS). */
export function signVoucher(
  channelSigner: OwsChannelClaimSigner,
  channelId: string,
  cumulativeDrops: string,
  log: Logger,
): ChannelClaim {
  const claim = channelSigner.signClaim(channelId, cumulativeDrops)
  log.mpp('signed channel voucher', {
    channelId,
    cumulativeXrp: (Number(cumulativeDrops) / 1e6).toFixed(6),
  })
  return claim
}

/**
 * Close the channel on-chain (funder-side `tfClose`), starting the settle delay
 * after which the unspent XRP returns to the agent. Signed via OWS.
 */
export async function closeChannel(
  signer: OwsXrplSigner,
  network: NetworkConfig,
  channelId: string,
  log: Logger,
): Promise<{ hash: string }> {
  log.step('closing payment channel (tfClose)', { channelId })
  const submitted = await signer.signAndSubmit(
    { TransactionType: 'PaymentChannelClaim', Channel: channelId, Flags: TF_CLOSE },
    { label: 'PaymentChannelClaim (close)' },
  )
  return { hash: submitted.hash }
}
