import { execFileSync } from 'node:child_process'
import { chmodSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { RLUSD_TESTNET } from '@rwa/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { encode } from 'xrpl'

const script = fileURLToPath(new URL('../policy/max-spend.mjs', import.meta.url))
const ACCOUNT = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV'

function offerCreateHex(takerGetsDrops: string): string {
  return encode({
    TransactionType: 'OfferCreate',
    Account: ACCOUNT,
    TakerGets: takerGetsDrops,
    TakerPays: { currency: RLUSD_TESTNET.currency, issuer: RLUSD_TESTNET.issuer, value: '10' },
    Fee: '12',
    Sequence: 1,
    Flags: 0,
    SigningPubKey: '',
  } as never)
}

function runPolicy(ctx: unknown): { allow: boolean; reason?: string } {
  const out = execFileSync(script, { input: JSON.stringify(ctx), encoding: 'utf8' })
  return JSON.parse(out)
}

describe('OWS max-spend executable policy', () => {
  beforeAll(() => chmodSync(script, 0o755))

  it('allows an XRP outflow within the cap (19 XRP <= 50)', () => {
    const ctx = {
      transaction: { raw: offerCreateHex('19000000') },
      policy_config: { maxSpendXrp: 50 },
    }
    expect(runPolicy(ctx).allow).toBe(true)
  })

  it('denies an XRP outflow over the cap (60 XRP > 50)', () => {
    const ctx = {
      transaction: { raw: offerCreateHex('60000000') },
      policy_config: { maxSpendXrp: 50 },
    }
    const r = runPolicy(ctx)
    expect(r.allow).toBe(false)
    expect(r.reason).toMatch(/exceeds max 50 XRP/)
  })

  it('allows a non-transaction sign (hash sign for pubkey recovery)', () => {
    expect(runPolicy({ policy_config: { maxSpendXrp: 50 } }).allow).toBe(true)
  })
})
