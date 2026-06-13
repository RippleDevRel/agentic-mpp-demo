// Side-effect-free barrel for programmatic use (e.g. the demo orchestrator).
// The executable CLI entry is src/index.ts (run via `pnpm --filter @rwa/agent start`).

export type { AgentContext } from './context'
export { buildAgentContext } from './context'
export { runAgentLoop } from './loop'
export { type AcquireDeps, type AcquireResult, runAcquisition } from './pipeline'
