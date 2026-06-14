import { defineConfig } from 'tsup'

// Bundles the runnable entrypoints to prove the whole workspace compiles to JS.
// All third-party and native deps stay external; only our own code is bundled.
// The apps are normally run via tsx in dev — this build is the CI buildability gate.
export default defineConfig({
  entry: {
    'merchant/server': 'packages/merchant/src/server.ts',
    'agent/index': 'packages/agent/src/index.ts',
    'scripts/check-testnet': 'scripts/check-testnet.ts',
    'scripts/demo': 'scripts/demo.ts',
  },
  outDir: 'dist',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  splitting: false,
  clean: true,
  skipNodeModulesBundle: true,
  // Native/third-party deps are never bundled.
  external: [
    'xrpl',
    'mppx',
    'xrpl-mpp-sdk',
    '@open-wallet-standard/core',
    '@open-wallet-standard/adapters',
    '@anthropic-ai/claude-agent-sdk',
    '@anthropic-ai/sdk',
  ],
})
