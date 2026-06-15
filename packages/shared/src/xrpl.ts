import { Client } from 'xrpl'

/** Open a connected client, run `fn`, always disconnect. */
export async function withClient<T>(
  rpcUrl: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client(rpcUrl)
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.disconnect()
  }
}

/** XRP balance in drops as a string, `'0'` if the account is not yet activated. */
export async function getXrpBalanceDrops(client: Client, address: string): Promise<string> {
  try {
    const res = await client.request({
      command: 'account_info',
      account: address,
      ledger_index: 'validated',
    })
    return res.result.account_data.Balance
  } catch {
    return '0'
  }
}

/**
 * Format a number as an XRPL IOU `value` string. XRPL IOU amounts allow at most
 * 15 significant digits; a raw float subtraction like `11 - 9.7963116174` yields
 * `1.2036883825999993` (17 digits) which the ledger rejects with temBAD_AMOUNT
 * ("Decimal precision out of range"). This trims to 15 significant digits.
 */
export function toIouValue(value: number | string): string {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid IOU value: ${value}`)
  if (n === 0) return '0'
  const s = Number(n.toPrecision(15)).toString()
  if (s.includes('e') || s.includes('E')) {
    throw new Error(`IOU value out of representable range: ${value}`)
  }
  return s
}

/** List MPT holdings for an account via `account_objects` (type mptoken). */
export async function listMptHoldings(
  client: Client,
  address: string,
): Promise<Array<{ issuanceId: string; amount: string }>> {
  const res = await client.request({
    command: 'account_objects',
    account: address,
    type: 'mptoken',
    ledger_index: 'validated',
  })
  return (res.result.account_objects ?? []).map((obj) => {
    const o = obj as unknown as { MPTokenIssuanceID?: string; MPTAmount?: string }
    return { issuanceId: o.MPTokenIssuanceID ?? '', amount: o.MPTAmount ?? '0' }
  })
}

export { Client }
