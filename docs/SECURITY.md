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

Only a disposable devnet keypair outside this repository may be used for future TxLINE onboarding, with filesystem mode `0600`. Before any transaction, verify the official network, program ID, matching IDL/types, token mint, and on-chain pricing matrix. Stop if the selected tier is not free.

Mainnet, paid tiers, and paid transactions require explicit human approval. The current application performs no on-chain transaction.

## Transport policy

Every live payload must be validated against a schema derived from the official TxLINE contract before normalization. The current live provider has no network client and reports not ready, preventing accidental calls through guessed endpoints or headers.

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
