# Submission checklist

Do not mark an item complete from intention or local code alone. Record the command/run/URL evidence without copying credentials or raw third-party datasets.

## TxLINE devnet evidence

- [x] Disposable wallet is outside the repository, mode `0600`, and devnet-only.
- [x] Program ID matches pinned official devnet IDL/types: `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`.
- [x] Token-2022 mint matches official devnet: `4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG`.
- [x] Pricing row was read on-chain: service level `1`, price `0`, sampling `0`, league bundle `1`, market bundle `2`.
- [x] ATA/subscription construction was simulated before broadcast.
- [x] Explicitly approved `subscribe(1,4)` finalized on Solana devnet.
- [x] Guest JWT and API token activation succeeded without exposing values.
- [x] Authenticated fixture snapshot returned real records.
- [x] Odds SSE opened and delivered a real data event.
- [x] Scores SSE opened and delivered a heartbeat.
- [x] `validateFixture` read-only simulation returned verified.
- [x] No mainnet, TxL purchase, card, real asset, or runtime wallet was used.

## Implementation

- [x] Official devnet origin/program/mint/OpenAPI/IDL/types are pinned with hashes/source.
- [x] Fixture, odds, score, heartbeat, guest-token, and proof payloads have Zod boundaries.
- [x] Unknown/incompatible live shapes fail closed.
- [x] SSE parser handles fragmented records and bounded event size.
- [x] Streams handle heartbeat, idle timeout, duplicate/out-of-order IDs, reconnect/backoff, and cancellation.
- [x] Guest JWT renews on HTTP 401; API token remains unchanged.
- [x] Errors and status redact known credentials and bearer/token patterns.
- [x] Official integer prices are preserved without invented decimal odds.
- [x] Proof status distinguishes verified/failed/unavailable.
- [x] LIVE DEVNET TXLINE and SYNTHETIC REPLAY are visibly separate.
- [x] Replay behavior and simulation-only boundary remain intact.

## Final local release gate

- [x] `npm run format:check`
- [x] `npm run lint`
- [x] `npm run typecheck`
- [x] `npm test` — 129/129.
- [x] `npm run test:integration` — 35/35.
- [x] `npm run build`
- [x] `npm run test:e2e` — Chromium 3/3.
- [x] `npm audit` — zero known vulnerabilities.
- [x] `docker build --check .`
- [x] Production Docker build and `/health`, `/ready`, `/api/live/status`, replay smoke.
- [x] Real credentialed devnet smoke repeated from the ignored credential file.
- [x] Working tree, staged diff, Git history, and Docker context secret scans are clean.
- [x] Final `git diff --check` and independent human-readable diff review are clean.

## GitHub and Render

- [ ] Logical commits created and pushed to `main`.
- [ ] GitHub Actions completes successfully for the exact head SHA.
- [ ] In Render Environment, create/update only: `TXLINE_NETWORK`, `TXLINE_API_ORIGIN`, `TXLINE_GUEST_JWT`, `TXLINE_API_TOKEN`, `TXLINE_LIVE_ENABLED`.
- [ ] Credential values are copied from the local ignored file directly into the two Render secret fields; values are not pasted into chat/docs/logs.
- [ ] No wallet path, keypair, private key, seed, or activation signature is stored in Render.
- [ ] Render deploy reports the exact successful Git commit.
- [ ] <https://txline-sentinel.onrender.com/health> passes.
- [ ] <https://txline-sentinel.onrender.com/ready> passes without a replay session cookie.
- [ ] <https://txline-sentinel.onrender.com/api/live/status> reports enabled devnet/authenticated state without secrets.
- [ ] Both SSE health states are honest: data/heartbeat or connected awaiting data.
- [ ] <https://txline-sentinel.onrender.com/docs> includes `/api/live/status`.
- [ ] Public replay reset → signal → settlement remains green in a fresh cookie session.

## Submission assets

- [x] README and TxLINE integration mapping updated.
- [x] Deployment, judge, and live-first demo instructions updated.
- [x] Final submission copy prepared.
- [ ] Run `rg -n '\b(PENDING|TBD)\b' README.md docs render.yaml` and resolve every release placeholder with verified evidence; no unreviewed `PENDING` or `TBD` remains.
- [ ] Record a target-`4:40` video (acceptable rehearsal range `4:30–4:45`): real devnet auth/fixture/SSE/proof first, deterministic replay second.
- [ ] Inspect the final encoded media duration and confirm it is strictly shorter than `5:00`.
- [ ] Review video frame-by-frame for credentials, wallet JSON, request headers, and raw restricted data.
- [ ] Add final video URL to `FINAL_SUBMISSION.md`/submission form.
- [ ] Confirm all public URLs in an incognito browser.
- [ ] Press Submit.

## Human participant and official terms

- [ ] The named human participant personally reads the current official eligibility rules and submission terms, and confirms age, jurisdiction, employment, conflict, and deadline eligibility before submitting.
- [ ] The human participant materially directed and controlled the entry, personally reviews the final source, claims, demo, and form, and can explain the architecture and evidence to judges.
- [ ] Any use of AI assistance is permitted and disclosed wherever the official rules or form require it; the submission makes no false authorship, eligibility, deployment, verification, or performance claim.
- [ ] The human participant confirms the project has the rights and licenses needed for every submitted asset and that no credential, wallet secret, restricted raw dataset, or third-party confidential material is published.
- [ ] The human participant—not an automated agent—performs the final factual review and presses **Submit**.
