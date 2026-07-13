# Architecture

TxLINE Sentinel is a compact TypeScript application. Fastify hosts REST/OpenAPI and the production dashboard, React/Vite provides the judge console, and the decision pipeline runs in one process for deterministic local replay.

```text
Official TxLINE HTTP/SSE              ReplayTxLineProvider | MockTxLineProvider
          |                                          |
 strict raw Zod contracts                    domain Zod contract
          |                                          |
 read-only live status              normalized messages + two clocks
          |                                          |
          |                                  +-------+-------+
          |                                  |               |
          |                         data-quality state   causal correlator
          |                                  |               |
          |                                  +-------+-------+
          |                                          |
          |                           odds movement + signal rules
          |                                          |
          |                         paper execution + counterfactuals
          |                                          |
          +-----------------------------+------------+
                                        |
                         REST/OpenAPI | dashboard | audit
```

The authenticated live sidecar and replay decision engine are deliberately separate. Live metadata cannot mutate an anonymous replay session, and replay cannot access the sidecar credentials.

The deterministic replay pipeline remains:

```text
normalized domain messages + two clocks
              |
     +--------+---------+
     |                  |
data-quality state   causal correlator
     |                  |
     +--------+---------+
              |
   odds movement + signal rules
              |
 Rule-based confidence + explanation
              |
 paper execution + counterfactual horizons
              |
 append-only, run-scoped audit events
              |
 REST/OpenAPI | CLI | dashboard | outbound Telegram
```

## Boundaries

| Layer        | Responsibility                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| Transport    | Official devnet HTTP/SSE, dual-header authentication, 401 JWT renewal, bounded reconnect, and shutdown.       |
| Providers    | Strict official raw schemas/adapters plus replay/mock domain providers. No strategy imports raw schemas.      |
| Domain       | Strict transport-independent models and source/received time semantics.                                       |
| Data quality | Per-fixture, per-feed sequence, timestamp, duplicate, latency, staleness, recovery, and bounded-memory state. |
| Correlation  | Confirmed events that precede the market source time and were received by decision time.                      |
| Signal       | Odds mathematics, rolling context, deterministic rules, componentized heuristic score, and explanation.       |
| Simulation   | Risk-capped paper positions, idempotent settlement, virtual P&L, and settled-equity drawdown.                 |
| Evaluation   | 30/60/300-second retained-movement counterfactuals.                                                           |
| Audit        | Process-append-only records separated by replay `runId`.                                                      |
| Interfaces   | Fastify/OpenAPI, one-shot CLI utilities, React judge dashboard, and optional outbound Telegram notifications. |

## Causal processing order

For every received replay message, the application:

1. checks staleness and unresolved score/odds divergence using the current simulated received time;
2. records a sanitized raw reference;
3. validates sequence, timestamps, duplicate status, and delay;
4. ignores invalid, duplicate, or out-of-order input;
5. normalizes an accepted score or odds record;
6. updates only state available by that record's received time;
7. creates alerts, signals, explanations, paper decisions, counterfactual points, and audit events.

The correlator never uses absolute timestamp distance or an event received after decision time. See [Signal engine](SIGNAL_ENGINE.md).

## State ownership

The MVP intentionally uses one in-memory agent per isolated replay session inside a single server process. Reset creates a new run namespace and clears that session's dynamic decision state; its audit records remain append-only. This makes the local judge path simple and reproducible but means:

- process restart loses all state;
- multiple replicas do not share state;
- replay state is isolated per opaque browser session, but those sessions are anonymous and memory-only;

A durable append-only store, authenticated identities, and multi-replica session coordination are deployment extensions, not hidden capabilities of the current build.

## Configuration

Strategy configuration version, signal thresholds, score weights, data-quality thresholds, counterfactual ratios, stake sizing, and exposure caps originate in typed configuration. Signals persist the configuration version and score components needed to reproduce the decision.

## Interface security

Cross-origin access is disabled unless `CORS_ORIGIN` is explicitly set, and replay writes reject mismatched browser origins. The optional origin supports stateless browser API access; the current cookie-backed dashboard and replay controls remain a same-origin deployment. The judge dashboard receives an opaque HttpOnly, SameSite session cookie, and production sets its Secure attribute. This isolates replay state but does not authenticate a person, so the service is not an untrusted multi-tenant control plane.

## Live integration boundary

The process-wide sidecar calls the official devnet fixture, odds, and scores snapshots plus odds/scores SSE streams. It validates before adaptation, bounds memory and body/event size, rejects unknown origins/paths, renews the guest JWT once after HTTP 401, redacts diagnostics, and exposes only sanitized status at `/api/live/status`.

Fixture and explicit confirmed soccer-event mappings can enter transport-independent models. Official integer odds are preserved as evidence, but they do not enter decimal-odds strategy calculations because Sentinel does not invent an undocumented scale. The server automatically verifies an observed fixture by fetching its official proof, encoding the pinned IDL instruction, and running an unsigned `sigVerify: false` devnet simulation. It never contains a wallet, creates a signature, or exposes a broadcast path. A separate one-shot Anchor `.view()` helper reproduces the official runnable example locally.
