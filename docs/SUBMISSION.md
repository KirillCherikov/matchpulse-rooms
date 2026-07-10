# Submission draft

## Project name

TxLINE Sentinel

## Tagline

Explainable real-time sports market intelligence powered by TxLINE.

## Short description

TxLINE Sentinel converts football scores, match events, and odds into normalized movements, causally verified explanations, feed-quality alerts, simulation-only paper decisions, counterfactual evaluation, and a reproducible audit trail.

> **SIMULATION ONLY — NO REAL MONEY**

## Problem

Odds movement alone is insufficient for professional market operations. Teams need to know whether a confirmed event available at decision time explains a move, whether the underlying feeds are healthy, how a deterministic rule reached its decision, and what happened afterward.

## Solution and technical highlights

- Transport-independent Replay, Mock, and Live provider architecture.
- Zod validation before live normalization.
- Explicit book percentage, classical overround, proportional margin removal, movement, velocity, acceleration, and rolling baseline.
- Causal confirmed-event correlation with separate post-event and late-confirmation relationships and no look-ahead.
- Separate stale, duplicate-ID, duplicate-sequence, out-of-order, gap, delay, invalid-timestamp, divergence, and recovery sentinel.
- Transparent Rule-based confidence score with stored components, typed weights, configuration version, and quality penalties.
- Risk-capped paper simulation with confirmed full-time, draw-selection, cancellation/postponement void, idempotent settlement, virtual P&L, and settled-equity drawdown.
- 30/60/300-second counterfactual retained-movement classification.
- Run-scoped append-only audit, REST/OpenAPI, one-shot CLI tools, and a technical judge dashboard.
- Optional outbound Telegram signal/critical-alert/recovery notifications and local command-response rendering.

## TxLINE use

Replay mode is the complete judge path. `ReplayTxLineProvider`, `MockTxLineProvider`, and a Zod-validating `LiveTxLineProvider` share the strategy boundary.

**Exact TxLINE data endpoints used in the current build: none.** Live network usage awaits verified official schemas, credentials, matching devnet artifacts, and safe pricing checks. No endpoint, header, program artifact, or response field is fabricated. Official references are listed in [TXLINE_INTEGRATION.md](TXLINE_INTEGRATION.md).

## Business value

The product targets sports trading operations, sportsbook risk teams, data providers, and quantitative analysts who need explainable movement context and feed-health evidence rather than an opaque betting recommendation.

## Links

- GitHub: `https://github.com/KirillCherikov/matchpulse-rooms`
- Deployment URL: `TBD after deployment authorization`
- API URL: `TBD after deployment authorization`
- Demo video: `TBD`

## Honest limitations

- The bundled replay is synthetic and explicitly labeled.
- The current build makes no live TxLINE call.
- State and audit persistence are in memory.
- Browser replay sessions are isolated in a bounded in-memory registry but remain anonymous and non-durable.
- The Rule-based confidence score is not statistically calibrated.
- Signal precision is 60-second movement persistence, not outcome accuracy or proof of profitability.
- Telegram has outbound notifications and local renderers but no inbound bot receiver.
- Public deployment and demo video require external platform actions.

## API feedback

See [API_FEEDBACK.md](API_FEEDBACK.md).
