/**
 * Merchant — PAYMENT CHANNEL mode (MPP `channel` intent, XRP-only).
 *
 * Unlike the charge server, this merchant issues NOTHING up front. It advertises
 * (via /catalog) a subscription endpoint; the agent opens a PayChannel funded
 * with XRP, and only THEN does the merchant start releasing permissioned RWA MPTs.
 * Each MPT is paid with an off-ledger cumulative voucher (claim) on that channel,
 * verified server-side with the SDK's `channel` method (verifyPaymentChannelClaim
 * + Store-tracked cumulative). When the agent stops/closes, the merchant redeems
 * the latest voucher with `closeFromStore`.
 *
 * Faithful to MPP: real mppx Challenge/Credential envelope + the SDK channel
 * intent. A single SDK method instance serves every funder — since SDK 0.1.0 the
 * server reads each channel's verification key from the ledger (its on-chain
 * `PublicKey`) rather than being configured with one, so it no longer needs a
 * per-funder instance. The `open` credential's PaymentChannelCreate blob is still
 * decoded to record the funder + channel key for the cooperative on-chain redeem.
 *
 * Run: pnpm merchant:channel
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { getEnvNumber, withClient } from '@agentic-mpp-demo-xrpl/shared'
import { Credential } from 'mppx'
import { generate } from 'mppx/discovery'
import { Mppx, Store } from 'mppx/server'
import { decode } from 'xrpl'
import { toDrops } from 'xrpl-mpp-sdk'
import { channel as channelMethod, closeFromStore } from 'xrpl-mpp-sdk/channel/server'
import { findOffer } from './catalog'
import { buildMerchant, type MerchantContext } from './context'
import { deliver } from './delivery'
import { releaseOne } from './issuer'

/** Per-channel state the merchant tracks (the SDK Store holds cumulative + replay). */
interface ChannelRecord {
  channelId: string
  publicKey: string
  funder: string
  capacityDrops: string
}

function requireSecret(): string {
  const s = process.env.MPP_SECRET_KEY
  if (!s) throw new Error('MPP_SECRET_KEY is required (mppx server secret).')
  return s
}

/**
 * Price per RWA MPT, in XRP drops. Channel mode is XRP-only by design — the SDK
 * `channel` intent carries drops with no currency field, and XRPL PayChannels
 * only hold XRP — so PAYMENT_CURRENCY is irrelevant here: the price is just
 * RWA_PRICE read as XRP.
 */
function priceDrops(ctx: MerchantContext): string {
  return toDrops(String(ctx.cfg.asset.pricePerUnit))
}

export async function startChannelServer(): Promise<{
  url: string
  close: () => Promise<void>
  ctx: MerchantContext
}> {
  const ctx = await buildMerchant()
  const { cfg, store, log } = ctx
  // One Store, cumulative + replay for every channel this server verifies.
  const sharedStore = Store.memory()
  const channels = new Map<string, ChannelRecord>()

  // Server-initiated session close: if the agent disconnects without closing, the
  // SDK's auto-close sweeper claims the latest voucher on-chain once the channel
  // goes idle for `idleMs`. idleMs MUST exceed the worst-case gap between vouchers,
  // or the sweeper fires mid-stream and claims a stale (too-low) cumulative while
  // the agent is still buying — under-collecting. Each round does an on-chain opt-in
  // + delivery + validation, which can spike past 30s on a busy testnet, so the
  // default is generous (120s): a genuinely-abandoned channel still closes within a
  // couple of minutes, but a live run is never swept.
  const idleMs = getEnvNumber('CHANNEL_IDLE_MS', 120000)
  const sweepIntervalMs = getEnvNumber('CHANNEL_SWEEP_MS', 10000)

  // A SINGLE long-lived method instance serves every funder. Since SDK 0.1.0 the
  // server takes each channel's verification key from the ledger (no configured
  // `publicKey`), so one instance verifies opens + vouchers from any number of
  // unrelated funders; its auto-close sweeper registers each channel under its own
  // on-chain key. It must persist across requests (its in-memory activeChannels is
  // what the sweeper scans), so it is built once at startup, not per call.
  const channelSvc = channelMethod({
    store: sharedStore,
    storeDurability: 'process-local',
    wallet: ctx.wallet,
    network: cfg.network.sdkNetwork,
    rpcUrl: cfg.network.rpcUrl,
    autoClose: {
      idleMs,
      sweepIntervalMs,
      onClose: ({
        channelId,
        cumulative,
        txHash,
      }: {
        channelId: string
        cumulative: string
        txHash: string
      }) => {
        log.mpp('AUTO-CLOSE: idle channel claimed on-chain by merchant', {
          channelId,
          cumulativeXrp: Number(cumulative) / 1e6,
        })
        log.txn('PaymentChannelClaim (auto-close redeem)', txHash, cfg.network.explorerTx?.(txHash))
      },
      onError: ({ channelId, error }: { channelId: string; error: Error }) =>
        log.warn('auto-close attempt failed', { channelId, msg: error.message }),
    },
  })
  const mppx = Mppx.create({ secretKey: requireSecret(), methods: [channelSvc] })

  const port = getEnvNumber('MERCHANT_PORT', 8787)

  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    try {
      if (path === '/' || path === '/info') {
        sendJson(res, 200, {
          service: 'autonomous-rwa-merchant',
          mode: 'channel',
          merchant: store.address,
          endpoints: { catalog: '/catalog', subscribe: '/subscribe', discovery: '/openapi.json' },
        })
        return
      }

      // MPP discovery: OpenAPI 3.1 doc advertising the `session` offer on
      // /subscribe, so agents/registries learn the channel terms up front.
      // Advisory — the runtime 402 session challenge stays authoritative.
      if (path === '/openapi.json') {
        const offer = mppx['xrpl/session']({
          amount: priceDrops(ctx),
          currency: 'XRP',
          channelId: '',
          recipient: store.address,
          description: 'Subscribe to RWA MPT emissions over an XRP payment channel',
        })
        const doc = generate(mppx, {
          info: { title: 'Autonomous RWA merchant (channel mode)', version: '1.0.0' },
          serviceInfo: { categories: ['rwa'] },
          routes: [{ handler: offer, method: 'get', path: '/subscribe' }],
        })
        sendJson(res, 200, doc)
        return
      }

      // Discoverable hint — the agent "ventures" to /subscribe from this text.
      if (path === '/catalog') {
        sendJson(res, 200, {
          merchant: store.address,
          message:
            'No issuances yet. Subscribe to MPT emissions via /subscribe (XRP payment channel): open a PayChannel and the merchant starts issuing RWA MPTs you pay per-token with cumulative vouchers.',
          subscribe: '/subscribe',
          issuances: store.extraIssuances.map((e) => ({
            issuanceId: e.issuanceId,
            url: `/rwa/${e.issuanceId}`,
            remainingUnits: e.remainingUnits,
          })),
        })
        return
      }

      // Subscription: advertise the channel, accept the `open`, then start issuing.
      if (path === '/subscribe') {
        const auth = req.headers.authorization
        if (!auth) {
          // Advertise: 402 session challenge with amount "0" (open commits nothing).
          const handler = mppx['xrpl/session']({
            amount: '0',
            currency: 'XRP',
            channelId: '',
            recipient: store.address,
            description: 'Open a PayChannel to subscribe to RWA MPT emissions',
          })
          await sendWebResponse((await handler(toWebRequest(req))).challenge as Response, res)
          return
        }

        // `open`: learn the channel public key + funder from the create blob.
        const cred = Credential.deserialize(auth) as {
          payload?: { action?: string; transaction?: string }
        }
        const blob = cred.payload?.transaction
        if (cred.payload?.action !== 'open' || !blob) {
          sendJson(res, 400, { error: 'EXPECTED_OPEN_CREDENTIAL' })
          return
        }
        const tx = decode(blob) as { Account?: string; PublicKey?: string; Amount?: string }
        const publicKey = tx.PublicKey
        const funder = tx.Account
        if (!publicKey || !funder) {
          sendJson(res, 400, { error: 'OPEN_BLOB_MISSING_FIELDS' })
          return
        }

        const handler = mppx['xrpl/session']({
          amount: '0',
          currency: 'XRP',
          channelId: '',
          recipient: store.address,
          description: 'channel open',
        })
        const result = await handler(toWebRequest(req))
        if (result.status === 402) {
          await sendWebResponse(result.challenge as Response, res)
          return
        }

        // Channel verified + on-chain: find its id and record it, then start issuing.
        const channelId = await findChannelId(ctx, funder)
        channels.set(channelId, { channelId, publicKey, funder, capacityDrops: tx.Amount ?? '0' })
        log.mpp('channel opened — starting issuance', { channelId, funder })
        const issuanceId = await releaseOne(ctx)
        const body = result.withReceipt(
          Response.json({ ok: true, subscribed: true, channelId, firstIssuance: issuanceId }),
        )
        await sendWebResponse(body as Response, res)
        return
      }

      // Per-MPT purchase: pay with a cumulative voucher on the open channel.
      const rwaMatch = path.match(/^\/rwa\/([^/]+)$/)
      if (rwaMatch) {
        const issuanceId = decodeURIComponent(rwaMatch[1] as string)
        const offer = findOffer(ctx, issuanceId)
        if (!offer) {
          sendJson(res, 404, { error: 'NOT_AVAILABLE', issuanceId })
          return
        }
        const auth = req.headers.authorization

        // Resolve the channel for this request (from the voucher's channelId, or
        // the single open channel) to know which public key verifies the claim.
        const rec = resolveChannel(channels, auth)
        if (!rec) {
          sendJson(res, 402, { error: 'NO_OPEN_CHANNEL', hint: 'subscribe first via /subscribe' })
          return
        }

        const handler = mppx['xrpl/session']({
          amount: priceDrops(ctx),
          currency: 'XRP',
          channelId: rec.channelId,
          recipient: store.address,
          description: `RWA issuance ${issuanceId} (${offer.units} units)`,
        })
        const result = await handler(toWebRequest(req))
        if (result.status === 402) {
          await sendWebResponse(result.challenge as Response, res)
          return
        }

        // Voucher verified — deliver the MPT to the channel funder.
        log.mpp('voucher verified — delivering RWA MPT', { channelId: rec.channelId, issuanceId })
        const delivery = await deliver(ctx, {
          reference: `${rec.channelId}:${issuanceId}`,
          issuanceId,
          units: offer.units,
          payer: rec.funder,
        })
        // Keep issuing: queue the next RWA MPT so the agent always has a next one
        // to buy until it hits the channel limit.
        await releaseOne(ctx).catch((e) =>
          log.warn('could not queue next issuance', {
            msg: e instanceof Error ? e.message : String(e),
          }),
        )
        const body = result.withReceipt(
          Response.json({
            ok: true,
            delivered: {
              issuanceId,
              to: delivery.to,
              units: offer.units,
              issueHash: delivery.issueHash,
            },
          }),
        )
        await sendWebResponse(body as Response, res)
        return
      }

      // Close + redeem the latest voucher for a channel.
      if (path === '/close') {
        const channelId = new URL(`http://x${req.url}`).searchParams.get('channelId') ?? ''
        const rec = channels.get(channelId)
        if (!rec) {
          sendJson(res, 404, { error: 'UNKNOWN_CHANNEL', channelId })
          return
        }
        // Cooperative redeem is an optimistic fast-path: redeem the latest voucher
        // on-chain right when the agent asks. If it fails (e.g. a transient
        // tecUNFUNDED_PAYMENT from racing the agent's own close), don't crash the
        // request — the auto-close sweeper will redeem the same voucher shortly.
        try {
          const redeemed = await closeFromStore({
            wallet: ctx.wallet,
            channelId,
            channelPublicKey: rec.publicKey,
            store: sharedStore,
            network: cfg.network.sdkNetwork,
            rpcUrl: cfg.network.rpcUrl,
          })
          if (redeemed) {
            log.mpp('channel close — redeeming latest voucher on-chain', {
              channelId,
              cumulativeXrp: Number(redeemed.cumulative) / 1e6,
            })
            log.txn(
              'PaymentChannelClaim (redeem)',
              redeemed.txHash,
              cfg.network.explorerTx?.(redeemed.txHash),
            )
          } else {
            log.mpp('channel close requested — no voucher on file, nothing to redeem', {
              channelId,
            })
          }
          sendJson(res, 200, { ok: true, redeemed })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          log.warn('cooperative redeem failed — auto-close sweeper will retry', { channelId, msg })
          sendJson(res, 200, { ok: false, redeemed: null, reason: msg, autoCloseWillRetry: true })
        }
        return
      }

      sendJson(res, 404, { error: 'NOT_FOUND' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('channel request handler failed', { msg })
      if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL', message: msg })
    }
  })

  const url = `http://localhost:${port}`
  await new Promise<void>((resolve) => server.listen(port, resolve))
  log.info('MERCHANT ONLINE (channel mode)', { address: store.address, catalog: `${url}/catalog` })

  return {
    url,
    ctx,
    close: () =>
      new Promise<void>((resolve, reject) => {
        channelSvc.dispose() // stop the auto-close sweeper
        server.close((e) => (e ? reject(e) : resolve()))
      }),
  }
}

/** Find the channel id opened by `funder` to the merchant (latest), via account_channels. */
async function findChannelId(ctx: MerchantContext, funder: string): Promise<string> {
  return withClient(ctx.cfg.network.rpcUrl, async (client) => {
    const res = await client.request({
      command: 'account_channels',
      account: funder,
      destination_account: ctx.store.address,
      ledger_index: 'validated',
    })
    const list = (res.result as { channels?: Array<{ channel_id: string }> }).channels ?? []
    const last = list.at(-1)
    if (!last) throw new Error(`no channel from ${funder} to merchant`)
    return last.channel_id
  })
}

/** Pick the channel a voucher refers to (by its channelId), or the only open one. */
function resolveChannel(
  channels: Map<string, ChannelRecord>,
  auth: string | undefined,
): ChannelRecord | undefined {
  if (auth) {
    try {
      const cred = Credential.deserialize(auth) as { payload?: { channelId?: string } }
      const id = cred.payload?.channelId
      if (id && channels.has(id)) return channels.get(id)
    } catch {
      // fall through to the single-channel case
    }
  }
  return channels.size === 1 ? [...channels.values()][0] : undefined
}

// --- node:http <-> Web Request/Response bridge ---
function toWebRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? 'localhost'
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    if (Array.isArray(v)) for (const val of v) headers.append(k, val)
    else headers.set(k, v)
  }
  return new Request(`http://${host}${req.url ?? '/'}`, { method: req.method ?? 'GET', headers })
}

async function sendWebResponse(webRes: Response, res: ServerResponse): Promise<void> {
  res.statusCode = webRes.status
  webRes.headers.forEach((v, k) => {
    res.setHeader(k, v)
  })
  res.end(await webRes.text())
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body, null, 2))
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  startChannelServer().catch((err) => {
    console.error(`channel merchant fatal: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
