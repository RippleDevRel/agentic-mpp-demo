import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { getEnv, getEnvNumber, listMptHoldings, withClient } from '@rwa/shared'
import { z } from 'zod'
import type { AcquireDeps } from './pipeline'
import type { AgentStore } from './state'
import { saveAgentStore } from './state'
import { discover } from './tools/discovery'
import { ensureFunded } from './tools/funding'
import { payViaMpp, quoteResource } from './tools/mpp'
import { ensureIouBalance } from './tools/swap'
import { ensureIouTrustline, optInToMpt } from './tools/trustline'

type ToolResult = { content: Array<{ type: 'text'; text: string }> }
const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
})

const SERVER = 'rwa'

/** Expose the Phase 2/3 functions as agent tools (strict zod schemas). */
function buildTools(deps: AcquireDeps, store: AgentStore) {
  const acquired = new Set(store.acquired)

  const getStatus = tool(
    'get_status',
    'Report the agent wallet address, XRP balance, MPT holdings, and which issuances are already acquired.',
    {},
    async () => {
      const holdings = await withClient(deps.network.rpcUrl, (c) =>
        listMptHoldings(c, deps.signer.address()),
      )
      return ok({
        address: deps.signer.address(),
        holdings,
        acquired: [...acquired],
        maxSpendXrp: deps.maxSpendXrp,
      })
    },
  )

  const ensureFundedTool = tool(
    'ensure_funded',
    'Ensure the wallet is activated and holds enough XRP for reserves, the swap, and fees. Pulls the testnet faucet if needed.',
    {},
    async () => {
      const r = await ensureFunded(
        deps.signer.address(),
        deps.network,
        { ownerObjects: 2, swapBudgetXrp: String(deps.maxSpendXrp) },
        deps.log,
      )
      return ok(r)
    },
  )

  const discoverTool = tool(
    'discover_issuances',
    "Read the seller's service endpoint to list the RWA resources on offer that you have not yet acquired. Returns each resource's id and the URL to request it. Payment details (recipient, amount) come from that URL's 402 challenge when you pay.",
    {},
    async () => {
      const items = await discover(
        { merchantUrl: deps.merchantUrl, network: deps.network, acquired },
        deps.log,
      )
      return ok(items)
    },
  )

  const quoteTool = tool(
    'quote_resource',
    'Request a resource URL to read its 402 challenge WITHOUT paying. Returns the payment terms learned from the merchant: recipient address, amount, and currency (XRP, or an IOU with its currency code + issuer). Use these values to drive the trustline, swap, and payment.',
    { url: z.string() },
    async ({ url }) => {
      const q = await quoteResource(url, deps.log)
      return ok({
        recipient: q.recipient,
        amount: q.amount,
        currencyKind: q.currency.kind,
        ...(q.currency.kind === 'IOU'
          ? { currency: q.currency.currency, issuer: q.currency.issuer }
          : {}),
      })
    },
  )

  const optInTool = tool(
    'opt_in_mpt',
    'Holder-side opt-in (MPTokenAuthorize) to a permissioned RWA MPT. Must be done before paying.',
    { issuanceId: z.string() },
    async ({ issuanceId }) => {
      await optInToMpt(deps.signer, deps.network, issuanceId, deps.log)
      return ok({ optedIn: issuanceId })
    },
  )

  const trustlineTool = tool(
    'ensure_trustline',
    'Set the trust line to an IOU issuer (the currency + issuer from a quote) so the agent can hold and pay it. Only needed when the quoted currency is an IOU, not XRP.',
    { currency: z.string(), issuer: z.string() },
    async ({ currency, issuer }) => {
      await ensureIouTrustline(deps.signer, deps.network, { currency, issuer }, deps.log)
      return ok({ trustline: { currency, issuer } })
    },
  )

  const swapTool = tool(
    'swap_for_currency',
    'Acquire an IOU by swapping XRP on-chain (OfferCreate, AMM-aware), up to MAX_SPEND. Pass requiredValue and the currency + issuer from the quote.',
    { requiredValue: z.string(), currency: z.string(), issuer: z.string() },
    async ({ requiredValue, currency, issuer }) => {
      await ensureIouBalance(
        deps.signer,
        deps.network,
        { currency, issuer },
        { requiredValue, maxSpendXrp: deps.maxSpendXrp, slippageBps: deps.slippageBps },
        deps.log,
      )
      return ok({ acquired: { currency, issuer }, requiredValue })
    },
  )

  const payTool = tool(
    'pay_via_mpp',
    'Pay an MPP-protected resource URL (push mode, signed via OWS) and take delivery. Returns the payment tx hash.',
    { url: z.string() },
    async ({ url }) => {
      const outcome = await payViaMpp(deps.signer, deps.network, url, deps.maxSpendXrp, deps.log)
      return ok({ paymentHash: outcome.paymentHash, delivered: outcome.delivered })
    },
  )

  const confirmTool = tool(
    'confirm_receipt',
    'Confirm the RWA MPT arrived in the wallet and mark the issuance acquired. Returns the on-chain balance.',
    { issuanceId: z.string() },
    async ({ issuanceId }) => {
      const holdings = await withClient(deps.network.rpcUrl, (c) =>
        listMptHoldings(c, deps.signer.address()),
      )
      const h = holdings.find((x) => x.issuanceId === issuanceId)
      if (!h || h.amount === '0') return ok({ received: false, issuanceId })
      acquired.add(issuanceId)
      store.acquired = [...acquired]
      saveAgentStore(store)
      deps.summary.add(`Acquired ${issuanceId}`, `${h.amount} base units`)
      return ok({ received: true, issuanceId, balance: h.amount })
    },
  )

  return [
    getStatus,
    ensureFundedTool,
    discoverTool,
    quoteTool,
    optInTool,
    trustlineTool,
    swapTool,
    payTool,
    confirmTool,
  ]
}

const SYSTEM_PROMPT = `You are an autonomous buyer agent operating a wallet on the XRP Ledger.

You are given ONLY the seller's service endpoint (a URL) — not its ledger address. You
discover what is on offer by reading that endpoint, and you learn each purchase's payment
details (recipient, amount, currency) from the resource's HTTP 402 "Payment Required"
challenge when you pay it. Never assume or hard-code the seller's address.

Your wallet's private key lives inside Open Wallet Standard (OWS) and never leaves it;
every transaction is signed there. Use ONLY the provided tools — do not attempt any
other action.

Hard safety bounds (never violate):
- Never cause spending beyond MAX_SPEND (reported by get_status). The swap tool enforces
  this, but do not retry swaps in a way that would exceed it.
- Operate only on the XRP Ledger via the given tools.
- Stop once every currently-available issuance from the merchant has been acquired.

Approach, step by step:
1. get_status to see your address, balance, and what is already acquired.
2. ensure_funded so you can cover reserves, the swap, and fees.
3. discover_issuances to list the resources on offer (id + URL) you do not yet own.
4. For EACH resource, in order:
   a. quote_resource with its URL to learn the payment terms from the 402: recipient,
      amount, and currency (XRP, or an IOU with currency code + issuer),
   b. opt_in_mpt (the permissioned MPT requires your holder opt-in before payment),
   c. if the quoted currency is an IOU: ensure_trustline {currency, issuer} from the
      quote, then swap_for_currency with requiredValue = the quoted amount and the same
      {currency, issuer}. If the quoted currency is XRP, skip this step (you hold XRP).
   d. pay_via_mpp with the resource URL,
   e. confirm_receipt with the issuance id.
5. When all discovered resources are confirmed received, summarize and stop.

Reason explicitly about each step. Trust the 402 quote — not any assumption — for the
currency, issuer, and amount. Prefer doing the setup actions yourself via the tools.`

/**
 * Run the autonomous acquisition driven by a Claude model (Claude Agent SDK).
 * Tools are the Phase 2/3 functions; the only runtime instruction is the goal.
 * Requires ANTHROPIC_API_KEY in the environment.
 */
export async function runAgentLoop(
  deps: AcquireDeps,
  store: AgentStore,
  goal: string,
): Promise<void> {
  const tools = buildTools(deps, store)
  const server = createSdkMcpServer({ name: SERVER, version: '0.1.0', tools })
  const allowedTools = tools.map((t) => `mcp__${SERVER}__${t.name}`)
  const model = getEnv('AGENT_MODEL') ?? 'sonnet'

  deps.log.step('starting model-driven agent loop', { model, goal })

  const response = query({
    prompt: goal,
    options: {
      model,
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { [SERVER]: server },
      allowedTools,
      permissionMode: 'bypassPermissions',
      maxTurns: getEnvNumber('AGENT_MAX_ITERATIONS', 40),
      // Do not load the host machine's settings, skills, or other MCP servers.
      settingSources: [],
    },
  })

  for await (const message of response) {
    const m = message as {
      type: string
      message?: { content?: unknown }
      subtype?: string
      result?: string
    }
    if (m.type === 'assistant' && m.message?.content) {
      for (const block of m.message.content as Array<{
        type: string
        text?: string
        name?: string
      }>) {
        if (block.type === 'text' && block.text?.trim())
          deps.log.info(`model: ${block.text.trim()}`)
        else if (block.type === 'tool_use') deps.log.step(`model calls tool: ${block.name}`)
      }
    } else if (m.type === 'result') {
      deps.log.info('model loop finished', { subtype: m.subtype })
    }
  }
}
