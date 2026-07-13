# Security

## Simulation boundary

The service contains virtual paper positions and analytics only.

> **SIMULATION ONLY — NO REAL MONEY**

Do not add bookmaker execution, wallet custody, deposits, withdrawals, real-money claims, or martingale logic.

## Secret handling

`.env`, `.env.local`, wallet JSON, keys, PEM files, credential directories, generated audit exports, runtime databases, and common secret-bearing files are excluded from source control and Docker build context. Only `.env.example` is versioned.

Never commit or print:

- guest JWTs or API tokens;
- Telegram bot tokens;
- authorization headers;
- private keys or seed phrases;
- wallet JSON;
- raw credential-bearing responses.

Runtime secrets belong in `.env.local` for local work or a deployment-platform secret store. They must not use client-visible environment prefixes.

## Wallet and transaction policy

Only the disposable devnet keypair outside this repository, with filesystem mode `0600`, was used for TxLINE onboarding. The completed subscription preflight verified Solana devnet, the pinned program/IDL/types, Token-2022 mint/account, current pricing row, account changes, fee/rent, and a successful simulation before the explicitly approved broadcast.

The finalized `subscribe(1,4)` transaction used a zero-TxL pricing row and ordinary devnet SOL fees/account rent. The server runtime contains no wallet and performs no on-chain transaction. Mainnet, paid tiers, TxL purchases, and any future state-changing transaction require separate explicit human approval.

## Transport policy

Every live JSON/SSE payload is validated against schemas derived from the pinned official TxLINE OpenAPI/examples before adaptation. The client restricts the HTTPS origin and allowed paths, refuses redirects, bounds bodies/events/retention, enforces stream ordering, renews the guest JWT only after 401, uses bounded retry/backoff and idle timeouts, and supports AbortController shutdown. Known secrets and bearer/token patterns are redacted before diagnostics reach status or logs.

The process-wide live sidecar is read-only. Subscription and activation signing remain explicit local tools. Runtime fixture verification receives only the disposable **public** address, manually encodes the pinned read-only instruction, and calls Solana devnet simulation with `sigVerify: false`; it has no private key, signing call, or broadcast method. The Anchor `.view()` proof helper is an optional local reproduction path. Anonymous replay sessions are given a cloned configuration with TxLINE credentials removed.

## HTTP boundary

- CORS is disabled by default and can allow one exact `CORS_ORIGIN` for stateless browser API access; cookie-backed dashboard sessions remain same-origin.
- The judge dashboard and API are served same-origin.
- Replay mutation endpoints use isolated opaque sessions and same-origin write checks, but do not authenticate a person.
- Session state is bounded to 32 idle-expiring agents; each in-memory audit log fails closed at 2,000 records.
- Anonymous replay agents force outbound Telegram delivery off even if an operator accidentally enables the feature globally.
- Dashboard responses receive CSP, frame, MIME-sniffing, referrer, and permissions headers. The deployment profile enables Secure cookies and HSTS.
- Fastify request/response schemas document the HTTP contract.
- Graceful SIGINT/SIGTERM handling closes the scheduler and server.

Authenticated identities, platform rate limiting, durable authorization audit, and multi-replica session coordination are required before multi-tenant production deployment.

## Data and audit policy

The audit log stores sanitized raw references rather than credentials or unrestricted raw payloads. Audit entries are append-only within the process and returned as clones. It refuses further replay mutation before its fixed capacity could produce unaudited state. Audit persistence is in memory, so restart destroys it; this is an availability limitation, not a durable compliance store.

## Dependency policy

Run `npm audit` and assess reachability. Do not use `npm audit fix --force`. Unused transaction dependencies must not remain in the runtime image merely for a future integration.

The verified release checkpoint reports zero known npm vulnerabilities. `@fastify/static` was upgraded to the patched 9.3 line after reviewing its path-handling advisories.
