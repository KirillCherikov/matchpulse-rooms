# Deployment

## Current status

The public service at <https://txline-sentinel.onrender.com> is a healthy replay deployment. The latest live-devnet work must not be described as public until its commit has passed GitHub Actions, Render has deployed that exact commit, and `/api/live/status` has been checked on the public host.

The local integration is already activated and smoke-tested against real TxLINE devnet data: an authenticated fixture snapshot returned seven records, odds SSE delivered a data event, scores SSE delivered a heartbeat, and an official `validateFixture` read-only simulation returned true. Render secret setup and deployment of this live sidecar are still manual external steps.

## Docker

Replay-only local run:

```bash
docker build -t txline-sentinel .
docker run --rm -p 3000:3000 --env SENTINEL_MODE=replay txline-sentinel
```

The container builds the Vite dashboard and TypeScript server, serves dashboard/API/OpenAPI on port 3000, runs as non-root `node`, exposes a `/health` container check, handles SIGTERM/SIGINT, and defaults safely to replay.

Verify:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
curl http://localhost:3000/api/live/status
curl http://localhost:3000/api/agent/status
```

The live sidecar can be tested locally only by loading an ignored mode-`0600` credential file into the process environment. Do not use `--env-file` with a file that contains unrelated secrets.

## Runtime topology

Keep `SENTINEL_MODE=replay` even when live data is enabled. The process hosts:

- one session-free, process-wide, read-only TxLINE devnet sidecar exposed through `/api/live/status`;
- a bounded registry of isolated deterministic replay sessions;
- no wallet, transaction signer, bookmaker client, or real-money execution path.

Deploy exactly one replica. Replay sessions and audit logs are memory-only and are not coordinated across replicas. Live transport failure must not block `/health`, `/ready`, the dashboard, or replay.

## Render environment

`render.yaml` pins these non-secret values:

| Variable                | Value                           | Reason                                       |
| ----------------------- | ------------------------------- | -------------------------------------------- |
| `SENTINEL_MODE`         | `replay`                        | deterministic judge decision path            |
| `TXLINE_NETWORK`        | `devnet`                        | runtime rejects mainnet when live is enabled |
| `TXLINE_API_ORIGIN`     | `https://txline-dev.txodds.com` | exact official devnet origin                 |
| `TXLINE_LIVE_ENABLED`   | `false` initially               | preserve replay until secrets are entered    |
| `TELEGRAM_ENABLED`      | `false`                         | no judge-environment outbound messaging      |
| `SESSION_COOKIE_SECURE` | `true`                          | HTTPS replay-session cookie                  |

The Blueprint declares `TXLINE_GUEST_JWT` and `TXLINE_API_TOKEN` with `sync: false`; it never contains their values.

One manual Render action is required: in **Render Dashboard → txline-sentinel → Environment**, create or update exactly `TXLINE_NETWORK`, `TXLINE_API_ORIGIN`, `TXLINE_GUEST_JWT`, `TXLINE_API_TOKEN`, and `TXLINE_LIVE_ENABLED`; paste the corresponding values from the local ignored credential file into the two secret fields, set `TXLINE_LIVE_ENABLED=true`, save, and deploy the latest commit. Do not paste any value into chat, Git, a screenshot, or a build argument.

Do **not** add the disposable wallet path, wallet JSON, seed, private key, subscription signature preimage, or activation signature to Render. Subscription and activation are one-time local operations; the server performs authenticated reads only.

## Public endpoints

- Dashboard: <https://txline-sentinel.onrender.com>
- Health: <https://txline-sentinel.onrender.com/health>
- Replay readiness: <https://txline-sentinel.onrender.com/ready>
- Live status: <https://txline-sentinel.onrender.com/api/live/status>
- OpenAPI UI: <https://txline-sentinel.onrender.com/docs>
- OpenAPI JSON: <https://txline-sentinel.onrender.com/docs/json>

`/ready` proves the replay judge path is available; live health is intentionally separate at `/api/live/status`. A live stream may be connected and authenticated while awaiting a covered event.

## Post-deploy verification

After Render reports the target commit deployed:

1. compare the Render commit SHA with `git rev-parse HEAD`;
2. verify `/health` returns liveness and `/ready` remains ready without allocating a replay session;
3. verify `/api/live/status` reports `enabled: true`, network `solana-devnet`, and authenticated transport;
4. accept either a data event or an honest connected/heartbeat `awaitingData` state when no covered fixture is active;
5. let the runtime automatically fetch the matching fixture proof and perform its unsigned devnet simulation; accept `verified` only with complete root/slot/compute/program evidence, and otherwise preserve the explicit `failed` or `unavailable` reason;
6. switch the dashboard to **SYNTHETIC REPLAY** and run reset → advance → signal → settlement;
7. verify `/docs` describes `/api/live/status` and all replay APIs;
8. run a secret scan against the committed tree and inspect Render logs for masked diagnostics only.

## Release checklist

1. Run formatting, lint, strict typecheck, unit tests, integration tests, production build, Chromium E2E, and `npm audit`.
2. Build the production image and smoke `/health`, `/ready`, `/api/live/status`, and replay status locally.
3. Run the real credentialed devnet smoke locally; CI remains fully mocked and credential-free.
4. Scan the working tree, staged diff, Git history, and Docker context for secrets.
5. Commit logically, push `main`, and wait for every GitHub Actions job.
6. Add Render secrets only through the Environment screen and deploy the exact successful commit.
7. Run the public live-status, replay, OpenAPI, and security-header smoke.
8. Update submission evidence only after the public checks pass.

## Judge deployment constraints

| Setting               | Value                             |
| --------------------- | --------------------------------- |
| Replica count         | `1`                               |
| Health path           | `/health`                         |
| Readiness path        | `/ready`                          |
| CORS                  | unset for same-origin dashboard   |
| Telegram              | disabled                          |
| Wallet/runtime signer | none                              |
| Persistent volume     | none until a durable store exists |

Before multi-tenant or long-running production use, add durable append-only persistence, authenticated identities, platform rate limits, observability, backup/restore, and multi-replica coordination. The opaque replay cookie isolates judge state; it is not identity authentication.
