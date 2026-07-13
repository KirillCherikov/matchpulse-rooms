# Submission draft

## Project name

TxLINE Sentinel

## Tagline

Explainable real-time sports market intelligence designed for TxLINE.

## Short description

TxLINE Sentinel converts football scores, match events, and odds into normalized movements, causally verified explanations, feed-quality alerts, simulation-only paper decisions, counterfactual evaluation, and a reproducible audit trail.

> **SIMULATION ONLY — NO REAL MONEY**

## Problem

Odds movement alone is insufficient for professional market operations. Teams need to know whether a confirmed event available at decision time explains a move, whether the underlying feeds are healthy, how a deterministic rule reached its decision, and what happened afterward.

## Solution and technical highlights

- Transport-independent Replay, Mock, and Live provider architecture.
- Authenticated official TxLINE devnet snapshots and dual SSE streams with strict Zod validation before adaptation.
- Pinned devnet program/IDL/types, zero-TxL `subscribe(1,4)`, guest activation, JWT renewal, and actual `validateFixture` read-only simulation.
- Explicit book percentage, classical overround, proportional margin removal, movement, velocity, acceleration, and rolling baseline.
- Causal confirmed-event correlation with separate post-event and late-confirmation relationships and no look-ahead.
- Separate stale, duplicate-ID, duplicate-sequence, out-of-order, gap, delay, invalid-timestamp, terminal-event rejection, divergence, and recovery sentinel.
- Transparent Rule-based confidence score with stored components, typed weights, configuration version, and quality penalties.
- Risk-capped paper simulation with confirmed full-time, draw-selection, cancellation/postponement void, idempotent settlement, virtual P&L, and settled-equity drawdown.
- 30/60/300-second counterfactual retained-movement classification.
- Run-scoped append-only audit, REST/OpenAPI, one-shot CLI tools, and a technical judge dashboard.
- Optional outbound Telegram signal/critical-alert/recovery notifications for trusted runtimes, plus local command-response rendering; anonymous replay sessions force delivery off.

## TxLINE use

The real integration uses the official devnet fixture/odds/scores snapshots, odds/scores SSE, guest-session renewal, token activation, fixture updates, and fixture-validation endpoint categories. Data calls send the documented guest Bearer JWT plus activated `X-Api-Token`; secrets never enter the browser or Git.

Free `subscribe(1,4)` finalized from disposable devnet wallet `78nxT4D9E6iBZUuSRDQ4NDwDFtzcwpQ3FG8gokMfCsfh` against program `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`. The authenticated smoke returned seven real fixtures, including `18143850` (Vietnam–Myanmar), an odds SSE data event, and a scores heartbeat. Official `validateFixture` simulation returned true against root account `AzB6fHDNvTThdvQazWvYfgsCbDm6Ksi3zP5BzoxYo5Ri`.

Live is a read-only observation sidecar. Deterministic replay remains the guaranteed explainable signal/paper-settlement path. Official integer odds are preserved without inventing an undocumented decimal scale. Full evidence and endpoint mapping are in [TXLINE_INTEGRATION.md](TXLINE_INTEGRATION.md).

## Business value

The product targets sports trading operations, sportsbook risk teams, data providers, and quantitative analysts who need explainable movement context and feed-health evidence rather than an opaque betting recommendation.

## Links

- GitHub: `https://github.com/KirillCherikov/matchpulse-rooms`
- Deployment URL: `https://txline-sentinel.onrender.com`
- OpenAPI URL: `https://txline-sentinel.onrender.com/docs`
- Machine-readable OpenAPI: `https://txline-sentinel.onrender.com/docs/json`
- Status API: `https://txline-sentinel.onrender.com/api/agent/status`
- Live status after exact-commit Render deployment: `https://txline-sentinel.onrender.com/api/live/status`
- Devnet subscription: `https://explorer.solana.com/tx/2oxcjpbnGZFaw2R2Sk4ptc7dJ5Y6tPNRfJXzc6sZFEY66h1FPsvGkGyqYQigdPmDBgYM2RJCEtdjzaHxHNrXabdj?cluster=devnet`
- Demo video: `TBD`

## Honest limitations

- The bundled replay is synthetic and explicitly labeled.
- Live devnet may be connected but awaiting data when no covered fixture is active.
- Official integer odds do not enter the decimal-odds paper engine without a published conversion contract.
- The live sidecar is read-only; it cannot place a bet or mutate replay paper state.
- State and audit persistence are in memory.
- Browser replay sessions are isolated in a bounded in-memory registry but remain anonymous and non-durable.
- The Rule-based confidence score is not statistically calibrated.
- Signal precision is 60-second movement persistence, not outcome accuracy or proof of profitability.
- Telegram has trusted-runtime outbound notifications and local renderers but no inbound bot receiver; the public replay deployment keeps delivery disabled.
- Render secret entry, exact live-commit deployment verification, and the demo video remain external submission actions.

## API feedback

See [API_FEEDBACK.md](API_FEEDBACK.md).
