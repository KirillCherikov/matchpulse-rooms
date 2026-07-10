# API

The unified Fastify server exposes the judge dashboard and a documented JSON API. OpenAPI UI is served at `/docs`; the machine-readable OpenAPI document is at `/docs/json`.

Registered schemas cover fixtures, replay state, agent status, signals, operational alerts, paper positions, analytics, audit events, replay-control requests, and error responses. Runtime Zod validation remains the provider-input boundary; Fastify schemas document and validate the HTTP boundary.

## Operations

| Method | Path      | Semantics                                                                 |
| ------ | --------- | ------------------------------------------------------------------------- |
| GET    | `/health` | Process liveness.                                                         |
| GET    | `/ready`  | Provider readiness; unavailable live mode returns HTTP 503 with a reason. |

Replay and mock modes are ready without credentials. Health does not imply that the intentionally incomplete live adapter is ready.

## Read APIs

| Method | Path                   | Response                                                                                     |
| ------ | ---------------------- | -------------------------------------------------------------------------------------------- |
| GET    | `/api/agent/status`    | Mode, replay state, fixture, current feed health, latest records, and simulation disclaimer. |
| GET    | `/api/fixtures`        | Normalized fixtures, including the synthetic-data label.                                     |
| GET    | `/api/signals`         | Current-run explainable signals.                                                             |
| GET    | `/api/signals/:id`     | One current-run signal or HTTP 404.                                                          |
| GET    | `/api/alerts`          | Current-run operational alert history.                                                       |
| GET    | `/api/positions`       | Paper positions plus `SIMULATION ONLY — NO REAL MONEY`.                                      |
| GET    | `/api/analytics`       | Virtual analytics plus the simulation disclaimer.                                            |
| GET    | `/api/audit?limit=100` | Process-level append-only audit events; limit must be an integer from 1 to 10,000.           |

Signals expose `ruleBasedConfidenceScore` and `confidenceComponents`. The score is a deterministic heuristic, not a probability. Normalized odds expose both `bookPercentage` and classical `overround`.

## Replay write APIs

`POST /api/replay/start` and `POST /api/replay/resume` accept an optional body:

```json
{ "speed": 1 }
```

Allowed speeds are `1`, `2`, `5`, and `10`.

| Method | Path                  | Semantics                                                          |
| ------ | --------------------- | ------------------------------------------------------------------ |
| POST   | `/api/replay/start`   | Start playback; after finished state, begin a clean replay run.    |
| POST   | `/api/replay/pause`   | Pause automatic playback.                                          |
| POST   | `/api/replay/resume`  | Resume, optionally with a new cadence.                             |
| POST   | `/api/replay/reset`   | Reset all dynamic pipeline state and begin a new run namespace.    |
| POST   | `/api/replay/advance` | Process exactly one event and leave replay paused unless finished. |

Malformed control data returns HTTP 400. Replay operations in a mode without replay controls return HTTP 409.

Example:

```bash
curl -X POST http://localhost:3000/api/replay/reset
curl -X POST http://localhost:3000/api/replay/advance
curl http://localhost:3000/api/signals
curl 'http://localhost:3000/api/audit?limit=100'
```

## Current limitations

- Each browser receives an isolated replay agent through an opaque HttpOnly, SameSite session cookie.
- The registry is bounded to 32 sessions with a 30-minute idle lifetime, and each append-only audit log fails closed at 2,000 events.
- Read collections other than audit are not paginated because the synthetic run is bounded.
- There is no live ingestion HTTP endpoint or completed TxLINE network transport.
- Replay mutation endpoints isolate session state and reject cross-origin browser writes, but the cookie is not user authentication.
- State is not durable and is lost on restart.
- CORS is disabled by default; set one trusted `CORS_ORIGIN` only when a separate frontend requires it.

These constraints are acceptable for the local and judge path; durable identity, storage, rate limiting, and replica coordination remain required before multi-tenant deployment.
