# Judge guide

TxLINE Sentinel combines a real authenticated TxLINE devnet observation surface with a deterministic, simulation-only replay decision walkthrough.

> **SIMULATION ONLY — NO REAL MONEY**

## 1. Verify real TxLINE devnet first

1. Open <https://txline-sentinel.onrender.com> and select **LIVE DEVNET TXLINE**.
2. Confirm the network is **SOLANA DEVNET**. The UI must never label this mainnet.
3. Confirm **TxLINE API: AUTHENTICATED** and inspect the independent odds/scores connection states.
4. Show the latest real fixture. The verified activation smoke returned seven fixtures, including `18143850` (Vietnam–Myanmar); the live snapshot may change as TxLINE publishes new records.
5. Show the latest real odds and score timestamps. If no covered match is active, an open stream with heartbeat/no data is correctly labeled `stream connected, awaiting data`.
6. Show proof status. `VERIFIED` is allowed only for an actual successful read-only on-chain simulation; connection/authentication alone must remain `VERIFICATION UNAVAILABLE`.
7. Open `/api/live/status` to demonstrate that connection metadata is session-free and that no JWT, API token, wallet secret, authorization header, or raw third-party payload is returned.

Public devnet evidence that can be checked independently:

- program `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`;
- Token-2022 mint `4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG`;
- disposable public wallet `78nxT4D9E6iBZUuSRDQ4NDwDFtzcwpQ3FG8gokMfCsfh`;
- finalized free-tier [`subscribe(1,4)` devnet transaction](https://explorer.solana.com/tx/2oxcjpbnGZFaw2R2Sk4ptc7dJ5Y6tPNRfJXzc6sZFEY66h1FPsvGkGyqYQigdPmDBgYM2RJCEtdjzaHxHNrXabdj?cluster=devnet);
- `validateFixture` simulation verified against root account `AzB6fHDNvTThdvQazWvYfgsCbDm6Ksi3zP5BzoxYo5Ri`.

The pricing row used service level `1`, price `0` TxL per week, sampling interval `0`, league bundle `1`, and market bundle `2`. The transaction consumed only ordinary devnet SOL fees/account rent.

## 2. Run the deterministic replay

Switch to **SYNTHETIC REPLAY**. Confirm `Synthetic demo data — not a real match` remains visible.

1. Click **Reset**, then **Next event** five times.
2. Inspect the Home win normalized-probability movement and confirmed goal.
3. Read the **Rule-based confidence score** and signed component reasons. The score is a heuristic, not a probability.
4. Verify the virtual position and strict exposure-capped stake.
5. Continue with **Next event** to expose duplicate, stale, sequence-gap, out-of-order, delayed, divergence, and recovery behavior.
6. Confirm current feed health recovers while historical alerts remain visible.
7. Select 10x and click **Start** to finish the run.
8. Verify confirmed full-time settlement, virtual P&L, signal precision, and settled-equity drawdown.
9. Open signal detail and inspect causal relationship plus 30/60/300-second retained-movement classifications.
10. Inspect the audit timeline and run-scoped correlation IDs.

Starting again after finished state creates clean dynamic state. Prior audit events remain append-only under their earlier `runId`.

## API path

Open <https://txline-sentinel.onrender.com/docs> for interactive OpenAPI or `/docs/json` for the machine-readable form.

```bash
BASE_URL="${BASE_URL:-https://txline-sentinel.onrender.com}"
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

# Session-free live evidence.
curl "$BASE_URL/api/live/status"

# One isolated deterministic replay session.
curl -c "$COOKIE_JAR" -b "$COOKIE_JAR" -X POST "$BASE_URL/api/replay/reset"
curl -c "$COOKIE_JAR" -b "$COOKIE_JAR" -X POST "$BASE_URL/api/replay/advance"
curl -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE_URL/api/agent/status"
curl -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE_URL/api/signals"
curl -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE_URL/api/alerts"
curl -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE_URL/api/positions"
curl -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE_URL/api/analytics"
curl -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$BASE_URL/api/audit?limit=100"
```

Keep the same cookie jar for the replay sequence; otherwise each request creates a different isolated session. Set `BASE_URL=http://localhost:3000` for a local backup.

## Local proof backup

If a judge wants to reproduce proof verification, use the ignored credential file and disposable devnet wallet outside the repository:

```bash
npm run txline:devnet -- smoke --credentials-file .env.live.local
npm run txline:devnet -- verify-fixture \
  --wallet /absolute/path/outside/repo/devnet-wallet.json \
  --credentials-file .env.live.local
```

Do not screen-share the credential file, environment values, wallet JSON, request headers, or unredacted logs.

## Interpretation checklist

- An open SSE stream proves accepted authentication/connection, not that a match is active.
- Official integer `Prices` are retained without an invented decimal scale and do not create live paper positions.
- The process-wide live sidecar is read-only; anonymous replay sessions never receive its credentials.
- `bookPercentage` is the sum of implied probabilities; `overround = bookPercentage - 1`.
- normalized probability is a margin-adjusted market value, not a true probability.
- late confirmation does not use future data and cannot open the current paper strategy.
- signal precision measures 60-second movement persistence, not betting accuracy or profit potential.
- The product has no bookmaker execution, deposits, withdrawals, wallet custody, or real-money path.
