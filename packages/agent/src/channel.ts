/**
 * Autonomous buyer agent — PAYMENT CHANNEL mode (deterministic driver).
 *
 * Stays faithful to MPP: the merchant DRIVES via 402 `channel` challenges. The
 * agent ventures from the /catalog hint to /subscribe, opens an XRP PayChannel
 * (OWS-signed PaymentChannelCreate blob in the MPP `open` credential — the server
 * submits it), then buys each freshly-issued RWA MPT with a cumulative `voucher`
 * (an OWS-signed claim) until it nears the channel capacity, then closes. The
 * key never leaves OWS. No swap/trustline — channels are XRP-only.
 *
 * Run: pnpm agent:channel   (against a running `pnpm merchant:channel`)
 */
import { getEnvNumber, listMptHoldings, withClient } from '@agentic-mpp-demo-xrpl/shared'
import { Challenge, Credential } from 'mppx'
import { toDrops } from 'xrpl-mpp-sdk'
import { buildAgentContext } from './context'
import { OwsChannelClaimSigner } from './signer/ows-channel-signer'
import { closeChannel } from './tools/channel'
import { ensureFunded } from './tools/funding'
import { optInToMpt } from './tools/trustline'

interface CatalogIssuance {
  issuanceId: string
  url: string
  remainingUnits: number
}

async function main(): Promise<void> {
  const { deps } = await buildAgentContext()
  const { signer, network, merchantUrl, log } = deps
  const address = signer.address()
  const channelSigner = new OwsChannelClaimSigner(signer)
  const source = `did:pkh:xrpl:${network.sdkNetwork}:${address}`
  const capacityDrops = BigInt(toDrops(String(getEnvNumber('CHANNEL_XRP', 50))))

  // Fund enough to lock the channel + owner reserves (channel + each MPT opt-in) + fees.
  await ensureFunded(
    address,
    network,
    { ownerObjects: 10, swapBudgetXrp: String(Number(capacityDrops) / 1e6) },
    log,
  )

  // 1. Read the catalog hint and venture to the subscribe endpoint.
  const catalog = (await (await fetch(`${merchantUrl}/catalog`)).json()) as {
    message?: string
    subscribe?: string
  }
  log.mpp('read catalog hint', { message: catalog.message })
  const subscribeUrl = `${merchantUrl}${catalog.subscribe ?? '/subscribe'}`

  // 2. GET /subscribe -> 402 channel offer (merchant proposes the channel).
  const offer = await fetch(subscribeUrl)
  if (offer.status !== 402) throw new Error(`expected a 402 channel offer, got ${offer.status}`)
  const openChallenge = Challenge.fromResponse(offer)
  const recipient = (openChallenge.request as { recipient: string }).recipient
  log.mpp('← 402 channel offer', { recipient })

  // 3. OWS-sign the PaymentChannelCreate blob (the server submits it) + open credential.
  const { blob } = await signer.signToBlob({
    TransactionType: 'PaymentChannelCreate',
    Destination: recipient,
    Amount: capacityDrops.toString(),
    SettleDelay: 86400,
    PublicKey: channelSigner.publicKey(),
  })
  const openCredential = Credential.serialize({
    challenge: openChallenge,
    payload: {
      action: 'open',
      transaction: blob,
      amount: '0',
      signature: channelSigner.signClaim('0'.repeat(64), '0').signature,
    },
    source,
  } as never)
  log.mpp('→ open credential (PaymentChannelCreate blob)', {
    capacityXrp: Number(capacityDrops) / 1e6,
  })
  const subRes = await fetch(subscribeUrl, { headers: { Authorization: openCredential } })
  const subBody = (await subRes.json().catch(() => null)) as {
    channelId?: string
    firstIssuance?: string
  } | null
  if (!subRes.ok || !subBody?.channelId) {
    throw new Error(`subscribe/open failed: ${subRes.status} ${JSON.stringify(subBody)}`)
  }
  const channelId = subBody.channelId
  log.mpp('channel open — merchant now issuing', { channelId })

  // 4. Buy each freshly-issued MPT with a cumulative voucher until the limit.
  let cumulative = 0n
  const acquired = new Set<string>()
  for (let round = 0; round < 50; round++) {
    const cat = (await (await fetch(`${merchantUrl}/catalog`)).json()) as {
      issuances?: CatalogIssuance[]
    }
    const next = (cat.issuances ?? []).find(
      (i) => i.remainingUnits > 0 && !acquired.has(i.issuanceId),
    )
    if (!next) {
      log.info('no more issuances on offer — stopping')
      break
    }
    const url = `${merchantUrl}${next.url}`

    // Permissioned MPT: opt in (holder authorize) before the merchant can deliver.
    await optInToMpt(signer, network, next.issuanceId, log)

    const q = await fetch(url)
    if (q.status !== 402) {
      log.info('resource did not 402 — stopping', { status: q.status })
      break
    }
    const challenge = Challenge.fromResponse(q)
    const price = BigInt((challenge.request as { amount: string }).amount)
    if (cumulative + price > capacityDrops) {
      log.mpp('channel limit reached — stopping before overspend', {
        committedXrp: Number(cumulative) / 1e6,
        nextPriceXrp: Number(price) / 1e6,
        capacityXrp: Number(capacityDrops) / 1e6,
      })
      break
    }
    cumulative += price

    const voucher = channelSigner.signClaim(channelId, cumulative.toString())
    const credential = Credential.serialize({
      challenge,
      payload: {
        action: 'voucher',
        channelId,
        amount: cumulative.toString(),
        signature: voucher.signature,
      },
      source,
    } as never)
    log.mpp('→ voucher', { issuanceId: next.issuanceId, cumulativeXrp: Number(cumulative) / 1e6 })
    const buyRes = await fetch(url, { headers: { Authorization: credential } })
    const buyBody = await buyRes.json().catch(() => null)
    if (!buyRes.ok) throw new Error(`voucher rejected: ${buyRes.status} ${JSON.stringify(buyBody)}`)

    const holdings = await withClient(network.rpcUrl, (c) => listMptHoldings(c, address))
    const held = holdings.find((x) => x.issuanceId === next.issuanceId)
    acquired.add(next.issuanceId)
    log.info('RWA MPT received via channel', {
      issuanceId: next.issuanceId,
      amount: held?.amount ?? '0',
    })
  }

  // 5. Close: merchant redeems the latest voucher, agent closes (tfClose).
  await fetch(`${merchantUrl}/close?channelId=${channelId}`).catch(() => null)
  await closeChannel(signer, channelId, log)

  log.info('channel run complete', {
    acquired: acquired.size,
    spentXrp: Number(cumulative) / 1e6,
    capacityXrp: Number(capacityDrops) / 1e6,
  })
  console.log(
    `✅ CHANNEL_DEMO_OK — acquired ${acquired.size} MPT(s) for ${Number(cumulative) / 1e6} XRP over one channel, key never left OWS`,
  )
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`channel agent failed: ${err instanceof Error ? err.stack : String(err)}`)
    process.exit(1)
  })
