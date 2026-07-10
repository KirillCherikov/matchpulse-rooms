# TxLINE Sentinel

> Explainable real-time sports market intelligence designed for TxLINE.

TxLINE Sentinel is a backend-first operations agent that turns football odds, scores, and match events into normalized market movements, causal event associations, data-quality alerts, reproducible signals, and simulation-only paper outcomes.

> **SIMULATION ONLY — NO REAL MONEY**

The project contains no bookmaker execution, deposits, withdrawals, wallet custody, martingale logic, or promises of profitability.

## Problem

An odds movement alone does not tell an operations team whether the move is material, whether a confirmed match event explains it, whether the feed is delayed or stale, or whether the decision can be reproduced later.

## Solution

TxLINE Sentinel validates transport-independent inputs, separates book percentage from classical overround, removes the book margin for comparison, evaluates movement speed and rolling context, and associates a move only with an event that was available by decision time. It then renders a deterministic explanation, optionally opens a risk-capped virtual position, evaluates later horizons, and records the complete decision chain in an append-only audit log.

## Key differentiators

- Causal event correlation without future-data access or absolute-timestamp matching.
- Separate operational alerts for stale, delayed, duplicate, out-of-order, gap, divergence, invalid-timestamp, rejected terminal events, and recovery conditions.
- A transparent **Rule-based confidence score**, including its component contributions and data-quality penalties; it is not a calibrated probability.
- Counterfactual observations at 30 seconds, 60 seconds, and five minutes using retained-movement ratios instead of treating every retracement as a reversal.
- Risk-capped paper simulation with win, loss, draw-selection, void, virtual P&L, settled-equity drawdown, and idempotent settlement semantics.
- Deterministic replay that judges can run without credentials or a live match.
- Run-scoped IDs and an append-only audit trail for inputs, normalized records, alerts, decisions, paper execution, counterfactual evaluation, and settlement.

## Architecture

```text
Replay / Mock / future verified official live transport
                       |
                 Zod validation
                       |
          Transport-independent domain models
                       |
          +------------+-------------+
          |                          |
  Data-quality sentinel      Causal event correlator
          |                          |
          +------------+-------------+
                       |
          Odds + explainable signal engine
                       |
        Paper simulation + counterfactuals
                       |
             Append-only audit trail
                       |
       REST/OpenAPI / CLI / dashboard / Telegram
```

The strategy and simulation layers do not depend on raw HTTP schemas. See [Architecture](docs/ARCHITECTURE.md) and [Data model](docs/DATA_MODEL.md).

## Requirements

- Node.js 22.13 or newer
- npm 10 or newer

## Quick start

```bash
npm ci
npm run dev
```

Open `http://localhost:5173` for the development dashboard. For the unified production-style server:

```bash
npm run build
npm start
```

Open `http://localhost:3000`; OpenAPI UI is at `http://localhost:3000/docs` and the machine-readable document is at `http://localhost:3000/docs/json`.

Public replay deployment:

- Dashboard: <https://txline-sentinel.onrender.com>
- OpenAPI: <https://txline-sentinel.onrender.com/docs>
- Health: <https://txline-sentinel.onrender.com/health>

## Environment variables

Copy `.env.example` to `.env.local` only when local overrides are needed. Never commit `.env.local`.

| Variable                 | Default or status                        | Purpose                                                                                                      |
| ------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `SENTINEL_MODE`          | `replay`                                 | `replay`, `mock`, or `live` provider selection.                                                              |
| `PORT`                   | `3000`                                   | Unified server port.                                                                                         |
| `HOST`                   | `0.0.0.0`                                | Listen address.                                                                                              |
| `LOG_LEVEL`              | `info`                                   | Fastify structured-log level.                                                                                |
| `CORS_ORIGIN`            | unset                                    | Optional exact origin for stateless browser API access; the stateful dashboard remains same-origin.          |
| `SESSION_COOKIE_SECURE`  | `false`                                  | Add the `Secure` flag to replay-session cookies; enabled by the HTTPS deployment profile.                    |
| `TXLINE_NETWORK`         | `devnet`                                 | Future verified live network selection.                                                                      |
| `TXLINE_API_ORIGIN`      | official devnet origin in `.env.example` | Origin only; the current live adapter makes no network call.                                                 |
| `TXLINE_GUEST_JWT`       | unset                                    | Optional runtime secret; replay does not need it.                                                            |
| `TXLINE_API_TOKEN`       | unset                                    | Optional runtime secret; replay does not need it.                                                            |
| `TELEGRAM_ENABLED`       | `false`                                  | Enables outbound notifications only for trusted fixed/live runtimes; anonymous replay sessions force it off. |
| `TELEGRAM_BOT_TOKEN`     | unset                                    | Runtime-only Telegram secret.                                                                                |
| `TELEGRAM_ALERT_CHAT_ID` | unset                                    | Outbound alert destination.                                                                                  |

## Odds terminology

For decimal odds `o_i`:

- implied probability is `q_i = 1 / o_i`;
- book percentage is `B = sum(q_i)`;
- classical overround is `B - 1`;
- normalized probability is `q_i / B`.

Normalized probability is a margin-adjusted comparison value, not a claim about the true probability of an outcome. An underround book can have a negative overround.

## Replay mode

The default scenario is explicitly labeled `Synthetic demo data — not a real match`.

```bash
npm run cli -- replay run
npm run cli -- signals list
npm run cli -- alerts list
npm run cli -- audit export --output ./data/audit.json
```

Dashboard and REST controls support Start, Pause, Resume, Reset, Next event, and 1x, 2x, 5x, and 10x cadence. Reset clears dynamic feed, signal, position, analytics, and fixture state and begins a new run namespace. The process-level audit remains append-only and uses `runId` to separate runs. Starting after a finished replay also begins a clean run.

Replay messages are processed in nondecreasing received-time order. The recorded source and received timestamps drive analytics; speed changes only wall-clock playback cadence.

## REST API

| Method | Path                                                                     |
| ------ | ------------------------------------------------------------------------ |
| GET    | `/health`, `/ready`                                                      |
| GET    | `/api/agent/status`, `/api/fixtures`, `/api/signals`, `/api/signals/:id` |
| GET    | `/api/alerts`, `/api/positions`, `/api/analytics`, `/api/audit`          |
| POST   | `/api/replay/start`, `/api/replay/pause`, `/api/replay/resume`           |
| POST   | `/api/replay/reset`, `/api/replay/advance`                               |

Fastify schemas describe request, response, and error contracts in OpenAPI. Replay state is isolated by an opaque HttpOnly session cookie in a bounded, in-memory registry; it is still anonymous and non-durable. See [API](docs/API.md).

## CLI

```bash
npm run cli -- health
npm run cli -- txline check
npm run cli -- fixtures list
npm run cli -- agent start
npm run cli -- replay start --speed 10
npm run cli -- replay run
npm run cli -- backtest run
npm run cli -- audit export --output ./data/audit.json
npm run cli -- telegram preview /status
```

`replay run`, `signals list`, `alerts list`, `backtest run`, and `audit export` are deterministic one-shot local evaluations. `replay start` prints the initial state of an ephemeral CLI process; use the dashboard or REST API for a continuing interactive replay session. `txline check` reports the intentionally unavailable live adapter until an official transport is activated. See [CLI](docs/CLI.md).

## Dashboard

The dark operations dashboard shows mode and replay state, fixture and score, current per-feed health, latest latency and movement, latest confirmed match event, Rule-based confidence score, explanation, operational alerts, virtual positions, virtual P&L, signal precision, drawdown, replay controls, and the audit timeline. A signal detail screen exposes causal relationship, signed score contributions, strategy configuration version, and counterfactual evidence.

## Telegram

Telegram is disabled by default. When explicitly enabled with runtime secrets in a trusted fixed/live runtime, the current integration can send outbound notifications for scores above the configured notification threshold, critical operational alerts, and feed recovery. Anonymous replay HTTP sessions always force outbound delivery off, including on the public judge deployment. The integration also contains deterministic renderers for `/status`, `/signals`, `/alerts`, `/fixture`, and `/positions`, exposed locally through `telegram preview`.

There is currently no Telegram webhook or `getUpdates` receiver, so those command renderers are not yet an interactive deployed bot. No Telegram token is committed or printed.

## TxLINE integration

`ReplayTxLineProvider`, `MockTxLineProvider`, and `LiveTxLineProvider` share one provider boundary. Replay is complete and is the judge path. The live provider validates injected domain-shaped messages but intentionally has no network transport yet.

**TxLINE data endpoints currently called: none.** No endpoint path, authentication header, program ID, IDL, token mint, or response schema is fabricated. Live activation awaits verified official credentials, matching artifacts, and pricing checks. See [TxLINE integration](docs/TXLINE_INTEGRATION.md).

Official references:

- <https://txline.txodds.com/documentation/quickstart>
- <https://txline.txodds.com/documentation/worldcup>
- <https://txline.txodds.com/llms.txt> — documented machine index, currently returning HTTP 404

## Quality checks

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
# Minimal Linux/CI hosts; may require permission to install system packages.
npx playwright install --with-deps chromium
npm run test:e2e
npm audit
```

If the required Linux browser libraries are already installed, `npx playwright install chromium` is sufficient.

The audited release checkpoint passes 82 unit/integration tests, 26 dedicated integration tests, the Chromium judge flow, production build, Docker build/smoke, and `npm audit` with zero known vulnerabilities. Do not use `npm audit fix --force`; review advisories for reachability and runtime relevance.

## Deployment

```bash
docker build -t txline-sentinel .
docker run --rm -p 3000:3000 --env SENTINEL_MODE=replay txline-sentinel
```

The image runs as a non-root user and includes a `/health` check. The replay build is deployed at <https://txline-sentinel.onrender.com>. Until durable session coordination is implemented, keep the judge deployment at one replica. See [Deployment](docs/DEPLOYMENT.md), [Judge guide](docs/JUDGE_GUIDE.md), and [Demo script](docs/DEMO_SCRIPT.md).

A judge-safe Render Blueprint is provided in `render.yaml`. The public service runs in replay mode with Telegram disabled and no TxLINE credentials.

## Honest limitations

- The bundled fixture is synthetic and is never represented as a real match.
- No live TxLINE endpoint is called yet; the adapter is a validated boundary, not a completed transport.
- State and audit records are in memory and are lost on process restart.
- Replay sessions are isolated in one process but remain anonymous, memory-only, bounded, and unsuitable for horizontal scaling without shared storage.
- Replay speed controls event cadence rather than reproducing original inter-arrival delays.
- Counterfactual horizons require both source progression and received availability within 30 seconds after each target; they do not interpolate or backfill from materially late data.
- Signal precision is a 60-second movement-persistence metric, not proof of predictive profitability.
- The Rule-based confidence score is a deterministic heuristic, not a calibrated probability or guarantee.
- Telegram supports outbound alerts and local command rendering, but no inbound bot receiver.
- Live TxLINE credentials/transport and a demo video remain pending external authorization or production work.

## Judge walkthrough

1. Open the dashboard and verify both the synthetic-data label and simulation disclaimer.
2. Click **Reset**, then **Next event** five times.
3. Inspect the confirmed-event movement, score components, explanation, and virtual position.
4. Continue to the duplicate, stale, gap, out-of-order, delayed, and recovery alerts.
5. Select 10x and click **Start** to finish settlement.
6. Inspect virtual P&L, signal precision, drawdown, counterfactual horizons, and audit records.
7. Open `/docs` for the REST contract.

## Documentation

- [Product](docs/PRODUCT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Architecture review](docs/SOL_ARCHITECTURE_REVIEW.md)
- [Signal engine](docs/SIGNAL_ENGINE.md)
- [Paper trading](docs/PAPER_TRADING.md)
- [Replay](docs/REPLAY.md)
- [Security](docs/SECURITY.md)
- [Submission draft](docs/SUBMISSION.md)

## License

MIT. See [LICENSE](LICENSE).
