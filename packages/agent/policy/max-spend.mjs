#!/usr/bin/env node
/**
 * OWS executable policy: cap the XRP an agent transaction may spend.
 *
 * OWS runs this BEFORE decrypting the key and signing. It pipes a PolicyContext
 * JSON on stdin and reads {"allow":bool,"reason"?} from stdout; {"allow":false}
 * (or a non-zero exit) blocks the signature — enforcement at the signing boundary.
 *
 * The tx blob is at `transaction.raw_hex` (NOT `transaction.raw`). Getting this
 * field name wrong makes the policy fail open (no `raw` → "allow") — i.e. the cap
 * silently does nothing. Tested live against OWS.
 *
 * Cap is PER TRANSACTION and targets IRREVERSIBLE native-XRP outflow: a Payment
 * (Amount/SendMax) or an OfferCreate (native TakerGets). A PaymentChannelCreate
 * deposit is a recoverable LOCK (not a terminal spend — the real spend is the
 * streamed vouchers, bounded by the channel capacity the operator sets), so it is
 * not gated here. Hash signs (pubkey recovery / channel claims) and non-XRP-outflow
 * txs (TrustSet, MPTokenAuthorize, IOU payments) carry no native XRP and are allowed.
 */
import { decode } from 'xrpl'

const allow = () => {
  process.stdout.write('{"allow":true}')
  process.exit(0)
}
const deny = (reason) => {
  process.stdout.write(JSON.stringify({ allow: false, reason }))
  process.exit(0)
}

const drops = (field) => (typeof field === 'string' && /^[0-9]+$/.test(field) ? Number(field) : 0)

async function readStdin() {
  let data = ''
  for await (const chunk of process.stdin) data += chunk
  return data
}

const ctx = await readStdin()
  .then((s) => JSON.parse(s))
  .catch(() => null)
if (!ctx) allow() // unreadable context → cannot evaluate a spend; nothing to gate

const capXrp = Number(ctx.policy_config?.maxSpendXrp ?? 50)
const capDrops = capXrp * 1_000_000

// OWS passes the encoded transaction blob here. Absent for hash-signing requests.
const rawHex = ctx.transaction?.raw_hex
if (!rawHex) allow() // not a tx signing request (e.g. signHash for pubkey recovery / claims)

let tx
try {
  tx = decode(rawHex)
} catch {
  allow() // not a decodable XRPL tx → cannot move native XRP
}

const fee = drops(tx.Fee)
let spend = fee
const kind = tx.TransactionType
if (kind === 'Payment') {
  // XRP leaves via SendMax (conversion) or a native Amount.
  spend = Math.max(drops(tx.SendMax), drops(tx.Amount)) + fee
} else if (kind === 'OfferCreate') {
  // XRP leaves via TakerGets when it is native (drops string).
  spend = drops(tx.TakerGets) + fee
}

if (spend > capDrops) {
  deny(`tx ${kind} would spend ${(spend / 1e6).toFixed(6)} XRP, exceeds max ${capXrp} XRP`)
}
allow()
