// Side-effect-free barrel for programmatic use (e.g. the demo orchestrator).
// The executable CLI entry is src/index.ts (run via `pnpm --filter @agentic-mpp-demo-xrpl/agent start`).

export { buildAgentContext } from './context'
export { runAgentLoop } from './loop'
export { runAcquisition } from './pipeline'
