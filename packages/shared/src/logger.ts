/* Minimal structured logger + run summary, shared across merchant, agent, scripts. */

type Level = 'info' | 'warn' | 'error' | 'step' | 'txn'

const ICONS: Record<Level, string> = {
  info: '·',
  warn: '⚠',
  error: '✖',
  step: '▸',
  txn: '⛓',
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, meta?: Record<string, unknown>): void
  error(msg: string, meta?: Record<string, unknown>): void
  /** A high-level pipeline step (discovery, swap, pay, …). */
  step(msg: string, meta?: Record<string, unknown>): void
  /** A confirmed on-chain transaction. */
  txn(label: string, hash: string, explorer?: string): void
  child(scope: string): Logger
}

function fmtMeta(meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) return ''
  const parts = Object.entries(meta).map(
    ([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`,
  )
  return ` ${parts.join(' ')}`
}

export function createLogger(scope: string): Logger {
  const emit = (level: Level, msg: string, meta?: Record<string, unknown>) => {
    const line = `${ICONS[level]} [${scope}] ${msg}${fmtMeta(meta)}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }
  return {
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
    step: (m, meta) => emit('step', m, meta),
    txn: (label, hash, explorer) =>
      emit('txn', `${label}: ${hash}`, explorer ? { explorer: explorer } : undefined),
    child: (child) => createLogger(`${scope}:${child}`),
  }
}

/** Accumulates milestones for a clean end-of-run summary (Phase 4.4). */
export class RunSummary {
  private readonly lines: string[] = []

  add(label: string, detail?: string): void {
    this.lines.push(detail ? `${label} — ${detail}` : label)
  }

  render(title = 'Run summary'): string {
    const body = this.lines.map((l, i) => `  ${i + 1}. ${l}`).join('\n')
    return `\n=== ${title} ===\n${body}\n`
  }
}
