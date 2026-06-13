import { XRPL_EXPLORER_URLS, XRPL_RPC_URLS } from 'xrpl-mpp-sdk'
import { getEnv } from './env'
import type { NetworkConfig, NetworkName } from './types'

const LOCAL_RPC_DEFAULT = 'ws://localhost:6006'

/**
 * Resolve the active network. `NETWORK=local|testnet`; `XRPL_RPC_URL` overrides
 * the endpoint. For `local` the SDK is still told `testnet` (network id 1) since
 * the xrpl-up sandbox runs a standalone rippled — only the RPC URL differs.
 */
export function resolveNetwork(name?: string): NetworkConfig {
  const networkName = (name ?? getEnv('NETWORK') ?? 'testnet') as NetworkName
  const override = getEnv('XRPL_RPC_URL')

  if (networkName === 'local') {
    return {
      name: 'local',
      sdkNetwork: 'testnet',
      rpcUrl: override ?? LOCAL_RPC_DEFAULT,
      faucetMode: 'local',
    }
  }

  if (networkName === 'testnet') {
    return {
      name: 'testnet',
      sdkNetwork: 'testnet',
      rpcUrl: override ?? XRPL_RPC_URLS.testnet,
      faucetMode: 'sdk-testnet',
      explorerTx: (hash) => `${XRPL_EXPLORER_URLS.testnet}${hash}`,
    }
  }

  throw new Error(`Unsupported NETWORK="${networkName}". Use "local" or "testnet".`)
}

/** SDK call options ({ network, rpcUrl }) so every SDK Wallet call hits the right endpoint. */
export function sdkNet(network: NetworkConfig): {
  network: NetworkConfig['sdkNetwork']
  rpcUrl: string
} {
  return { network: network.sdkNetwork, rpcUrl: network.rpcUrl }
}
