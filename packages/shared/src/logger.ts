/* Minimal structured logger + run summary, shared across merchant, agent, scripts.
 *
 * Lines are colored by their ORIGIN so the operator can see, at a glance, which
 * subsystem is acting when merchant and agent share one terminal:
 *   agent (cyan) · OWS custody (green) · MPP protocol (magenta) ·
 *   on-chain tx (blue) · merchant infra (white) · warn (yellow) · error (red).
 */

type Level = 'info' | 'warn' | 'error' | 'step' | 'txn'

/** The origin a line belongs to — drives its color. */
type Channel = 'agent' | 'merchant' | 'ows' | 'mpp' | 'chain' | 'plain'

const ICONS: Record<Level, string> = {
  info: '·',
  warn: '⚠',
  error: '✖',
  step: '▸',
  txn: '⛓',
}

// Bright (9x) variants — they keep good contrast on a dark terminal, where the
// dim 3x colors (especially blue/gray) are hard to read.
const ANSI = {
  reset: '\x1b[0m',
  red: '\x1b[91m',
  green: '\x1b[92m',
  yellow: '\x1b[93m',
  blue: '\x1b[94m',
  magenta: '\x1b[95m',
  cyan: '\x1b[96m',
  white: '\x1b[97m',
} as const

// Emit color when attached to a TTY (and NO_COLOR is unset), or when FORCE_COLOR
// is set so a piped `pnpm demo` still shows the origin colors.
const USE_COLOR =
  'FORCE_COLOR' in process.env || (process.stdout.isTTY === true && !('NO_COLOR' in process.env))

const CHANNEL_COLOR: Record<Channel, string> = {
  agent: ANSI.cyan,
  merchant: ANSI.white,
  ows: ANSI.green,
  mpp: ANSI.magenta,
  chain: ANSI.blue,
  plain: '',
}

/** Level always wins for warn/error/txn; otherwise the channel decides the color. */
function colorFor(level: Level, channel: Channel): string {
  if (level === 'error') return ANSI.red
  if (level === 'warn') return ANSI.yellow
  if (level === 'txn') return CHANNEL_COLOR.chain
  return CHANNEL_COLOR[channel]
}

function paint(text: string, color: string): string {
  return USE_COLOR && color ? `${color}${text}${ANSI.reset}` : text
}

/** Default channel for plain info/step lines, inferred from the logger scope. */
function baseChannel(scope: string): Channel {
  if (scope === 'agent' || scope.startsWith('agent:')) return 'agent'
  if (scope === 'merchant' || scope.startsWith('merchant:')) return 'merchant'
  return 'plain'
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, meta?: Record<string, unknown>): void
  error(msg: string, meta?: Record<string, unknown>): void
  /** A high-level pipeline step (discovery, swap, pay, …). */
  step(msg: string, meta?: Record<string, unknown>): void
  /** A confirmed on-chain transaction (colored as chain). */
  txn(label: string, hash: string, explorer?: string): void
  /** An Open Wallet Standard custody action: wallet, policy, signing (green). */
  ows(msg: string, meta?: Record<string, unknown>): void
  /** A Machine Payments Protocol action: 402 challenge, credential, settlement (magenta). */
  mpp(msg: string, meta?: Record<string, unknown>): void
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
  const base = baseChannel(scope)
  const emit = (level: Level, channel: Channel, msg: string, meta?: Record<string, unknown>) => {
    const line = paint(
      `${ICONS[level]} [${scope}] ${msg}${fmtMeta(meta)}`,
      colorFor(level, channel),
    )
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }
  return {
    info: (m, meta) => emit('info', base, m, meta),
    warn: (m, meta) => emit('warn', base, m, meta),
    error: (m, meta) => emit('error', base, m, meta),
    step: (m, meta) => emit('step', base, m, meta),
    ows: (m, meta) => emit('step', 'ows', m, meta),
    mpp: (m, meta) => emit('step', 'mpp', m, meta),
    txn: (label, hash, explorer) =>
      emit('txn', 'chain', `${label}: ${hash}`, explorer ? { explorer: explorer } : undefined),
    child: (child) => createLogger(`${scope}:${child}`),
  }
}

/** One-line legend mapping each origin to its color, for the start of a run. */
export function colorLegend(): string {
  const swatch = (label: string, channel: Channel) => paint(label, CHANNEL_COLOR[channel])
  return `legend: ${[
    swatch('agent', 'agent'),
    swatch('OWS', 'ows'),
    swatch('MPP', 'mpp'),
    swatch('on-chain', 'chain'),
    swatch('merchant', 'merchant'),
  ].join('  ')}`
}

/** Accumulates milestones for a clean end-of-run summary. */
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
