import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { getEnv, getEnvNumber, listMptHoldings, withClient } from '@rwa/shared'
import { z } from 'zod'
import type { AcquireDeps } from './pipeline'
import type { AgentStore } from './state'
import { saveAgentStore } from './state'
import { discover } from './tools/discovery'
import { ensureFunded } from './tools/funding'
import { payViaMpp } from './tools/mpp'
import { ensurePaymentCurrency } from './tools/swap'
import { ensurePaymentTrustline, optInToMpt } from './tools/trustline'

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
    "Discover the merchant's RWA MPT issuances not yet acquired. Returns each issuance's id, price, currency, and the MPP URL to pay.",
    {},
    async () => {
      const items = await discover(
        {
          merchantUrl: deps.merchantUrl,
          merchantAddress: deps.merchantAddress,
          network: deps.network,
          acquired,
        },
        deps.log,
      )
      return ok(items)
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
    'Set the trust line to the payment-currency issuer so the agent can hold and pay in it. No-op for XRP.',
    {},
    async () => {
      await ensurePaymentTrustline(deps.signer, deps.network, deps.payment, deps.log)
      return ok({ trustline: deps.payment.label })
    },
  )

  const swapTool = tool(
    'swap_for_currency',
    'Acquire the payment currency by swapping XRP on-chain (OfferCreate, AMM-aware), up to MAX_SPEND. requiredValue is the amount of payment currency needed.',
    { requiredValue: z.string() },
    async ({ requiredValue }) => {
      await ensurePaymentCurrency(
        deps.signer,
        deps.network,
        deps.payment,
        { requiredValue, maxSpendXrp: deps.maxSpendXrp, slippageBps: deps.slippageBps },
        deps.log,
      )
      return ok({ acquired: deps.payment.label, requiredValue })
    },
  )

  const payTool = tool(
    'pay_via_mpp',
    'Pay an MPP-protected issuance URL (push mode, signed via OWS) and take delivery. Returns the payment tx hash.',
    { url: z.string() },
    async ({ url }) => {
      const outcome = await payViaMpp(deps.signer, deps.network, url, deps.log)
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
    optInTool,
    trustlineTool,
    swapTool,
    payTool,
    confirmTool,
  ]
}

const SYSTEM_PROMPT = `You are an autonomous buyer agent operating a wallet on the XRP Ledger.

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
3. discover_issuances to list what the merchant offers that you do not yet own.
4. For EACH issuance, in order:
   a. opt_in_mpt (the permissioned MPT requires your holder opt-in before payment),
   b. ensure_trustline (so you can hold/pay the payment currency),
   c. swap_for_currency with requiredValue = the issuance price (skip if already held),
   d. pay_via_mpp with the issuance url,
   e. confirm_receipt with the issuance id.
5. When all discovered issuances are confirmed received, summarize and stop.

Reason explicitly about each step. Prefer doing the setup actions yourself via the tools.`

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
