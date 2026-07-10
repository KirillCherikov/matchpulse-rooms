# Architecture and correctness review

## Executive summary

This review independently examined TxLINE Sentinel's architecture, domain models, odds mathematics, causal event processing, signal rules, data-quality state, Rule-based confidence score, paper simulation, counterfactual evaluation, replay determinism, audit trail, interfaces, security posture, tests, documentation, deployment assets, and Git hygiene.

The existing replay-first implementation provided a strong end-to-end foundation. The hardening pass made ambiguous mathematical terms explicit, removed future-data correlation risk, made simulation and reset semantics precise, bounded quality-state memory, exposed reproducible score components, strengthened API contracts, and documented the remaining product boundaries.

No real-money execution, bookmaker integration, wallet custody, or mainnet transaction path was introduced.

> **SIMULATION ONLY — NO REAL MONEY**

## Severity scale

| Severity | Meaning                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------- |
| Critical | Could directly violate the product's safety boundary or invalidate the entire decision result. |
| High     | Could materially bias signals, corrupt replay/simulation state, or mislead an operator.        |
| Medium   | Reduces reproducibility, interface correctness, resilience, or audit clarity.                  |
| Low      | Maintainability, documentation, or operational polish issue with limited immediate impact.     |

No critical finding remained after the reviewed hardening changes.

## Findings and resolutions

| Severity | Area                     | Finding and importance                                                                                                                                                                          | Resolution                                                                                                                                                                                                                                                                | Regression coverage                                                                                                                                              |
| -------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High     | Event correlation        | Absolute timestamp distance can associate a movement with a source-future event or a confirmation unavailable at decision time, creating look-ahead bias.                                       | Correlation now requires event source time at or before odds source time, a bounded nonnegative source lag, and event receipt by decision receipt. `post_event_reaction` and `late_event_confirmation` are explicit; only the former can open the current paper strategy. | Preceding available event, future-source rejection, pre-receipt rejection, late-confirmation classification, and direction consistency.                          |
| High     | Replay lifecycle         | Restarting a finished provider without resetting engines can leak duplicate memory, signals, positions, or bankroll into another run. Manual advance can also leave a misleading running state. | Reset and start-after-finished create a new run namespace and clear provider, quality, correlator, signal, paper, analytics, counterfactual, and fixture state. Manual advance pauses first.                                                                              | Full replay restart determinism, clean reset, unique run-scoped IDs, speed/reset state, and no accumulated positions or signals.                                 |
| High     | Paper settlement         | Settlement needs explicit draw, void, repeated-settlement, concurrent-exposure, and atomic bankroll semantics to avoid incorrect virtual accounting.                                            | Confirmed full time derives home/draw/away; confirmed cancellation/postponement voids; already settled positions are ignored; concurrent positions share a cap; batch P&L is applied once.                                                                                | Win/loss/draw/void, repeated settlement, zero-rounded stake, duplicate signal, concurrent global cap, atomic batch settlement, and void exclusion from win rate. |
| High     | Data-quality state       | Duplicate sequence, regressing timestamps, active recovery, unbounded seen IDs, or cross-feed sequence comparison can corrupt accepted state and create alert storms.                           | Odds and score have independent state; duplicate IDs/sequences and regressing timestamps are ignored; timestamps are validated; issue reporting and seen IDs are bounded; stale state is suppressed until recovery and reset fully clears it.                             | Duplicate ID/sequence suppression, independent feeds, invalid/future/backward timestamps, stale suppression, recovery/current health, reset, and bounded memory. |
| Medium   | Odds terminology         | Using `overround` for the entire sum of implied probabilities conflicts with the classical definition and can produce misleading UI and audit labels.                                           | The model now stores `bookPercentage = sum(1 / odds)` and `overround = bookPercentage - 1`; normalization divides by book percentage.                                                                                                                                     | Fair book, positive overround, underround, normalized sum, and full-snapshot fields.                                                                             |
| Medium   | Movement time            | Artificially clamping zero or negative elapsed time can generate extreme but valid-looking velocity.                                                                                            | Movement requires advancing source time, with advancing received time as fallback; otherwise it rejects the calculation.                                                                                                                                                  | Non-advancing timestamp rejection and exact movement/velocity checks.                                                                                            |
| Medium   | Confidence semantics     | A field named simply confidence can be mistaken for an empirically calibrated probability, and scattered thresholds make decisions hard to reproduce.                                           | It is now `ruleBasedConfidenceScore`, with persisted component contributions, typed weights, quality penalties, a single strategy version, a separate paper threshold, and a separate notification threshold.                                                             | Custom weights, exact component breakdown, threshold behavior, quality penalties, configuration version, and negative/incompatible movement ineligibility.       |
| Medium   | Counterfactual reversal  | A binary sign check can call a small retracement a full reversal and hide sparse-horizon observation delay.                                                                                     | Evaluation now computes retained-movement ratio at 30/60/300 seconds, rejects observations more than 30 seconds late, and compares settled immediate/confirmation unit returns. Default persisted/inconclusive/reversed thresholds are 0.60 and 0.00.                     | All three horizons, expired-horizon rejection, stable and small-retracement persistence, inconclusive partial retention, full reversal, and entry comparison.    |
| Medium   | Feed-health presentation | Historical critical alerts should remain auditable but must not make current health appear permanently degraded after recovery.                                                                 | Agent status now exposes current per-feed health separately from alert history; recovery clears active stale state.                                                                                                                                                       | Stale-to-recovery transition while the earlier alert remains in history.                                                                                         |
| Medium   | Audit reproducibility    | Resetting visible state while reusing IDs makes records from separate runs ambiguous. Mutable return values could also weaken append-only guarantees.                                           | Audit events carry `runId` and a global monotonic sequence; signals, alerts, and positions use run prefixes; reads and appends return clones. Prior events remain append-only across reset.                                                                               | Audit immutability, global sequence, run separation, unique correlation IDs, and required decision/execution/settlement events.                                  |
| Medium   | OpenAPI                  | Route summaries without request/response models are insufficient for judge discovery and client integration.                                                                                    | Reusable Fastify/OpenAPI schemas now cover domain responses, control requests, parameters, and common errors.                                                                                                                                                             | `/docs/json` path/schema assertions, endpoint status/shape checks, invalid control and audit-limit cases.                                                        |
| Medium   | CLI readiness            | A TxLINE check performed against the default replay provider can report ready despite the absent live transport. One-shot replay commands can also be mistaken for persistent controls.         | `txline check` forces live readiness without network traffic; environment loading is centralized; CLI documentation labels one-shot and ephemeral behavior.                                                                                                               | No-credential live readiness and CLI help/command smoke checks.                                                                                                  |
| Medium   | HTTP/deployment boundary | Reflect-all CORS, root containers, and non-isolated E2E environments weaken a public judge deployment.                                                                                          | CORS is off unless one origin is configured; the container runs non-root with a health check; graceful shutdown is registered; Playwright forces replay, disables Telegram, uses a dedicated port, and never reuses an existing server.                                   | HTTP origin behavior, container/API smoke flow, isolated Chromium judge flow, and shutdown checks.                                                               |
| Medium   | Public replay isolation  | A single anonymous process-global replay lets one client reset another judge's cursor and audit view.                                                                                           | Replay agents and schedulers are isolated by an opaque HttpOnly, SameSite cookie in a 32-entry, idle-expiring registry; cross-origin writes are rejected and production cookies are Secure.                                                                               | Two-session HTTP test proves independent cursors; Origin regression returns 403; Chromium exercises the same cookie flow.                                        |
| Medium   | Numeric input domain     | Extreme finite decimal odds can overflow winning paper P&L into non-finite bankroll and JSON/audit values.                                                                                      | Provider schemas and math enforce a generous `1,000,000` maximum; paper opening repeats the guard; settlement validates every projected P&L and bankroll before atomic mutation.                                                                                          | Provider, odds-helper, and paper regressions reject `Number.MAX_VALUE`; existing atomic-settlement tests remain green.                                           |
| Medium   | Runtime retention        | Future live history and process audit arrays can grow without a bound; full-history cloning amplifies memory use.                                                                               | Live diagnostic retention is capped, sessions/TTL are bounded, audit refuses append at 2,000 events, and replay actions reserve audit capacity before mutating state.                                                                                                     | Live cache eviction and fail-closed audit-capacity regressions.                                                                                                  |
| Low      | Secret/build hygiene     | Git ignores alone do not prevent ignored credentials or generated audit exports from entering a Docker build context.                                                                           | Secret, wallet, credential, audit-export, report, and generated-output patterns are mirrored in ignore policy; unused future Solana transaction dependencies were removed from the MVP runtime.                                                                           | Repository/history pattern scan and dependency audit review before push.                                                                                         |

## Mathematical and decision invariants

The review established these explicit invariants:

1. `bookPercentage = sum(impliedProbability)`.
2. `overround = bookPercentage - 1`.
3. Normalized probabilities sum to one within floating-point tolerance.
4. A decision never consumes an event received after its decision timestamp.
5. Late confirmation is context, not paper eligibility.
6. A directionally inconsistent event is not labeled confirmed movement.
7. An active critical/stale feed cannot open a paper position.
8. One signal ID can open at most one position.
9. Total open stake cannot exceed the configured global exposure cap.
10. Settlement applies only to open positions and is idempotent.
11. Void produces zero virtual P&L and is excluded from decided win-rate/return denominators.
12. Replay reset leaves no dynamic signal, position, quality, or analytics state from the prior run.

## Tests added or expanded

The simulation, replay, quality, audit, and lifecycle hardening initially added 24 regression tests across five files. Subsequent causality, numeric-domain, provider, HTTP-session, malformed-input, and security regressions bring the final suite to 57 passing tests.

### Odds, causality, and signals

- book percentage and classical overround, including underround;
- margin normalization and non-advancing time rejection;
- source-future and receipt-future event rejection;
- late-confirmation relationship without paper eligibility;
- directional goal/red-card consistency and negative-movement ineligibility;
- configurable Rule-based confidence weights, components, threshold, penalties, and strategy version;
- retained-movement classifications at 30, 60, and 300 seconds.

### Data quality, simulation, and replay

- duplicate ID and duplicate sequence suppression;
- independent odds and score sequences;
- invalid, future, and regressing timestamps;
- stale alert suppression, current health, recovery, reset, and bounded memory;
- duplicate paper signal, concurrent global cap, zero stake, draw, void, loss, repeated settlement, and atomic batch bankroll update;
- historical maximum drawdown amount and percentage;
- backward replay received-time rejection, provider state/speed reset, full deterministic restart, and clean dynamic reset;
- unconfirmed full time does not settle; confirmed cancellation voids;
- a flat market response does not satisfy event-confirmed movement;
- audit cloning, run IDs, global sequence, and completeness.

### Interfaces

- required API routes and OpenAPI schemas;
- replay validation/error responses and simulation disclaimers;
- judge dashboard flow from reset through signal, operational warning, recovery, settlement, analytics, signal detail, and audit;
- Telegram-disabled command rendering without outbound traffic.

The release gate remains:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
npm run test:e2e
npm audit
```

Final release checkpoint:

- formatter, lint, and strict TypeScript typecheck: passed;
- unit/integration suite: 57/57 passed;
- dedicated integration suite: 12/12 passed;
- production Vite/TypeScript build: passed;
- Playwright Chromium judge flow: 1/1 passed;
- `npm audit`: zero known vulnerabilities;
- Docker image build plus `/health` and status smoke requests: passed.

## Remaining limitations

- The bundled match is synthetic, not recorded TxLINE data.
- The live provider has no official network transport and currently calls no TxLINE data endpoint.
- State and audit persistence are in memory and disappear on process restart.
- One process holds at most 32 anonymous, isolated replay sessions with a 30-minute idle lifetime; sessions and audit data are not durable or coordinated across replicas.
- Replay cadence is event-based rather than scaled from original inter-arrival delays.
- Counterfactual points use the first eligible snapshot at or beyond a horizon, do not interpolate, and remain absent when the configured 30-second observation-lag limit is exceeded.
- Drawdown is based on settled virtual bankroll and excludes unrealized mark-to-market movement.
- The Rule-based confidence score is not statistically calibrated.
- Signal precision measures 60-second movement persistence rather than final-match prediction accuracy.
- Telegram has outbound alerts and local response renderers but no inbound webhook or polling receiver.
- A durable audit store, pagination/retention, live fallback/circuit behavior, multi-replica coordination, and public deployment remain future production work.
- Public deployment, live onboarding, and any transaction require the appropriate external authorization.

## Conclusion

The replay MVP now has explicit mathematical, causal, simulation, and audit semantics suitable for a transparent hackathon demonstration. The remaining limits are documented product boundaries rather than hidden capabilities. Live TxLINE and public deployment should proceed only after official contracts, credentials, pricing, and external authorization are available.
