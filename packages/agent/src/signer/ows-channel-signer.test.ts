import { secp256k1 } from '@noble/curves/secp256k1'
import { describe, expect, it } from 'vitest'
import { authorizeChannel, dropsToXrp, ECDSA, verifyPaymentChannelClaim, Wallet } from 'xrpl'
import { claimDigestHex } from './ows-channel-signer'

const CHANNEL_ID = '5DB01B7FFED6B67E6B0414DED11E051D2EE2B7619CE0EAA6286D67A3A4D5BDB3'

describe('claimDigestHex (PayChannel claim digest)', () => {
  // OWS signs this digest; prove the digest + DER path reproduces xrpl.js
  // `authorizeChannel` exactly (so an OWS-signed claim verifies on the merchant).
  it('reproduces authorizeChannel and verifies for a secp256k1 key', () => {
    const wallet = Wallet.generate(ECDSA.secp256k1)
    const drops = '1000000'

    const digest = claimDigestHex(CHANNEL_ID, drops)
    const priv = wallet.privateKey.replace(/^00/, '') // 32-byte secp256k1 scalar
    const der = secp256k1.sign(digest, priv, { lowS: true }).toDERHex().toUpperCase()

    // Same signature xrpl.js would produce from the private key.
    expect(der).toBe(authorizeChannel(wallet, CHANNEL_ID, drops).toUpperCase())
    // And the merchant accepts it (verify takes XRP, not drops).
    expect(
      verifyPaymentChannelClaim(CHANNEL_ID, dropsToXrp(drops).toString(), der, wallet.publicKey),
    ).toBe(true)
  })

  it('is deterministic and amount-specific', () => {
    expect(claimDigestHex(CHANNEL_ID, '1000000')).toBe(claimDigestHex(CHANNEL_ID, '1000000'))
    expect(claimDigestHex(CHANNEL_ID, '1000000')).not.toBe(claimDigestHex(CHANNEL_ID, '2000000'))
  })
})
