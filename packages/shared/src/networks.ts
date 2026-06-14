import { XRPL_EXPLORER_URLS, XRPL_RPC_URLS } from 'xrpl-mpp-sdk'
import { getEnv } from './env'
import type { NetworkConfig, NetworkName } from './types'

const TESTNET_HTTP_RPC_DEFAULT = 'https://s.altnet.rippletest.net:51234/'

/**
 * Resolve the active network. Testnet only; `XRPL_RPC_URL` / `XRPL_HTTP_RPC_URL`
 * override the WS / HTTP endpoints.
 */
export function resolveNetwork(name?: string): NetworkConfig {
  const networkName = (name ?? getEnv('NETWORK') ?? 'testnet') as NetworkName
  if (networkName !== 'testnet') {
    throw new Error(`Unsupported NETWORK="${networkName}". Only "testnet" is supported.`)
  }
  return {
    name: 'testnet',
    sdkNetwork: 'testnet',
    rpcUrl: getEnv('XRPL_RPC_URL') ?? XRPL_RPC_URLS.testnet,
    httpRpcUrl: getEnv('XRPL_HTTP_RPC_URL') ?? TESTNET_HTTP_RPC_DEFAULT,
    explorerTx: (hash) => `${XRPL_EXPLORER_URLS.testnet}${hash}`,
  }
}

/** SDK call options ({ network, rpcUrl }) so every SDK Wallet call hits the right endpoint. */
export function sdkNet(network: NetworkConfig): {
  network: NetworkConfig['sdkNetwork']
  rpcUrl: string
} {
  return { network: network.sdkNetwork, rpcUrl: network.rpcUrl }
}
