import type { Logger, NetworkConfig } from '@rwa/shared'
import { Challenge, Credential } from 'mppx'
import type { Amount } from 'xrpl'
import type { OwsXrplSigner } from '../signer/ows-xrpl-signer'

export interface PaymentOutcome {
  paymentHash: string
  delivered: unknown
}

/** Build the XRPL Amount from the 402 challenge's currency + amount strings. */
function amountFromChallenge(currencyStr: string, amount: string): Amount {
  if (currencyStr === 'XRP') return amount // drops
  const c = JSON.parse(currencyStr) as { currency: string; issuer: string }
  return { currency: c.currency, issuer: c.issuer, value: amount }
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
  log.step('received 402 challenge', {
    amount: req.amount,
    currency: req.currency,
    recipient: req.recipient,
  })

  const amount = amountFromChallenge(req.currency, req.amount)
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
