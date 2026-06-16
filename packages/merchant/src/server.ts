import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { getEnvNumber } from '@agentic-mpp-demo-xrpl/shared'
import { Receipt } from 'mppx'
import { Mppx, Store } from 'mppx/server'
import { toDrops } from 'xrpl-mpp-sdk'
import { charge } from 'xrpl-mpp-sdk/server'
import { ensureBootstrapped } from './bootstrap'
import { buildCatalog, findOffer } from './catalog'
import { buildMerchant, type MerchantContext } from './context'
import { deliver } from './delivery'
import { startIssuerLoop } from './issuer'

/** Amount string in the unit the charge handler expects per currency type. */
function chargeAmount(ctx: MerchantContext): string {
  const price = ctx.cfg.asset.pricePerUnit
  return ctx.cfg.payment.kind === 'XRP' ? toDrops(price) : price
}

function chargeCurrencyString(ctx: MerchantContext): string {
  return ctx.cfg.payment.kind === 'XRP' ? 'XRP' : JSON.stringify(ctx.cfg.payment.sdk)
}

export async function startServer(): Promise<{
  url: string
  close: () => Promise<void>
  ctx: MerchantContext
}> {
  const ctx = await buildMerchant()
  await ensureBootstrapped(ctx)
  const { cfg, store, log } = ctx

  const mppx = Mppx.create({
    secretKey: requireSecret(),
    methods: [
      charge({
        recipient: store.address,
        currency: cfg.payment.kind === 'XRP' ? 'XRP' : cfg.payment.sdk,
        autoTrustline: cfg.payment.kind !== 'XRP',
        wallet: ctx.wallet,
        network: cfg.network.sdkNetwork,
        rpcUrl: cfg.network.rpcUrl,
        store: Store.memory(),
      }),
    ],
  })

  const port = getEnvNumber('MERCHANT_PORT', 8787)

  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    try {
      if (path === '/' || path === '/info') {
        sendJson(res, 200, {
          service: 'autonomous-rwa-merchant',
          merchant: store.address,
          network: cfg.network.name,
          paymentCurrency: cfg.payment.label,
          endpoints: { catalog: '/catalog', buy: '/rwa/:issuanceId' },
        })
        return
      }

      if (path === '/catalog') {
        log.info('GET /catalog')
        sendJson(res, 200, buildCatalog(ctx))
        return
      }

      const rwaMatch = path.match(/^\/rwa\/([^/]+)$/)
      if (rwaMatch) {
        const issuanceId = decodeURIComponent(rwaMatch[1] as string)
        const offer = findOffer(ctx, issuanceId)
        if (!offer) {
          sendJson(res, 404, { error: 'NOT_AVAILABLE', issuanceId })
          return
        }

        const credential = req.headers.authorization
        log.mpp('← incoming MPP request', {
          method: req.method,
          path,
          credential: credential ?? '(none — will issue a 402 challenge)',
        })

        const handler = mppx['xrpl/charge']({
          amount: chargeAmount(ctx),
          currency: chargeCurrencyString(ctx),
          description: sanitizeHeaderValue(`RWA issuance ${issuanceId} (${offer.units} units)`),
        })

        const result = await handler(toWebRequest(req))
        if (result.status === 402) {
          const challengeResp = result.challenge as Response
          log.mpp('402 PAYMENT REQUIRED', {
            issuanceId,
            amount: chargeAmount(ctx),
            currency: cfg.payment.label,
          })
          log.mpp('→ 402 challenge sent', {
            wwwAuthenticate: challengeResp.headers.get('www-authenticate') ?? '(none)',
          })
          await sendWebResponse(challengeResp, res)
          return
        }

        // mppx 0.7 exposes the receipt only via the Payment-Receipt header it sets
        // on withReceipt(); peek it to recover the on-chain tx reference.
        const peek = result.withReceipt(Response.json({}))
        const reference = Receipt.fromResponse(peek).reference
        if (!reference)
          throw new Error('Payment verified but no receipt reference to key delivery on')
        log.mpp('payment verified — delivering RWA MPT', { reference })

        const delivery = await deliver(ctx, { reference, issuanceId, units: offer.units })
        const delivered = {
          issuanceId,
          to: delivery.to,
          units: offer.units,
          baseAmount: delivery.baseAmount,
          authorizeHash: delivery.authorizeHash,
          issueHash: delivery.issueHash,
        }
        log.mpp('→ delivery response sent', { body: JSON.stringify({ ok: true, delivered }) })
        const body = result.withReceipt(Response.json({ ok: true, delivered }))
        await sendWebResponse(body as Response, res)
        return
      }

      sendJson(res, 404, { error: 'NOT_FOUND' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('request handler failed', { msg })
      if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL', message: msg })
    }
  })

  const url = `http://localhost:${port}`
  await new Promise<void>((resolve) => server.listen(port, resolve))

  log.info('========================================================')
  log.info('MERCHANT ONLINE', { address: store.address, network: cfg.network.name })
  log.info('agent goal address (MERCHANT_ADDRESS)', { address: store.address })
  log.info('endpoints', { catalog: `${url}/catalog`, buy: `${url}/rwa/:issuanceId` })
  log.info('========================================================')

  const stopIssuer = startIssuerLoop(ctx)

  return {
    url,
    ctx,
    close: () =>
      new Promise<void>((resolve, reject) => {
        stopIssuer()
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

function requireSecret(): string {
  const s = process.env.MPP_SECRET_KEY
  if (!s) throw new Error('MPP_SECRET_KEY is required (mppx server secret).')
  return s
}

// --- node:http <-> Web Request/Response bridge (mirrors the SDK examples) ---

function toWebRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? 'localhost'
  const url = `http://${host}${req.url ?? '/'}`
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    if (Array.isArray(v)) for (const val of v) headers.append(k, val)
    else headers.set(k, v)
  }
  return new Request(url, { method: req.method ?? 'GET', headers })
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

function sanitizeHeaderValue(s: string): string {
  return s
    .replace(/[",\\\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  startServer().catch((err) => {
    console.error(`merchant fatal: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
