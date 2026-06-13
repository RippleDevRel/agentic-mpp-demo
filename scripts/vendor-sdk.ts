/**
 * Regenerate the local xrpl-mpp-sdk tarball that `pnpm.overrides` points at.
 *
 * The SDK is not yet published to npm (see FINDINGS.md). This script clones it at
 * a pinned commit, builds it, and `npm pack`s it into `vendor/`. CI runs the same
 * steps before `pnpm install`. Going live on npm = drop the override in package.json.
 *
 * Usage: pnpm sdk:vendor  (or: tsx scripts/vendor-sdk.ts)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SDK_REPO = 'https://github.com/krkmu/xrpl-mpp-sdk.git'
const SDK_COMMIT = '4e94d5e84c85a340df2cd26b03eaddeec560c45d'
const VENDOR_DIR = resolve('vendor')

function run(cmd: string, args: string[], cwd?: string): void {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' })
}

function main(): void {
  // Prefer an existing local reference checkout to avoid a network clone.
  const localRef = resolve('..', '.mpp-reference', 'xrpl-mpp-sdk')
  let sdkDir: string
  let cleanup: (() => void) | undefined

  if (existsSync(join(localRef, 'package.json'))) {
    console.log(`Using local SDK checkout at ${localRef}`)
    sdkDir = localRef
  } else {
    const tmp = mkdtempSync(join(tmpdir(), 'xrpl-mpp-sdk-'))
    console.log(`Cloning SDK @ ${SDK_COMMIT} into ${tmp}`)
    run('git', ['clone', SDK_REPO, tmp])
    run('git', ['-C', tmp, 'checkout', SDK_COMMIT])
    sdkDir = tmp
    cleanup = () => rmSync(tmp, { recursive: true, force: true })
  }

  try {
    run('pnpm', ['install'], sdkDir)
    run('pnpm', ['build'], sdkDir)
    run('npm', ['pack', '--pack-destination', VENDOR_DIR], sdkDir)
    console.log(`\nTarball written to ${VENDOR_DIR}/xrpl-mpp-sdk-0.1.0.tgz`)
  } finally {
    cleanup?.()
  }
}

main()
