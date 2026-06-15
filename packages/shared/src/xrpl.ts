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
