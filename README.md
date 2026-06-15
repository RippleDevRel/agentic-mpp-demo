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

`MAX_SPEND` is enforced **solely by the OWS policy** at signing, in both modes — the app
never gates spend in code (it only reads the cap to provision funding and to inform the
model). (OWS has no cumulative/rolling limit yet, so the cap is per-transaction.)

## How OWS works (key storage, policy, signing)

This section is the developer-level detail behind the two subsections above: where the
key lives, what the agent can actually touch, and how signing is brokered.

### The vault on disk

OWS stores everything under a vault directory (`OWS_VAULT_PATH`, default `~/.ows`),
created with `700` permissions, in three folders:

```
<vault>/
  wallets/<wallet-id>.json    # the encrypted key material
  keys/<key-id>.json          # policy-bound API tokens
  policies/<policy-id>.json   # the rules a token is evaluated against
```

### Key storage — the private key is never at rest in cleartext

The wallet is a BIP39 **mnemonic** (`key_type: "mnemonic"`) derived into one account per
chain via BIP44 paths; the XRPL account is `m/44'/144'/0'/0/0`. The mnemonic is sealed in
the wallet file's `crypto` block and is never written in cleartext:

- **KDF**: `scrypt` (`n=65536, r=8, p=1`) stretches the **owner passphrase**
  (`OWS_PASSPHRASE`) + a per-wallet salt into a 256-bit key.
- **Cipher**: `aes-256-gcm` (with `iv` + `auth_tag`) encrypts the mnemonic. GCM is
  *authenticated* — any tampering with the ciphertext is detected on decrypt.

Without the owner passphrase, the ciphertext is inert.

### API tokens — how the agent signs without the passphrase

The agent never receives the owner passphrase. It is handed a **policy-bound API token**
minted by `createApiKey(...)`. In `keys/<id>.json`:

- the raw token is not stored, only its `token_hash` (SHA-256);
- `wallet_secrets` holds a copy of the key **re-encrypted with a key derived from the
  token** (`hkdf-sha256`, info `ows-api-key-v1`). That is what lets the token unlock its
  own copy of the key to sign — no passphrase needed;
- the token carries its scopes: `wallet_ids`, `policy_ids`, and `expires_at`.

So the token is a narrow, revocable, time-bounded capability — not the key, and not the
passphrase.

### Policy configuration

A policy (`policies/<id>.json`) combines two layers, with `action: "deny"` as the
default:

- **Declarative rules** — here `allowed_chains` (`xrpl:mainnet` only) and `expires_at`
  (the token's right to sign lapses after 30 days).
- **An executable policy** — `executable` points at an external program
  (`packages/agent/policy/max-spend.mjs`). On *every* signing request OWS pipes a
  `PolicyContext` JSON to its stdin (the decoded tx, the policy `config`, …) and reads
  `{ allow, reason }` from stdout. Ours decodes the tx, sums the XRP outflow, and denies
  when it exceeds `config.maxSpendXrp`.

The policy binds **because the agent signs with the token** (which references
`policy_ids`), not with the passphrase. That is the "enforced at the signing boundary"
guarantee: even a model-driven agent cannot get an out-of-policy transaction signed.
`ensureAgentWallet` (`packages/agent/src/tools/wallet.ts`) wires this up: create wallet →
create policy → mint token → sign with the token.

> `chain_ids` uses `xrpl:mainnet` even on testnet: OWS's XRPL chain id is
> network-agnostic (XRPL addresses are the same across networks). Testnet vs mainnet is
> decided by the RPC URL, not by OWS.

### The `SigningPubKey` recovery (the one real integration wrinkle)

A signed XRPL transaction must carry `SigningPubKey` (the signer's public key) alongside
`TxnSignature`; rippled checks the signature against that key and the key against the
`Account`. Two OWS ergonomics collide here: OWS does **not** expose the public key, and
its `signAndSend` expects `SigningPubKey` to already be present (it only injects
`TxnSignature` and broadcasts). The fix in `packages/agent/src/signer/ows-xrpl-signer.ts`:

1. ask OWS to `signHash` a known hash (this does not export the key);
2. recover the secp256k1 public key from that signature via ECDSA recovery — try both
   recovery bits and keep the candidate whose derived XRPL address matches the OWS
   account;
3. set it as `SigningPubKey`, autofill, encode, then hand the blob to `signAndSend`.

The pubkey is cached, `NetworkID` is stripped (networks with id ≤ 1024 must omit it), and
all signing is serialized through a mutex (the account sequence is not concurrency-safe).
The clean upstream fix would be an external-signer constructor on the SDK `Wallet`
(`Wallet.fromSigner`).

### What the agent can and cannot access

| The agent has | The agent never has |
| --- | --- |
| the merchant **endpoint URL** + its own API key | the merchant's ledger address (it learns it from the 402) |
| a **policy-bound OWS token** (XRPL-only, expiring, spend-capped) | the OWS **owner passphrase** |
| `signHash` / `signAndSend` brokered signing | the **private key / mnemonic** (it stays encrypted in the vault) |
| the recovered **public key** + its own XRPL address | any way to export the key (`exportWallet`/seed paths are blocked by a test) |

### On-chain access: reads via xrpl.js, writes via OWS

The agent's **code** depends on `xrpl.js` for all ledger **reads** — `withClient`
(`packages/shared/src/xrpl.ts`) opens an xrpl.js `Client` over **WebSocket**
(`XRPL_RPC_URL`) and issues rippled queries (`account_info`, `account_objects`,
`account_lines`, `book_offers`, `tx`). **Writes** never go through xrpl.js submit: the tx
is autofilled/encoded with xrpl.js, then handed to **OWS `signAndSend`**, which signs
inside the vault and broadcasts over **HTTP JSON-RPC** (`XRPL_HTTP_RPC_URL`). So reads use
the WS endpoint; the signed write path uses OWS over HTTP.

What the **model** can query depends on the mode: in **rails** the read happens inside
domain tools (`get_status`, `discover_issuances`, `quote_resource`, …) and the model only
sees shaped results; in **minimal** a thin `xrpl_query` tool forwards `{command, params}`
to `client.request` — full read access, but still executed by our code, never by the model.

### Why an autonomous agent cannot bypass OWS

"The agent has xrpl.js" is about the **code**, not the **model**. The model does not run
code — it cannot `import xrpl` or call `Wallet.generate()`. It can only emit **tool calls**
against a fixed allow-list, and:

- **No tool generates, holds, or signs with a local key.** The only signing primitive
  (`xrpl_sign_submit` in minimal; the domain verbs in rails) routes *exclusively* through
  the OWS signer. The model can build a transaction JSON, but the sole way it reaches the
  ledger is OWS — there is no local-key path to choose.
- `xrpl_query` is **read-only** (`client.request`, never a locally-signed `submit`); xrpl.js
  is reachable only from our code.
- The surface is locked: `allowedTools` is an explicit allow-list and `settingSources: []`
  means no host MCP servers / skills / tools are loaded.
- A build-time guard (`packages/agent/src/signer/isolation.test.ts`) fails CI if anyone
  adds a local-key path (`fromSeed`, `fromFaucet`, `exportWallet`, …) to the agent code.

So the guarantee is **structural, not prompt-based**: the agent is genuinely autonomous,
but its only on-chain write path is OWS — itself bounded by the policy.

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
| Guardrails | OWS policy (sole enforcer) | OWS policy (sole enforcer) |
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
| `MAX_SPEND`, `AGENT_MAX_ITERATIONS` | per-tx XRP cap (enforced by the OWS policy at signing) + loop bound |
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

## Notes & moving forward (hardening the key boundary)

This demo keeps the key out of the **agent's reach** (no tool can export it or sign with a
local key — see [Why an autonomous agent cannot bypass OWS](#why-an-autonomous-agent-cannot-bypass-ows)).
But OWS runs **in-process** (a native NAPI module, not a separate daemon), so the boundary
today is *logical*, not a separate process or hardware. The plaintext key materializes
transiently in the agent process's memory during signing, and the encrypted vault lives
wherever `OWS_VAULT_PATH` points. For a real deployment, harden in this order:

1. **Never bake the vault or secrets into an image.** Mount the vault as a volume; pass
   `OWS_PASSPHRASE` / tokens via a secrets manager or runtime env, never a layer or VCS.
2. **Run with the token, not the passphrase.** Create the wallet once (the only step that
   needs `OWS_PASSPHRASE`), then run the agent with just the vault + the policy-bound API
   token (`.data/agent.<network>.json`). The passphrase never enters the run environment;
   the token is XRPL-only, expiring, and spend-capped.
3. **Tighten the policy for the target.** Per-recipient allowlists, a lower `MAX_SPEND`,
   shorter token expiry, and—once OWS supports it—a cumulative/rolling limit instead of a
   per-transaction one.
4. **Separate the signer from the agent (the real isolation).** Move OWS into its own
   service/container that owns the vault and exposes only a sign endpoint; the agent
   container holds no vault and no key, and calls out to sign. Then a compromise of the
   agent process cannot touch key material at all. This is what the upstream
   `Wallet.fromSigner` (external-signer) gap unlocks — until it lands, signing is
   in-process. A two-service split (agent ↔ OWS signer) is the natural next step.
5. **Defense in depth around the model.** Keep `settingSources: []` and the explicit
   `allowedTools` allowlist so no extra tools leak in; keep the `isolation.test.ts` guard
   in CI so no local-key signing path can be introduced by accident.

In short: today the agent *cannot* obtain or misuse the key, but the key still shares the
agent's process. Production isolation = a separate signer service + secrets management +
a policy scoped to the deployment.

## License

Apache-2.0. See `LICENSE`.
