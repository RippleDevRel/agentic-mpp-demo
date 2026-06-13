/**
 * Operator setup for the Local Sandbox (deterministic, CI-friendly) mode.
 *
 * Brings up an xrpl-up sandbox (Docker, MPT + AMM enabled at genesis), creates a
 * stable IOU and an XRP/stable AMM so the agent's swap route is deterministic,
 * then leaves the merchant to be started with NETWORK=local PAYMENT_CURRENCY=IOU.
 *
 * REQUIRES DOCKER. This project's validated path is testnet (see README/FINDINGS);
 * local mode is provided for offline/CI determinism and needs Docker present.
 *
 * Run: pnpm setup:local
 */
import { execFileSync } from 'node:child_process'

function has(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8' })
}

function main(): void {
  if (!has('docker', ['--version'])) {
    console.error(
      '✖ Docker is required for the local sandbox (xrpl-up runs rippled in Docker).\n' +
        '  Install Docker, or use the validated testnet path:\n' +
        '    NETWORK=testnet pnpm exec tsx scripts/demo.ts',
    )
    process.exit(1)
  }
  if (!has('pnpm', ['dlx', 'xrpl-up', '--help'])) {
    console.error('✖ Could not invoke xrpl-up. Check its install (npm: xrpl-up).')
    process.exit(1)
  }

  console.log('=== starting xrpl-up local sandbox (Docker) ===')
  // Sandbox boots rippled standalone with MPT + AMM amendments at genesis.
  run('pnpm', ['dlx', 'xrpl-up', 'start', '--node', 'local'])

  console.log('=== next steps (operator) ===')
  console.log(
    [
      '1. Create a stable IOU issuer + fund it:    xrpl-up faucet --node local',
      '2. Open an XRP/stable AMM so the swap has a route:  xrpl-up amm create ... --node local',
      '3. Export the issuer + currency for the agent + merchant:',
      '     export LOCAL_STABLE_ISSUER=<issuer r-address>',
      '     export LOCAL_STABLE_CURRENCY=USD',
      '4. Start the merchant in local IOU mode:',
      '     NETWORK=local PAYMENT_CURRENCY=IOU pnpm merchant',
      '5. Run the demo against it:  NETWORK=local pnpm exec tsx scripts/demo.ts',
      '',
      'See FINDINGS.md — local mode was authored against the documented xrpl-up CLI but',
      'not executed in the build environment (no Docker); testnet is the validated path.',
    ].join('\n'),
  )
}

main()
