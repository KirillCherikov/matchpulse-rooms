# Deployment

## Current status

The replay-mode container is publicly deployed at <https://txline-sentinel.onrender.com>. The dashboard, `/health`, `/ready`, `/docs`, session-isolated replay controls, signal generation, and paper-position opening were verified over HTTPS on July 11, 2026.

Live TxLINE deployment is not ready and must not be enabled merely to obtain a public URL.

## Docker

```bash
docker build -t txline-sentinel .
docker run --rm -p 3000:3000 --env SENTINEL_MODE=replay txline-sentinel
```

The container:

- builds the Vite dashboard and TypeScript server;
- serves dashboard, API, and OpenAPI on port 3000;
- runs as the non-root `node` user;
- includes a `/health` container health check;
- handles SIGTERM/SIGINT through Fastify shutdown;
- defaults safely to replay when mode is not overridden.

Verify:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
curl http://localhost:3000/api/agent/status
```

## Judge deployment constraints

Deploy exactly one replica. One process owns a bounded registry of isolated in-memory replay sessions. Horizontal replicas would still have independent session registries and audit logs without a shared durable store.

Recommended settings:

| Setting           | Value                                           |
| ----------------- | ----------------------------------------------- |
| Mode              | `SENTINEL_MODE=replay`                          |
| Port              | Platform-provided `PORT` or `3000`              |
| Health path       | `/health`                                       |
| Readiness path    | `/ready`                                        |
| Replica count     | `1`                                             |
| Persistent volume | Not useful until a durable store is implemented |
| CORS              | Unset for same-origin dashboard                 |
| Telegram          | Disabled for judge deployment                   |

The process must remain writable only to its own runtime needs. Do not copy `.env.local`, wallet files, keys, audit exports, `secrets/`, or `credentials/` into the image or build context.

## Render blueprint

`render.yaml` defines the deployed Docker web service named `txline-sentinel` on the free plan, with `/health` as its health check. It pins judge-safe runtime values for replay mode, disables Telegram, and enables deploys only after checks pass.

Current public endpoints:

- Dashboard: <https://txline-sentinel.onrender.com>
- Health: <https://txline-sentinel.onrender.com/health>
- Readiness: <https://txline-sentinel.onrender.com/ready>
- OpenAPI UI: <https://txline-sentinel.onrender.com/docs>
- OpenAPI JSON: <https://txline-sentinel.onrender.com/docs/json>

The judge deployment contains no TxLINE or Telegram secrets. Keep the selected branch at `main`, the service public, and the replica count at one.

## Release checklist

1. Run the complete quality suite, including Chromium E2E.
2. Review `npm audit` without force-fixing.
3. Scan Git history and the Docker context for secrets.
4. Build and smoke-test the image locally.
5. Verify the deployed replay-mode replica and its `/health` check.
6. Verify dashboard, `/health`, `/ready`, `/docs`, replay reset/advance, settlement, and signal detail over HTTPS.
7. Keep the deployment and API URLs current in README and `SUBMISSION.md`.
8. Keep a tested local Docker demo as the backup flow.

CI is defined in `.github/workflows/ci.yml` and covers install, formatting, lint, typecheck, unit/integration tests, dependency audit, production build, Chromium installation, E2E, and a dependent production-image build plus container health/API smoke test.

## Production extensions

Before multi-tenant or long-running use, add durable append-only persistence, authenticated identities, platform rate limits, observability, backup/restore, and multi-replica coordination. The current opaque session cookie isolates judge state but is not an authentication mechanism.

## Live mode gate

Do not deploy live mode until the official TxLINE transport, exact schemas, authentication lifecycle, network consistency, and failure behavior are implemented and tested. If onboarding requires an on-chain action, first verify the current pricing row is free and obtain the required explicit authorization.
