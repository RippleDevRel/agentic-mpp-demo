/**
 * Autonomous RWA buyer agent — entrypoint.
 *
 * Given a single goal (acquire every RWA token issued by MERCHANT_ADDRESS) and an
 * API key, it bootstraps its OWS wallet, funds itself, discovers the merchant's
 * issuances, swaps for the payment currency, opts in, pays via MPP, and takes
 * delivery — with the private key never leaving OWS.
 *
 * With ANTHROPIC_API_KEY set, a Claude model drives the tool-use loop. Without a
 * key (e.g. CI), it runs the same tools through a deterministic pipeline so the
 * flow stays verifiable. Run: pnpm --filter @rwa/agent start
 */
import { colorLegend, getEnv } from '@rwa/shared'
import { buildAgentContext } from './context'
import { runAgentLoop } from './loop'
import { runAcquisition } from './pipeline'

async function main(): Promise<void> {
  console.log(colorLegend())
  const { deps, store, goal } = await buildAgentContext()
  deps.log.info('agent goal', { goal })

  if (getEnv('ANTHROPIC_API_KEY')) {
    await runAgentLoop(deps, store, goal)
  } else {
    deps.log.warn(
      'ANTHROPIC_API_KEY not set — running the deterministic pipeline (no model in the loop)',
    )
    await runAcquisition(deps, store)
  }

  console.log(deps.summary.render('Autonomous acquisition summary'))
}

main().catch((err) => {
  console.error(`agent failed: ${err instanceof Error ? err.stack : String(err)}`)
  process.exit(1)
})
