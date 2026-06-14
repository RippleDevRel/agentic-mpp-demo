import { currencyLabel, type Logger, type NetworkConfig, toDrops, withClient } from '@rwa/shared'
import type { OwsXrplSigner } from '../signer/ows-xrpl-signer'
import type { IouCurrency } from './trustline'

const TF_IMMEDIATE_OR_CANCEL = 0x00020000

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
 * Preflight an XRP -> payment-currency route via the order book (which includes
 * AMM liquidity) and return the XRP (drops) needed for `needValue`, with slippage.
 * Throws if no route exists.
 */
async function quoteXrpDrops(
  network: NetworkConfig,
  payment: { currency: string; issuer: string },
  needValue: string,
  slippageBps: number,
  log: Logger,
): Promise<bigint> {
  return withClient(network.rpcUrl, async (client) => {
    const res = await client.request({
      command: 'book_offers',
      taker_gets: { currency: payment.currency, issuer: payment.issuer },
      taker_pays: { currency: 'XRP' },
      ledger_index: 'validated',
      limit: 10,
    })
    const offers = res.result.offers ?? []
    if (offers.length === 0)
      throw new Error('no XRP->payment-currency route (empty order book / no AMM)')
    // `quality` = TakerPays(drops) / TakerGets(RLUSD) = drops per unit.
    const best = offers[0] as { quality?: string }
    const dropsPerUnit = Number(best.quality ?? '0')
    const withSlip = computeMaxXrpDrops(needValue, dropsPerUnit, slippageBps)
    log.step('swap route preflight', {
      needValue,
      dropsPerUnit: dropsPerUnit.toFixed(2),
      maxXrp: (Number(withSlip) / 1_000_000).toFixed(6),
    })
    return withSlip
  })
}

/**
 * Ensure the agent holds at least `requiredValue` of an IOU (the currency LEARNED
 * from the 402). Swaps XRP -> IOU on-chain via an OfferCreate (ImmediateOrCancel)
 * signed through OWS — the offer-crossing engine consults AMM liquidity, so no
 * path-finding is needed. Never spends beyond MAX_SPEND.
 */
export async function ensureIouBalance(
  signer: OwsXrplSigner,
  network: NetworkConfig,
  iou: IouCurrency,
  params: { requiredValue: string; maxSpendXrp: number; slippageBps: number },
  log: Logger,
): Promise<void> {
  const label = currencyLabel(iou.currency)
  const address = signer.address()
  const have = await iouBalance(network, address, iou)
  if (Number(have) >= Number(params.requiredValue)) {
    log.info(`already hold enough ${label}`, { have, required: params.requiredValue })
    return
  }

  const need = (Number(params.requiredValue) - Number(have)).toString()
  const maxXrpDrops = await quoteXrpDrops(network, iou, need, params.slippageBps, log)
  const capDrops = BigInt(toDrops(String(params.maxSpendXrp)))
  if (maxXrpDrops > capDrops) {
    throw new Error(
      `swap would exceed MAX_SPEND: needs up to ${Number(maxXrpDrops) / 1e6} XRP, cap ${params.maxSpendXrp} XRP`,
    )
  }

  log.step(`swapping XRP -> ${label}`, { need, maxXrpDrops: maxXrpDrops.toString() })
  await signer.signAndSubmit(
    {
      TransactionType: 'OfferCreate',
      TakerGets: maxXrpDrops.toString(),
      TakerPays: { currency: iou.currency, issuer: iou.issuer, value: need },
      Flags: TF_IMMEDIATE_OR_CANCEL,
    },
    { label: `OfferCreate XRP->${label}` },
  )

  const after = await iouBalance(network, address, iou)
  if (Number(after) < Number(params.requiredValue)) {
    throw new Error(
      `swap did not yield enough ${label}: have ${after}, need ${params.requiredValue}`,
    )
  }
  log.info(`acquired ${label} via swap`, { balance: after })
}
