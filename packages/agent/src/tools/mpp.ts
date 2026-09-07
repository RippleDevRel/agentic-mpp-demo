/**
 * MPP client tools: read a resource's HTTP 402 to learn the payment terms
 * (recipient, amount, currency, issuer) without paying, and pay in one of the two
 * MPP charge modes — both keeping the key in OWS:
 *  - PUSH (default): OWS signs + broadcasts the XRPL Payment, then hands the tx
 *    hash to the merchant via an mppx credential (`type: 'hash'`).
 *  - PULL: OWS signs the Payment into a blob but does NOT broadcast; the blob is
 *    handed to the merchant (`type: 'transaction'`), which submits it on-chain.
 * Either way the merchant verifies the payment and the key never leaves OWS.
 */
import { createHash } from 'node:crypto'
import type { Logger, NetworkConfig } from '@agentic-mpp-demo-xrpl/shared'
import { Challenge, Credential } from 'mppx'
import type { Amount } from 'xrpl'
import type { XrplSubmitSigner } from '../signer/common'

/**
 * The `InvoiceID` that binds a push-mode Payment to a specific 402 challenge.
 * The hardened MPP server rejects an unbound payment; it expects the challenge's
 * explicit `invoiceId` when present, else `sha512half(challenge.id)` — matching
 * the SDK's `challengeInvoiceId` (SHA-512 of the id, first 32 bytes, uppercase hex).
 */
export function challengeInvoiceId(challengeId: string): string {
  return createHash('sha512').update(challengeId, 'utf8').digest('hex').slice(0, 64).toUpperCase()
}

export interface PaymentOutcome {
  paymentHash: string
  delivered: unknown
}

/**
 * MPP charge payment mode:
 *  - `push`: the agent submits the Payment itself, then presents the tx hash.
 *  - `pull`: the agent presents a signed-but-unbroadcast Payment blob; the
 *    merchant submits it. Requires a signer that can produce such a blob
 *    (the OWS recovery signer — `signerKind: 'channel'`).
 */
export type PayMode = 'push' | 'pull'

/** Payment currency as learned from the 402 — never from local config. */
export type ParsedCurrency = { kind: 'XRP' } | { kind: 'IOU'; currency: string; issuer: string }

export interface ResourceQuote {
  /** XRPL address to pay (learned from the 402, not given to the agent). */
  recipient: string
  /** Amount to pay: IOU display value, or XRP drops. */
  amount: string
  currency: ParsedCurrency
}

/** Parse the 402 challenge currency string ('XRP' or JSON {currency,issuer}). */
function parseCurrency(currencyStr: string): ParsedCurrency {
  if (currencyStr === 'XRP') return { kind: 'XRP' }
  const c = JSON.parse(currencyStr) as { currency: string; issuer: string }
  return { kind: 'IOU', currency: c.currency, issuer: c.issuer }
}

/** Build the XRPL Amount from a parsed currency + amount. */
function toXrplAmount(currency: ParsedCurrency, amount: string): Amount {
  return currency.kind === 'XRP'
    ? amount // drops
    : { currency: currency.currency, issuer: currency.issuer, value: amount }
}

/**
 * Read a resource's 402 challenge to learn its payment terms (recipient, amount,
 * currency, issuer) WITHOUT paying. This is how the agent discovers what a
 * purchase costs and in which token — nothing about the currency or the merchant
 * address is configured ahead of time.
 */
export async function quoteResource(url: string, log: Logger): Promise<ResourceQuote> {
  log.mpp('→ GET (read 402 quote, no payment)', { url })
  const res = await fetch(url)
  if (res.status !== 402) {
    throw new Error(`expected a 402 quote from ${url}, got ${res.status}: ${await res.text()}`)
  }
  const challenge = Challenge.fromResponse(res)
  const req = challenge.request as { amount: string; currency: string; recipient: string }
  const currency = parseCurrency(req.currency)
  log.mpp('← 402 challenge', { status: res.status, challenge: JSON.stringify(challenge.request) })
  log.mpp('quoted resource from its 402 challenge', {
    recipient: req.recipient,
    amount: req.amount,
    currency: currency.kind === 'XRP' ? 'XRP' : `IOU issuer=${currency.issuer}`,
  })
  return { recipient: req.recipient, amount: req.amount, currency }
}

/**
 * Pay an MPP-protected resource while keeping the key in OWS: read the 402
 * challenge, build + OWS-sign the XRPL Payment, and hand the SDK-powered server a
 * credential it verifies. The `mode` picks who broadcasts:
 *  - `push` (default): the agent submits the Payment and presents its tx hash.
 *  - `pull`: the agent presents the signed blob unbroadcast; the merchant submits
 *    it. Needs a signer that can hand back a blob (the OWS recovery signer).
 * No private key leaves OWS in either mode, and the SDK server still verifies the
 * on-chain payment.
 */
export async function payViaMpp(
  signer: XrplSubmitSigner,
  network: NetworkConfig,
  url: string,
  log: Logger,
  mode: PayMode = 'push',
): Promise<PaymentOutcome> {
  log.mpp('→ GET (attempt resource)', { url })
  const first = await fetch(url)
  if (first.status === 200) {
    log.mpp('resource already accessible (no payment required)')
    return { paymentHash: '', delivered: await first.json() }
  }
  if (first.status !== 402) {
    throw new Error(`expected 402, got ${first.status}: ${await first.text()}`)
  }

  const challenge = Challenge.fromResponse(first)
  const req = challenge.request as { amount: string; currency: string; recipient: string }
  const currency = parseCurrency(req.currency)
  log.mpp('← 402 challenge', { status: first.status, challenge: JSON.stringify(challenge.request) })
  log.mpp('received 402 challenge', {
    amount: req.amount,
    currency: currency.kind === 'XRP' ? 'XRP' : `IOU issuer=${currency.issuer}`,
    recipient: req.recipient,
  })

  // Bind the payment to THIS challenge so the hardened server accepts it: set the
  // InvoiceID to the challenge's explicit invoiceId, else sha512half(challenge.id).
  const explicitInvoiceId = (challenge.request as { methodDetails?: { invoiceId?: string } })
    .methodDetails?.invoiceId
  const invoiceId = explicitInvoiceId ?? challengeInvoiceId(challenge.id)

  // No app-level spend gate: a direct XRP payment over the cap is rejected by the
  // OWS policy at signing time (the executable spend-cap policy).
  const amount = toXrplAmount(currency, req.amount)
  const payment =
    typeof amount === 'string'
      ? {
          TransactionType: 'Payment' as const,
          Destination: req.recipient,
          Amount: amount,
          InvoiceID: invoiceId,
        }
      : {
          TransactionType: 'Payment' as const,
          Destination: req.recipient,
          Amount: amount,
          SendMax: amount,
          InvoiceID: invoiceId,
        }

  const source = `did:pkh:xrpl:${network.sdkNetwork}:${signer.address()}`

  // PUSH: broadcast the Payment ourselves, present the tx hash. PULL: OWS-sign the
  // Payment into a blob but leave it unbroadcast — the merchant submits it.
  let paymentHash: string
  let credential: string
  if (mode === 'pull') {
    if (!signer.signToBlob) {
      throw new Error(
        'pull mode requires the OWS recovery signer (signerKind: "channel"), which can hand back an unbroadcast signed blob',
      )
    }
    const signed = await signer.signToBlob(payment)
    paymentHash = signed.hash
    log.mpp('OWS-signed Payment blob (pull mode) — merchant will submit it', { paymentHash })
    credential = Credential.serialize({
      challenge,
      payload: { type: 'transaction', blob: signed.blob },
      source,
    } as never)
  } else {
    const submitted = await signer.signAndSubmit(payment, { label: 'MPP Payment (push mode)' })
    paymentHash = submitted.hash
    credential = Credential.serialize({
      challenge,
      payload: { type: 'hash', hash: submitted.hash },
      source,
    } as never)
  }

  log.mpp('submitting MPP credential to merchant', { mode })
  log.mpp('→ GET (Authorization: MPP credential)', { url, source, paymentHash, credential })
  const second = await fetch(url, { headers: { Authorization: credential } })
  const body = await second.json().catch(() => null)
  log.mpp('← settlement response', { status: second.status, body: JSON.stringify(body) })
  if (!second.ok) {
    throw new Error(`MPP settlement rejected: ${second.status} ${JSON.stringify(body)}`)
  }
  log.mpp('MPP payment accepted; merchant delivering')
  return {
    paymentHash,
    delivered: (body as { delivered?: unknown })?.delivered ?? body,
  }
}
