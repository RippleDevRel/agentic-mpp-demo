# Autonomous RWA Buyer Agent over MPP on XRPL

A template/demo where a merchant periodically issues a permissioned Multi-Purpose
Token (MPT) representing a Real World Asset (RWA), and an autonomous agent — given a
single instruction and an API key — bootstraps **everything it needs** (wallet,
funding, trust lines, MPT authorization, on-chain swap) and acquires those tokens by
paying through the Machine Payments Protocol (MPP).

The headline is the **autonomy of the setup**, not the sophistication of the purchase.
The agent starts with one sentence:

> _"Acquire every RWA token available from the merchant whose service endpoint is `<MERCHANT_URL>`."_

Everything else — creating a wallet, funding it, discovering issuances, acquiring the
payment currency, opting in, paying, taking delivery — it figures out. **The private
key never leaves Open Wallet Standard (OWS).**

This project is an independent consumer of [`xrpl-mpp-sdk`](https://github.com/krkmu/xrpl-mpp-sdk)
and [`@open-wallet-standard/core`](https://github.com/open-wallet-standard/core) — it
does not fork or vendor either.

## Architecture

```
                 ┌────────────────────────── operator setup ──────────────────────────┐
                 │  merchant (issuer + MPP server)                                      │
                 │  • self-funds, creates permissioned RWA MPT (tfMPTRequireAuth)       │
                 │  • sets RLUSD trust line, serves /catalog + /rwa/:id (MPP 402)        │
                 │  • on paid 402: MPTokenAuthorize(payer) then issues the MPT           │
                 └──────────────────────────────────────────────────────────────────────┘
                                              ▲   │ 402 challenge / delivery
                              MPP credential  │   ▼
   ┌──────────────────────────── agent autonomy ───────────────────────────────────────┐
   │  Claude Agent SDK loop  ──drives──►  tools  (two modes: rails | minimal)            │
   │    discover ─► fund ─► opt-in (MPTokenAuthorize) ─► trust (RLUSD) ─►                │
   │    swap (XRP→RLUSD OfferCreate) ─► pay (MPP push mode) ─► confirm receipt           │
   │                                       │                                             │
   │                          every tx ──► OWS vault (holds key, enforces policy) ──► XRPL │
   └──────────────────────────────────────────────────────────────────────────────────┘
```

- **Operator setup** = the merchant. It is bootstrapped (funded, issuance created)
  with no manual steps when the server starts.
- **Agent autonomy** = the buyer. It is given *only* the seller's **service endpoint**
  (a URL) and an API key — **not** the merchant's ledger address. It reads the endpoint's
  catalog to find the resources on offer and learns each purchase's **payment recipient,
  amount, and currency from the resource's HTTP 402 challenge** when it pays. No wallet,
  funding, trust line, authorization, or swap is pre-provisioned.

### Key isolation (the crux)

The agent's key is generated inside OWS and never leaves it. Every transaction the
agent issues — activation, `MPTokenAuthorize` opt-in, `TrustSet`, the XRP→RLUSD
`OfferCreate`, and the MPP payment — is signed by OWS. Because OWS does not expose the
public key and its signer expects `SigningPubKey` to be present, the signer recovers
the secp256k1 public key from a signature (ECDSA recovery, matching the OWS address)
and lets OWS `signAndSend` inject the signature and broadcast. The MPP payment is done
in **push mode**: OWS signs+submits the on-chain Payment, then the tx hash is handed to
the SDK-powered merchant via an mppx credential — so the key stays in OWS while the
merchant still verifies the payment.

### Guardrails (enforced by OWS, in both modes)

The agent signs with a policy-bound OWS API token, so the OWS policy is enforced **at the
signing boundary** — a misbehaving (or model-driven) agent cannot get a non-compliant
transaction signed:

- **XRPL only** + a time-bounded API token (declarative rules).
- **Per-transaction spend cap** of `MAX_SPEND` XRP, via an OWS *executable* policy
  (`packages/agent/policy/max-spend.mjs`) that decodes the tx and denies on overflow.

`MAX_SPEND` is also checked in-app on the rails swap; in minimal mode the OWS cap is the
backstop. (OWS has no cumulative/rolling limit yet, so the cap is per-transaction.)

## Workspace layout

```
packages/
  shared/    # config (networks, assets), env, xrpl helpers, logger, SDK re-exports
  merchant/  # RWA issuer + MPP charge server + delivery (bootstrap, server, issuer)
  agent/
    src/signer/         # OWS signing bridge (pubkey recovery + signAndSend)
    src/tools/          # rails: discovery, funding, swap, trustline, mpp, wallet
    src/loop.ts         # rails agent (high-level domain tools)
    src/minimal.ts      # minimal agent (generic primitives only)
    src/pipeline.ts     # deterministic fallback (keyless / CI)
    policy/max-spend.mjs # OWS executable spend-cap policy
scripts/     # check-testnet, demo, vendor-sdk
vendor/      # locally built xrpl-mpp-sdk tarball (gitignored; regenerated by CI)
```

## Quick start (testnet — the validated path)

```bash
pnpm sdk:vendor            # build the xrpl-mpp-sdk tarball (it is not yet on npm)
pnpm install
cp .env.example .env       # set ANTHROPIC_API_KEY (optional), OWS_PASSPHRASE, etc.

pnpm check:testnet         # verify the XRP/RLUSD AMM route is reachable
pnpm demo                  # boot merchant + agent, acquire end-to-end
```

`pnpm demo` boots the merchant, points the agent at it, and runs the autonomous
acquisition. With `ANTHROPIC_API_KEY` set, a Claude model drives the tool-use loop;
without one it runs the same tools through a deterministic pipeline (handy for CI).

## Two agent modes: "rails" vs "minimal"

The same goal, the same OWS-custodied wallet and policy, but two ends of the
**autonomy ⇄ reliability** spectrum. Both keep the key in OWS and are bounded by the
same OWS policy (XRPL-only, expiry, per-tx MAX_SPEND cap).

```bash
# against a running merchant (MERCHANT_URL defaults to http://localhost:8787):
pnpm agent           # rails  — high-level domain tools
pnpm agent:minimal   # minimal — generic primitives, the model builds the txs itself
```

Both read `ANTHROPIC_API_KEY`, `OWS_PASSPHRASE`, and `MERCHANT_URL` from `.env`. Without
`ANTHROPIC_API_KEY`, `pnpm agent` falls back to the deterministic pipeline.

- **Rails** (`packages/agent/src/loop.ts`) exposes **9 domain verbs**
  (`discover_issuances`, `quote_resource`, `opt_in_mpt`, `ensure_trustline`,
  `swap_for_currency`, `pay_via_mpp`, `confirm_receipt`, …). The *how* of each on-chain
  action — tx construction, AMM quoting, reserve sizing, idempotency, wait-for-validation
  — lives in code. The model only orchestrates: it decides the sequence, wires the 402
  data through, loops, and stops.

- **Minimal** (`packages/agent/src/minimal.ts`) exposes only **generic primitives** —
  `xrpl_query` (read), `xrpl_sign_submit` (sign any tx via OWS), `faucet`, `http_get`,
  `mpp_quote`, `mpp_settle`. There is **no** bespoke opt-in/trustline/swap/discovery code:
  the model reads the ledger, builds the XRPL transactions itself (as JSON), works out the
  ordering, and self-corrects from errors. OWS is the only hard guardrail.

### What's irreducible either way

Two pieces have no generic/CLI equivalent and exist in both modes:
1. **The OWS signing bridge** (`packages/agent/src/signer/ows-xrpl-signer.ts`) — recover
   the pubkey, sign via OWS `signAndSend`.
2. **The MPP credential glue** (`Challenge.fromResponse` + `Credential.serialize`) — the
   402/credential envelope can't be reconstructed from raw HTTP.

### The tradeoff (measured on testnet, model-driven)

| | Rails | Minimal |
| --- | --- | --- |
| Tools exposed | 9 domain verbs | 6 generic primitives |
| Who builds the transactions | the code | **the model** (JSON) |
| Discovers the flow | recipe in the prompt | the model derives + adapts |
| Reliability | deterministic, first try | works, but **stumbles then self-corrects** |
| Tool calls for one purchase | ~11 | ~26 (more reads, retries, reasoning) |
| Guardrails | OWS policy + in-code checks | **OWS policy only** |
| Observed | clean acquisition | self-fixed a `book_offers` query, acquired multiple issuances end-to-end, **0 OWS denials** |

Both were validated live on testnet. The minimal agent genuinely "figures it out" — but it
costs more model turns and demands very robust primitives (e.g. transactions are passed as
JSON strings, and tools return clear errors the model can read and recover from). The rails
agent trades that autonomy for determinism, lower cost, and testability. Pick by how much
you trust the model to assemble protocol-correct transactions vs. how much you want pinned
in code; OWS catches the *dangerous* (out-of-policy) either way — not the *incorrect*.

## Environment reference (`.env.example`)

| Variable | Purpose |
| --- | --- |
| `NETWORK` | `testnet` (only) |
| `XRPL_RPC_URL` / `XRPL_HTTP_RPC_URL` | optional WS / HTTP RPC overrides |
| `MERCHANT_SEED` | operator-held; if empty the merchant generates + faucet-funds one |
| `MERCHANT_PORT` | merchant HTTP port |
| `MERCHANT_URL` | the seller endpoint the agent is given (its only merchant locator; default `http://localhost:8787`) |
| `RWA_PRICE`, `RWA_AVAILABLE_UNITS`, `RWA_ASSET_SCALE`, `RWA_METADATA` | RWA issuance + pricing |
| `MPP_SECRET_KEY` | mppx server secret (merchant) |
| `PAYMENT_CURRENCY` | what the merchant charges: `RLUSD` \| `XRP` |
| `ANTHROPIC_API_KEY`, `AGENT_MODEL` | model loop (default model `sonnet`); omit key → deterministic pipeline |
| `MAX_SPEND`, `AGENT_MAX_ITERATIONS` | per-tx XRP cap (enforced in-app **and** by the OWS policy) + loop bound |
| `OWS_WALLET_NAME`, `OWS_PASSPHRASE`, `OWS_VAULT_PATH` | OWS wallet name, owner passphrase, vault dir |
| `SWAP_SLIPPAGE_BPS` | swap slippage bound |

## Known constraints

1. **Signer integration is the central task.** Resolved by recovering the OWS public
   key and signing through OWS (`signAndSend`); the MPP leg uses push mode. The clean
   upstream fix is an external-signer constructor on the SDK `Wallet`
   (`Wallet.fromSigner`).
2. **RLUSD funding on testnet** is not scriptable, so the agent self-funds in XRP and
   swaps to RLUSD on the existing testnet AMM (no operator liquidity setup).
3. **RLUSD identifiers** come from the SDK `RLUSD_TESTNET` constant (40-char hex
   currency + issuer), not redefined here.
4. **Account reserves** are sized explicitly (base + owner per trust line / MPT + swap
   + fees) before funding.
5. **`xrpl-mpp-sdk` is not yet on npm.** It is consumed via a single `pnpm` override
   pointing at a locally built tarball; going live on npm is a one-line change.
6. **Testnet only.** No local/Docker sandbox: everything runs against XRPL testnet.

## Out of scope (future work)

Atomic delivery-versus-payment (escrow/crypto-conditions); mainnet / real-value RLUSD;
multi-agent competition; off-chain payment channels.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
