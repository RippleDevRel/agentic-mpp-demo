import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = fileURLToPath(new URL('.', import.meta.url))
const agentSrc = join(here, '..')

function allSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...allSourceFiles(p))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

describe('OWS key isolation', () => {
  it('the agent never extracts key material from OWS', () => {
    // exportWallet / importWalletPrivateKey would move the private key out of the
    // vault; the seed-derived SDK Wallet path would read a seed into the process.
    const forbidden = ['exportWallet', 'importWalletPrivateKey', '.fromSeed(', '.fromFaucet(']
    for (const file of allSourceFiles(agentSrc)) {
      const src = readFileSync(file, 'utf8')
      for (const token of forbidden) {
        expect(src.includes(token), `${file} must not use ${token}`).toBe(false)
      }
    }
  })

  it('the signer only uses the non-extracting OWS calls', () => {
    const src = readFileSync(join(here, 'ows-xrpl-signer.ts'), 'utf8')
    // It signs/queries through OWS, never exporting the key.
    expect(src).toContain('signAndSend')
    expect(src).toContain('signHash')
    expect(src).toContain('getWallet')
    expect(src).not.toContain('exportWallet')
  })
})
