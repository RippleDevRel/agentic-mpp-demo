/**
 * OWS-backed PayChannel claim signer — the irreducible glue for channel mode.
 *
 * A PayChannel claim is a secp256k1 signature over
 * `sha512half(encodeForSigningClaim({ channel, amount }))`, with `amount` in
 * DROPS (note: xrpl.js `authorizeChannel` takes drops, while
 * `verifyPaymentChannelClaim` takes XRP and converts internally). That digest is
 * exactly what OWS `signHash` signs, so we can authorize cumulative claims with
 * the key never leaving the vault — reusing the recovered OWS public key.
 */
import { createHash } from 'node:crypto'
import { encodeForSigningClaim } from 'xrpl'
import type { OwsXrplSigner } from './ows-xrpl-signer'

/** A signed PayChannel claim (matches the SDK's `ChannelClaim` shape). */
export interface ChannelClaim {
  channelId: string
  /** Cumulative authorized amount in drops. */
  amount: string
  /** DER signature hex (uppercase). */
  signature: string
}

/** The 32-byte digest (hex) a PayChannel claim signs, for `channelId` + cumulative `drops`. */
export function claimDigestHex(channelId: string, drops: string): string {
  // xrpl's d.ts mistypes the claim arg as a full tx; the function takes {channel, amount}.
  const signingData = encodeForSigningClaim({ channel: channelId, amount: drops } as never)
  return createHash('sha512')
    .update(Buffer.from(signingData, 'hex'))
    .digest()
    .subarray(0, 32)
    .toString('hex')
}

/**
 * Signs cumulative PayChannel claims through OWS. The agent's channel public key
 * is the recovered OWS secp256k1 key, so the merchant verifies each claim with
 * `verifyPaymentChannelClaim(channelId, dropsToXrp(amount), signature, publicKey)`.
 */
export class OwsChannelClaimSigner {
  constructor(private readonly signer: OwsXrplSigner) {}

  /** The channel public key (recovered from OWS) the merchant verifies claims against. */
  publicKey(): string {
    return this.signer.publicKey()
  }

  /** Sign a cumulative claim for `drops` on `channelId` via OWS. */
  signClaim(channelId: string, drops: string): ChannelClaim {
    const signature = this.signer.signDigest(claimDigestHex(channelId, drops))
    return { channelId, amount: drops, signature }
  }
}
