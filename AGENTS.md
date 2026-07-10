# TxLINE Sentinel Engineering Guide

## Product boundary

TxLINE Sentinel is professional sports-data infrastructure and paper-trading decision support. It is **simulation only**: do not add real-money betting, bookmaker execution, deposits, withdrawals, wallet custody, profit promises, or martingale logic.

## Safety and secrets

- Never commit `.env*` files except `.env.example`, private keys, wallet JSON, JWTs, API tokens, Telegram tokens, authorization headers, or raw credential-bearing payloads.
- Use a disposable devnet wallet only for TxLINE onboarding. Keep it outside this repository with mode `0600`.
- Do not make a mainnet or paid transaction without explicit human approval.
- Sanitized examples must not contain credentials or commercially restricted raw data.

## Data discipline

- Use official TxLINE endpoint paths and headers only.
- Validate every live HTTP/SSE payload with Zod before normalization.
- Preserve raw payload references in the append-only audit log; never make up unobserved sporting events.
- Clearly label synthetic replay data as `Synthetic demo data — not a real match`.

## Quality bar

- TypeScript stays strict. Keep domain models independent from raw transport schemas.
- Run `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` before a release.
- Prefer small, focused commits using conventional commit prefixes.
