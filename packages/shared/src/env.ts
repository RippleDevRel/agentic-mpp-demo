import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

let loaded = false

/**
 * Load the nearest `.env` into `process.env` once, using Node's built-in loader
 * (no dotenv dependency). Safe to call from every entrypoint; a missing file is
 * not an error. Honors an explicit `path` or the `ENV_FILE` override.
 */
export function loadEnv(path?: string): void {
  if (loaded) return
  loaded = true
  const file = resolve(path ?? process.env.ENV_FILE ?? '.env')
  if (existsSync(file)) {
    process.loadEnvFile(file)
  }
}

export function getEnv(key: string): string | undefined {
  const v = process.env[key]
  return v === undefined || v === '' ? undefined : v
}

export function requireEnv(key: string): string {
  const v = getEnv(key)
  if (v === undefined) {
    throw new Error(`Missing required environment variable: ${key}`)
  }
  return v
}

export function getEnvNumber(key: string, fallback: number): number {
  const v = getEnv(key)
  if (v === undefined) return fallback
  const n = Number(v)
  if (Number.isNaN(n)) throw new Error(`Environment variable ${key} must be a number, got: ${v}`)
  return n
}
