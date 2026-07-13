# Final submission copy

This file is ready to paste into the hackathon form after the three `PENDING` items in the release status are completed.

## Project

**TxLINE Sentinel**

## Tagline

Verified TxLINE data, explainable market movements, and deterministic paper-trading evidence.

## Short description

TxLINE Sentinel is a professional sports-data operations console that combines authenticated TxLINE devnet HTTP/SSE, on-chain fixture-proof verification, causal odds/event analysis, feed-quality monitoring, deterministic replay, simulation-only paper decisions, counterfactual evaluation, and a run-scoped audit trail.

> **SIMULATION ONLY — NO REAL MONEY**

## The problem

An odds change alone is not actionable evidence. Operators need to know whether the feed is healthy, whether a confirmed sporting event available at decision time explains the move, exactly which deterministic rules fired, and whether the decision can be reproduced later without look-ahead bias.

## What we built

TxLINE Sentinel has two explicit data surfaces:

1. **LIVE DEVNET TXLINE** — an authenticated, process-wide, read-only sidecar for real fixtures, odds/scores timestamps, SSE heartbeats/events, reconnect state, and proof status.
2. **SYNTHETIC REPLAY** — a credential-free, deterministic judge scenario that always demonstrates causal movement, quality alerts, transparent confidence components, risk-capped virtual positions, counterfactual horizons, settlement, analytics, and audit.

This split avoids a common demo failure: a real feed is still proven, while the decision walkthrough does not depend on a covered match being active during judging.

## Confirmed TxLINE devnet evidence

- Official program: `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`.
- Official TxL Token-2022 mint: `4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG`.
- On-chain pricing row: service level `1`, zero TxL, sampling interval `0`, league bundle `1`, market bundle `2`.
- Finalized free `subscribe(1,4)` transaction: [Solana Explorer](https://explorer.solana.com/tx/2oxcjpbnGZFaw2R2Sk4ptc7dJ5Y6tPNRfJXzc6sZFEY66h1FPsvGkGyqYQigdPmDBgYM2RJCEtdjzaHxHNrXabdj?cluster=devnet).
- Disposable public wallet: `78nxT4D9E6iBZUuSRDQ4NDwDFtzcwpQ3FG8gokMfCsfh`.
- Exact guest-JWT/token activation succeeded on the devnet host.
- Authenticated snapshot returned seven real fixtures, including `18143850` (Vietnam–Myanmar).
- Odds SSE opened and delivered a real data event; scores SSE opened and delivered a heartbeat.
- Official `validateFixture` read-only simulation returned true against root account `AzB6fHDNvTThdvQazWvYfgsCbDm6Ksi3zP5BzoxYo5Ri`.

No TxL was transferred. Only ordinary devnet SOL fees/account rent were involved. The server has no wallet or transaction signer.

## Official TxLINE capabilities used

- guest session: `POST /auth/guest/start`;
- activation: `POST /api/token/activate`;
- fixture snapshot and updates;
- odds snapshot and SSE stream;
- scores snapshot and SSE stream;
- fixture proof retrieval and `validateFixture` simulation;
- documented `Authorization: Bearer <guest JWT>` plus `X-Api-Token` data authentication;
- guest-JWT renewal after HTTP 401.

Raw official payloads are validated with Zod before adaptation. SSE is parsed across fragmented chunks, ordered by `timestamp:index`, bounded in memory, protected by idle timeout, and reconnected with bounded exponential backoff and `Last-Event-ID`. Shutdown uses `AbortController`; diagnostics redact credentials.

## Technical differentiation

- Causal correlation uses both source and receipt time, preventing future-data leakage.
- `post_event_reaction` and `late_event_confirmation` are distinct; late data cannot open the current paper strategy.
- Book percentage and classical overround are modeled separately and margin normalization is explicit.
- A rule-based score exposes signed components and versioned configuration; it is never presented as a calibrated probability.
- Duplicate, ordering, gap, stale, delay, timestamp, divergence, terminal-state, and recovery behavior is auditable.
- Paper positions are simulation only, globally exposure-capped, atomically settled, and measured with virtual P&L/drawdown.
- 30/60/300-second counterfactuals measure retained movement without mislabeling a small retracement as reversal.
- Proof UI has three honest states: Verified, Verification failed, Verification unavailable.
- Official integer odds are retained without fabricating a decimal scale; they cannot silently enter the paper engine.

## Safety and data discipline

There is no bookmaker execution, deposit, withdrawal, wallet custody, mainnet transaction, martingale, profit promise, or real-money path. Credentials exist only in ignored local files or the deployment secret store. Raw commercial datasets and credential-bearing responses are not committed or rendered.

## Links

- Source: <https://github.com/KirillCherikov/matchpulse-rooms>
- Application: <https://txline-sentinel.onrender.com>
- OpenAPI: <https://txline-sentinel.onrender.com/docs>
- Live status after verified live deployment: <https://txline-sentinel.onrender.com/api/live/status>
- Architecture/integration evidence: [TXLINE_INTEGRATION.md](TXLINE_INTEGRATION.md)
- Demo script: [DEMO_SCRIPT.md](DEMO_SCRIPT.md)
- Video: `PENDING — record and upload after public live verification`

## Honest limitations

- A covered match is not guaranteed to be active during judging; connected/heartbeat awaiting-data is a valid live state.
- Live is read-only operational evidence and does not drive virtual positions.
- TxLINE integer odds are not converted without an official scale contract.
- Replay/audit state is in memory and one replica is required.
- The confidence score is deterministic but not statistically calibrated; signal precision is movement persistence, not a profitability claim.

## Release status

- Real devnet subscription, authentication, snapshot, SSE, and proof simulation: complete.
- Strict live provider, LIVE/REPLAY UI, mocked credential-free CI coverage, and documentation: implemented in the current branch.
- Local release gate complete: 129/129 tests, 35/35 dedicated integration tests, Chromium
  3/3, production build, dependency audit, Docker replay/live smoke, and secret scan all pass.
- `PENDING`: push the reviewed commits and confirm GitHub Actions for the exact head SHA.
- `PENDING`: enter the two credentials in Render Environment, deploy the exact successful commit, and verify public live status.
- `PENDING`: record the target-4:40, strictly sub-five-minute video and press Submit.
