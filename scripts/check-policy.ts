/**
 * Live testnet probe: is the OWS spend-cap policy actually enforced, or can the
 * agent bypass it? Creates a fresh OWS wallet bound to a MAX_SPEND policy, funds
 * it ABOVE the cap (so any block is the policy, not lack of funds), then tries to
 * sign+submit via the policy-bound token — the agent's ONLY signing path. The
 * Payment/OfferCreate probes go through the NATIVE signer (the real agent path,
 * OWS `signAndSend`); the PaymentChannelCreate probe uses the channel signer
 * (which exposes the channel public key). The policy binds to the token, so it
 * is enforced identically on both.
 *
 * Run: MAX_SPEND=10 pnpm check:policy
 */
import { RLUSD_TESTNET, resolveNetwork } from '@agentic-mpp-demo-xrpl/shared'
import { buildAgentContext } from '../packages/agent/src/context'
import type { SignableTx, XrplSubmitSigner } from '../packages/agent/src/signer/common'
import type { OwsXrplSigner } from '../packages/agent/src/signer/ows-xrpl-signer'
import { ensureFunded } from '../packages/agent/src/tools/funding'
import { ensureAgentWallet } from '../packages/agent/src/tools/wallet'

type Outcome = string
type Tx = SignableTx

async function attempt(signer: XrplSubmitSigner, label: string, tx: Tx): Promise<Outcome> {
  try {
    await signer.signAndSubmit(tx, { label })
    return 'ALLOWED (signed+submitted)'
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/exceeds max|denied|policy|not allowed/i.test(msg))
      return `DENIED by OWS policy — ${msg.slice(0, 90)}`
    // Signed fine but failed on-chain for another reason → the policy ALLOWED it.
    return `ALLOWED (signed; on-chain result: ${msg.slice(0, 70)})`
  }
}

async function main(): Promise<void> {
  const { deps } = await buildAgentContext()
  const { signer, network, log } = deps
  const cap = Number(process.env.MAX_SPEND ?? '10')
  log.step('policy probe', { maxSpendXrp: cap, address: signer.address() })

  // Fund well above the cap so a block can only be the policy, never funds.
  await ensureFunded(signer.address(), network, { ownerObjects: 4, swapBudgetXrp: '60' }, log)

  const rlusd = { currency: RLUSD_TESTNET.currency, issuer: RLUSD_TESTNET.issuer, value: '1' }
  const IOC = 0x00020000

  const results: Record<string, Outcome> = {}

  // 1. OfferCreate spending 30 XRP (> cap) — the kind of tx a swap-to-buy uses.
  results['OfferCreate TakerGets 30 XRP (> cap)'] = await attempt(
    signer,
    'probe: OfferCreate 30 XRP',
    {
      TransactionType: 'OfferCreate',
      TakerGets: '30000000',
      TakerPays: rlusd,
      Flags: IOC,
    },
  )

  // 2. OfferCreate spending 5 XRP (< cap) — should pass the policy (IOC may not fill).
  results['OfferCreate TakerGets 5 XRP (< cap)'] = await attempt(
    signer,
    'probe: OfferCreate 5 XRP',
    {
      TransactionType: 'OfferCreate',
      TakerGets: '5000000',
      TakerPays: rlusd,
      Flags: IOC,
    },
  )

  // 3. Payment of 30 XRP (> cap) to self — tests the Payment path of the policy.
  results['Payment 30 XRP (> cap)'] = await attempt(signer, 'probe: Payment 30 XRP', {
    TransactionType: 'Payment',
    Destination: signer.address(),
    Amount: '30000000',
  })

  // 4. PaymentChannelCreate locking 30 XRP (> cap) — a recoverable lock the policy
  //    intentionally does NOT gate as spend (the channel capacity bounds the real
  //    spend). Channel mode uses the recovery signer, which exposes the public key.
  const { signer: channelSigner } = await ensureAgentWallet(resolveNetwork(), log, 'channel')
  const ch = channelSigner as OwsXrplSigner
  results['PaymentChannelCreate 30 XRP (> cap)'] = await attempt(ch, 'probe: PayChannel 30 XRP', {
    TransactionType: 'PaymentChannelCreate',
    Destination: ch.address(),
    Amount: '30000000',
    SettleDelay: 86400,
    PublicKey: ch.publicKey(),
  })

  console.log(`\n=== OWS policy enforcement probe (MAX_SPEND=${cap} XRP) ===`)
  for (const [k, v] of Object.entries(results))
    console.log(`  ${v.startsWith('DENIED') ? '🛑' : '✅'} ${k}\n      → ${v}`)
  console.log()
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`policy probe failed: ${err instanceof Error ? err.stack : String(err)}`)
    process.exit(1)
  })
