/**
 * Minimal autonomous agent — the "figure it out yourself" variant.
 *
 * Same OWS-custodied wallet + policy as the rails agent, but the model is given
 * only generic primitives (read ledger, sign+submit any XRPL tx via OWS, faucet,
 * http get, MPP quote/settle). There is NO bespoke opt-in/trustline/swap/discovery
 * code: the model builds the XRPL transactions itself and orchestrates the flow,
 * bounded by the OWS policy (XRPL-only + per-tx MAX_SPEND cap).
 *
 * Run: OWS_PASSPHRASE=... MERCHANT_URL=... ANTHROPIC_API_KEY=... pnpm agent:minimal
 */
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { colorLegend, getEnv, getEnvNumber, withClient } from '@rwa/shared'
import { Challenge, Credential } from 'mppx'
import { z } from 'zod'
import { buildAgentContext } from './context'
import { quoteResource } from './tools/mpp'

const TESTNET_FAUCET = 'https://faucet.altnet.rippletest.net/accounts'
const SERVER = 'rwamin'
const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] })

async function main(): Promise<void> {
  console.log(colorLegend())
  const { deps } = await buildAgentContext()
  const { signer, network, merchantUrl, maxSpendXrp, log } = deps
  const address = signer.address()

  const tools = [
    tool(
      'xrpl_query',
      'Read the XRP Ledger. `command` is an rippled method (account_info, account_objects, account_lines, book_offers, tx). `paramsJson` is a JSON STRING of its arguments, e.g. \'{"account":"r...","ledger_index":"validated"}\'.',
      { command: z.string(), paramsJson: z.string().optional() },
      async ({ command, paramsJson }) => {
        let params: Record<string, unknown> = {}
        if (paramsJson) {
          try {
            params = JSON.parse(paramsJson)
          } catch (e) {
            return ok({
              error: `paramsJson is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
            })
          }
        }
        try {
          const res = await withClient(network.rpcUrl, (c) =>
            c.request({ command, ...params } as never),
          )
          return ok((res as { result: unknown }).result)
        } catch (e) {
          return ok({ error: e instanceof Error ? e.message : String(e) })
        }
      },
    ),
    tool(
      'xrpl_sign_submit',
      'Autofill, sign via OWS (key isolated, policy-enforced), submit, and wait for validation. Pass `txJson`: a JSON STRING of the XRPL transaction, WITHOUT Account/SigningPubKey/Sequence/Fee (handled for you), e.g. \'{"TransactionType":"TrustSet","LimitAmount":{"currency":"...","issuer":"...","value":"1000000000"}}\'. Returns the tx hash + engine result, or an error if OWS denies it or it fails on-chain.',
      { txJson: z.string() },
      async ({ txJson }) => {
        let t: Record<string, unknown>
        try {
          t = JSON.parse(txJson)
        } catch (e) {
          return ok({
            error: `txJson is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
          })
        }
        // tolerate a {"tx": {...}} wrapper
        if (t && typeof t.tx === 'object' && !t.TransactionType) t = t.tx as Record<string, unknown>
        delete t.Account
        delete t.SigningPubKey
        if (!t.TransactionType) {
          return ok({
            error:
              'transaction is missing TransactionType (e.g. "TrustSet", "MPTokenAuthorize", "OfferCreate", "Payment")',
          })
        }
        try {
          const r = await signer.signAndSubmit(t as never, { label: String(t.TransactionType) })
          return ok({ hash: r.hash, engineResult: r.engineResult })
        } catch (e) {
          return ok({ error: e instanceof Error ? e.message : String(e) })
        }
      },
    ),
    tool(
      'faucet',
      'Fund an XRPL testnet address with XRP (use on your own address if account_info reports it is not found).',
      { address: z.string() },
      async ({ address: dest }) => {
        const r = await fetch(TESTNET_FAUCET, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ destination: dest }),
        })
        return ok({ status: r.status })
      },
    ),
    tool(
      'http_get',
      'Plain HTTP GET (e.g. the merchant catalog). Returns parsed JSON when possible.',
      { url: z.string() },
      async ({ url }) => {
        const r = await fetch(url)
        const text = await r.text()
        try {
          return ok({ status: r.status, json: JSON.parse(text) })
        } catch {
          return ok({ status: r.status, text })
        }
      },
    ),
    tool(
      'mpp_quote',
      "Read an MPP resource's 402 challenge WITHOUT paying. Returns the payment terms: recipient, amount, and currency (XRP, or an IOU with currency code + issuer).",
      { url: z.string() },
      async ({ url }) => {
        const q = await quoteResource(url, log)
        return ok({
          recipient: q.recipient,
          amount: q.amount,
          currencyKind: q.currency.kind,
          ...(q.currency.kind === 'IOU'
            ? { currency: q.currency.currency, issuer: q.currency.issuer }
            : {}),
        })
      },
    ),
    tool(
      'mpp_settle',
      'After you have signed+submitted the on-chain Payment, hand the merchant your payment tx hash to take delivery. Returns the delivery receipt.',
      { url: z.string(), paymentTxHash: z.string() },
      async ({ url, paymentTxHash }) => {
        const res = await fetch(url)
        if (res.status !== 402) return ok({ ok: false, error: `expected 402, got ${res.status}` })
        const challenge = Challenge.fromResponse(res)
        const credential = Credential.serialize({
          challenge,
          payload: { type: 'hash', hash: paymentTxHash },
          source: `did:pkh:xrpl:${network.sdkNetwork}:${address}`,
        } as never)
        const settled = await fetch(url, { headers: { Authorization: credential } })
        const body = await settled.json().catch(() => null)
        return ok({
          ok: settled.ok,
          status: settled.status,
          delivered: (body as { delivered?: unknown })?.delivered ?? body,
        })
      },
    ),
  ]

  const server = createSdkMcpServer({ name: SERVER, version: '0.1.0', tools })
  const allowedTools = tools.map((t) => `mcp__${SERVER}__${t.name}`)
  const goal = `Acquire every RWA token offered by the merchant at ${merchantUrl}.`
  const systemPrompt = buildPrompt(address, merchantUrl, maxSpendXrp)
  const model = getEnv('AGENT_MODEL') ?? 'sonnet'

  log.step('starting MINIMAL agent loop (generic primitives only)', { model, address })

  const response = query({
    prompt: goal,
    options: {
      model,
      systemPrompt,
      mcpServers: { [SERVER]: server },
      allowedTools,
      permissionMode: 'bypassPermissions',
      maxTurns: getEnvNumber('AGENT_MAX_ITERATIONS', 60),
      settingSources: [],
    },
  })

  for await (const message of response) {
    const m = message as { type: string; message?: { content?: unknown }; subtype?: string }
    if (m.type === 'assistant' && m.message?.content) {
      for (const block of m.message.content as Array<{
        type: string
        text?: string
        name?: string
      }>) {
        if (block.type === 'text' && block.text?.trim()) log.info(`model: ${block.text.trim()}`)
        else if (block.type === 'tool_use') log.step(`model calls tool: ${block.name}`)
      }
    } else if (m.type === 'result') {
      log.info('minimal loop finished', { subtype: m.subtype })
    }
  }
}

function buildPrompt(address: string, merchantUrl: string, maxSpendXrp: number): string {
  return `You are an autonomous buyer agent on the XRP Ledger. Your wallet is custodied by Open
Wallet Standard (OWS); its private key never leaves OWS. You can ONLY sign via
xrpl_sign_submit, and OWS enforces a policy: XRPL only, and at most ${maxSpendXrp} XRP of
native XRP out per transaction (fee included) — it will REJECT anything over. Your wallet
address is ${address}.

Goal: acquire every RWA token offered by the merchant at ${merchantUrl}.

You have low-level primitives only — work out the steps and the transactions yourself.
Note: xrpl_query takes a JSON-string \`paramsJson\`, and xrpl_sign_submit takes a
JSON-string \`txJson\` (the whole transaction serialized as a string).
- xrpl_query(command, paramsJson): read the ledger (account_info, account_objects, account_lines, book_offers, tx).
- xrpl_sign_submit(txJson): autofills, signs via OWS, submits, waits for validation. txJson omits Account/SigningPubKey/Sequence/Fee.
- faucet(address): testnet XRP faucet — fund yourself if account_info shows the account is not found, then WAIT and re-query account_info until it exists before signing.
- http_get(url): plain GET (e.g. the merchant's /catalog).
- mpp_quote(url): read an MPP resource's 402 and return its payment terms.
- mpp_settle(url, paymentTxHash): after you pay on-chain, hand over the tx hash to take delivery.

XRPL knowledge you need (you decide when/whether to use each). All examples below are the
JSON you pass as txJson:
- The RWA is a PERMISSIONED MPT: you MUST opt in as a holder BEFORE paying:
  {"TransactionType":"MPTokenAuthorize","MPTokenIssuanceID":"<id>"}. The issuer authorizes you when your payment arrives.
- To hold/pay an IOU you must trust its issuer first:
  {"TransactionType":"TrustSet","LimitAmount":{"currency":"<cur>","issuer":"<issuer>","value":"1000000000"}}.
- To obtain an IOU you don't hold, swap XRP for it with an immediate-or-cancel offer:
  {"TransactionType":"OfferCreate","TakerGets":"<maxXrpDrops>","TakerPays":{"currency":"<cur>","issuer":"<issuer>","value":"<amount>"},"Flags":131072}.
  TakerGets is your max XRP budget in drops (1 XRP = 1,000,000 drops); keep it safely under ${maxSpendXrp} XRP (leave room for the fee) or OWS rejects it. It fills at market and cancels the rest. Then check account_lines to confirm you received enough.
- To pay an MPP resource: mpp_quote(url) for {recipient, amount, currency...}; build
  {"TransactionType":"Payment","Destination":"<recipient>","Amount":<"drops" if XRP, else {"currency":"<cur>","issuer":"<issuer>","value":"<amount>"}>} and add "SendMax" equal to Amount for an IOU; xrpl_sign_submit it; then mpp_settle(url, <that tx hash>).

Discover what's on offer yourself: http_get(${merchantUrl}/catalog) lists items with issuanceId + endpoint (resolve the endpoint relative to ${merchantUrl}). Stop once you hold every offered issuance (verify with account_objects type=mptoken). Reason step by step; if OWS rejects a tx, read the reason and adjust.`
}

main().catch((err) => {
  console.error(`minimal agent failed: ${err instanceof Error ? err.stack : String(err)}`)
  process.exit(1)
})
