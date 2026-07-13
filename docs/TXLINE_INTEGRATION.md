# TxLINE integration

## Verified devnet activation

TxLINE Sentinel has completed the official free-tier path on **Solana devnet only**. This is no longer a placeholder provider boundary.

| Evidence                   | Verified value                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Disposable public wallet   | `78nxT4D9E6iBZUuSRDQ4NDwDFtzcwpQ3FG8gokMfCsfh`                                                                                                         |
| TxLINE devnet program      | `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`                                                                                                         |
| Devnet TxL Token-2022 mint | `4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG`                                                                                                         |
| Pricing row                | service level `1`; `pricePerWeekToken = 0`; `samplingIntervalSec = 0`; league bundle `1`; market bundle `2`                                            |
| Subscription               | `subscribe(1, 4)` finalized on devnet; no TxL payment                                                                                                  |
| Transaction                | [`2oxc…Xabdj`](https://explorer.solana.com/tx/2oxcjpbnGZFaw2R2Sk4ptc7dJ5Y6tPNRfJXzc6sZFEY66h1FPsvGkGyqYQigdPmDBgYM2RJCEtdjzaHxHNrXabdj?cluster=devnet) |
| Authentication             | exact devnet guest-JWT activation flow succeeded; credentials are stored only outside Git                                                              |
| Authenticated snapshot     | seven real fixtures returned, including fixture `18143850`, Vietnam–Myanmar                                                                            |
| Streams                    | odds SSE opened and delivered a real data event; scores SSE opened and delivered a heartbeat                                                           |
| Proof                      | official `validateFixture` read-only simulation returned verified against root account `AzB6fHDNvTThdvQazWvYfgsCbDm6Ksi3zP5BzoxYo5Ri`                  |

The transaction paid only ordinary devnet SOL fees/account rent. It did not transfer TxL, use a credit card, touch mainnet, or involve a wallet holding real assets. No wallet secret, guest JWT, API token, activation signature, authorization header, or raw third-party dataset is committed or shown in this repository.

## Pinned official contracts

The devnet toolchain uses the current artifacts from the official [`txodds/tx-on-chain`](https://github.com/txodds/tx-on-chain) repository, pinned at commit `9b2de4c30cf0f4e01c88d73c365543276d065cf2` with devnet IDL/OpenAPI version `1.5.6`. The repository commit, IDL/type hashes, OpenAPI hash, program ID, mint, token programs, API origin, and RPC origin are recorded in [`vendor/txline/devnet/pin.json`](../vendor/txline/devnet/pin.json). Vendored files are limited to the matching devnet IDL and generated TypeScript type, with source and license recorded in [`vendor/txline/devnet/README.md`](../vendor/txline/devnet/README.md).

Official references used:

- [Quickstart](https://txline.txodds.com/documentation/quickstart)
- [World Cup Free Tier](https://txline.txodds.com/documentation/worldcup)
- [Runnable Devnet Examples](https://txline.txodds.com/documentation/examples/devnet-examples)
- [Fetching Snapshots](https://txline.txodds.com/documentation/examples/fetching-snapshots)
- [Streaming Data](https://txline.txodds.com/documentation/examples/streaming-data)
- [On-Chain Validation](https://txline.txodds.com/documentation/examples/onchain-validation)
- [Guest Session API](https://txline.txodds.com/api-reference/authentication/start-a-new-guest-session)

## Authentication protocol

The activation helper follows the official sequence exactly:

1. `POST /auth/guest/start` on `https://txline-dev.txodds.com` returns a guest JWT.
2. The wallet signs the exact byte string `${txSig}::${jwt}` for the standard bundle, whose selected-leagues array is empty.
3. `POST /api/token/activate` receives `txSig`, the Base64 detached wallet signature, and `leagues: []`, authenticated with `Authorization: Bearer <guest JWT>`.
4. Data calls use both `Authorization: Bearer <guest JWT>` and `X-Api-Token: <activated API token>`.

The production provider treats HTTP `401` as an expired/invalid guest session: it obtains a fresh JWT from the same devnet host and retries once with the unchanged activated API token. HTTP `403` is not treated as a JWT-renewal signal; it indicates that the API token/network/subscription bundle must be checked. Credentials are bounded, redacted from diagnostics, and never returned by Sentinel's API.

## Official endpoint categories

The long-running read-only sidecar currently uses:

- `GET /api/fixtures/snapshot`;
- `GET /api/odds/snapshot/{fixtureId}`;
- `GET /api/scores/snapshot/{fixtureId}`;
- `GET /api/odds/updates/{epochDay}/{hourOfDay}/{interval}?fixtureId=...` as the documented five-minute historical fallback;
- `GET /api/scores/historical/{fixtureId}` as the documented completed-fixture fallback;
- `GET /api/odds/stream`;
- `GET /api/scores/stream`;
- `POST /auth/guest/start` only when a `401` requires guest-JWT renewal.

The activation tooling additionally uses:

- `POST /api/token/activate`;

The automatic runtime verifier re-fetches `GET /api/fixtures/snapshot` and requires an exact
match to the displayed fixture ID, source timestamp, schedule, participants, competition, state,
and sanitized raw reference. The local proof-reproduction helper instead uses
`GET /api/fixtures/updates/{epochDay}/{hourOfDay}` to locate a recent runnable example record.
Both flows then call
`GET /api/fixtures/validation?fixtureId=...&timestamp=...` for that exact observation.

Historical fallback is attempted only when the selected fixture started between six hours and fourteen days ago and its current snapshot is empty. Every returned record must match that fixture ID or the provider fails closed. The official OpenAPI also documents odds-proof and score-stat validation endpoints; Sentinel does not claim to call those because this release uses the fixture-proof flow. Deterministic replay remains the guaranteed decision walkthrough.

## HTTP/SSE runtime behavior

`LiveTxLineProvider` is an authenticated, production-bounded HTTP/SSE client:

- HTTPS origin is pinned to the credential-free devnet origin;
- redirects and undocumented/cross-origin paths are rejected;
- JSON and every SSE data event are validated with Zod before use;
- response bodies, SSE events, retained records, duplicate sets, and connection sequence maps are bounded;
- the SSE parser supports fragmented chunks, comments, `id`, `event`, `data`, and `retry` fields;
- stream event IDs must match and advance as `timestamp:index`; duplicates and out-of-order events are ignored;
- score sequences must advance within a fixture/connection pair;
- heartbeat/activity and idle timeout are tracked separately for odds and scores;
- reconnect uses bounded exponential backoff and resumes with `Last-Event-ID` when available;
- `AbortController` closes requests, readers, sleeps, and both streams during shutdown;
- diagnostics redact known credentials, bearer values, tokens, control characters, and excess length.

An accepted SSE connection proves that the request and credentials were accepted. It does **not** prove that a covered match is active at that moment. A heartbeat-only stream is therefore represented honestly as `stream connected, awaiting data`.

## Normalization and fail-closed mapping

Official transport objects never flow directly into the strategy engine.

| TxLINE field/record                                  | Sentinel representation                                                                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `FixtureId` / `fixtureId`                            | decimal string fixture ID; never generated locally                                                                                       |
| `Participant1`, `Participant2`, `Participant1IsHome` | feed-designated home/away participant mapping; not a venue claim                                                                         |
| `GameState` / `gameState`                            | absent means `unknown`; supplied `1` maps to scheduled and supplied `6` to cancelled; every other supplied value fails schema validation |
| `Ts`, `ts`                                           | ISO `sourceTimestamp` after finite epoch-millisecond validation                                                                          |
| local receipt clock                                  | ISO `receivedTimestamp`, recorded separately from provider time                                                                          |
| SSE `id`                                             | transport ordering and resume cursor; must be `timestamp:index`                                                                          |
| score `connectionId`, `seq`, `id`                    | stable score identity and per-connection sequence                                                                                        |
| confirmed `dataSoccer` flags                         | only one explicit Goal, RedCard, Penalty, or VAR event may become a domain event                                                         |
| `dataSoccer.Minutes`                                 | event minute; required for mapped soccer events                                                                                          |
| participant IDs and `scoreSoccer` totals             | home/away team and score only when both sides map unambiguously                                                                          |
| `SuperOddsType`, `PriceNames`, `Prices`, `Pct`       | validated and retained as official odds evidence                                                                                         |
| generated `txline://...` reference                   | sanitized path-only raw reference; odds message IDs are hashed                                                                           |
| proof simulation result                              | `verified`, `failed`, or `unavailable`; never inferred from API availability alone                                                       |

The official odds payload currently exposes integer `Prices`. Sentinel does not invent a decimal scale or silently convert those integers into the internal `match_winner` decimal-odds model. Real odds are retained and timestamped for live status, but they cannot open a paper position until TxLINE publishes or confirms the applicable conversion contract. This is an intentional fail-closed boundary, not missing data disguised as a value.

Unsupported or ambiguous score actions remain validated retained records and advance the SSE cursor,
but are not fabricated into Sentinel's event taxonomy. Missing required minutes, ambiguous
participants, one-sided totals, unknown top-level fields, malformed proof nodes, oversized
messages, and invalid timestamps fail closed.

## Proof verification

There are two deliberately separate read-only verification paths.

### Automatic server-runtime verification

For each latest observed fixture, the runtime:

1. refetches the authenticated fixture snapshot and requires the exact displayed observation (ID,
   source/schedule timestamps, participants, competition, state, and sanitized reference);
2. fetches `/api/fixtures/validation` for that exact fixture/timestamp and requires the returned snapshot fields to match the authenticated observation;
3. validates the proof shape and decodes every hash as exactly 32 bytes;
4. derives the `ten_daily_fixtures_roots` PDA for the fixture timestamp window under the pinned devnet program and verifies the program/root account owners;
5. manually encodes the pinned IDL `validateFixture` instruction into a transaction whose only signature is all-zero, then calls devnet `simulateTransaction` with `sigVerify: false` and a bounded compute-unit limit;
6. reports `Verified` only when the pinned program's simulation return data decodes to `true` and complete fixture/root/program/source/IDL/RPC-slot/compute evidence is present.

The proof snapshot carries TxLINE's packed u64 fixture identifier; its lower 48-bit pure ID must
equal the API fixture ID, and the proof summary must match that same pure ID. The runtime also
requires the proof timestamp to equal the displayed observation timestamp, preventing a newer
record for the same match from lending a stale dashboard row a `Verified` label.

The runtime receives only the disposable wallet's **public address** as the simulation fee payer. It has no wallet file, private key, Anchor wallet, signing call, or send/broadcast method.

### One-shot Anchor reproduction helper

The local `verify-fixture` command mirrors TxLINE's official runnable `fixture_validation_view_only.ts` example with the pinned IDL/generated types and Anchor `.view()`. It uses the protected disposable devnet keypair only as the local Anchor provider and never broadcasts a validation transaction. This helper independently reproduced `validateFixture === true` against root account `AzB6fHDNvTThdvQazWvYfgsCbDm6Ksi3zP5BzoxYo5Ri`.

Transport success without a completed on-chain result is `Verification unavailable`; a completed false/rejected result is `Verification failed`. Neither snapshot authentication nor SSE connection state can produce `Verified`.

## Runtime separation

The deployed design deliberately keeps two sources side by side:

- **LIVE DEVNET TXLINE** is one process-wide, authenticated, read-only observation sidecar. It reports connection/authentication state, the latest real fixture, odds/score timestamps, per-stream heartbeat/event/reconnect state, and proof status. It cannot place bets, sign transactions, mutate replay sessions, or open virtual positions.
- **SYNTHETIC REPLAY** is the deterministic, session-isolated signal/settlement walkthrough. It continues to work without TxLINE availability or credentials.

`SENTINEL_MODE` therefore remains `replay`; `TXLINE_LIVE_ENABLED=true` starts the independent live sidecar. Anonymous replay agents never receive TxLINE credentials.

## Local operations

Subscription/activation signing is confined to the one-shot devnet tool, never the server runtime. The runtime automatically performs unsigned proof simulation; the local helper below provides an optional Anchor `.view()` reproduction:

```bash
# Inspect pinned program/pricing/accounts and simulate without broadcasting.
npm run txline:devnet -- preflight --wallet /absolute/path/outside/repo/devnet-wallet.json

# Authenticated snapshot and bounded SSE smoke; values are loaded from an ignored file.
npm run txline:devnet -- smoke --credentials-file .env.live.local

# Read-only on-chain fixture proof simulation.
npm run txline:devnet -- verify-fixture \
  --wallet /absolute/path/outside/repo/devnet-wallet.json \
  --credentials-file .env.live.local
```

The wallet file must be outside the repository and mode `0600`. `.env.live.local` must be ignored and mode `0600`. Do not pass secret values on the command line, paste them into documentation, or copy the wallet into Render.

## Honest limitations

- Devnet coverage does not guarantee an active match or a data event during every demo window.
- The current sidecar is read-only operational evidence; replay remains the only decision/paper-simulation source.
- Official integer odds are preserved without an invented decimal-price scale.
- Only explicit confirmed soccer event flags in the supported mapping enter the internal event model.
- Runtime proof verification is attempted automatically for the latest real fixture. It remains `unavailable` when a matching proof/root/RPC result cannot be obtained, and becomes `verified` only with complete successful simulation evidence; snapshot/SSE authentication alone never becomes `Verified`.
- Guest JWT renewal is automatic on `401`; renewing the four-week on-chain subscription remains an explicit local devnet operation.
- Mainnet, paid tiers, TxL purchases, bookmaker execution, wallet custody, and real-money actions are outside this product.
