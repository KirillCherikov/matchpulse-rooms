# Architecture

TxLINE Sentinel is a compact TypeScript application. Fastify hosts REST/OpenAPI and the production dashboard, React/Vite provides the judge console, and the decision pipeline runs in one process for deterministic local replay.

```text
TxLineProvider
  ReplayTxLineProvider | MockTxLineProvider | LiveTxLineProvider
              |
       Zod input contract
              |
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
| Transport    | Future official HTTP/SSE/authentication implementation. No strategy imports raw schemas.                      |
| Providers    | Replay, mock, or validated live message adaptation and readiness.                                             |
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

The MVP intentionally uses one in-memory agent per server process. Reset creates a new run namespace and clears all dynamic decision state; process-level audit records remain append-only. This makes the local judge path simple and reproducible but means:

- process restart loses all state;
- multiple replicas do not share state;
- replay state is isolated per opaque browser session, but those sessions are anonymous and memory-only;

A durable append-only store, authenticated identities, and multi-replica session coordination are deployment extensions, not hidden capabilities of the current build.

## Configuration

Strategy configuration version, signal thresholds, score weights, data-quality thresholds, counterfactual ratios, stake sizing, and exposure caps originate in typed configuration. Signals persist the configuration version and score components needed to reproduce the decision.

## Interface security

Cross-origin access is disabled unless `CORS_ORIGIN` is explicitly set, and replay writes reject mismatched browser origins. The same-origin judge dashboard receives an opaque HttpOnly, SameSite session cookie; production deployment sets its Secure attribute. This isolates replay state but does not authenticate a person, so the service is not an untrusted multi-tenant control plane.

## Live integration boundary

The live provider currently validates injected domain-shaped data and reports not ready. It does not call TxLINE. Official transport paths, headers, schemas, program artifacts, and authentication will be added only after they are verified against official documentation and safe devnet onboarding requirements.
