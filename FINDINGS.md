# Findings & "What it takes" — Autonomous RWA Agent

Living log of every assumption, integration decision, and gap encountered while
executing the build plan. Required deliverable per plan §10.6.

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

## Open items to verify during build
- [ ] OWS `@open-wallet-standard/core` installs with darwin-arm64 prebuilt; `signAndSend`
      produces a valid XRPL blob (resolves GAP 1 for setup txs).
- [ ] Whether OWS exposes the pubkey via any API not yet found.
- [ ] testnet XRP/RLUSD AMM reachable for the swap leg (check-testnet.ts).
