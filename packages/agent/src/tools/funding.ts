import { getXrpBalanceDrops, type Logger, type NetworkConfig, withClient } from '@rwa/shared'
import { BASE_RESERVE_DROPS, fromDrops, OWNER_RESERVE_DROPS, toDrops } from 'xrpl-mpp-sdk'

const TESTNET_FAUCET = 'https://faucet.altnet.rippletest.net/accounts'

export interface FundingPlan {
  /** Owner objects the agent will create (RLUSD trustline + RWA MPT holding). */
  ownerObjects: number
  /** XRP (as a decimal string) to keep available for the swap input. */
  swapBudgetXrp: string
}

/** Total drops the agent must hold: base reserve + owner reserves + swap input + fee buffer. */
export function sizeFundingDrops(plan: FundingPlan): bigint {
  const base = BigInt(BASE_RESERVE_DROPS)
  const owner = BigInt(OWNER_RESERVE_DROPS) * BigInt(plan.ownerObjects)
  const swap = BigInt(toDrops(plan.swapBudgetXrp))
  const fees = 2_000_000n // ~2 XRP buffer for fees across the run
  return base + owner + swap + fees
}

/**
 * Ensure the agent's XRPL account is activated and holds enough XRP to cover
 * reserves, the swap input, and fees. Pulls from the scriptable testnet faucet
 * (no seed needed — funds by destination address). Local sandbox funding goes
 * through xrpl-up (requires Docker) and is out of scope when Docker is absent.
 */
export async function ensureFunded(
  address: string,
  network: NetworkConfig,
  plan: FundingPlan,
  log: Logger,
): Promise<{ balanceDrops: string }> {
  const target = sizeFundingDrops(plan)
  log.step('reserve sizing', {
    targetXrp: fromDrops(target.toString()),
    base: fromDrops(BASE_RESERVE_DROPS),
    ownerEach: fromDrops(OWNER_RESERVE_DROPS),
    ownerObjects: plan.ownerObjects,
    swapXrp: plan.swapBudgetXrp,
  })

  return withClient(network.rpcUrl, async (client) => {
    let balance = BigInt(await getXrpBalanceDrops(client, address))
    for (let attempt = 0; balance < target && attempt < 5; attempt++) {
      log.step('funding from faucet', {
        address,
        have: fromDrops(balance.toString()),
        need: fromDrops(target.toString()),
      })
      await pullFaucet(address, network)
      // Wait for the funding tx to validate.
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 3000))
        balance = BigInt(await getXrpBalanceDrops(client, address))
        if (balance >= target) break
      }
    }
    if (balance < target) {
      throw new Error(
        `funding fell short: have ${fromDrops(balance.toString())} XRP, need ${fromDrops(target.toString())} XRP`,
      )
    }
    log.info('agent funded', { address, balanceXrp: fromDrops(balance.toString()) })
    return { balanceDrops: balance.toString() }
  })
}

async function pullFaucet(address: string, network: NetworkConfig): Promise<void> {
  if (network.faucetMode === 'local') {
    throw new Error('Local sandbox funding requires xrpl-up (Docker). Use NETWORK=testnet.')
  }
  const res = await fetch(TESTNET_FAUCET, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ destination: address }),
  })
  if (!res.ok) throw new Error(`faucet request failed: ${res.status} ${await res.text()}`)
}
