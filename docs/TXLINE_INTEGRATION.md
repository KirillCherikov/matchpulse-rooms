# TxLINE integration

## Current state

`ReplayTxLineProvider`, `MockTxLineProvider`, and `LiveTxLineProvider` implement a shared provider boundary. Replay mode is complete and requires no TxLINE credential. The live provider validates injected domain-shaped messages through Zod but intentionally does not create an HTTP, SSE, or on-chain client.

**TxLINE data endpoints currently called by the application: none.**

No endpoint path, authentication header, program ID, IDL, token mint, proof schema, or response field is guessed. The REST routes under `/api/...` are TxLINE Sentinel's own API, not TxLINE endpoints.

## Official sources

- <https://txline.txodds.com/documentation/quickstart>
- <https://txline.txodds.com/documentation/worldcup>
- <https://txline.txodds.com/llms.txt>

The default devnet origin in `.env.example` is taken from the official World Cup documentation. An origin alone is not treated as a completed transport contract.

## Exact blocker

The repository has no configured live credentials, no activated disposable devnet subscription, no committed matching IDL/types, and no implemented mapping from an official raw response to the domain models. No TxLINE network call or on-chain transaction is made.

During verification on July 10, 2026, the official Quickstart and World Cup pages were reachable, but the documented `https://txline.txodds.com/llms.txt` index returned HTTP 404. That missing index is recorded as an upstream documentation blocker; it is not bypassed by guessing data endpoint paths or response schemas.

This blocker does not affect replay, signal detection, data-quality monitoring, paper simulation, REST/OpenAPI, CLI one-shot evaluation, or the judge dashboard.

## Safe activation checklist

1. Re-read the official documentation and discover the exact API pages through `llms.txt`.
2. Use a disposable devnet keypair outside this repository with mode `0600`.
3. Verify the current network, RPC, program ID, token mint, matching IDL, and matching TypeScript types.
4. Read the current on-chain pricing matrix.
5. Stop if the selected service level is not free.
6. Obtain explicit authorization before any devnet subscription transaction.
7. Obtain a fresh guest JWT and activate the token exactly as documented.
8. Store credentials only in `.env.local` or an approved secret store.
9. Implement bounded timeout, retry/backoff, failure state, and heartbeat behavior around official endpoints.
10. Validate every official raw payload before mapping it into `Fixture`, `OddsUpdate`, or `MatchEvent`.
11. Save only sanitized examples and raw references.
12. Add contract, failure, recovery, and proof-validation tests.

Mainnet and any paid transaction require separate explicit human approval and are not automated.

## Expected live mapping responsibilities

The future adapter must keep transport concerns separate:

- guest and activated-token authentication;
- official endpoint paths and query parameters;
- raw response schemas;
- fixture, score, event, and odds normalization;
- sequence and heartbeat semantics;
- historical replay retrieval;
- validation proofs where officially available;
- cached last-known snapshots and bounded failure recovery.

Strategy code will continue to receive only transport-independent models.
