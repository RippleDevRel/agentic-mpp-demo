import {
  createLogger,
  getEnv,
  type Logger,
  type ResolvedConfig,
  resolveConfig,
  sdkNet,
} from '@agentic-mpp-demo-xrpl/shared'
import { Wallet as XrplWallet } from 'xrpl'
import { Wallet } from 'xrpl-mpp-sdk'
import { loadStore, type MerchantStore, saveStore } from './state'

export interface MerchantContext {
  cfg: ResolvedConfig
  /** SDK Wallet bound to the merchant account (issuer + charge recipient). */
  wallet: Wallet
  store: MerchantStore
  net: ReturnType<typeof sdkNet>
  log: Logger
  persist(): void
}

/**
 * Load (or create + fund) the merchant wallet, reusing persisted state across
 * restarts. On testnet/local the faucet funds via the SDK; an explicit
 * MERCHANT_SEED is honored and funded if the account is not yet activated.
 */
export async function buildMerchant(): Promise<MerchantContext> {
  const cfg = resolveConfig()
  const log = createLogger('merchant')
  const net = sdkNet(cfg.network)
  const existing = loadStore(cfg.network.name)

  let wallet: Wallet
  let seed: string

  if (existing) {
    wallet = Wallet.fromSeed(existing.seed)
    seed = existing.seed
    log.info('reusing persisted merchant account', { address: wallet.address })
  } else {
    const envSeed = getEnv('MERCHANT_SEED')
    if (envSeed) {
      wallet = Wallet.fromSeed(envSeed)
      seed = envSeed
      await ensureActivated(cfg, wallet, log)
    } else {
      log.step('generating + funding merchant account from faucet')
      wallet = await Wallet.fromFaucet({ network: net.network, rpcUrl: net.rpcUrl })
      // The SDK Wallet keeps the seed; we persist it so restarts reuse the account.
      seed = wallet.seed ?? ''
      if (!seed)
        throw new Error('Faucet wallet has no recoverable seed; set MERCHANT_SEED instead.')
    }
    log.info('merchant account ready', { address: wallet.address })
  }

  const store: MerchantStore = existing ?? {
    address: wallet.address,
    seed,
    issuanceId: '',
    requireAuth: true,
    assetScale: cfg.asset.assetScale,
    network: cfg.network.name,
    remainingUnits: cfg.asset.availableUnits,
    extraIssuances: [],
    deliveries: {},
  }

  const ctx: MerchantContext = {
    cfg,
    wallet,
    store,
    net,
    log,
    persist: () => saveStore(store),
  }
  ctx.persist()
  return ctx
}

/** Fund an explicit-seed account from the faucet if it is not yet activated. */
async function ensureActivated(cfg: ResolvedConfig, wallet: Wallet, log: Logger): Promise<void> {
  const balance = await wallet.getXrpBalance({
    network: cfg.network.sdkNetwork,
    rpcUrl: cfg.network.rpcUrl,
  })
  if (balance !== '0') return
  log.step('funding merchant account from faucet (MERCHANT_SEED not yet activated)')
  const xrplWallet = XrplWallet.fromSeed(wallet.seed ?? '')
  const { Client } = await import('xrpl')
  const client = new Client(cfg.network.rpcUrl)
  await client.connect()
  try {
    await client.fundWallet(xrplWallet)
  } finally {
    await client.disconnect()
  }
}
