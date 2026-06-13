# Findings & "What it takes" — Autonomous RWA Agent

Living log of every assumption, integration decision, and gap encountered while
executing the build plan. Required deliverable per plan §10.6.

## TL;DR — "what it takes" (plan §10.6)
- **SDK on npm?** No. `xrpl-mpp-sdk` is consumed via one `pnpm` override → a locally
  built tarball; going live on npm = delete the override block (one line).
- **Which signing path worked (2.3)?** Full key isolation, no SDK fork, no seed: OWS
  generates/holds the key; the signer recovers the secp256k1 pubkey from a `signHash`
  signature (ECDSA recovery, address-matched) to set `SigningPubKey`, then OWS
  `signAndSend` injects `TxnSignature` and broadcasts (HTTP JSON-RPC). The MPP payment
  uses **push mode**: OWS signs+submits the Payment, then an mppx credential hands the
  tx hash to the SDK server. Verified live on testnet, end to end.
- **Credential interop gaps?** None blocking. mppx `Challenge.fromResponse` +
  `Credential.serialize({challenge, payload:{type:'hash',hash}, source})` interoperate
  with the SDK server's push-mode verify. (mppx 0.7 dropped `result.receipt`; recover
  the reference via `Receipt.fromResponse(result.withReceipt(...))`.)
- **What the SDK should expose for a clean consumer:** an external-signer constructor
  on `Wallet`, e.g. `Wallet.fromSigner({ address, publicKey, sign })`, so the SDK
  *client* `charge` can sign via OWS directly (today it signs internally with a
  seed-derived Wallet). Until then the MPP leg uses push mode (above). Secondary: OWS
  could expose the account public key (avoids the recovery dance) and accept a wss RPC.
- **Assumptions made:** testnet network id ≤ 1024 so `NetworkID` is stripped; testnet
  XRP/RLUSD AMM exists (checked via `check:testnet`); merchant = issuer = charge
  recipient; one purchase buys the whole offered lot; MAX_SPEND enforced in-app (OWS
  has no declarative amount rule). Local (Docker) mode authored but not executed here.

## Environment

- Node v23.7.0, pnpm 11.6.0 (via corepack), npm 10.9.2, git 2.47.1.
- **Docker is NOT installed.** `xrpl-up` local sandbox requires Docker (MPT+AMM at
  genesis). Consequence: the `local` network / `pnpm demo:local` path cannot run on
  this machine until Docker is installed. Build everything network-agnostic; verify
  end-to-end on **testnet** where Docker is not needed, and document the Docker
  prerequisite for `local`.

## Pinned reference commits (read-only, never forked/vendored)

- `xrpl-mpp-sdk` @ `4e94d5e84c85a340df2cd26b03eaddeec560c45d` (v0.1.0, 2026-06-05).
- `@open-wallet-standard/core` @ `0e62e5f8f9b3e02a0131554eaa2a0c4ead1493d8` (v1.3.2, 2026-06-11).
- Clones live OUTSIDE the repo at `../.mpp-reference/` so nothing is vendored.

## SDK consumption (risk #6 — not on npm)

- SDK built locally (`pnpm install && pnpm build`) and packed with `npm pack` to
  `vendor/xrpl-mpp-sdk-0.1.0.tgz` (gitignored). A single `pnpm.overrides` entry
  redirects the bare `xrpl-mpp-sdk` specifier to this tarball.
- **Going live on npm = remove the one `pnpm.overrides` line.** All imports stay at
  bare published specifiers (`xrpl-mpp-sdk`, `xrpl-mpp-sdk/client`, `/server`).
- SDK build output: ESM in `dist/`, subpath exports `.`, `./client`, `./server`,
  `./channel*`. Peers: `xrpl@>=4.0.0`, `mppx@>=0.4.0` (we install these from npm).

## Tooling gotchas hit during scaffolding
- Machine-global `~/.npmrc` points the registry at a corporate Artifactory mirror,
  which timed out. Plan mandates the official registry, so a project `.npmrc` pins
  `registry=https://registry.npmjs.org/` (also the correct fix).
- **pnpm 11 ignores `pnpm.overrides` in `package.json`** — overrides moved to a
  top-level `overrides:` block in `pnpm-workspace.yaml`. The SDK tarball override
  lives there now.

## Phase 2.3 — the signer seam (THE crux). Confirmed by reading source.

### SDK `Wallet` (sdk/src/utils/wallet.ts)
- **Private constructor.** Only factories: `fromSeed(seed)`, `generate(algo)`,
  `fromFaucet()`. **No external-signer / sign-callback / public-key constructor.**
- Wraps an xrpl.js `XrplWallet` and signs internally (`wallet.sign(prepared)`).
- Client `charge({ wallet?, seed?, mode, network, ... })` (pull/push). In pull mode
  it builds + signs the Payment internally and sends `{ type:'transaction', blob }`.
  There is **no hook to inject an external signature** into `charge`.

### OWS signing (bindings/node, crates/ows-signer/src/chains/xrpl.rs)
- `signTransaction(wallet, chain, txHex, passphrase?, index?, vault?)` →
  `{ signature: <hex DER>, recoveryId: undefined }`. Key decrypted in-process, used,
  wiped — **never leaves OWS**. `signAndSend(...)` signs + broadcasts internally.
- XRPL signing is **secp256k1 only** (DER sig over SHA512-half of `STX\0`‖txbytes).
- **GAP 1:** OWS does **not expose the XRPL public key** (`getWallet` gives address
  only; WDK adapter returns `publicKey: null`). To assemble a signed XRPL blob with
  xrpl.js you need `SigningPubKey`. So a "sign callback returns blob" path needs the
  pubkey, which OWS withholds. `signAndSend` sidesteps this (OWS assembles+submits
  internally) — to verify it produces valid XRPL blobs.
- **GAP 2:** OWS `ows pay` / x402 client is **EVM/USDC (`exact` scheme) ONLY**. No
  XRPL scheme. So plan option 3 (run the MPP payment leg via OWS's native client) is
  **not viable** — OWS cannot speak the SDK server's XRPL MPP envelope.

### Resolution (recorded; see signer/ows-xrpl-signer.ts)
- **Setup/acquisition txs the agent issues directly** (activation, TrustSet,
  MPTokenAuthorize opt-in, AMM swap/OfferCreate): route through OWS so the key never
  leaves OWS. This is the genuine key-isolation proof and satisfies the Phase 2 DoD.
- **MPP payment leg (SDK client `charge`)**: SDK `Wallet` has no external-signer hook
  and OWS x402 can't do XRPL, so true isolation here needs an **SDK enhancement**:
  `Wallet.fromSigner({ address, publicKey, sign })` where `sign` delegates to OWS
  (plan option 2). This is recorded as the required upstream SDK change — NOT patched
  into our local artifact (that would mask the gap). For a runnable demo the documented
  fallback (plan option 4) is used: an env-gated, off-by-default `ALLOW_SEED_FALLBACK`
  that hands the SDK `Wallet` a seed for the payment leg only, loudly flagged as a
  security downgrade. The strict happy path keeps the key in OWS for everything except
  this leg, which is blocked pending the SDK enhancement.

## Phase 2.3 RESOLVED — OWS-isolated XRPL signing works (proven on testnet)
The target (key never leaves OWS, no SDK fork, no seed) is achievable for every tx
the agent issues directly. Real installed OWS v1.3.2 Node API:
- `createWallet(name, passphrase, words, vault)` → derives 10 chains incl.
  `xrpl:mainnet` at `m/44'/144'/0'/0/0` (secp256k1). Address is network-agnostic.
- `signAndSend(wallet, 'xrpl', txHex, passphrase, index, HTTP_rpc, vault)` → `{txHash}`.
  It signs over `txHex` and injects ONLY `TxnSignature`; it **broadcasts via curl/HTTP
  JSON-RPC (NOT wss)** and **expects `SigningPubKey` already embedded in txHex**.
- `AccountInfo` exposes address only — **no public key** (GAP 1). `signTransaction`
  returns a bare DER signature, no recoveryId.

**The unlock:** recover the secp256k1 public key without the private key leaving OWS —
`signHash(wallet,'xrpl',H)` → DER sig; parse (r,s); brute-force the 2 recovery bits with
`@noble/curves`; derive the XRPL address for each candidate and keep the one matching the
OWS address. Recovered `SigningPubKey` once, cache it. Then: build unsigned tx, set
`SigningPubKey`, autofill via xrpl.js (WS), `delete NetworkID` (testnet id 1 must omit it),
`encode()`, hand the hex to OWS `signAndSend` (HTTP). **Proven:** an AccountSet validated
on testnet (`rcaeZ8Cw7…`), key never left OWS.

Consequences for config: a NetworkConfig now carries BOTH a WS url (xrpl.js) and an
HTTP JSON-RPC url (OWS broadcast). Dependency added: `@noble/curves` (agent) for recovery.

This still leaves the **MPP payment leg** (SDK client `charge`) needing the SDK `Wallet`,
which has no external-signer hook — recorded as the upstream SDK enhancement
(`Wallet.fromSigner`). For that one leg the demo uses the env-gated, off-by-default
`ALLOW_SEED_FALLBACK`; everything else (activation, TrustSet, MPTokenAuthorize opt-in,
AMM swap) goes through the OWS signer with full isolation.

## OWS policy model (Phase 2.1)
- OWS declarative policy rules are only `allowed_chains` and `expires_at` — **no
  native max-amount rule**. So MAX_SPEND is enforced in-app (the swap/payment tools);
  OWS bounds the agent to XRPL-only + expiry. A future executable (WASM) policy could
  add an on-device spend cap.
- Policies are enforced **only when signing with an agent token** (`ows_key_...`), not
  with the owner passphrase. So: owner creates wallet + policy + API key once; the
  agent signs with the token. Implemented in tools/wallet.ts; token persisted in
  `.data/agent.<net>.json` (gitignored — it's a capability, not the key).
- **Phase 2 verified live:** agent wallet `r9N21UZHkayw7…` created (key in OWS),
  policy `agent-treasury-xrpl-only` + token issued, funded 100 XRP from faucet, and an
  AccountSet signed via the token reached `tesSUCCESS` (`D8E5522…`). Key never left OWS.

## Phase 3.5 — MPP payment WITHOUT giving up key isolation (the better path)
The SDK client `charge` signs internally with the SDK `Wallet` (no external-signer
hook), and OWS keys are BIP39/BIP32-derived so there is no XRPL family-seed to hand
`Wallet.fromSeed` — an SDK-Wallet fallback would be a *different account* than the
funded/opted-in OWS one. Instead, the MPP pay leg is done in **push mode** using mppx
primitives + OWS signing, so the key stays in OWS and the SDK-powered server still
verifies the payment:
1. `GET /rwa/:id` → 402; parse with mppx `Challenge.fromResponse(res)`.
2. Build the XRPL Payment (XRP or RLUSD IOU) to `challenge.request.recipient`.
3. **OWS signs + submits** it (push mode) → tx hash (key isolated).
4. `Credential.serialize({ challenge, payload:{type:'hash',hash}, source:'did:pkh:xrpl:<net>:<addr>' })`
   (no private key needed — the on-chain tx is the proof).
5. Re-`GET` with `Authorization: <credential>` → SDK server `verifyPush` confirms → 200 + delivery.
This is still MPP/mppx + the SDK-powered server; only the signing leg routes through OWS
(not OWS's EVM-only `ows pay`). The clean upstream fix remains SDK `Wallet.fromSigner`,
recorded as the required enhancement; the `ALLOW_SEED_FALLBACK` path is kept only as an
off-by-default cross-check.

Swap leg: XRP→RLUSD via an `OfferCreate` (tfImmediateOrCancel) signed through OWS — the
offer-crossing engine consults AMM liquidity, no path-finding needed; quote/slippage from
`book_offers`, capped by MAX_SPEND.

## SDK API facts relied upon (from source)
- Constants (root export): `RLUSD_TESTNET = { currency:'524C555344…0000', issuer:'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV' }`,
  `BASE_RESERVE_DROPS='1000000'`, `OWNER_RESERVE_DROPS='200000'`, `XRPL_RPC_URLS`,
  `XRPL_FAUCET_URLS`, `NetworkId='mainnet'|'testnet'|'devnet'`.
- `Wallet` methods used: `createToken`, `authorize`, `issue`, `acceptToken`,
  `holdsToken`, `requireAuthorization`, `getXrpBalance`, `listIssuedTokens`,
  `listAcceptedTokens`.
- Server: `charge({ recipient, currency, autoTrustline, autoMPTAuthorize, store, ... })`
  + `prepareRecipient(...)`. Credentials bound to `did:pkh:xrpl:<net>:<addr>`.
- Reference: `examples/agent-template/src/{client,server}.ts`, `demo/mpt-charge.ts`
  (read-only; not forked).

## Phase 1 — merchant (verified live on testnet)
- Merchant = issuer = MPP charge recipient (one account). "Inventory" is a
  `remainingUnits` counter; delivery mints the MPT to the buyer (issuer→holder),
  so there is no self-minting. One purchase buys the whole offered lot.
- `Wallet.createToken({ requireAuthorization: true })` sets `tfMPTRequireAuth`. ✓
- mppx 0.7 changed the success result: it exposes only `withReceipt`, NOT
  `result.receipt`. Recover the on-chain tx hash via `Receipt.fromResponse(peek)`
  where `peek = result.withReceipt(...)`. The payer address is resolved from that
  tx's `Account`.
- `acceptToken` returns a discriminated `AcceptTokenResult` — guard `'hash' in res`.
- `MPTHoldingInfo` uses `balance` (not `amount`); raw `account_objects` uses
  `MPTAmount`. (Test harness initially checked the wrong field.)
- MPT metadata must follow XLS-89 (`ticker`/`name`/`asset_class`/`issuer_name`/`icon`)
  or rippled warns (non-fatal). `rwaMetadata()` now emits a compliant object.
- **Live proof:** merchant `rD875xqXGEBWEL9Tat62AqCtfxsnp7NdVA` issued
  `0115BE04…`; a buyer opted in, paid the 402 (XRP), and the ledger shows the buyer
  holding `MPTAmount: 500` (5 units @ scale 2). Delivery authorize + issue both
  validated.
- Root package now depends on the workspace packages + `xrpl` so `scripts/`
  (Phase 5 demo/orchestration) can import them.

## Phase 3 VERIFIED LIVE — full autonomous acquisition on testnet (RLUSD path)
From an OWS wallet with only XRP, the agent autonomously: discovered the merchant's
issuance (on-ledger `account_objects mpt_issuance` + catalog) → opted in
(MPTokenAuthorize) → set the RLUSD trust line → swapped XRP→RLUSD via an OfferCreate
(IOC, ~1.71 XRP/RLUSD, got 10 RLUSD) → paid 10 RLUSD via MPP push mode → merchant
verified the credential, authorized the holder, and delivered. **Agent received 300
base units (3 @ scale 2). Every agent tx signed through OWS — key never left OWS.**
Tx trail (testnet): opt-in 1FB271FF, TrustSet 66E10DC0, swap A9E6F7A9, MPP Payment
817BD40D, issuer-auth 0467B227, delivery 367EC856.
- XLS-89: `rwa` asset_class also requires `asset_subclass` — added.
- `MPTHoldingInfo.balance` vs raw `MPTAmount` (account_objects) — pipeline uses the
  raw helper (`amount`).

## Phase 4 — Claude Agent SDK brain
- Built with `@anthropic-ai/claude-agent-sdk` 0.3.177: Phase 2/3 functions exposed as
  in-process tools via `tool()` + `createSdkMcpServer()`; `query({prompt, options})`
  drives the loop. `allowedTools` whitelists only the `mcp__rwa__*` tools,
  `settingSources: []` keeps the host's settings/skills/MCPs out, `permissionMode:
  'bypassPermissions'` runs headless. Model via `AGENT_MODEL` (default `sonnet`).
- **Model loop VERIFIED LIVE on testnet** (once an ANTHROPIC_API_KEY was provided):
  `pnpm demo:testnet` ran Claude (sonnet) which autonomously orchestrated the tools —
  `get_status → ensure_funded → discover_issuances → opt_in_mpt → ensure_trustline →
  swap_for_currency → pay_via_mpp → confirm_receipt` — and acquired 300 base units
  (paid 10 RLUSD). `model loop finished subtype=success`; key never left OWS. The SDK
  exposes tools lazily, so the model also calls `ToolSearch` to load schemas first.
- `index.ts` runs the model loop when a key is present and falls back to the
  deterministic pipeline otherwise (keyless CI/demo).

## Phase 5 — demo, tests, docs, CI
- `scripts/demo.ts`: one-command orchestrator (boot merchant → point agent → acquire →
  assert MPT lands). **Verified live on testnet: DEMO_OK**, agent acquired 300 base
  units (paid 10 RLUSD), key never left OWS, in a single process.
- Unit tests (vitest, 13 passing): reserve sizing, swap quote math, discovery dedup,
  currency hex, and the **key-isolation source scan** (no `exportWallet`/seed paths).
  Plus a network-gated integration smoke (`RUN_INTEGRATION=1`).
- CI: prebuilds the vendored SDK → install → lint → typecheck → build → test.
- `pnpm demo:local` needs Docker (xrpl-up); `pnpm demo:testnet` is the validated path.

## Resolved items
- [x] OWS installs darwin-arm64 prebuilt; `signAndSend` broadcasts via HTTP (not wss).
- [x] OWS does not expose the pubkey → recovered via ECDSA from `signHash`.
- [x] testnet XRP/RLUSD route reachable (~1.71 XRP/RLUSD) — `check:testnet` passes.
