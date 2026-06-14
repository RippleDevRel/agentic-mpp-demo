import { type Logger, type NetworkConfig, toDrops } from '@rwa/shared'
import { Challenge, Credential } from 'mppx'
import type { Amount } from 'xrpl'
import type { OwsXrplSigner } from '../signer/ows-xrpl-signer'

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
  const res = await fetch(url)
  if (res.status !== 402) {
    throw new Error(`expected a 402 quote from ${url}, got ${res.status}: ${await res.text()}`)
  }
  const challenge = Challenge.fromResponse(res)
  const req = challenge.request as { amount: string; currency: string; recipient: string }
  const currency = parseCurrency(req.currency)
  log.step('quoted resource from its 402 challenge', {
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
  signer: OwsXrplSigner,
  network: NetworkConfig,
  url: string,
  maxSpendXrp: number,
  log: Logger,
): Promise<PaymentOutcome> {
  const first = await fetch(url)
  if (first.status === 200) {
    log.info('resource already accessible (no payment required)')
    return { paymentHash: '', delivered: await first.json() }
  }
  if (first.status !== 402) {
    throw new Error(`expected 402, got ${first.status}: ${await first.text()}`)
  }

  const challenge = Challenge.fromResponse(first)
  const req = challenge.request as { amount: string; currency: string; recipient: string }
  const currency = parseCurrency(req.currency)
  log.step('received 402 challenge', {
    amount: req.amount,
    currency: currency.kind === 'XRP' ? 'XRP' : `IOU issuer=${currency.issuer}`,
    recipient: req.recipient,
  })

  // Bound a direct XRP payment by MAX_SPEND (IOU spend is bounded at the swap).
  if (currency.kind === 'XRP' && BigInt(req.amount) > BigInt(toDrops(String(maxSpendXrp)))) {
    throw new Error(`payment ${Number(req.amount) / 1e6} XRP exceeds MAX_SPEND ${maxSpendXrp} XRP`)
  }

  const amount = toXrplAmount(currency, req.amount)
  const payment =
    typeof amount === 'string'
      ? { TransactionType: 'Payment' as const, Destination: req.recipient, Amount: amount }
      : {
          TransactionType: 'Payment' as const,
          Destination: req.recipient,
          Amount: amount,
          SendMax: amount,
        }

  const submitted = await signer.signAndSubmit(payment, { label: 'MPP Payment (push mode)' })

  const source = `did:pkh:xrpl:${network.sdkNetwork}:${signer.address()}`
  const credential = Credential.serialize({
    challenge,
    payload: { type: 'hash', hash: submitted.hash },
    source,
  } as never)

  log.step('submitting MPP credential (tx hash) to merchant')
  const second = await fetch(url, { headers: { Authorization: credential } })
  const body = await second.json().catch(() => null)
  if (!second.ok) {
    throw new Error(`MPP settlement rejected: ${second.status} ${JSON.stringify(body)}`)
  }
  log.info('MPP payment accepted; merchant delivering')
  return {
    paymentHash: submitted.hash,
    delivered: (body as { delivered?: unknown })?.delivered ?? body,
  }
}
