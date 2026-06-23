/**
 * Live testnet check for the agent-side PayChannel mechanics (OWS-only):
 * open a channel, sign a cumulative voucher, and verify it with xrpl.js — the
 * key never leaving OWS. Proves the channel keystone before wiring the merchant.
 *
 * Run: pnpm check:channel
 */
import { dropsToXrp, verifyPaymentChannelClaim, Wallet } from 'xrpl'
import { buildAgentContext } from '../packages/agent/src/context'
import { OwsChannelClaimSigner } from '../packages/agent/src/signer/ows-channel-signer'
import { OwsXrplSigner } from '../packages/agent/src/signer/ows-xrpl-signer'
import { openChannel, signVoucher } from '../packages/agent/src/tools/channel'
import { ensureFunded } from '../packages/agent/src/tools/funding'

async function main(): Promise<void> {
  // Channel mode uses the OWS pubkey-recovery signer (native OWS can't expose it).
  const { deps } = await buildAgentContext({ signerKind: 'channel' })
  const { signer, network, log } = deps
  if (!(signer instanceof OwsXrplSigner))
    throw new Error('channel check requires the recovery signer')

  // Fund the agent enough for a 50 XRP channel + reserves + fees.
  await ensureFunded(signer.address(), network, { ownerObjects: 1, swapBudgetXrp: '55' }, log)

  // A throwaway destination must exist on-ledger; pull it from the faucet.
  const dest = Wallet.generate()
  log.step('funding a throwaway channel destination', { address: dest.classicAddress })
  await fetch('https://faucet.altnet.rippletest.net/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ destination: dest.classicAddress }),
  })
  await new Promise((r) => setTimeout(r, 8000))

  const channelSigner = new OwsChannelClaimSigner(signer)
  const channel = await openChannel(
    signer,
    channelSigner,
    network,
    { destination: dest.classicAddress, amountDrops: '50000000' },
    log,
  )

  const cumulativeDrops = '10000000' // 10 XRP committed
  const claim = signVoucher(channelSigner, channel.channelId, cumulativeDrops, log)
  const ok = verifyPaymentChannelClaim(
    channel.channelId,
    dropsToXrp(claim.amount).toString(),
    claim.signature,
    channel.publicKey,
  )

  log.info('voucher verification', { ok, cumulativeXrp: 10 })
  if (!ok) throw new Error('voucher did not verify against the OWS channel public key')
  console.log('✅ CHANNEL_OK — opened a PayChannel and signed a verifiable voucher via OWS')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`channel check failed: ${err instanceof Error ? err.stack : String(err)}`)
    process.exit(1)
  })
