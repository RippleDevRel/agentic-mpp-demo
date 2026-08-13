/**
 * MPP client tools: read a resource's HTTP 402 to learn the payment terms
 * (recipient, amount, currency, issuer) without paying, and pay in PUSH mode —
 * an OWS-signed XRPL Payment whose tx hash is handed to the merchant via an mppx
 * credential. The key stays in OWS; the merchant still verifies the payment.
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
 * Pay an MPP-protected resource in PUSH mode while keeping the key in OWS:
 * read the 402 challenge, build + OWS-sign + submit the XRPL Payment, then hand
 * the tx hash to the SDK-powered server via an mppx credential. No private key
 * leaves OWS, and the SDK server still verifies the on-chain payment.
 */
export async function payViaMpp(
  signer: XrplSubmitSigner,
  network: NetworkConfig,
  url: string,
  log: Logger,
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

  const submitted = await signer.signAndSubmit(payment, { label: 'MPP Payment (push mode)' })

  const source = `did:pkh:xrpl:${network.sdkNetwork}:${signer.address()}`
  const credential = Credential.serialize({
    challenge,
    payload: { type: 'hash', hash: submitted.hash },
    source,
  } as never)

  log.mpp('submitting MPP credential (tx hash) to merchant')
  log.mpp('→ GET (Authorization: MPP credential)', {
    url,
    source,
    paymentHash: submitted.hash,
    credential,
  })
  const second = await fetch(url, { headers: { Authorization: credential } })
  const body = await second.json().catch(() => null)
  log.mpp('← settlement response', { status: second.status, body: JSON.stringify(body) })
  if (!second.ok) {
    throw new Error(`MPP settlement rejected: ${second.status} ${JSON.stringify(body)}`)
  }
  log.mpp('MPP payment accepted; merchant delivering')
  return {
    paymentHash: submitted.hash,
    delivered: (body as { delivered?: unknown })?.delivered ?? body,
  }
}
