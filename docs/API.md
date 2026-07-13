# API

The unified Fastify server exposes the judge dashboard and a documented JSON API. OpenAPI UI is served at `/docs`; the machine-readable OpenAPI document is at `/docs/json`.

Registered schemas cover fixtures, replay state, agent status, signals, operational alerts, paper positions, analytics, audit events, replay-control requests, and error responses. Runtime Zod validation remains the provider-input boundary; Fastify schemas document and validate the HTTP boundary.

## Operations

| Method | Path      | Semantics                                                                          |
| ------ | --------- | ---------------------------------------------------------------------------------- |
| GET    | `/health` | Process liveness.                                                                  |
| GET    | `/ready`  | Deterministic replay/provider readiness; independent of live-sidecar availability. |

Replay and mock modes are ready without credentials. `/ready` is session-free and does not allocate a replay agent or set a session cookie. The read-only TxLINE sidecar has independent health at `/api/live/status`, so a devnet outage or quiet stream never blocks the deterministic judge path.

## Read APIs

| Method | Path                   | Response                                                                                     |
| ------ | ---------------------- | -------------------------------------------------------------------------------------------- |
| GET    | `/api/agent/status`    | Mode, replay state, fixture, current feed health, latest records, and simulation disclaimer. |
| GET    | `/api/live/status`     | Session-free TxLINE devnet auth, fixture, stream, heartbeat/reconnect, and proof status.     |
| GET    | `/api/fixtures`        | Normalized fixtures, including the synthetic-data label.                                     |
| GET    | `/api/signals`         | Current-run explainable signals.                                                             |
| GET    | `/api/signals/:id`     | One current-run signal or HTTP 404.                                                          |
| GET    | `/api/alerts`          | Current-run operational alert history.                                                       |
| GET    | `/api/positions`       | Paper positions plus `SIMULATION ONLY — NO REAL MONEY`.                                      |
| GET    | `/api/analytics`       | Virtual analytics plus the simulation disclaimer.                                            |
| GET    | `/api/audit?limit=100` | Process-level append-only audit events; limit must be an integer from 1 to 10,000.           |

Signals expose `ruleBasedConfidenceScore` and `confidenceComponents`. The score is a deterministic heuristic, not a probability. Normalized odds expose both `bookPercentage` and classical `overround`.

`/api/live/status` never returns the guest JWT, API token, authorization headers, wallet data, or raw third-party records. Its proof enum is strictly `verified`, `failed`, or `unavailable`; a successful HTTP connection alone cannot produce `verified`.

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
BASE_URL="${BASE_URL:-https://txline-sentinel.onrender.com}"
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

curl -c "$COOKIE_JAR" -b "$COOKIE_JAR" -X POST "$BASE_URL/api/replay/reset"
curl -c "$COOKIE_JAR" -b "$COOKIE_JAR" -X POST "$BASE_URL/api/replay/advance"
curl -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE_URL/api/signals"
curl -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE_URL/api/audit?limit=100"
```

The cookie jar is required because every replay session is isolated by its opaque session cookie. Set `BASE_URL=http://localhost:3000` to run the same sequence against a local server.

## Current limitations

- Each browser receives an isolated replay agent through an opaque HttpOnly, SameSite session cookie.
- The registry is bounded to 32 sessions with a 30-minute idle lifetime, and each append-only audit log fails closed at 2,000 events.
- When all 32 non-expired replay sessions are occupied, creation of a new session returns HTTP 503 instead of evicting an active judge session.
- Read collections other than audit are not paginated because the synthetic run is bounded.
- Live is one process-wide read-only TxLINE devnet sidecar rather than a public ingestion endpoint. It cannot mutate replay state or open paper positions.
- An accepted stream can be connected while awaiting covered data; no active fixture is guaranteed.
- Official integer odds are retained without inventing a decimal conversion contract.
- Replay mutation endpoints isolate session state and reject cross-origin browser writes, but the cookie is not user authentication.
- State is not durable and is lost on restart.
- CORS is disabled by default. One exact `CORS_ORIGIN` can expose stateless browser API reads, but the current cookie-backed dashboard and replay controls are intentionally same-origin and are not a supported cross-origin frontend deployment.

These constraints are acceptable for the local and judge path; durable identity, storage, rate limiting, and replica coordination remain required before multi-tenant deployment.
