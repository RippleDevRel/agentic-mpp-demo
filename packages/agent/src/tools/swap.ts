/**
 * Swap tool: acquire the payment IOU by swapping XRP on-chain. Prices the route
 * from the AMM pool reserves (`amm_info`, constant-product + fee), falling back
 * to the order book, then submits an Immediate-Or-Cancel `OfferCreate` via OWS.
 * Aims slightly above the requirement and retries on under-fill so thin/volatile
 * testnet liquidity does not leave the balance just short. The XRP spend cap is
 * enforced by the OWS policy at signing, not here.
 */
import { currencyLabel, type Logger, type NetworkConfig, toIouValue, withClient } from '@agentic-mpp-demo-xrpl/shared'
import type { OwsXrplSigner } from '../signer/ows-xrpl-signer'
import type { IouCurrency } from './trustline'

const TF_IMMEDIATE_OR_CANCEL = 0x00020000

/** Aim this far above the required amount so a small under-fill still clears it. */
const SWAP_TARGET_BUFFER_BPS = 200
/** Re-quote and re-offer up to this many times to reach the target. */
const MAX_SWAP_ATTEMPTS = 4

/** Current balance of an IOU the account holds (display units), '0' if none. */
async function iouBalance(
  network: NetworkConfig,
  address: string,
  currency: { currency: string; issuer: string },
): Promise<string> {
  return withClient(network.rpcUrl, async (client) => {
    const res = await client
      .request({
        command: 'account_lines',
        account: address,
        peer: currency.issuer,
        ledger_index: 'validated',
      })
      .catch(() => null)
    const line = res?.result.lines?.find((l) => l.currency === currency.currency)
    return line?.balance ?? '0'
  })
}

/** Pure: XRP drops needed for `needValue` units at `dropsPerUnit`, plus slippage. */
export function computeMaxXrpDrops(
  needValue: string,
  dropsPerUnit: number,
  slippageBps: number,
): bigint {
  if (!Number.isFinite(dropsPerUnit) || dropsPerUnit <= 0) throw new Error('invalid book quality')
  const raw = Number(needValue) * dropsPerUnit
  return BigInt(Math.ceil(raw * (1 + slippageBps / 10_000)))
}

/**
 * Pure: XRP drops to receive `needValue` of the IOU from an AMM pool, using the
 * constant-product formula with the pool's trading fee, plus a slippage buffer.
 * `tradingFee` is the XRPL field (units of 1/100000; 1000 = 1%).
 */
export function ammQuoteDrops(
  xrpReserveDrops: number,
  iouReserve: number,
  needValue: number,
  tradingFee: number,
  slippageBps: number,
): bigint {
  if (!(xrpReserveDrops > 0) || !(iouReserve > 0)) throw new Error('empty AMM pool')
  if (!(needValue > 0)) throw new Error('non-positive swap amount')
  if (needValue >= iouReserve) throw new Error('swap amount exceeds AMM liquidity')
  const fee = tradingFee / 100_000
  // Input dx to receive needValue out: (X + dx·(1-fee))·(Y - dy) = X·Y.
  const dxDrops = (xrpReserveDrops * needValue) / (iouReserve - needValue) / (1 - fee)
  return BigInt(Math.ceil(dxDrops * (1 + slippageBps / 10_000)))
}

/** Price the swap from the AMM pool reserves (preferred — exact for current state). */
async function quoteXrpDropsViaAmm(
  network: NetworkConfig,
  iou: IouCurrency,
  needValue: string,
  slippageBps: number,
  log: Logger,
): Promise<bigint> {
  return withClient(network.rpcUrl, async (client) => {
    const res = (await client.request({
      command: 'amm_info',
      asset: { currency: 'XRP' },
      asset2: { currency: iou.currency, issuer: iou.issuer },
      ledger_index: 'validated',
    } as never)) as {
      result?: { amm?: { amount?: string; amount2?: { value?: string }; trading_fee?: number } }
    }
    const amm = res.result?.amm
    if (!amm?.amount || !amm.amount2?.value) throw new Error('no AMM pool for XRP/this IOU')
    const xrpReserve = Number(amm.amount)
    const iouReserve = Number(amm.amount2.value)
    const fee = amm.trading_fee ?? 0
    const drops = ammQuoteDrops(xrpReserve, iouReserve, Number(needValue), fee, slippageBps)
    log.step('swap route preflight (AMM)', {
      needValue,
      xrpReserve: (xrpReserve / 1e6).toFixed(2),
      iouReserve: iouReserve.toFixed(2),
      tradingFee: fee,
      maxXrp: (Number(drops) / 1e6).toFixed(6),
    })
    return drops
  })
}

/**
 * Fallback: price via the order book (which the offer-crossing engine bridges to
 * AMM liquidity). Uses the best offer's quality. Throws if no route exists.
 */
async function quoteXrpDropsViaBook(
  network: NetworkConfig,
  iou: IouCurrency,
  needValue: string,
  slippageBps: number,
  log: Logger,
): Promise<bigint> {
  return withClient(network.rpcUrl, async (client) => {
    const res = await client.request({
      command: 'book_offers',
      taker_gets: { currency: iou.currency, issuer: iou.issuer },
      taker_pays: { currency: 'XRP' },
      ledger_index: 'validated',
      limit: 10,
    })
    const offers = res.result.offers ?? []
    if (offers.length === 0)
      throw new Error('no XRP->payment-currency route (empty order book / no AMM)')
    // `quality` = TakerPays(drops) / TakerGets(IOU) = drops per unit.
    const best = offers[0] as { quality?: string }
    const dropsPerUnit = Number(best.quality ?? '0')
    const withSlip = computeMaxXrpDrops(needValue, dropsPerUnit, slippageBps)
    log.step('swap route preflight (book)', {
      needValue,
      dropsPerUnit: dropsPerUnit.toFixed(2),
      maxXrp: (Number(withSlip) / 1_000_000).toFixed(6),
    })
    return withSlip
  })
}

/** AMM-first quote, order-book fallback. */
async function quoteXrpDrops(
  network: NetworkConfig,
  iou: IouCurrency,
  needValue: string,
  slippageBps: number,
  log: Logger,
): Promise<bigint> {
  try {
    return await quoteXrpDropsViaAmm(network, iou, needValue, slippageBps, log)
  } catch (err) {
    log.warn('AMM quote unavailable, falling back to the order book', {
      msg: err instanceof Error ? err.message : String(err),
    })
    return quoteXrpDropsViaBook(network, iou, needValue, slippageBps, log)
  }
}

/**
 * Ensure the agent holds at least `requiredValue` of an IOU (the currency LEARNED
 * from the 402). Swaps XRP -> IOU on-chain via an OWS-signed Immediate-Or-Cancel
 * `OfferCreate`, sized from the AMM quote (+ slippage) toward a small buffer above
 * the requirement, retrying if a swap under-fills. The XRP spend cap is enforced
 * by the OWS policy at signing, not here.
 */
export async function ensureIouBalance(
  signer: OwsXrplSigner,
  network: NetworkConfig,
  iou: IouCurrency,
  params: { requiredValue: string; slippageBps: number },
  log: Logger,
): Promise<void> {
  const label = currencyLabel(iou.currency)
  const address = signer.address()
  const required = Number(params.requiredValue)
  const target = required * (1 + SWAP_TARGET_BUFFER_BPS / 10_000)

  for (let attempt = 1; attempt <= MAX_SWAP_ATTEMPTS; attempt++) {
    const have = Number(await iouBalance(network, address, iou))
    if (have >= required) {
      log.info(`already hold enough ${label}`, { have, required })
      return
    }

    const need = toIouValue(target - have)
    const maxXrpDrops = await quoteXrpDrops(network, iou, need, params.slippageBps, log)
    log.step(`swapping XRP -> ${label}`, { attempt, need, maxXrpDrops: maxXrpDrops.toString() })
    await signer.signAndSubmit(
      {
        TransactionType: 'OfferCreate',
        TakerGets: maxXrpDrops.toString(),
        TakerPays: { currency: iou.currency, issuer: iou.issuer, value: need },
        Flags: TF_IMMEDIATE_OR_CANCEL,
      },
      { label: `OfferCreate XRP->${label}` },
    )

    const after = Number(await iouBalance(network, address, iou))
    if (after >= required) {
      log.info(`acquired ${label} via swap`, { balance: after, attempt })
      return
    }
    log.warn(`swap under-filled, retrying`, { have: after, required, attempt })
  }

  const finalBal = await iouBalance(network, address, iou)
  throw new Error(
    `could not reach ${required} ${label} after ${MAX_SWAP_ATTEMPTS} swaps (have ${finalBal})`,
  )
}
