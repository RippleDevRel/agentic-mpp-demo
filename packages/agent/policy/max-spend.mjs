#!/usr/bin/env node
/**
 * OWS executable policy: cap the XRP an agent transaction may spend.
 *
 * OWS runs this BEFORE decrypting the key and signing. It pipes the PolicyContext
 * JSON on stdin (chain_id, wallet_id, api_key_id, transaction:{to,value,raw}, ...,
 * plus our policy_config) and reads {"allow":bool,"reason"?} from stdout. A
 * non-zero exit or {"allow":false} blocks the signature — so this cap is enforced
 * at the signing boundary, not just in the agent process.
 *
 * Cap is PER TRANSACTION (OWS does not yet track cumulative spend — see FINDINGS).
 * Money only moves via a decodable XRPL tx; hash signs (pubkey recovery) and
 * non-XRP-outflow txs (TrustSet, MPTokenAuthorize, IOU payments) are allowed.
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
if (!ctx) allow() // unreadable context: fail open only for non-tx (money needs a valid tx)

const capXrp = Number(ctx.policy_config?.maxSpendXrp ?? 50)
const capDrops = capXrp * 1_000_000

const raw = ctx.transaction?.raw
if (!raw) allow() // not a transaction signing request (e.g. hash sign for pubkey recovery)

let tx
try {
  tx = decode(raw)
} catch {
  allow() // not a decodable XRPL tx → cannot move funds
}

const fee = drops(tx.Fee)
let spend = fee
const kind = tx.TransactionType
if (tx.TransactionType === 'Payment') {
  // XRP leaves via SendMax (conversion) or a native Amount.
  spend = Math.max(drops(tx.SendMax), drops(tx.Amount)) + fee
} else if (tx.TransactionType === 'OfferCreate') {
  // XRP leaves via TakerGets when it is native (drops string).
  spend = drops(tx.TakerGets) + fee
}

if (spend > capDrops) {
  deny(`tx ${kind} would spend ${(spend / 1e6).toFixed(6)} XRP, exceeds max ${capXrp} XRP`)
}
allow()
